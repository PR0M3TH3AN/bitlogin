/**
 * End-to-end passkey ceremony test (docs/passkey-login.md §PK6).
 *
 * The vitest suites verify the derivation contract and the option shapes, but
 * they cannot exercise the part that actually breaks in the wild: a REAL
 * browser running REAL WebAuthn create/get ceremonies, PRF extension results
 * crossing the browser boundary, and the widget's worker deriving an account
 * from them. This drives headless Chromium through Playwright with a CDP
 * virtual authenticator (`hasPrf: true`), against the built demo served
 * locally and pointed at an in-process mock relay -- so it is hermetic: no
 * public relays, no hardware, no platform passkey provider.
 *
 * Skipped automatically when the Playwright browser isn't installed
 * (`npx playwright install chromium`), so `npm test` stays green anywhere.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Relative source import on purpose: test-support is deliberately NOT a
// package export (it must never ship), and vitest resolves the TS directly.
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { generatePrivateKey, getPublicKeyHex } from "../../../core/src/crypto/secp256k1.js";
import { encodeNpub, encodeNsec } from "../../../core/src/nostr/nip19.js";
import { verifyNostrEvent } from "../../../core/src/nostr/event.js";

const DIST = fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json"
};

let chromiumAvailable = true;
type PlaywrightModule = typeof import("playwright");
let playwright: PlaywrightModule | null = null;
try {
  playwright = (await import("playwright")) as PlaywrightModule;
  const path = playwright.chromium.executablePath();
  if (!path || !existsSync(path)) chromiumAvailable = false;
} catch {
  chromiumAvailable = false;
}

/**
 * Serves the built demo, with one substitution: the account page's widget is
 * pointed at the local mock relay (the real page uses BitLogin's public relay
 * list, which this test must never touch).
 */
function startServer(relayUrls: string[]): Promise<{ server: Server; origin: string }> {
  const relayList = relayUrls.join(",");
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // A directory is served by its index page, as the real site serves /signer/ and /connect/.
      const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
      const filePath = join(DIST, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
      if (!existsSync(filePath)) {
        res.writeHead(404).end("not found");
        return;
      }
      let body: string | Buffer = await readFile(filePath);
      if (relative === "/account.html") {
        body = body
          .toString("utf8")
          .replace(
            "<bitlogin-auth id=\"bitlogin-widget\">",
            `<bitlogin-auth id="bitlogin-widget" vault-relays="${relayList}" discovery-relays="${relayList}">`
          );
      }
      // The sign-in window asks relays for a profile. It is given the mock ones, as the account page is.
      if (relative === "/connect/index.html") {
        body = body.toString("utf8").replace('<html lang="en">', `<html lang="en" data-vault-relays="${relayList}" data-discovery-relays="${relayList}">`);
      }
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] ?? "application/octet-stream",
        // No service worker interference in the harness.
        "cache-control": "no-store"
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((resolve) => {
    // localhost, NOT 127.0.0.1: WebAuthn treats a bare IP as an invalid RP id
    // ("SecurityError: This is an invalid domain"), while localhost is a
    // trusted secure context.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, origin: `http://localhost:${port}` });
    });
  });
}

/**
 * Drives the mandatory recovery ceremony that every passkey registration now
 * runs before a session exists: read the 12 words, answer the three-word quiz
 * from them, submit. Returns the phrase. For a generated identity that is
 * the whole ceremony (the phrase derives the key); an imported key gets one
 * more screen, driven by acknowledgeKeyBackup below.
 */
async function completeRecoveryCeremony(widget: {
  locator: (selector: string) => any;
}): Promise<string[]> {
  await widget.locator(".phrase-word").first().waitFor({ timeout: 60_000 });
  const cells: string[] = await widget.locator(".phrase-word").allTextContents();
  const words = cells.map((cell) => cell.replace(/^\s*\d+\.\s*/u, "").trim());
  await widget.locator('[data-action="goto-verify-phrase"]').click();
  const inputs = widget.locator('form[data-form="verify-phrase"] input');
  const count: number = await inputs.count();
  for (let i = 0; i < count; i++) {
    const name: string = await inputs.nth(i).getAttribute("name");
    await inputs.nth(i).fill(words[Number(name.replace("confirm-", ""))]!);
  }
  await widget.locator('form[data-form="verify-phrase"] button[type="submit"]').click();
  return words;
}

/**
 * Imported keys only: the key is shown, and Finish is refused until it is
 * acknowledged as saved. Returns the nsec that was on screen.
 */
async function acknowledgeKeyBackup(widget: { locator: (selector: string) => any }): Promise<string> {
  const saveKey = widget.locator('form[data-form="save-key"]');
  await saveKey.waitFor({ timeout: 60_000 });
  const shownKey: string = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
  await saveKey.locator('button[type="submit"]').click();
  await widget.locator(".notice.error").waitFor({ timeout: 10_000 });
  expect(await widget.locator(".pubkey").count()).toBe(0);
  await widget.locator("#key-saved-check").check();
  await saveKey.locator('button[type="submit"]').click();
  return shownKey;
}

/** Password sign-up through the generated-password screen, up to the phrase. */
async function startPasswordSignUp(widget: { locator: (selector: string) => any }, loginName: string): Promise<void> {
  await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(loginName);
  await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
  await widget.locator("#saved-check").check();
  await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
}

describe.skipIf(!chromiumAvailable)("passkey sign-in, real browser ceremony", () => {
  let relays: MockRelay[] = [];
  let server: Server;
  let origin: string;

  beforeAll(async () => {
    // Three relays: registration and login require a quorum, exactly as the
    // core account e2e suite models it.
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    ({ server, origin } = await startServer(relays.map((r) => r.url)));
  }, 60_000);

  afterAll(async () => {
    server?.close();
    await Promise.all(relays.map((r) => r.close()));
  });

  it(
    "creates a passkey, registers an account, and signs back in to the SAME identity",
    async () => {
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        // Virtual authenticator with PRF: what a platform passkey provider
        // (Google Password Manager, iCloud Keychain, Bitwarden) would do.
        const cdp = await context.newCDPSession(await context.newPage());
        await cdp.send("WebAuthn.enable");
        const { authenticatorId } = (await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            ctap2Version: "ctap2_1",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            hasPrf: true,
            isUserVerified: true,
            automaticPresenceSimulation: true
          }
        })) as { authenticatorId: string };
        expect(authenticatorId).toBeTruthy();

        const page = context.pages()[0]!;
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });

        const widget = page.locator("bitlogin-auth");
        // The disclosure state survives re-renders by design, so open it only
        // when the passkey row isn't already showing.
        const openOptions = async () => {
          await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
          if ((await widget.locator('[data-action="goto-passkey"]').count()) === 0) {
            await widget.locator('[data-action="toggle-more"]').click();
          }
          await widget.locator('[data-action="goto-passkey"]').waitFor({ timeout: 30_000 });
        };

        await openOptions();
        await widget.locator('[data-action="goto-passkey"]').click();
        // Create a passkey: the real navigator.credentials.create ceremony,
        // PRF evaluated by the virtual authenticator.
        await widget.locator('[data-action="passkey-register"]').click();

        // Setup screen appears once the ceremony produced a PRF result.
        await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="passkey-new"]').click();

        // Recovery is MANDATORY for passkey accounts: registration lands on
        // the phrase screens, and NO session exists until they're completed.
        await widget.locator(".phrase-word").first().waitFor({ timeout: 60_000 });
        expect(await page.evaluate(() => window.bitlogin?.activeMethod())).toBeNull();
        const words = await completeRecoveryCeremony(widget);
        expect(words).toHaveLength(12);

        // Only now does the session exist and the dashboard appear.
        const pubkeyLine = widget.locator(".pubkey");
        await pubkeyLine.waitFor({ timeout: 60_000 });
        const firstNpub = (await pubkeyLine.textContent())?.trim() ?? "";
        expect(firstNpub).toMatch(/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u);

        // Not a UI-only illusion: the capsules really landed on the relays,
        // so this is a genuine protocol-level account.
        const capsuleKinds = relays.flatMap((r) => r.storedEventKinds());
        expect(capsuleKinds.filter((kind) => kind === 30078).length).toBeGreaterThan(0);

        // No deferred "secure it later" card exists any more -- recovery was
        // completed before the session was granted.
        expect(await widget.locator('[data-action="goto-confirm-phrase"]').count()).toBe(0);

        // The passkey session is reported to the host, method-aware.
        const session = await page.evaluate(() => window.bitlogin?.activeSession());
        expect(session?.method).toBe("bitlogin");
        expect(session?.npub).toBe(firstNpub);

        // Backup health panel, against the same relays: healthy at first,
        // then every relay drops the account (the loss this panel exists
        // for), the panel says so, and one tap re-sends it from this device.
        const healthNotice = widget.locator(".notice:has(strong)").first();
        const healthRows = widget.locator(".health-row");
        await widget.locator('[data-action="goto-health"]').click();
        await healthRows.first().waitFor({ timeout: 30_000 });
        expect(await healthRows.count()).toBe(3);
        expect(await healthNotice.textContent()).toContain("Stored on every relay");
        expect(await widget.locator(".health-cell.bad").count()).toBe(0);

        for (const relay of relays) relay.wipeAllData();
        await widget.locator('[data-action="health-recheck"]').click();
        await widget.locator(".health-cell.bad").first().waitFor({ timeout: 30_000 });
        expect(await healthNotice.textContent()).toContain("Relays have dropped your account");
        expect(await widget.locator(".health-cell.bad").count()).toBe(6);

        await widget.locator('[data-action="health-repair"]').click();
        await widget.locator(".notice:has-text('Stored on every relay')").waitFor({ timeout: 30_000 });
        expect(await widget.locator(".health-cell.bad").count()).toBe(0);
        expect(relays.every((r) => r.storedEventKinds().filter((kind) => kind === 30078).length >= 2)).toBe(true);
        await widget.locator('[data-action="goto-dashboard"]').click();
        await pubkeyLine.waitFor({ timeout: 30_000 });

        // A generated identity is covered by its phrase: no key-backup notice.
        expect(await widget.locator("[data-key-backup-notice]").count()).toBe(0);

        // Sign out, then sign IN with the same passkey: derivation must land
        // on the same account. One relay drops the account in between; the
        // sign-in itself must put it back, with nobody opening a health screen.
        relays[2]!.wipeAllData();
        await widget.locator('[data-action="logout"]').click();
        await openOptions();
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-auth"]').click();

        await pubkeyLine.waitFor({ timeout: 60_000 });
        const secondNpub = (await pubkeyLine.textContent())?.trim() ?? "";
        expect(secondNpub).toBe(firstNpub);
        await expect
          .poll(() => relays[2]!.storedEventKinds().filter((kind) => kind === 30078).length, { timeout: 30_000 })
          .toBeGreaterThanOrEqual(2);

        // A returning sign-in does not repeat the ceremony.
        expect(await widget.locator(".phrase-word").count()).toBe(0);

        await page.screenshot({
          path: fileURLToPath(new URL("../../../../.e2e-passkey-dashboard.png", import.meta.url))
        });
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    180_000
  );

  it(
    "hands a real session to a second worker, which can then sign and do nothing else (sign-in-window.md §SW4)",
    async () => {
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        const cdp = await context.newCDPSession(await context.newPage());
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        const page = context.pages()[0]!;
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = page.locator("bitlogin-auth");
        // A throwaway account, made the ordinary way, against the mock relays.
        await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
        if ((await widget.locator('[data-action="goto-passkey"]').count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-register"]').click();
        await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="passkey-new"]').click();
        await completeRecoveryCeremony(widget);
        await widget.locator(".pubkey").waitFor({ timeout: 60_000 });
        const session = await page.evaluate(() => window.bitlogin?.activeSession());
        expect(session?.publicKey).toMatch(/^[0-9a-f]{64}$/u);

        // Two headless signers on this origin stand for the two sides: the
        // sign-in window (it restores the real session) and the embedded
        // signer (it starts with nothing). Each has a crypto worker of its own.
        // Given to the page as text: a test runner rewrites a dynamic import in a function it serializes.
        const result = (await page.evaluate(`(async () => {
          const url = "/vendor/bitlogin/bitlogin-headless.js";
          const mod = await import(url);
          const sender = await mod.createHeadlessSigner();
          const receiver = await mod.createHeadlessSigner();
          const restored = await sender.restore();
          const before = { receiverUnlocked: await receiver.isUnlocked(), senderSignerOnly: await sender.isSignerOnly() };
          const refuses = async (work) => {
            try {
              await work();
              return "ALLOWED";
            } catch (err) {
              return String(err.message).slice(0, 60);
            }
          };
          const acceptWithoutBegin = await refuses(() => receiver.acceptHandoff({ senderPublicKey: "ab".repeat(32), payload: "x" }));
          const recipient = await receiver.beginHandoff();
          const sealed = await sender.exportHandoff(recipient);
          const accepted = await receiver.acceptHandoff(sealed);
          const signed = await receiver.signEvent({ kind: 1, content: "signed after a hand-off", tags: [], created_at: 1_794_000_000 });
          const out = {
            restored: restored?.pubkey ?? null,
            before,
            acceptWithoutBegin,
            sealedLooksLikeAKey: /^[0-9a-f]{64}$/.test(sealed.payload),
            accepted: accepted.pubkey,
            signerOnly: await receiver.isSignerOnly(),
            signed: { pubkey: signed.pubkey, kind: signed.kind, sig: typeof signed.sig === "string" && signed.sig.length === 128 },
            // What a session that can only sign is refused.
            decrypt: await refuses(() => receiver.nip44Decrypt("ab".repeat(32), "x")),
            encrypt: await refuses(() => receiver.nip44Encrypt("ab".repeat(32), "x")),
            handOnAgain: await refuses(async () => receiver.exportHandoff(await sender.beginHandoff())),
            // A hand-off is used once: the same sealed key opens nothing a second time.
            again: await refuses(() => receiver.acceptHandoff(sealed)),
            // The sending side is untouched: still a full session, still able to hand over.
            senderStillFull: !(await sender.isSignerOnly()) && (await sender.isUnlocked())
          };
          // And nothing was written: a third signer restoring from this origin's cache gets the ORIGINAL
          // full session (the one sign-in cached), never a second, signer-only one.
          const third = await mod.createHeadlessSigner();
          const thirdRestored = await third.restore();
          out.cacheUnchanged = thirdRestored?.pubkey === restored?.pubkey && !(await third.isSignerOnly());
          sender.destroy();
          receiver.destroy();
          third.destroy();
          return out;
        })()`)) as Record<string, any>;
        expect(result.restored).toBe(session!.publicKey);
        expect(result.before).toEqual({ receiverUnlocked: false, senderSignerOnly: false });
        expect(result.acceptWithoutBegin).toContain("No hand-off was begun");
        expect(result.sealedLooksLikeAKey).toBe(false);
        expect(result.accepted).toBe(session!.publicKey);
        expect(result.signerOnly).toBe(true);
        expect(result.signed).toEqual({ pubkey: session!.publicKey, kind: 1, sig: true });
        expect(result.decrypt).toContain("can only sign");
        expect(result.encrypt).toContain("can only sign");
        expect(result.handOnAgain).toContain("can only sign");
        expect(result.again).toContain("No hand-off was begun");
        expect(result.senderStillFull).toBe(true);
        expect(result.cacheUnchanged).toBe(true);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    180_000
  );

  it(
    "a site on another origin gets a signer through the sign-in window, and never the key (sign-in-window.md)",
    async () => {
      // A site that asks: its own origin, a hidden frame of BitLogin's signer, and everything it hears kept.
      const asking = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a site that asks</title><button id="open">Sign in with BitLogin</button>
<iframe id="signer" src="${origin}/signer/index.html" style="width:1px;height:1px;border:0;position:absolute;left:-9px"></iframe>
<script type="module">
  const SIGNIN = "${origin}";
  const frame = document.getElementById("signer");
  window.heard = [];
  addEventListener("message", (e) => window.heard.push({ origin: e.origin, data: e.data }));
  document.getElementById("open").onclick = () => { window.popup = window.open(SIGNIN + "/connect/index.html", "bitlogin-connect", "popup,width=460,height=660"); };
  window.ask = (message, wait = 2500) => new Promise((done) => {
    const id = "q" + Math.random().toString(36).slice(2, 8);
    const on = (e) => { if (e.source === frame.contentWindow && e.origin === SIGNIN && e.data && e.data.id === id) { removeEventListener("message", on); done(e.data); } };
    addEventListener("message", on);
    frame.contentWindow.postMessage({ nswp: "nswp-signer", v: 1, id, ...message }, SIGNIN);
    setTimeout(() => done({ t: "no answer" }), wait);
  });
  window.tryToRead = () => {
    const out = {};
    try { out.frame = frame.contentWindow.document.body ? "READ" : "?"; } catch (err) { out.frame = "refused: " + err.name; }
    try { out.popup = window.popup.document.body ? "READ" : "?"; } catch (err) { out.popup = "refused: " + err.name; }
    return out;
  };
</script>`);
      });
      await new Promise<void>((resolve) => asking.listen(0, "127.0.0.1", () => resolve()));
      const askingAddress = asking.address();
      // 127.0.0.1 where the sign-in address is localhost: two different sites, as a browser counts them.
      const site = `http://127.0.0.1:${typeof askingAddress === "object" && askingAddress ? askingAddress.port : 0}`;
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        const cdp = await context.newCDPSession(await context.newPage());
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        // A throwaway account at the sign-in address, made the ordinary way, against the mock relays.
        const account = context.pages()[0]!;
        await account.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = account.locator("bitlogin-auth");
        await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
        if ((await widget.locator('[data-action="goto-passkey"]').count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-register"]').click();
        await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="passkey-new"]').click();
        await completeRecoveryCeremony(widget);
        await widget.locator(".pubkey").waitFor({ timeout: 60_000 });
        const session = await account.evaluate(() => window.bitlogin?.activeSession());
        const me = session!.publicKey;

        // Their own profile, signed by them and on the relays: where the sign-in window finds who they are. It is
        // newer than the one sign-up published. With an older one beside it, and one signed by somebody else,
        // neither of which may be believed.
        const profileOf = (content: Record<string, string>, created_at: number) =>
          account.evaluate((e) => (window as any).nostr.signEvent(e), { kind: 0, created_at, tags: [], content: JSON.stringify(content) });
        const nowSec = Math.floor(Date.now() / 1000);
        const stranger = generatePrivateKey();
        const profiles = [
          await profileOf({ name: "Old Name", picture: "https://pictures.example/old.png" }, nowSec - 500),
          await profileOf({ name: "Ada\u202e Lovelace  ", picture: "https://pictures.example/ada.png", about: "Line one\nline two" }, nowSec + 2),
          { ...(await profileOf({ name: "Forged" }, nowSec + 9)), pubkey: getPublicKeyHex(stranger) }
        ];
        for (const relay of relays) {
          await new Promise<void>((resolve, reject) => {
            const socket = new WebSocket(relay.url);
            socket.onerror = () => reject(new Error("mock relay refused a connection"));
            socket.onopen = () => {
              for (const event of profiles) socket.send(JSON.stringify(["EVENT", event]));
              setTimeout(() => {
                socket.close();
                resolve();
              }, 300);
            };
          });
        }

        // The asking site, in another tab.
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${site}/`);
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
        const ask = (message: Record<string, unknown>) => page.evaluate((m) => (window as any).ask(m), message) as Promise<Record<string, any>>;

        // Locked: it says so, and signs nothing. A refusal carries nothing but its id.
        expect(await ask({ t: "state" })).toMatchObject({ t: "state", unlocked: false });
        const locked = await ask({ t: "sign", event: { kind: 1, content: "before", tags: [] } });
        expect(locked.t).toBe("refused");
        expect(Object.keys(locked).sort()).toEqual(["id", "nswp", "t", "v"]);
        const sessionKey = getPublicKeyHex(generatePrivateKey());
        expect((await ask({ t: "pass", session: sessionKey })).t).toBe("refused");

        // The window: BitLogin's own page, naming the site as the browser reports it.
        const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
        await popup.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
        expect(new URL(popup.url()).origin).toBe(origin);
        expect(await popup.locator("#site").textContent()).toBe(site);
        // The window says the site can tell others who they are.
        expect(await popup.locator("#ask").textContent()).toContain("who you are");
        // The address can be read, in a light-themed browser and a dark one. It once could not: dark text on a
        // dark bar, in the light theme, on the one line the user is told to check.
        for (const colorScheme of ["light", "dark"] as const) {
          await popup.emulateMedia({ colorScheme });
          const contrast = await popup.locator("#site").evaluate((el) => {
            const luminance = (css: string): number => {
              const [r, g, b] = (css.match(/[\d.]+/gu) ?? []).slice(0, 3).map((v) => {
                const c = Number(v) / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
            };
            const style = getComputedStyle(el);
            const [hi, lo] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
            return (hi! + 0.05) / (lo! + 0.05);
          });
          expect(contrast, colorScheme).toBeGreaterThan(7);
        }
        expect(await page.evaluate(() => (window as any).tryToRead())).toEqual({ frame: "refused: SecurityError", popup: "refused: SecurityError" });
        // A press that lands at once was meant for the site, and is ignored.
        await popup.locator("#allow").click();
        await page.waitForTimeout(400);
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: false });
        await popup.waitForTimeout(800);
        await popup.locator("#allow").click();
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });

        // Unlocked, as the account that is signed in at the sign-in address.
        const state = await ask({ t: "state" });
        expect(state).toMatchObject({ t: "state", unlocked: true, pubkey: me });
        // Who they are: from the newest profile their own key signed, tidied. Not the older one, not the forged one.
        expect({ name: state.name, picture: state.picture, about: state.about }).toEqual({
          name: "Ada Lovelace",
          picture: "https://pictures.example/ada.png",
          about: "Line one line two"
        });

        // A room pass (§SW16): the site names a session key, and the signer makes everything else.
        const passed = await ask({ t: "pass", session: sessionKey, origin: "https://elsewhere.example", name: "Somebody Else", ttl: 999_999 });
        expect(passed.t).toBe("signed");
        const pass = passed.event;
        expect(verifyNostrEvent(pass)).toBe(true);
        expect(pass).toMatchObject({ kind: 27300, pubkey: me, content: "" });
        expect(pass.tags.slice(0, 2)).toEqual([["nswp:session", sessionKey], ["nswp:origin", site]]);
        expect(pass.tags[2][0]).toBe("expiration");
        expect(Number(pass.tags[2][1]) - pass.created_at).toBe(4 * 3600);
        expect(Math.abs(pass.created_at - Date.now() / 1000)).toBeLessThan(120);
        expect(pass.tags.slice(3)).toEqual([["name", "Ada Lovelace"], ["picture", "https://pictures.example/ada.png"], ["about", "Line one line two"]]);
        // Not for the identity key itself, not for something that is no key, and never through "sign".
        expect((await ask({ t: "pass", session: me })).t).toBe("refused");
        expect((await ask({ t: "pass", session: "not a key" })).t).toBe("no answer");
        const signed = await ask({ t: "sign", event: { kind: 1, content: "from a site that asks", tags: [["t", "x"], ["nswp:world", "https://elsewhere.example"]], created_at: 1 } });
        expect(signed.t).toBe("signed");
        expect(signed.event).toMatchObject({ kind: 1, content: "from a site that asks", pubkey: me, tags: [["t", "x"], ["nswp:world", site]] });
        expect(Math.abs(signed.event.created_at - Date.now() / 1000)).toBeLessThan(120);
        // What a site may not have signed: a profile, a follow list, a message, a web proof, a pass, an account's own data.
        for (const kind of [0, 3, 4, 27235, 27300, 30078]) expect((await ask({ t: "sign", event: { kind, content: "{}", tags: [] } })).t, String(kind)).toBe("refused");
        // The site never heard the key, in any message.
        const heard = JSON.stringify(await page.evaluate(() => (window as any).heard));
        expect(heard).not.toMatch(/nsec1|"payload"|senderPublicKey/u);

        // The site's page is loaded again: it is still allowed, with no window and nothing asked of anyone.
        const pagesBefore = context.pages().length;
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        const afterReload = await ask({ t: "state" });
        expect(afterReload).toMatchObject({ t: "state", unlocked: true, pubkey: me });
        expect(afterReload.until - Date.now() / 1000).toBeGreaterThan(29 * 24 * 3600);
        // No window was opened. (Not "the same number": the sign-in window may only now be closing.)
        expect(context.pages().length).toBeLessThanOrEqual(pagesBefore);
        const again = await ask({ t: "sign", event: { kind: 1, content: "after a reload", tags: [] } });
        expect(again.event).toMatchObject({ kind: 1, content: "after a reload", pubkey: me, tags: [["nswp:world", site]] });
        expect(afterReload).toMatchObject({ name: "Ada Lovelace", picture: "https://pictures.example/ada.png", about: "Line one line two" });
        // Loading the page again is not a way round the count: six a minute, with the pass and the one signed
        // before. A pass is counted like a signature.
        let more = 0;
        for (let i = 0; i < 8; i++) if ((await ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t === "signed") more++;
        expect(more).toBe(3);
        expect((await ask({ t: "pass", session: sessionKey })).t).toBe("refused");
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect((await ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("refused");
        // What is kept is not the key in the clear, and the site still can't read any of it.
        expect(await page.evaluate(() => (window as any).tryToRead().frame)).toBe("refused: SecurityError");

        // Lock: nothing more is signed, and the site is forgotten, across a reload too.
        expect(await ask({ t: "lock" })).toMatchObject({ t: "state", unlocked: false });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await ask({ t: "state" })).toMatchObject({ t: "state", unlocked: false });
        expect((await ask({ t: "sign", event: { kind: 1, content: "after", tags: [] } })).t).toBe("refused");
        // The sign-in address itself is still signed in, with a full session: handing over took nothing from it.
        expect(await account.evaluate(() => window.bitlogin?.activeSession()?.publicKey)).toBe(me);
        expect(errors).toEqual([]);

        // Someone not signed in at the sign-in address is asked to sign in there, with the ordinary widget, and
        // is offered no Allow.
        const fresh = await browser.newContext();
        const visitor = await fresh.newPage();
        await visitor.goto(`${site}/`);
        await visitor.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
        const [popup2] = await Promise.all([fresh.waitForEvent("page"), visitor.click("#open")]);
        await popup2.locator("#signin").waitFor({ state: "visible", timeout: 30_000 });
        expect(await popup2.locator("#widget-slot bitlogin-auth").count()).toBe(1);
        expect(await popup2.locator("#ask").isVisible()).toBe(false);
        await fresh.close();
      } finally {
        await browser.close();
        asking.close();
      }
    },
    240_000
  );

  it(
    "a different passkey derives a DIFFERENT account (PRF is per-credential)",
    async () => {
      const browser = await playwright!.chromium.launch();
      const npubs: string[] = [];
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          // Fresh context each round: a brand-new virtual authenticator, so
          // round two is a genuinely different passkey.
          const context = await browser.newContext();
          const page = await context.newPage();
          const cdp = await context.newCDPSession(page);
          await cdp.send("WebAuthn.enable");
          await cdp.send("WebAuthn.addVirtualAuthenticator", {
            options: {
              protocol: "ctap2",
              ctap2Version: "ctap2_1",
              transport: "internal",
              hasResidentKey: true,
              hasUserVerification: true,
              hasPrf: true,
              isUserVerified: true,
              automaticPresenceSimulation: true
            }
          });
          await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
          const widget = page.locator("bitlogin-auth");
          await widget.locator('[data-action="toggle-more"]').click();
          await widget.locator('[data-action="goto-passkey"]').click();
          await widget.locator('[data-action="passkey-register"]').click();
          await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
          await widget.locator('[data-action="passkey-new"]').click();
          await completeRecoveryCeremony(widget);
          const pubkey = widget.locator(".pubkey");
          await pubkey.waitFor({ timeout: 60_000 });
          npubs.push((await pubkey.textContent())?.trim() ?? "");
          await context.close();
        }
        expect(npubs[0]).toMatch(/^npub1/u);
        expect(npubs[1]).toMatch(/^npub1/u);
        expect(npubs[0]).not.toBe(npubs[1]);
      } finally {
        await browser.close();
      }
    },
    180_000
  );

  it(
    "every relay drops a generated account, and the phrase alone rebuilds the same identity",
    async () => {
      const browser = await playwright!.chromium.launch();
      try {
        const page = await (await browser.newContext()).newPage();
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = page.locator("bitlogin-auth");

        await widget.locator('[data-action="goto-create"]').click();
        await startPasswordSignUp(widget, "rebuildme");
        const words = await completeRecoveryCeremony(widget);
        // A generated identity needs no key-backup screen: the phrase is it.
        const pubkeyLine = widget.locator(".pubkey");
        await pubkeyLine.waitFor({ timeout: 60_000 });
        expect(await widget.locator('form[data-form="save-key"]').count()).toBe(0);
        const npub = (await pubkeyLine.textContent())?.trim() ?? "";
        expect(npub).toMatch(/^npub1/u);

        await widget.locator('[data-action="logout"]').click();
        for (const relay of relays) relay.wipeAllData();

        await widget.locator('[data-action="toggle-more"]').click();
        await widget.locator('[data-action="goto-recover"]').click();
        await widget.locator('form[data-form="recover-phrase"] input[name="phrase"]').fill(words.join(" "));
        await widget.locator('form[data-form="recover-phrase"] button[type="submit"]').click();

        // Nothing is rebuilt or signed in until the identity is confirmed.
        const confirm = widget.locator('[data-action="rebuild-confirm"]');
        await confirm.waitFor({ timeout: 60_000 });
        expect(((await widget.locator(".credential-box").first().textContent()) ?? "").trim()).toBe(npub);
        expect(await page.evaluate(() => window.bitlogin?.activeMethod())).toBeNull();
        expect(relays.flatMap((r) => r.storedEventKinds()).filter((kind) => kind === 30078)).toEqual([]);
        await confirm.click();

        const newLogin = widget.locator('form[data-form="recover-new-credentials"]');
        await newLogin.waitFor({ timeout: 60_000 });
        await newLogin.locator('input[name="newLoginName"]').fill("rebuilt");
        await newLogin.locator('button[type="submit"]').click();
        await pubkeyLine.waitFor({ timeout: 60_000 });
        expect((await pubkeyLine.textContent())?.trim()).toBe(npub);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    180_000
  );

  it(
    "an imported key is told it is different and must be acknowledged as saved",
    async () => {
      const importedKey = generatePrivateKey();
      const importedNsec = encodeNsec(importedKey);
      const importedNpub = encodeNpub(getPublicKeyHex(importedKey));
      const browser = await playwright!.chromium.launch();
      try {
        const page = await (await browser.newContext()).newPage();
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = page.locator("bitlogin-auth");

        await widget.locator('[data-action="toggle-more"]').click();
        await widget.locator('[data-action="goto-import"]').click();
        await widget.locator('form[data-form="import-key"] input[name="importKey"]').fill(importedNsec);
        await widget.locator('form[data-form="import-key"] button[type="submit"]').click();
        await widget.locator('[data-action="import-continue"]').click();
        await startPasswordSignUp(widget, "importer");
        await completeRecoveryCeremony(widget);

        await widget.locator('form[data-form="save-key"]').waitFor({ timeout: 60_000 });
        expect(await widget.locator("h2").textContent()).toContain("Keep your private key safe");
        expect(await widget.locator(".sub").first().textContent()).toContain("Imported accounts are different");
        expect(await acknowledgeKeyBackup(widget)).toBe(importedNsec);

        const pubkeyLine = widget.locator(".pubkey");
        await pubkeyLine.waitFor({ timeout: 60_000 });
        expect((await pubkeyLine.textContent())?.trim()).toBe(importedNpub);

        // The dashboard keeps saying so: this account's phrase is not enough.
        expect(await widget.locator("[data-key-backup-notice]").textContent()).toContain(
          "not contained in its recovery phrase"
        );
        await widget.locator('[data-key-backup-notice] [data-action="goto-export"]').click();
        expect(await widget.locator(".small").first().textContent()).toContain("not contained in its recovery phrase");
      } finally {
        await browser.close();
      }
    },
    180_000
  );
  it(
    "an application declares what it wants, the user approves it once, and it then signs in the background (sign-in-window.md §SW9)",
    async () => {
      // An application on its own origin, using BitLogin's client the way a real one would: vendored, same-origin.
      const vendor = join(DIST, "vendor", "bitlogin");
      const asking = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname.startsWith("/vendor/bitlogin/")) {
          const file = join(vendor, normalize(url.pathname.slice("/vendor/bitlogin/".length)).replace(/^(\.\.[/\\])+/u, ""));
          if (!existsSync(file)) return void res.writeHead(404).end("not found");
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
          return void res.end(await readFile(file));
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>an application</title><button id="open">Sign in with BitLogin</button>
<script type="module">
  import { createBitLoginClient } from "/vendor/bitlogin/bitlogin-client.js";
  const more = new URLSearchParams(location.search).has("more");
  window.heard = [];
  addEventListener("message", (e) => window.heard.push({ origin: e.origin, data: e.data }));
  window.bl = createBitLoginClient({
    at: "${origin}",
    permissions: {
      name: "Test App",
      sign: [0, 1, 5, 7, 27235, 30078, ...(more ? [3] : [])],
      appData: ["testapp:"],
      proofs: ["https://api.testapp.example"],
      read: [30078]
    }
  });
  window.attempt = async (method, ...args) => {
    try {
      const target = method.includes(".") ? window.bl[method.split(".")[0]] : window.bl;
      return { ok: true, value: await target[method.split(".").pop()](...args) };
    } catch (err) {
      return { ok: false, name: err.name };
    }
  };
  document.getElementById("open").onclick = () => { window.signedIn = window.bl.signIn(); };
  window.isReady = window.bl.ready();
</script>`);
      });
      await new Promise<void>((resolve) => asking.listen(0, "127.0.0.1", () => resolve()));
      const askingAddress = asking.address();
      const site = `http://127.0.0.1:${typeof askingAddress === "object" && askingAddress ? askingAddress.port : 0}`;
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        const cdp = await context.newCDPSession(await context.newPage());
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        const account = context.pages()[0]!;
        await account.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = account.locator("bitlogin-auth");
        await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
        if ((await widget.locator('[data-action="goto-passkey"]').count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-register"]').click();
        await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="passkey-new"]').click();
        await completeRecoveryCeremony(widget);
        await widget.locator(".pubkey").waitFor({ timeout: 60_000 });
        const me = (await account.evaluate(() => window.bitlogin?.activeSession()))!.publicKey;

        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${site}/`);
        const attempt = (method: string, ...args: unknown[]) =>
          page.evaluate(([m, a]) => (window as any).attempt(m, ...(a as unknown[])), [method, args] as const) as Promise<{ ok: boolean; value?: any; name?: string }>;
        const sign = (event: Record<string, unknown>) => attempt("signEvent", event);

        // Not allowed yet: nobody is signed in to it, and nothing is signed.
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false });
        expect(await sign({ kind: 1, content: "before", tags: [] })).toEqual({ ok: false, name: "BitLoginRefused" });

        // The window shows the address, the name it gave itself, and everything it asked, the sensitive apart.
        const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
        await popup.locator("#allow-app").waitFor({ state: "visible", timeout: 30_000 });
        expect(new URL(popup.url()).origin).toBe(origin);
        expect(await popup.locator("#app-site").textContent()).toBe(site);
        expect(await popup.locator("#app-name").textContent()).toBe("Test App");
        // The address can be read, in a light-themed browser and a dark one. It once could not: dark text on a
        // dark bar, in the light theme, on the one line the user is told to check.
        for (const colorScheme of ["light", "dark"] as const) {
          await popup.emulateMedia({ colorScheme });
          const contrast = await popup.locator("#app-site").evaluate((el) => {
            const luminance = (css: string): number => {
              const [r, g, b] = (css.match(/[\d.]+/gu) ?? []).slice(0, 3).map((v) => {
                const c = Number(v) / 255;
                return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              });
              return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
            };
            const style = getComputedStyle(el);
            const [hi, lo] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => b - a);
            return (hi! + 0.05) / (lo! + 0.05);
          });
          expect(contrast, colorScheme).toBeGreaterThan(7);
        }
        // An address BitLogin has no name for is said to be unknown, and its own name for itself is shown as only that.
        expect(await popup.locator("#app-known").isVisible()).toBe(false);
        expect(await popup.locator("#app-unknown").isVisible()).toBe(true);
        expect(await popup.locator("#app-name-line").isVisible()).toBe(true);
        expect(await popup.locator("#ask").isVisible()).toBe(false);
        expect(await popup.locator("#app-ordinary li").allTextContents()).toEqual([
          `prove who you are to ${new URL(site).host}, api.testapp.example`,
          "post notes",
          "post reactions",
          "save its own data (testapp:)",
          "read its own saved data"
        ]);
        expect(await popup.locator("#app-sensitive li").allTextContents()).toEqual(["change your profile", "delete what you have posted"]);
        await popup.waitForTimeout(1000);
        await popup.locator("#allow-app").click();
        expect(await page.evaluate(() => (window as any).signedIn)).toBe(true);
        expect(await page.evaluate(() => (window as any).bl.state())).toMatchObject({ signedIn: true, pubkey: me });

        // What it was approved for is signed with no prompt, marked with the application's address.
        const note = await sign({ kind: 1, content: "from an application", tags: [["t", "x"], ["bitlogin:site", "https://elsewhere.example"]] });
        expect(note.value).toMatchObject({ kind: 1, pubkey: me, content: "from an application", tags: [["t", "x"], ["bitlogin:site", site]] });
        expect((await sign({ kind: 0, content: "{}", tags: [] })).ok).toBe(true);
        // What it did not ask for is refused, and so is anything outside the terms of what it did.
        expect((await sign({ kind: 3, content: "", tags: [] })).ok).toBe(false);
        expect((await sign({ kind: 27302, content: "", tags: [] })).ok).toBe(false);
        const data = (d: string) => sign({ kind: 30078, content: "x", tags: [["d", d]] });
        expect((await data("testapp:settings")).ok).toBe(true);
        expect((await data("otherapp:settings")).ok).toBe(false);
        expect((await data("bitlogin:password:v1")).ok).toBe(false);
        const proof = (u: string) => sign({ kind: 27235, content: "", tags: [["u", u], ["method", "GET"]] });
        expect((await proof(`${site}/v1/me`)).ok).toBe(true);
        expect((await proof("https://api.testapp.example/v1/orders")).ok).toBe(true);
        // A proof that would work at someone else's server is not signed.
        expect((await proof("https://api.bitunlock.network/v1/orders")).ok).toBe(false);

        // Reading is tied to an event of a kind it may read. Its own draft: yes. Raw, against the user's own key: no.
        const sealed = await attempt("nip44.encrypt", me, "a private draft");
        expect(sealed.ok).toBe(true);
        expect(sealed.value).not.toContain("a private draft");
        const draft = await sign({ kind: 30078, content: sealed.value, tags: [["d", "testapp:draft:1"]] });
        expect(await attempt("decryptEvent", draft.value)).toEqual({ ok: true, value: "a private draft" });
        expect(await attempt("nip44.decrypt", me, sealed.value)).toEqual({ ok: false, name: "BitLoginRefused" });
        // The same ciphertext in a kind it may not read stays closed.
        const asNote = await sign({ kind: 1, content: sealed.value, tags: [] });
        expect(await attempt("decryptEvent", asNote.value)).toEqual({ ok: false, name: "BitLoginRefused" });
        // And it may not encrypt to a stranger: it asked for no peers and no messages.
        expect((await attempt("nip44.encrypt", "c".repeat(64), "hello")).ok).toBe(false);

        // In the background, at an application's pace: forty proofs in a row, where a world gets six a minute.
        const burst = await page.evaluate(async (u) => {
          let ok = 0;
          for (let i = 0; i < 40; i++) if ((await (window as any).attempt("signEvent", { kind: 27235, content: "", tags: [["u", u], ["method", "GET"]] })).ok) ok++;
          return ok;
        }, `${site}/v1/poll`);
        expect(burst).toBe(40);

        // The page is loaded again: still allowed, for the same things, with no window.
        const pagesBefore = context.pages().length;
        await page.reload();
        expect(await page.evaluate(() => (window as any).isReady)).toMatchObject({ signedIn: true, pubkey: me });
        // No window was opened. (Not "the same number": the sign-in window may only now be closing.)
        expect(context.pages().length).toBeLessThanOrEqual(pagesBefore);
        expect((await sign({ kind: 7, content: "+", tags: [] })).ok).toBe(true);
        expect((await sign({ kind: 3, content: "", tags: [] })).ok).toBe(false);
        expect(await attempt("decryptEvent", draft.value)).toEqual({ ok: true, value: "a private draft" });

        // The application now wants more than was approved: it is not signed in until the user is asked again.
        await page.goto(`${site}/?more`);
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false, needsMore: true });
        expect((await sign({ kind: 3, content: "", tags: [] })).ok).toBe(false);

        // Nothing the application heard was a key.
        expect(JSON.stringify(await page.evaluate(() => (window as any).heard))).not.toMatch(/nsec1|"payload"|senderPublicKey/u);

        // Signing out of the application ends it, across a reload too.
        await page.goto(`${site}/`);
        await page.evaluate(() => (window as any).isReady);
        expect((await attempt("signOut")).ok).toBe(true);
        await page.reload();
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false });
        expect((await sign({ kind: 1, content: "after", tags: [] })).ok).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        asking.close();
      }
    },
    240_000
  );

  /**
   * A browser's password manager saves from, and fills into, real form fields:
   * a login name marked `username` beside a field of type "password" marked
   * `new-password` or `current-password`, in a form that is submitted. This
   * checks that every screen which makes or takes a password is such a form,
   * in each engine. It cannot check the browser's own prompt: that is drawn
   * outside the page, and no test harness sees it.
   */
  for (const engine of ["chromium", "firefox", "webkit"] as const) {
    const installed = (() => {
      try {
        const path = playwright?.[engine].executablePath();
        return !!path && existsSync(path);
      } catch {
        return false;
      }
    })();
    it.skipIf(!installed)(
      `every password screen is a form a password manager can save from and fill (${engine})`,
      async () => {
        const browser = await playwright![engine].launch();
        try {
          const page = await (await browser.newContext()).newPage();
          const errors: string[] = [];
          page.on("pageerror", (err) => errors.push(String(err)));
          await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
          const widget = page.locator("bitlogin-auth");
          const loginName = `saver-${engine}`;

          /** What a password manager reads off a form: the marked fields, in order. */
          const fieldsOf = (form: string): Promise<{ autocomplete: string; type: string; value: string; readOnly: boolean; visible: boolean }[]> =>
            widget.locator(`form[data-form="${form}"]`).evaluate((el) =>
              Array.from(el.querySelectorAll<HTMLInputElement>("input[autocomplete]")).map((input) => ({
                // The attribute as written: Firefox's `input.autocomplete` property is empty for these values.
                autocomplete: input.getAttribute("autocomplete") ?? "",
                type: input.type,
                value: input.value,
                readOnly: input.readOnly,
                visible: input.getClientRects().length > 0
              }))
            );

          // Sign-up: the generated password is in a real field, beside the login name.
          await widget.locator('[data-action="goto-create"]').click();
          await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(loginName);
          await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
          const shown: string = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          expect(shown.length).toBeGreaterThan(20);
          expect(await fieldsOf("create-credential")).toEqual([
            { autocomplete: "username", type: "text", value: loginName, readOnly: true, visible: true },
            { autocomplete: "new-password", type: "password", value: shown, readOnly: false, visible: true }
          ]);
          // It cannot be made to differ from the password the account gets.
          const generated = widget.locator("#generatedPassword");
          await generated.fill("something else entirely");
          expect(await generated.inputValue()).toBe(shown);
          await generated.press("End");
          await generated.pressSequentially("xyz");
          expect(await generated.inputValue()).toBe(shown);
          // A different password is a different field value too.
          await widget.locator('[data-action="regenerate-credential"]').click();
          const password: string = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          expect(password).not.toBe(shown);
          expect(await generated.inputValue()).toBe(password);

          await widget.locator("#saved-check").check();
          await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
          const words = await completeRecoveryCeremony(widget);
          await widget.locator(".pubkey").waitFor({ timeout: 90_000 });

          // Sign-in: filled the way a password manager fills, then submitted.
          await widget.locator('[data-action="logout"]').click();
          await widget.locator('[data-action="goto-login"]').click();
          expect((await fieldsOf("login")).map(({ autocomplete, type, readOnly, visible }) => ({ autocomplete, type, readOnly, visible }))).toEqual([
            { autocomplete: "username", type: "text", readOnly: false, visible: true },
            { autocomplete: "current-password", type: "password", readOnly: false, visible: true }
          ]);
          await widget.locator('form[data-form="login"]').evaluate(
            (el, [name, secret]) => {
              const set = (selector: string, value: string) => {
                const input = el.querySelector<HTMLInputElement>(selector)!;
                input.value = value;
                input.dispatchEvent(new Event("input", { bubbles: true }));
                input.dispatchEvent(new Event("change", { bubbles: true }));
              };
              set('input[autocomplete="username"]', name!);
              set('input[autocomplete="current-password"]', secret!);
            },
            [loginName, password]
          );
          await widget.locator('form[data-form="login"] button[type="submit"]').click();
          await widget.locator(".pubkey").waitFor({ timeout: 90_000 });

          // Rotation: the login name, the old password and the new one, as a change-password form.
          await widget.locator('[data-action="goto-change-password"]').click();
          const rotated: string = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          expect(await fieldsOf("change-password")).toEqual([
            { autocomplete: "username", type: "text", value: loginName, readOnly: true, visible: true },
            { autocomplete: "current-password", type: "password", value: "", readOnly: false, visible: true },
            { autocomplete: "new-password", type: "password", value: rotated, readOnly: false, visible: true }
          ]);
          await widget.locator('[data-action="goto-dashboard"]').click();

          // Recovery: a new login name, typed, and the new password, as a sign-up form.
          await widget.locator('[data-action="logout"]').click();
          await widget.locator('[data-action="goto-login"]').click();
          await widget.locator('[data-action="goto-recover"]').click();
          await widget.locator('form[data-form="recover-phrase"] input[name="phrase"]').fill(words.join(" "));
          await widget.locator('form[data-form="recover-phrase"] button[type="submit"]').click();
          await widget.locator('form[data-form="recover-new-credentials"]').waitFor({ timeout: 90_000 });
          const recovered: string = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          expect(await fieldsOf("recover-new-credentials")).toEqual([
            { autocomplete: "username", type: "text", value: "", readOnly: false, visible: true },
            { autocomplete: "new-password", type: "password", value: recovered, readOnly: false, visible: true }
          ]);
          expect(errors).toEqual([]);
        } finally {
          await browser.close();
        }
      },
      300_000
    );
  }
});
