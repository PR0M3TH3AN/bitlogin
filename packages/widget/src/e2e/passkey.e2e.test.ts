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
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
      // The sign-in window asks relays for a profile, the list of sites publishes a take-back, and the embedded
      // signer reads it. Each is given the mock relays, as the account page is.
      if (relative === "/connect/index.html" || relative === "/sites/index.html" || relative === "/signer/index.html") {
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

        // The widget's signed-in view says who is signed in: a picture or a letter, the name from their own signed
        // profile, and the whole key. Loaded again, it shows the profile that is now the newest.
        expect(await widget.locator(".who .pubkey").textContent()).toBe(encodeNpub(me));
        expect(await widget.locator(".who-pic").count()).toBe(1);
        await account.reload({ waitUntil: "domcontentloaded" });
        await widget.locator(".who-name", { hasText: "Ada Lovelace" }).waitFor({ timeout: 30_000 });
        expect(await widget.locator(".who-about").textContent()).toBe("Line one line two");
        // The picture's address can't be fetched here, so the letter stands in for it.
        await widget.locator(".who-pic", { hasText: "A" }).waitFor({ timeout: 30_000 });

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
        // Who they are signing in as, before anything can be pressed: the name from their own signed profile, the
        // whole key, the line about them, and a picture (here one that can't be fetched, so a letter stands in).
        await popup.locator("#who", { hasText: "Ada Lovelace" }).waitFor({ timeout: 30_000 });
        expect(await popup.locator("#who-key").textContent()).toBe(encodeNpub(me));
        expect(await popup.locator("#who-about").textContent()).toBe("Line one line two");
        expect(await popup.locator("#who-pic").textContent()).toBe("A");
        // The site, the account and the buttons are all on screen at the size the window opens at, with nothing
        // to scroll: the list of what it allows comes after them.
        await popup.setViewportSize({ width: 460, height: 660 });
        for (const id of ["#site", "#who", "#switch", "#allow", "#deny"]) {
          const box = (await popup.locator(id).boundingBox())!;
          expect(box.y, id).toBeGreaterThanOrEqual(0);
          expect(box.y + box.height, id).toBeLessThanOrEqual(660);
        }
        expect((await popup.locator("#allow").boundingBox())!.y).toBeLessThan((await popup.locator("#lasts").boundingBox())!.y);
        // Remembered unless they untick it, and the window says for how long: seven days for an address BitLogin
        // does not know. Unticked, it is for this visit.
        expect(await popup.locator("#remember-row").isVisible()).toBe(true);
        expect(await popup.locator("#remember").isChecked()).toBe(true);
        expect(await popup.locator("#remember-row").textContent()).toContain("7 days");
        expect(await popup.locator("#lasts").textContent()).toContain("7 days");
        await popup.locator("#remember").uncheck();
        expect(await popup.locator("#lasts").textContent()).toContain("for this visit");
        await popup.waitForTimeout(800);
        await popup.locator("#allow").click();
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
        const visit = await ask({ t: "state" });
        expect(visit).toMatchObject({ t: "state", unlocked: true, pubkey: me, remembered: false });
        expect(visit.until - Date.now() / 1000).toBeLessThanOrEqual(12 * 3600);
        expect((await ask({ t: "sign", event: { kind: 1, content: "on a visit", tags: [] } })).t).toBe("signed");
        // The page is loaded again: the visit is over, nothing was kept, and nothing is signed.
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await ask({ t: "state" })).toMatchObject({ t: "state", unlocked: false });
        expect((await ask({ t: "sign", event: { kind: 1, content: "after the visit", tags: [] } })).t).toBe("refused");

        // Asked again, and this time the tick is left on. The first window closes itself a moment after Allow.
        if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => popup.close());
        const [popupAgain] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
        await popupAgain.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
        expect(await popupAgain.locator("#remember").isChecked()).toBe(true);
        expect(await popupAgain.locator("#lasts").textContent()).toContain("7 days");
        await popupAgain.waitForTimeout(1000);
        await popupAgain.locator("#allow").click();
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });

        // Unlocked, as the account that is signed in at the sign-in address.
        const state = await ask({ t: "state" });
        expect(state).toMatchObject({ t: "state", unlocked: true, pubkey: me, remembered: true });
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
        expect(afterReload).toMatchObject({ t: "state", unlocked: true, pubkey: me, remembered: true });
        // Seven days, for an address BitLogin does not know.
        expect(afterReload.until - Date.now() / 1000).toBeGreaterThan(6 * 24 * 3600);
        expect(afterReload.until - Date.now() / 1000).toBeLessThanOrEqual(7 * 24 * 3600);
        // No window was opened. (Not "the same number": the sign-in window may only now be closing.)
        expect(context.pages().length).toBeLessThanOrEqual(pagesBefore);
        const again = await ask({ t: "sign", event: { kind: 1, content: "after a reload", tags: [] } });
        expect(again.event).toMatchObject({ kind: 1, content: "after a reload", pubkey: me, tags: [["nswp:world", site]] });
        expect(afterReload).toMatchObject({ name: "Ada Lovelace", picture: "https://pictures.example/ada.png", about: "Line one line two" });
        // Loading the page again is not a way round the count: three notes a minute, and that was the second.
        // The pass did not use one up: passes are counted apart.
        let more = 0;
        for (let i = 0; i < 4; i++) if ((await ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t === "signed") more++;
        expect(more).toBe(1);
        // Two passes a minute, and the first was made before the page was loaded again.
        expect((await ask({ t: "pass", session: sessionKey })).t).toBe("signed");
        expect((await ask({ t: "pass", session: sessionKey })).t).toBe("refused");
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect((await ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("refused");
        expect((await ask({ t: "pass", session: sessionKey })).t).toBe("refused");
        // What is kept is not the key in the clear, and the site still can't read any of it.
        expect(await page.evaluate(() => (window as any).tryToRead().frame)).toBe("refused: SecurityError");

        // The sign-in address's own list (§SW18) has the site once, as it was last allowed: remembered.
        const listing = await context.newPage();
        await listing.goto(`${origin}/sites/index.html`);
        const row = listing.locator("#sites li[data-site]");
        await row.first().waitFor({ timeout: 30_000 });
        expect(await row.count()).toBe(1);
        // And says who is signed in here, by name and by the whole key.
        await listing.locator("#me-name", { hasText: "Ada Lovelace" }).waitFor({ timeout: 30_000 });
        expect(await listing.locator("#me-key").textContent()).toBe(encodeNpub(me));
        expect(await row.getAttribute("data-site")).toBe(site);
        expect(await row.locator(".connect-site").textContent()).toBe(site);
        expect(await row.textContent()).toContain("Remembered on this device");
        // Its link to the site gives the site no way back to this page.
        expect(await row.locator("a").getAttribute("rel")).toBe("noopener noreferrer");
        // Taken back (docs/take-back.md): a record goes to the relays, sealed, and the line leaves the list.
        expect(await row.locator("button").textContent()).toBe("Take it back");
        await row.locator("button").click();
        await listing.locator("#said", { hasText: "Taken back" }).waitFor({ timeout: 30_000 });
        expect(await listing.locator("#sites li").count()).toBe(0);
        expect(await listing.locator("#empty").isVisible()).toBe(true);
        expect(relays.every((relay) => relay.storedEventKinds().filter((kind) => kind === 30078).length >= 3)).toBe(true);
        // It is not instant, as the page says. This site's signer asked the relays a moment ago, when its page
        // was last loaded, and does not ask again for a day: until then it still signs.
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        await page.waitForTimeout(1500);
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: true });
        await listing.close();

        // Lock: nothing more is signed, and the site is forgotten, across a reload too.
        expect(await ask({ t: "lock" })).toMatchObject({ t: "state", unlocked: false });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await ask({ t: "state" })).toMatchObject({ t: "state", unlocked: false });
        expect((await ask({ t: "sign", event: { kind: 1, content: "after", tags: [] } })).t).toBe("refused");
        // The sign-in address itself is still signed in, with a full session: handing over took nothing from it.
        expect(await account.evaluate(() => window.bitlogin?.activeSession()?.publicKey)).toBe(me);
        expect(errors).toEqual([]);

        // A site allowed and then taken back before its signer has ever asked: the next time its page is loaded,
        // the signer asks, finds the record, and is locked. Nobody signed out at the site.
        const allowAgain = async () => {
          const [again] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
          await again.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
          await again.waitForTimeout(1000);
          await again.locator("#allow").click();
          await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
          if (!again.isClosed()) await again.waitForEvent("close", { timeout: 10_000 }).catch(() => again.close());
        };
        const lockedSoon = () =>
          page.waitForFunction(async () => (await (window as any).ask({ t: "state" })).unlocked === false, null, { timeout: 30_000, polling: 500 });
        await allowAgain();
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: true, remembered: true });
        const takingBack = await context.newPage();
        await takingBack.goto(`${origin}/sites/index.html`);
        await takingBack.locator("#sites li[data-site] button").click();
        await takingBack.locator("#said", { hasText: "Taken back" }).waitFor({ timeout: 30_000 });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        await lockedSoon();
        expect((await ask({ t: "sign", event: { kind: 1, content: "after it was taken back", tags: [] } })).t).toBe("refused");
        // And it stays gone: the grant was removed, not paused.
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: false });
        // The site never learns why, and nothing of the record reaches it.
        expect(JSON.stringify(await page.evaluate(() => (window as any).heard))).not.toMatch(/taken-back|all_before/u);

        // Allowed again afterwards, it is allowed: the record ends what came before it, and nothing after.
        await allowAgain();
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        await page.waitForTimeout(2000);
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: true, remembered: true });

        // "Sign out of every site" ends it too, though this browser's signer for it checked a moment ago: so
        // here it shows only at the sign-in address, where the list is emptied and the record is published.
        await takingBack.reload();
        await takingBack.locator("#sites li[data-site]").first().waitFor({ timeout: 30_000 });
        await takingBack.locator("#all").click();
        await takingBack.locator("#said", { hasText: "Every site is taken back" }).waitFor({ timeout: 30_000 });
        expect(await takingBack.locator("#sites li").count()).toBe(0);
        await takingBack.close();
        expect(await ask({ t: "lock" })).toMatchObject({ unlocked: false });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");

        // With the lock on (§SW12), the window asks for it before anything is handed over, and nothing is kept
        // for the site whatever is ticked: a key at rest in a site's storage is one the lock would not cover.
        await account.bringToFront();
        await widget.locator('[data-action="goto-lock-settings"]').click();
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPin"]').fill("246810");
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPinAgain"]').fill("246810");
        await widget.locator('form[data-form="lock-enable"] button[type="submit"]').click();
        await widget.locator('[data-action="lock-off"]').waitFor({ timeout: 60_000 });
        const [lockedPopup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
        await lockedPopup.locator("#unlock").waitFor({ state: "visible", timeout: 30_000 });
        expect(await lockedPopup.locator("#ask").isVisible()).toBe(false);
        expect(await lockedPopup.locator("#unlock-device").isVisible()).toBe(false);
        await lockedPopup.locator("#unlock-pin").fill("000000");
        await lockedPopup.locator("#unlock-go").click();
        await lockedPopup.locator("#status", { hasText: "4 tries left" }).waitFor({ timeout: 60_000 });
        expect(await lockedPopup.locator("#ask").isVisible()).toBe(false);
        await lockedPopup.locator("#unlock-pin").fill("246810");
        await lockedPopup.locator("#unlock-go").click();
        await lockedPopup.locator("#allow").waitFor({ state: "visible", timeout: 60_000 });
        // No box to tick: with the lock on, nothing is kept for any site, and the window says so.
        expect(await lockedPopup.locator("#remember-row").isVisible()).toBe(false);
        expect(await lockedPopup.locator("#lasts").textContent()).toContain("Your lock is on");
        await lockedPopup.waitForTimeout(1000);
        await lockedPopup.locator("#allow").click();
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me, remembered: false });
        await page.reload();
        await page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: false });

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
    "one Allow covers every site of a family, asked at its second site (site-family.md)",
    async () => {
      // Sites at https addresses under two made-up domains. Nothing is listening at them: the browser's requests
      // for their pages are answered here, so each is a real page of that address with BitLogin's signer in it.
      const sitePage = `<!doctype html><meta charset="utf-8"><title>a site of a family</title><button id="open">Sign in with BitLogin</button>
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
</script>`;
      const ONE = "https://one.worlds-test.example";
      const TWO = "https://two.worlds-test.example";
      const THREE = "https://three.worlds-test.example";
      const FOUR = "https://four.worlds-test.example";
      const ELSEWHERE = "https://one.other-test.example";
      const FAMILY = "https://*.worlds-test.example";
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        await context.route(/^https:\/\/[a-z]+\.(worlds|other)-test\.example\//u, (route) =>
          route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-store" }, body: sitePage })
        );
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

        const errors: string[] = [];
        const visit = async (site: string) => {
          const page = await context.newPage();
          page.on("pageerror", (err) => errors.push(String(err)));
          await page.goto(`${site}/`);
          await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
          const ask = (message: Record<string, unknown>) => page.evaluate((m) => (window as any).ask(m), message) as Promise<Record<string, any>>;
          const window_ = async () => {
            const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
            await popup.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
            // A press sooner than the question could be read is ignored.
            await popup.waitForTimeout(1000);
            return popup;
          };
          const unlocked = () => page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
          return { page, ask, window: window_, unlocked };
        };
        const sessionKey = getPublicKeyHex(generatePrivateKey());

        // The first site of the family: the question is the ordinary one. Nothing says there is a family.
        const one = await visit(ONE);
        expect(await one.ask({ t: "state" })).toMatchObject({ unlocked: false });
        const first = await one.window();
        expect(await first.locator("#site").textContent()).toBe(ONE);
        expect(await first.locator("#family").isVisible()).toBe(false);
        expect(await first.locator("#allow-family").isVisible()).toBe(false);
        expect(await first.locator("#allow").textContent()).toBe("Allow");
        await first.locator("#allow").click();
        await one.unlocked();
        expect(await one.ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me, remembered: true });

        // The second: one site's Allow is not another's. It is asked, and now offered the family, as two buttons.
        const two = await visit(TWO);
        expect(await two.ask({ t: "state" })).toMatchObject({ unlocked: false });
        expect((await two.ask({ t: "sign", event: { kind: 1, content: "not allowed here", tags: [] } })).t).toBe("refused");
        const second = await two.window();
        expect(await second.locator("#site").textContent()).toBe(TWO);
        expect(await second.locator("#family").isVisible()).toBe(true);
        expect(await second.locator("#family-earlier").textContent()).toBe(ONE);
        expect(await second.locator("#family-domain").textContent()).toBe("worlds-test.example");
        expect(await second.locator("#family-lasts").textContent()).toContain("7 days");
        expect(await second.locator("#allow-family").textContent()).toBe("Allow every worlds-test.example site");
        expect(await second.locator("#allow").textContent()).toBe("Just this one");
        // A family is never for one visit: unticking "remember" takes the offer away, and ticking it brings it back.
        await second.locator("#remember").uncheck();
        expect(await second.locator("#allow-family").isVisible()).toBe(false);
        expect(await second.locator("#allow").textContent()).toBe("Allow");
        await second.locator("#remember").check();
        expect(await second.locator("#allow-family").isVisible()).toBe(true);
        await second.locator("#allow-family").click();
        await two.unlocked();
        const twoState = await two.ask({ t: "state" });
        expect(twoState).toMatchObject({ unlocked: true, pubkey: me, remembered: true });
        // Seven days, for a family BitLogin does not know.
        expect(twoState.until - Date.now() / 1000).toBeGreaterThan(6 * 24 * 3600);
        expect(twoState.until - Date.now() / 1000).toBeLessThanOrEqual(7 * 24 * 3600);
        if (!second.isClosed()) await second.waitForEvent("close", { timeout: 10_000 }).catch(() => second.close());

        // A third site of the family, never seen before: signed in with no window and nothing pressed.
        const pagesBefore = context.pages().length;
        const three = await visit(THREE);
        await three.unlocked();
        expect(await three.ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me, remembered: true });
        expect(context.pages().length).toBe(pagesBefore + 1);
        // What it signs is marked with its own address, and its pass is for its own address: not the family's,
        // and not the site the family was allowed from.
        const note = await three.ask({ t: "sign", event: { kind: 1, content: "from a third site", tags: [] } });
        expect(note.event).toMatchObject({ kind: 1, pubkey: me, tags: [["nswp:world", THREE]] });
        const passed = await three.ask({ t: "pass", session: sessionKey });
        expect(passed.t).toBe("signed");
        expect(verifyNostrEvent(passed.event)).toBe(true);
        expect(passed.event.tags.slice(0, 2)).toEqual([["nswp:session", sessionKey], ["nswp:origin", THREE]]);
        // Still only a note, a reaction and a pass: nothing an application would have to be approved for.
        for (const kind of [0, 3, 4, 27235, 27300, 30078]) expect((await three.ask({ t: "sign", event: { kind, content: "{}", tags: [] } })).t, String(kind)).toBe("refused");
        expect((await three.ask({ t: "encrypt", peer: sessionKey, text: "x" })).t).toBe("refused");

        // The counts are the family's. Two passes a minute: the third site made one, the second makes one, and
        // then neither gets another. Three notes a minute, the same way.
        await two.page.reload();
        await two.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect((await two.ask({ t: "pass", session: sessionKey })).t).toBe("signed");
        expect((await two.ask({ t: "pass", session: sessionKey })).t).toBe("refused");
        expect((await two.ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("signed");
        expect((await two.ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("signed");
        expect((await two.ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("refused");
        await three.page.reload();
        await three.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await three.ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me });
        expect((await three.ask({ t: "pass", session: sessionKey })).t).toBe("refused");
        expect((await three.ask({ t: "sign", event: { kind: 7, content: "+", tags: [] } })).t).toBe("refused");

        // A site on another domain is not in the family, whatever it is called.
        const elsewhere = await visit(ELSEWHERE);
        expect(await elsewhere.ask({ t: "state" })).toMatchObject({ unlocked: false });
        expect((await elsewhere.ask({ t: "sign", event: { kind: 1, content: "elsewhere", tags: [] } })).t).toBe("refused");
        await elsewhere.page.close();

        // The sign-in address's list has the family as one row, with the sites it was allowed from.
        const listing = await context.newPage();
        await listing.goto(`${origin}/sites/index.html`);
        const familyRow = listing.locator(`#sites li[data-site="${FAMILY}"]`);
        await familyRow.waitFor({ timeout: 30_000 });
        expect(await familyRow.locator(".connect-site").textContent()).toBe("Every site at worlds-test.example");
        expect(await familyRow.textContent()).toContain(`Allowed from ${TWO}, ${ONE}`);
        expect(await listing.locator("#sites li[data-site]").count()).toBe(2);
        await listing.close();

        // Signing out of one site that the family signed in signs out of the family: the others stop too.
        expect(await three.ask({ t: "lock" })).toMatchObject({ unlocked: false });
        await two.page.reload();
        await two.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await two.ask({ t: "state" })).toMatchObject({ unlocked: false });
        await three.page.reload();
        await three.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await three.ask({ t: "state" })).toMatchObject({ unlocked: false });
        // The first site was allowed by itself, before there was a family. That grant is its own, and stays.
        await one.page.reload();
        await one.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await one.ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me, remembered: true });

        // Asked again at the third site, and this time: just this one. Then no other site of the family is signed
        // in by it, and the question is not put again at the next one.
        const third = await three.window();
        expect(await third.locator("#allow-family").isVisible()).toBe(true);
        await third.locator("#allow").click();
        await three.unlocked();
        const four = await visit(FOUR);
        expect(await four.ask({ t: "state" })).toMatchObject({ unlocked: false });
        const fourth = await four.window();
        expect(await fourth.locator("#family").isVisible()).toBe(false);
        expect(await fourth.locator("#allow-family").isVisible()).toBe(false);
        expect(await fourth.locator("#allow").textContent()).toBe("Allow");
        // "Use a different account" opens the chooser: the accounts kept on this device, and a way to sign in as
        // one that is not. Signing in as another leaves the first kept, and hands nothing to the site.
        await fourth.locator("#switch").click();
        await fourth.locator("#choose").waitFor({ state: "visible", timeout: 30_000 });
        expect(await fourth.locator("#ask").isVisible()).toBe(false);
        expect(await fourth.locator("#accounts .connect-account-row").count()).toBe(1);
        expect(await fourth.locator(`#accounts [data-pubkey="${me}"]`).count()).toBe(1);
        await fourth.locator("#add-account").click();
        await fourth.locator("#signin").waitFor({ state: "visible", timeout: 30_000 });
        expect(await fourth.locator("#choose").isVisible()).toBe(false);
        expect(await fourth.locator("#widget-slot bitlogin-auth").count()).toBe(1);
        // Nobody is signed in at the sign-in address now, and the first account is offered by name to come back to.
        expect(await fourth.evaluate(() => (window as any).bitlogin.readCachedSession())).toBeNull();
        await fourth.locator(`#widget-slot bitlogin-auth [data-continue-as] [data-account="${me}"]`).waitFor({ timeout: 30_000 });
        expect(await four.ask({ t: "state" })).toMatchObject({ unlocked: false });
        // A site allowed as the first account stays allowed as it: what it holds is its own.
        expect(await one.ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: me });
        await fourth.close();
        await two.page.reload();
        await two.page.waitForFunction(() => typeof (window as any).ask === "function");
        expect(await two.ask({ t: "state" })).toMatchObject({ unlocked: false });

        // No site heard the key, in any message.
        for (const site of [one, two, three, four]) expect(JSON.stringify(await site.page.evaluate(() => (window as any).heard))).not.toMatch(/nsec1|"payload"|senderPublicKey/u);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    240_000
  );

  it(
    "several accounts are kept on one device, and switched between with no password (account-switching.md)",
    async () => {
      const sitePage = `<!doctype html><meta charset="utf-8"><title>a site that asks</title><button id="open">Sign in</button><button id="switch">Switch</button>
<iframe id="signer" src="${origin}/signer/index.html" style="width:1px;height:1px;border:0;position:absolute;left:-9px"></iframe>
<script type="module">
  const SIGNIN = "${origin}";
  const frame = document.getElementById("signer");
  window.heard = [];
  addEventListener("message", (e) => window.heard.push({ origin: e.origin, data: e.data }));
  document.getElementById("open").onclick = () => { window.open(SIGNIN + "/connect/index.html", "bitlogin-connect", "popup,width=460,height=660"); };
  document.getElementById("switch").onclick = () => { window.open(SIGNIN + "/connect/index.html#switch", "bitlogin-connect", "popup,width=460,height=660"); };
  window.ask = (message, wait = 2500) => new Promise((done) => {
    const id = "q" + Math.random().toString(36).slice(2, 8);
    const on = (e) => { if (e.source === frame.contentWindow && e.origin === SIGNIN && e.data && e.data.id === id) { removeEventListener("message", on); done(e.data); } };
    addEventListener("message", on);
    frame.contentWindow.postMessage({ nswp: "nswp-signer", v: 1, id, ...message }, SIGNIN);
    setTimeout(() => done({ t: "no answer" }), wait);
  });
</script>`;
      const asking = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(sitePage);
      });
      await new Promise<void>((resolve) => asking.listen(0, "127.0.0.1", () => resolve()));
      const askingAddress = asking.address();
      const site = `http://127.0.0.1:${typeof askingAddress === "object" && askingAddress ? askingAddress.port : 0}`;
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        const account = await context.newPage();
        const cdp = await context.newCDPSession(account);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        await account.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = account.locator("bitlogin-auth");
        const signedInAs = async () => (await account.evaluate(() => window.bitlogin?.activeSession()))?.publicKey ?? null;
        /** A new account, with a new passkey, from the welcome screen. */
        const create = async () => {
          await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
          if ((await widget.locator('[data-action="goto-passkey"]').count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
          await widget.locator('[data-action="goto-passkey"]').click();
          await widget.locator('[data-action="passkey-register"]').click();
          await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
          await widget.locator('[data-action="passkey-new"]').click();
          await completeRecoveryCeremony(widget);
          await widget.locator(".who .pubkey").waitFor({ timeout: 60_000 });
          return (await signedInAs())!;
        };

        // The first account. With one account here, the signed-in view offers to add another.
        const first = await create();
        await widget.locator('[data-action="goto-accounts"]', { hasText: "Add another account" }).waitFor({ timeout: 30_000 });
        const events: string[] = [];
        await account.exposeFunction("noteEvent", (name: string) => void events.push(name));
        await account.evaluate(() => {
          const el = document.querySelector("bitlogin-auth")!;
          el.addEventListener("bitlogin-login", () => (window as any).noteEvent("login"));
          el.addEventListener("bitlogin-logout", () => (window as any).noteEvent("logout"));
        });
        await widget.locator('[data-action="goto-accounts"]').click();
        expect(await widget.locator(".account-row").count()).toBe(1);
        await widget.locator('[data-action="account-add"]').click();
        // Nobody is signed in, the host was told, and the first account is still kept: it is offered by name.
        await widget.locator("[data-continue-as] .account-row").waitFor({ timeout: 30_000 });
        expect(await signedInAs()).toBeNull();
        expect(await account.evaluate(() => (window as any).bitlogin.readCachedSession())).toBeNull();
        expect(events).toEqual(["logout"]);
        expect(await widget.locator(`[data-continue-as] [data-account="${first}"]`).count()).toBe(1);

        // The second account, made the ordinary way. Both are kept now.
        const second = await create();
        expect(second).not.toBe(first);
        await widget.locator('[data-action="goto-accounts"]', { hasText: "Switch account" }).waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="goto-accounts"]').click();
        expect(await widget.locator(".account-row").count()).toBe(2);
        expect(await widget.locator(`.account-row.current[data-account="${second}"]`).count()).toBe(1);

        // Switch back to the first: one press, nothing typed, no passkey asked for.
        events.length = 0;
        await widget.locator(`button.account-row[data-account="${first}"]`).click();
        await widget.locator(".who .pubkey", { hasText: encodeNpub(first) }).waitFor({ timeout: 30_000 });
        expect(await signedInAs()).toBe(first);
        expect(events).toEqual(["logout", "login"]);
        expect((await account.evaluate(() => (window as any).bitlogin.readCachedSession())).pubkey).toBe(first);
        // It signs as the account it says it is.
        const signed = await account.evaluate(() => (window as any).nostr.signEvent({ kind: 1, created_at: 1, tags: [], content: "as the first" }));
        expect(signed.pubkey).toBe(first);
        expect(verifyNostrEvent(signed)).toBe(true);
        // Loaded again, it is still the one last switched to, and both are still kept.
        await account.reload({ waitUntil: "domcontentloaded" });
        await widget.locator(".who .pubkey", { hasText: encodeNpub(first) }).waitFor({ timeout: 30_000 });
        // Nothing kept for either is the key in the clear.
        const stored = await account.evaluate(async () => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const open = indexedDB.open("bitlogin");
            open.onsuccess = () => resolve(open.result);
            open.onerror = () => reject(open.error);
          });
          const out: string[] = [];
          for (const name of Array.from(db.objectStoreNames)) {
            const all = await new Promise<unknown[]>((resolve) => {
              const req = db.transaction(name).objectStore(name).getAll();
              req.onsuccess = () => resolve(req.result);
              req.onerror = () => resolve([]);
            });
            out.push(JSON.stringify(all.map((v) => (typeof v === "string" ? v : String(v)))));
          }
          return out.join("");
        });
        expect(stored).not.toMatch(/everydayPrivateKeyHex|nsec1/u);

        // A site asks, for the first time, with two accounts kept here: the window asks which, and assumes neither.
        const page = await context.newPage();
        await page.goto(`${site}/`);
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
        const ask = (message: Record<string, unknown>) => page.evaluate((m) => (window as any).ask(m), message) as Promise<Record<string, any>>;
        const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
        await popup.locator("#choose").waitFor({ state: "visible", timeout: 30_000 });
        expect(await popup.locator("#ask").isVisible()).toBe(false);
        expect(await popup.locator("#choose-site").textContent()).toBe(site);
        expect(await popup.locator("#accounts .connect-account-row").count()).toBe(2);
        // The site has been told nothing.
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: false });
        await popup.locator(`#accounts [data-pubkey="${second}"]`).click();
        await popup.locator("#ask").waitFor({ state: "visible", timeout: 30_000 });
        expect(await popup.locator("#who-key").textContent()).toBe(encodeNpub(second));
        await popup.waitForTimeout(1000);
        await popup.locator("#allow").click();
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
        expect(await ask({ t: "state" })).toMatchObject({ unlocked: true, pubkey: second });
        if (!popup.isClosed()) await popup.waitForEvent("close", { timeout: 10_000 }).catch(() => popup.close());

        // The site's own "switch account": the window opens at the chooser, and the site is then the other one.
        const [switching] = await Promise.all([context.waitForEvent("page"), page.click("#switch")]);
        await switching.locator("#choose").waitFor({ state: "visible", timeout: 30_000 });
        await switching.locator(`#accounts [data-pubkey="${first}"]`).click();
        await switching.locator("#ask").waitFor({ state: "visible", timeout: 30_000 });
        expect(await switching.locator("#who-key").textContent()).toBe(encodeNpub(first));
        await switching.waitForTimeout(1000);
        await switching.locator("#allow").click();
        await page.waitForFunction((pk) => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.pubkey === pk), first, { timeout: 30_000 });
        const note = await ask({ t: "sign", event: { kind: 1, content: "as the first, at a site", tags: [] } });
        expect(note.event.pubkey).toBe(first);
        if (!switching.isClosed()) await switching.waitForEvent("close", { timeout: 10_000 }).catch(() => switching.close());

        // The lock covers every account kept here. Turned on as one, it seals the other too: after "Lock now",
        // switching to the other asks for the PIN, and then opens it.
        await account.reload({ waitUntil: "domcontentloaded" });
        await widget.locator(".who .pubkey", { hasText: encodeNpub(first) }).waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="goto-lock-settings"]').click();
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPin"]').fill("246810");
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPinAgain"]').fill("246810");
        await widget.locator('form[data-form="lock-enable"] button[type="submit"]').click();
        await widget.locator('[data-action="lock-off"]').waitFor({ timeout: 60_000 });
        await widget.locator('[data-action="goto-dashboard"]').click();
        await widget.locator('[data-action="lock-now"]').click();
        await widget.locator('form[data-form="lock-open"]').waitFor({ timeout: 30_000 });
        expect(await signedInAs()).toBeNull();
        await widget.locator('form[data-form="lock-open"] input[name="lockPin"]').fill("246810");
        await widget.locator('form[data-form="lock-open"] button[type="submit"]').click();
        await widget.locator(".who .pubkey", { hasText: encodeNpub(first) }).waitFor({ timeout: 60_000 });
        await widget.locator('[data-action="goto-accounts"]').click();
        await widget.locator(`button.account-row[data-account="${second}"]`).click();
        await widget.locator(".who .pubkey", { hasText: encodeNpub(second) }).waitFor({ timeout: 30_000 });
        expect(await signedInAs()).toBe(second);

        // Log out forgets the account that is signed in, on this device, and leaves the other: it is offered.
        await widget.locator('[data-action="logout"]').click();
        await widget.locator("[data-continue-as] .account-row").waitFor({ timeout: 30_000 });
        expect(await widget.locator("[data-continue-as] .account-row").count()).toBe(1);
        expect(await widget.locator(`[data-continue-as] [data-account="${first}"]`).count()).toBe(1);
        await widget.locator(`[data-continue-as] [data-account="${first}"]`).click();
        await widget.locator(".who .pubkey", { hasText: encodeNpub(first) }).waitFor({ timeout: 60_000 });
        expect(await signedInAs()).toBe(first);
        // The last one logged out of leaves nothing kept.
        await widget.locator('[data-action="logout"]').click();
        await widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        await account.waitForTimeout(500);
        expect(await widget.locator("[data-continue-as]").count()).toBe(0);
        await account.reload({ waitUntil: "domcontentloaded" });
        await widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        expect(await widget.locator("[data-continue-as]").count()).toBe(0);
        expect(await signedInAs()).toBeNull();
      } finally {
        await browser.close();
        asking.close();
      }
    },
    300_000
  );

  it(
    "the embedded signer loads itself again, once, when one of its files fails to arrive",
    async () => {
      const asking = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a site that asks</title>
<iframe id="signer" src="${origin}/signer/index.html"></iframe>
<script>window.heard = []; addEventListener("message", (e) => window.heard.push({ origin: e.origin, data: e.data }));</script>`);
      });
      await new Promise<void>((resolve) => asking.listen(0, "127.0.0.1", () => resolve()));
      const askingAddress = asking.address();
      const site = `http://127.0.0.1:${typeof askingAddress === "object" && askingAddress ? askingAddress.port : 0}`;
      const browser = await playwright!.chromium.launch();
      try {
        // What a deploy can do to a page caught in the middle of it: the signer's file is not there the first time.
        const context = await browser.newContext();
        let asked = 0;
        await context.route("**/vendor/bitlogin/bitlogin-signer.js", (route) => (++asked === 1 ? route.abort() : route.continue()));
        const page = await context.newPage();
        await page.goto(`${site}/`);
        await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
        expect(asked).toBe(2);
        expect(page.frames().find((f) => f.url().startsWith(`${origin}/signer/`))!.url()).toContain("again=1");
        await context.close();

        // A file that never arrives: it tries once more and then stops. It does not load itself for ever.
        const broken = await browser.newContext();
        let tries = 0;
        await broken.route("**/vendor/bitlogin/bitlogin-signer.js", (route) => {
          tries++;
          return route.abort();
        });
        const silent = await broken.newPage();
        await silent.goto(`${site}/`);
        await silent.waitForTimeout(3000);
        expect(tries).toBe(2);
        expect(await silent.evaluate(() => (window as any).heard.length)).toBe(0);
      } finally {
        await browser.close();
        asking.close();
      }
    },
    120_000
  );

  it(
    "a file saved from Export identity is taken back in by \"Restore from an export file\"",
    async () => {
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext({ acceptDownloads: true });
        const account = await context.newPage();
        const cdp = await context.newCDPSession(account);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        await account.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = account.locator("bitlogin-auth");
        await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="toggle-more"]').click();
        // The way back in is offered beside the other ways to sign in.
        expect(await widget.locator('[data-action="goto-restore-file"]').count()).toBe(1);
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-register"]').click();
        await widget.locator('[data-action="passkey-new"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="passkey-new"]').click();
        await completeRecoveryCeremony(widget);
        await widget.locator(".who .pubkey").waitFor({ timeout: 60_000 });
        const me = (await account.evaluate(() => window.bitlogin?.activeSession()))!.publicKey;

        // Both files, saved the ordinary way from Export identity.
        await widget.locator('[data-action="goto-export"]').first().click();
        const [exportDownload] = await Promise.all([account.waitForEvent("download"), widget.locator('[data-action="download-recovery-export"]').click()]);
        expect(exportDownload.suggestedFilename()).toBe("bitlogin-recovery-export.json");
        const exportPath = await exportDownload.path();
        await widget.locator('[data-action="reveal-nsec"]').click();
        await widget.locator('[data-action="download-key-backup"]').waitFor({ timeout: 30_000 });
        const [keyDownload] = await Promise.all([account.waitForEvent("download"), widget.locator('[data-action="download-key-backup"]').click()]);
        expect(keyDownload.suggestedFilename()).toBe("bitlogin-private-key.txt");
        const keyPath = await keyDownload.path();
        // The screen says how each is brought back.
        expect(await widget.evaluate((el) => el.shadowRoot!.textContent)).toContain("Restore from an export file");

        await widget.locator('[data-action="goto-dashboard"]').click();
        await widget.locator('[data-action="logout"]').click();
        await widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        const openRestore = async () => {
          if ((await widget.locator('[data-action="goto-restore-file"]').count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
          await widget.locator('[data-action="goto-restore-file"]').click();
          await widget.locator('input[name="restoreFile"]').waitFor({ timeout: 30_000 });
        };

        // The recovery export: it is read, and the recovery phrase is asked for, with the file already loaded.
        await openRestore();
        await widget.locator('input[name="restoreFile"]').setInputFiles(exportPath);
        await widget.locator('form[data-form="recover-phrase"]').waitFor({ timeout: 30_000 });
        expect(await widget.locator(".notice.info").textContent()).toContain("Loaded recovery export");
        // The file alone restores nothing: nobody is signed in.
        expect(await account.evaluate(() => window.bitlogin?.activeSession() ?? null)).toBeNull();

        // The key file: the identity it holds is shown, and it is the account's own, before anything is made.
        await widget.locator('[data-action="goto-welcome"]').first().click();
        await openRestore();
        await widget.locator('input[name="restoreFile"]').setInputFiles(keyPath);
        await widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
        expect((await widget.locator(".credential-box").textContent())?.trim()).toBe(encodeNpub(me));
        // The key itself is not put on the page.
        expect(await widget.evaluate((el) => el.shadowRoot!.innerHTML)).not.toMatch(/nsec1[a-z0-9]{20,}/u);
        expect(await account.evaluate(() => window.bitlogin?.activeSession() ?? null)).toBeNull();

        // A file that is neither is refused, in words, and nothing happens.
        await widget.locator('[data-action="goto-welcome"]').first().click();
        await openRestore();
        await widget.locator('input[name="restoreFile"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("shopping list") });
        await widget.locator(".notice.error", { hasText: "not a file BitLogin" }).waitFor({ timeout: 30_000 });
        expect(await widget.locator('input[name="restoreFile"]').count()).toBe(1);
      } finally {
        await browser.close();
      }
    },
    180_000
  );

  it(
    "every way in and every way back: a created account and an imported key, restored by password, phrase, key and file",
    async () => {
      const browser = await playwright!.chromium.launch();
      const tag = getPublicKeyHex(generatePrivateKey()).slice(0, 6);
      /** A device that has never seen the account: its own storage, nothing kept. */
      const device = async () => {
        const context = await browser.newContext({ acceptDownloads: true });
        const page = await context.newPage();
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = page.locator("bitlogin-auth");
        await widget.locator('[data-action="toggle-more"]').waitFor({ timeout: 30_000 });
        const more = async (action: string) => {
          if ((await widget.locator(`[data-action="${action}"]`).count()) === 0) await widget.locator('[data-action="toggle-more"]').click();
          await widget.locator(`[data-action="${action}"]`).click();
        };
        const who = async () => (await page.evaluate(() => window.bitlogin?.activeSession() ?? null))?.publicKey ?? null;
        const signedIn = async () => {
          await widget.locator(".who .pubkey").waitFor({ timeout: 90_000 });
          return (await who())!;
        };
        const error = () => widget.locator(".notice.error").first();
        let lastError = "";
        /** The name, the generated password, and the rest of setting an account up. For an imported key, the key step too. */
        const setUp = async (name: string, imported: boolean) => {
          await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(name);
          await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
          await widget.locator("#credential-box").waitFor({ timeout: 30_000 });
          const password = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          await widget.locator("#saved-check").check();
          await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
          const phrase = (await completeRecoveryCeremony(widget)).join(" ");
          if (imported) {
            await widget.locator("#key-saved-check").waitFor({ timeout: 60_000 });
            await widget.locator("#key-saved-check").check();
            await widget.locator('form[data-form="save-key"] button[type="submit"]').click();
          }
          return { name, password, phrase, pubkey: await signedIn() };
        };
        const create = async (name: string) => {
          await widget.locator('[data-action="goto-create"]').click();
          return setUp(name, false);
        };
        const importKey = async (key: string, name: string) => {
          await more("goto-import");
          await widget.locator('form[data-form="import-key"] input[name="importKey"]').fill(key);
          await widget.locator('form[data-form="import-key"] button[type="submit"]').click();
          await widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
          const shown = ((await widget.locator(".credential-box").textContent()) ?? "").trim();
          await widget.locator('[data-action="import-continue"]').click();
          return { shown, ...(await setUp(name, true)) };
        };
        const login = async (name: string, password: string) => {
          await widget.locator('[data-action="goto-login"]').click();
          await widget.locator('form[data-form="login"] input[name="loginName"]').fill(name);
          await widget.locator('form[data-form="login"] input[name="password"]').fill(password);
          await widget.locator('form[data-form="login"] button[type="submit"]').click();
        };
        /** Enter the phrase, with the recovery export where one is given. Says which step came next. */
        const recover = async (phrase: string, exportPath?: string): Promise<"found" | "rebuild" | "error"> => {
          await more("goto-recover");
          await widget.locator('form[data-form="recover-phrase"] input[name="phrase"]').fill(phrase);
          if (exportPath) {
            await widget.locator('input[name="offlineExportFile"]').setInputFiles(exportPath);
            await widget.locator(".notice.info", { hasText: "Loaded recovery export" }).waitFor({ timeout: 30_000 });
            await widget.locator('form[data-form="recover-phrase"] input[name="phrase"]').fill(phrase);
          }
          await widget.locator('form[data-form="recover-phrase"] button[type="submit"]').click();
          const next = await Promise.race([
            widget.locator('form[data-form="recover-new-credentials"]').waitFor({ timeout: 90_000 }).then(() => "found" as const),
            widget.locator('[data-action="rebuild-confirm"]').waitFor({ timeout: 90_000 }).then(() => "rebuild" as const),
            error().waitFor({ timeout: 90_000 }).then(() => "error" as const)
          ]);
          if (next === "error") lastError = ((await error().textContent()) ?? "").trim();
          return next;
        };
        /** After the phrase was accepted: a new login name, the new generated password, and in. */
        const finishRecovery = async (name: string) => {
          await widget.locator('form[data-form="recover-new-credentials"] input[name="newLoginName"]').fill(name);
          const password = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          await widget.locator('form[data-form="recover-new-credentials"] button[type="submit"]').click();
          return { name, password, pubkey: await signedIn() };
        };
        /** Both files from Export identity, and the key as it is shown. */
        const exportAll = async () => {
          await widget.locator('[data-action="goto-export"]').first().click();
          const [exportDownload] = await Promise.all([page.waitForEvent("download"), widget.locator('[data-action="download-recovery-export"]').click()]);
          await widget.locator('[data-action="reveal-nsec"]').click();
          await widget.locator('[data-action="download-key-backup"]').waitFor({ timeout: 30_000 });
          const nsec = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          const [keyDownload] = await Promise.all([page.waitForEvent("download"), widget.locator('[data-action="download-key-backup"]').click()]);
          // Kept past this device's life: a browser's own copy of a download goes when its context is closed.
          const kept = mkdtempSync(join(saved, "files-"));
          const files = { exportPath: join(kept, exportDownload.suggestedFilename()), keyPath: join(kept, keyDownload.suggestedFilename()), nsec };
          await exportDownload.saveAs(files.exportPath);
          await keyDownload.saveAs(files.keyPath);
          await widget.locator('[data-action="goto-dashboard"]').click();
          return files;
        };
        const restoreFile = async (path: string) => {
          await more("goto-restore-file");
          await widget.locator('input[name="restoreFile"]').setInputFiles(path);
        };
        /** It signs as who it says it is: the last word on whether an account really came back. */
        const signs = async () => {
          const event = await page.evaluate(() => (window as any).nostr.signEvent({ kind: 1, created_at: 1, tags: [], content: "back" }));
          return verifyNostrEvent(event) ? (event.pubkey as string) : null;
        };
        return { context, page, widget, more, who, signedIn, error, said: () => lastError, create, importKey, login, recover, finishRecovery, exportAll, restoreFile, signs, close: () => context.close() };
      };
      const dropEverything = () => relays.forEach((relay) => relay.wipeAllData());
      const saved = mkdtempSync(join(tmpdir(), "bitlogin-restore-"));

      try {
        // ================= An account BitLogin made: a login name and a generated password. =================
        const first = await device();
        const made = await first.create(`made${tag}`);
        expect(made.password.length).toBeGreaterThan(20);
        expect(made.phrase.split(" ")).toHaveLength(12);
        expect(await first.signs()).toBe(made.pubkey);
        const madeFiles = await first.exportAll();
        expect(madeFiles.nsec).toMatch(/^nsec1[a-z0-9]{58}$/u);
        await first.close();

        // 1. Another device, the login name and password.
        let d = await device();
        await d.login(made.name, made.password);
        expect(await d.signedIn()).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();

        // A wrong password signs nobody in, and says so. So does a name nobody has.
        d = await device();
        await d.login(made.name, `${made.password}x`);
        await d.error().waitFor({ timeout: 90_000 });
        expect(await d.who()).toBeNull();
        await d.close();

        // 2. The key itself, pasted under "Import a Nostr key", is the same identity under a new login.
        d = await device();
        const rewrapped = await d.importKey(madeFiles.nsec, `rewrap${tag}`);
        expect(rewrapped.shown).toBe(encodeNpub(made.pubkey));
        expect(rewrapped.pubkey).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();

        // 3. The recovery phrase, while relays still hold the account. Written carelessly: capitals and extra spaces.
        d = await device();
        const careless = await d.recover(`  ${made.phrase.toUpperCase().replace(/ /gu, "   ")} `);
        expect(careless === "error" ? d.said() : careless).toBe("found");
        const recovered = await d.finishRecovery(`recov${tag}`);
        expect(recovered.pubkey).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();
        // The new login it set works on another device.
        d = await device();
        await d.login(recovered.name, recovered.password);
        expect(await d.signedIn()).toBe(made.pubkey);
        await d.close();

        // A phrase that is not one is refused; so is a real one that belongs to nobody (it would only rebuild).
        d = await device();
        expect(await d.recover("these are not twelve words from the list at all sorry no")).toBe("error");
        expect(await d.who()).toBeNull();
        await d.close();

        // 4. Every relay drops everything. The phrase and the recovery export file bring the whole account back.
        dropEverything();
        d = await device();
        expect(await d.recover(made.phrase, madeFiles.exportPath)).toBe("found");
        const fromFile = await d.finishRecovery(`file${tag}`);
        expect(fromFile.pubkey).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();

        // The same, through "Restore from an export file": the file first, then the phrase.
        dropEverything();
        d = await device();
        await d.restoreFile(madeFiles.exportPath);
        await d.widget.locator('form[data-form="recover-phrase"]').waitFor({ timeout: 30_000 });
        expect(await d.widget.locator(".notice.info").textContent()).toContain("Loaded recovery export");
        await d.widget.locator('form[data-form="recover-phrase"] input[name="phrase"]').fill(made.phrase);
        await d.widget.locator('form[data-form="recover-phrase"] button[type="submit"]').click();
        await d.widget.locator('form[data-form="recover-new-credentials"]').waitFor({ timeout: 90_000 });
        expect((await d.finishRecovery(`file2${tag}`)).pubkey).toBe(made.pubkey);
        await d.close();

        // The export file with somebody else's phrase restores nothing.
        dropEverything();
        d = await device();
        const strangerDevice = await device();
        const stranger = await strangerDevice.create(`other${tag}`);
        await strangerDevice.close();
        dropEverything();
        const wrongPhrase = await d.recover(stranger.phrase, madeFiles.exportPath);
        expect(wrongPhrase).not.toBe("found");
        expect(await d.who()).toBeNull();
        await d.close();

        // 5. Every relay drops everything, and there is no file. The phrase alone rebuilds the identity it made.
        dropEverything();
        d = await device();
        expect(await d.recover(made.phrase)).toBe("rebuild");
        expect(((await d.widget.locator(".credential-box").textContent()) ?? "").trim()).toBe(encodeNpub(made.pubkey));
        await d.widget.locator('[data-action="rebuild-confirm"]').click();
        await d.widget.locator('form[data-form="recover-new-credentials"]').waitFor({ timeout: 90_000 });
        const rebuilt = await d.finishRecovery(`rebuilt${tag}`);
        expect(rebuilt.pubkey).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();
        // And what it rebuilt is an account again: signed in to by name and password on another device.
        d = await device();
        await d.login(rebuilt.name, rebuilt.password);
        expect(await d.signedIn()).toBe(made.pubkey);
        await d.close();

        // 6. The key file, through "Restore from an export file", with every relay empty.
        dropEverything();
        d = await device();
        await d.restoreFile(madeFiles.keyPath);
        await d.widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
        expect(((await d.widget.locator(".credential-box").textContent()) ?? "").trim()).toBe(encodeNpub(made.pubkey));
        await d.widget.locator('[data-action="import-continue"]').click();
        const fromKeyFile = await d.widget.locator('form[data-form="create-name"]').waitFor({ timeout: 30_000 }).then(async () => {
          await d.widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(`keyfile${tag}`);
          await d.widget.locator('form[data-form="create-name"] button[type="submit"]').click();
          await d.widget.locator("#credential-box").waitFor({ timeout: 30_000 });
          await d.widget.locator("#saved-check").check();
          await d.widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
          await completeRecoveryCeremony(d.widget);
          await d.widget.locator("#key-saved-check").waitFor({ timeout: 60_000 });
          await d.widget.locator("#key-saved-check").check();
          await d.widget.locator('form[data-form="save-key"] button[type="submit"]').click();
          return d.signedIn();
        });
        expect(fromKeyFile).toBe(made.pubkey);
        expect(await d.signs()).toBe(made.pubkey);
        await d.close();

        // ================= A key from outside, imported and wrapped. =================
        dropEverything();
        const outside = generatePrivateKey();
        const outsidePub = getPublicKeyHex(outside);
        const second = await device();
        const wrapped = await second.importKey(encodeNsec(outside), `wrap${tag}`);
        expect(wrapped.shown).toBe(encodeNpub(outsidePub));
        expect(wrapped.pubkey).toBe(outsidePub);
        expect(await second.signs()).toBe(outsidePub);
        const wrappedFiles = await second.exportAll();
        // What Export identity shows is the key that was imported, unchanged.
        expect(wrappedFiles.nsec).toBe(encodeNsec(outside));
        await second.close();

        // The same key as 64 hex characters is the same identity.
        d = await device();
        await d.more("goto-import");
        await d.widget.locator('form[data-form="import-key"] input[name="importKey"]').fill(Array.from(outside, (b) => b.toString(16).padStart(2, "0")).join(""));
        await d.widget.locator('form[data-form="import-key"] button[type="submit"]').click();
        await d.widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
        expect(((await d.widget.locator(".credential-box").textContent()) ?? "").trim()).toBe(encodeNpub(outsidePub));
        await d.close();
        // Something that is no key is refused.
        d = await device();
        await d.more("goto-import");
        await d.widget.locator('form[data-form="import-key"] input[name="importKey"]').fill("nsec1notakeyatall");
        await d.widget.locator('form[data-form="import-key"] button[type="submit"]').click();
        await d.error().waitFor({ timeout: 30_000 });
        expect(await d.widget.locator('[data-action="import-continue"]').count()).toBe(0);
        await d.close();

        // 1. Another device, its login name and password.
        d = await device();
        await d.login(wrapped.name, wrapped.password);
        expect(await d.signedIn()).toBe(outsidePub);
        expect(await d.signs()).toBe(outsidePub);
        await d.close();

        // 2. Its recovery phrase, while relays hold the account: the imported key comes back, not a new one.
        d = await device();
        expect(await d.recover(wrapped.phrase)).toBe("found");
        expect((await d.finishRecovery(`wraprec${tag}`)).pubkey).toBe(outsidePub);
        expect(await d.signs()).toBe(outsidePub);
        await d.close();

        // 3. Every relay drops everything. The phrase alone cannot bring an imported key back, and does not
        //    pretend to: what it offers to rebuild is a different identity, shown, with a warning. Not taken.
        dropEverything();
        d = await device();
        expect(await d.recover(wrapped.phrase)).toBe("rebuild");
        const offered = ((await d.widget.locator(".credential-box").textContent()) ?? "").trim();
        expect(offered).toMatch(/^npub1/u);
        expect(offered).not.toBe(encodeNpub(outsidePub));
        expect(await d.widget.locator(".notice.warn", { hasText: "Only continue if this is your npub" }).count()).toBe(1);
        expect(await d.who()).toBeNull();
        await d.close();

        // 4. Still nothing on any relay: the phrase with the recovery export file brings the imported key back.
        d = await device();
        expect(await d.recover(wrapped.phrase, wrappedFiles.exportPath)).toBe("found");
        expect((await d.finishRecovery(`wrapfile${tag}`)).pubkey).toBe(outsidePub);
        expect(await d.signs()).toBe(outsidePub);
        await d.close();

        // 5. The key file, through "Restore from an export file", wraps the same identity again.
        dropEverything();
        d = await device();
        await d.restoreFile(wrappedFiles.keyPath);
        await d.widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
        expect(((await d.widget.locator(".credential-box").textContent()) ?? "").trim()).toBe(encodeNpub(outsidePub));
        await d.close();

        // 6. A passkey, with "I already have a Nostr key": the same identity behind a passkey.
        dropEverything();
        d = await device();
        const cdp = await d.context.newCDPSession(d.page);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        await d.more("goto-passkey");
        await d.widget.locator('[data-action="passkey-register"]').click();
        await d.widget.locator('[data-action="passkey-import"]').waitFor({ timeout: 30_000 });
        await d.widget.locator('[data-action="passkey-import"]').click();
        await d.widget.locator('form[data-form="import-key"] input[name="importKey"]').fill(encodeNsec(outside));
        await d.widget.locator('form[data-form="import-key"] button[type="submit"]').click();
        await d.widget.locator('[data-action="import-continue"]').waitFor({ timeout: 30_000 });
        await d.widget.locator('[data-action="import-continue"]').click();
        await completeRecoveryCeremony(d.widget);
        await d.widget.locator("#key-saved-check").waitFor({ timeout: 60_000 });
        await d.widget.locator("#key-saved-check").check();
        await d.widget.locator('form[data-form="save-key"] button[type="submit"]').click();
        expect(await d.signedIn()).toBe(outsidePub);
        expect(await d.signs()).toBe(outsidePub);
        // Signed out and back in with the passkey alone.
        await d.widget.locator('[data-action="logout"]').click();
        await d.widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        await d.more("goto-passkey");
        await d.widget.locator('[data-action="passkey-auth"]').click();
        expect(await d.signedIn()).toBe(outsidePub);
        await d.close();
      } finally {
        await browser.close();
        rmSync(saved, { recursive: true, force: true });
      }
    },
    900_000
  );

  it(
    "a site that asks for more than it may have is told so at once, and so is the user in the window",
    async () => {
      const sitePage = `<!doctype html><meta charset="utf-8"><title>a site that asks for a lot</title><button id="open">Sign in</button>
<iframe id="signer" src="${origin}/signer/index.html" style="width:1px;height:1px;border:0;position:absolute;left:-9px"></iframe>
<script type="module">
  const SIGNIN = "${origin}";
  const frame = document.getElementById("signer");
  window.heard = [];
  addEventListener("message", (e) => window.heard.push({ origin: e.origin, data: e.data }));
  document.getElementById("open").onclick = () => { window.open(SIGNIN + "/connect/index.html", "bitlogin-connect", "popup,width=460,height=660"); };
  window.ask = (message, wait = 2500) => new Promise((done) => {
    const id = "q" + Math.random().toString(36).slice(2, 8);
    const on = (e) => { if (e.source === frame.contentWindow && e.origin === SIGNIN && e.data && e.data.id === id) { removeEventListener("message", on); done(e.data); } };
    addEventListener("message", on);
    frame.contentWindow.postMessage({ nswp: "nswp-signer", v: 1, id, ...message }, SIGNIN);
    setTimeout(() => done({ t: "no answer" }), wait);
  });
</script>`;
      // One site at a public address, answered here; one at a local address, served here.
      const PUBLIC = "https://app.asks-test.example";
      const asking = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(sitePage);
      });
      await new Promise<void>((resolve) => asking.listen(0, "127.0.0.1", () => resolve()));
      const askingAddress = asking.address();
      const LOCAL = `http://127.0.0.1:${typeof askingAddress === "object" && askingAddress ? askingAddress.port : 0}`;
      // A pass, a terminal and a world grant: kinds kept, at BitLogin's real address, for one named site.
      const lots = { name: "Asks A Lot", sign: [1, 27300, 27302, 27303] };
      const plain = { name: "Asks A Little", sign: [1, 7] };
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        await context.route(`${PUBLIC}/`, (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: sitePage }));
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
        await widget.locator(".who .pubkey").waitFor({ timeout: 60_000 });
        const me = (await account.evaluate(() => window.bitlogin?.activeSession()))!.publicKey;

        const visit = async (site: string) => {
          const page = await context.newPage();
          await page.goto(`${site}/`);
          await page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "ready"), null, { timeout: 30_000 });
          const ask = (message: Record<string, unknown>) => page.evaluate((m) => (window as any).ask(m), message) as Promise<Record<string, any>>;
          const open = async () => {
            const [popup] = await Promise.all([context.waitForEvent("page"), page.click("#open")]);
            return popup;
          };
          return { page, ask, open };
        };

        // At a public address: the kinds are not this site's to ask for. It is told so in the answer to `want`,
        // before any window. A set it may have is taken.
        const pub = await visit(PUBLIC);
        expect(await pub.ask({ t: "want", permissions: plain })).toMatchObject({ t: "state", unlocked: false, taken: true });
        expect(await pub.ask({ t: "want", permissions: lots })).toMatchObject({ t: "state", unlocked: false, taken: false });
        // A plain question about state says nothing of it.
        expect("taken" in (await pub.ask({ t: "state" }))).toBe(false);
        // The window shows the plain question, and says in words that more was asked and will not be given.
        const turned = await pub.open();
        await turned.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
        expect(await turned.locator("#ask").isVisible()).toBe(true);
        expect(await turned.locator("#ask-app").isVisible()).toBe(false);
        expect(await turned.locator("#turned-down").isVisible()).toBe(true);
        expect(await turned.locator("#turned-down").textContent()).toContain("asked for more than it may have");
        await turned.waitForTimeout(1000);
        await turned.locator("#allow").click();
        await pub.page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
        // What it got is the plain grant: a note, and none of what it asked for.
        const got = await pub.ask({ t: "state" });
        expect(got).toMatchObject({ unlocked: true, pubkey: me });
        expect(got.permissions).toBeUndefined();
        expect((await pub.ask({ t: "sign", event: { kind: 1, content: "a note", tags: [] } })).t).toBe("signed");
        for (const kind of [27300, 27302, 27303]) expect((await pub.ask({ t: "sign", event: { kind, content: "", tags: [] } })).t, String(kind)).toBe("refused");

        // A site that asked for nothing more is shown no such line.
        if (!turned.isClosed()) await turned.waitForEvent("close", { timeout: 10_000 }).catch(() => turned.close());
        await pub.ask({ t: "lock" });
        await pub.page.reload();
        await pub.page.waitForFunction(() => typeof (window as any).ask === "function");
        const plainWindow = await pub.open();
        await plainWindow.locator("#allow").waitFor({ state: "visible", timeout: 30_000 });
        expect(await plainWindow.locator("#turned-down").isVisible()).toBe(false);
        await plainWindow.close();

        // At a local address, with BitLogin itself a local copy (as it is in this test): the same set is taken,
        // shown in full as an application's, and the window says why it may be asked for here.
        const local = await visit(LOCAL);
        expect(await local.ask({ t: "want", permissions: lots })).toMatchObject({ t: "state", taken: true });
        const dev = await local.open();
        await dev.locator("#allow-app").waitFor({ state: "visible", timeout: 30_000 });
        expect(await dev.locator("#ask").isVisible()).toBe(false);
        expect(await dev.locator("#app-local").isVisible()).toBe(true);
        expect(await dev.locator("#app-local").textContent()).toContain("local copy of BitLogin");
        // The three are listed among what deserves a second look.
        expect(await dev.locator("#app-sensitive li").count()).toBe(3);
        await dev.waitForTimeout(1000);
        await dev.locator("#allow-app").click();
        await local.page.waitForFunction(() => (window as any).heard.some((m: any) => m.data?.t === "state" && m.data.unlocked), null, { timeout: 30_000 });
        const pass = await local.ask({ t: "sign", event: { kind: 27300, content: "", tags: [["nswp:session", "b".repeat(64)], ["nswp:origin", LOCAL], ["expiration", "9999999999"]] } });
        expect(pass.t).toBe("signed");
        expect(pass.event).toMatchObject({ kind: 27300, pubkey: me });
        expect(verifyNostrEvent(pass.event)).toBe(true);
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
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false, canAsk: true });
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
        // An application BitLogin does not know is remembered for seven days, unless they untick it.
        expect(await popup.locator("#remember-app").isChecked()).toBe(true);
        expect(await popup.locator("#app-lasts").textContent()).toContain("7 days");
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

        // In the background, at an application's pace: forty proofs in a row, where a world gets three a minute.
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
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false, needsMore: true, canAsk: true });
        expect((await sign({ kind: 3, content: "", tags: [] })).ok).toBe(false);

        // Nothing the application heard was a key.
        expect(JSON.stringify(await page.evaluate(() => (window as any).heard))).not.toMatch(/nsec1|"payload"|senderPublicKey/u);

        // Signing out of the application ends it, across a reload too.
        await page.goto(`${site}/`);
        await page.evaluate(() => (window as any).isReady);
        expect((await attempt("signOut")).ok).toBe(true);
        await page.reload();
        expect(await page.evaluate(() => (window as any).isReady)).toEqual({ signedIn: false, canAsk: true });
        expect((await sign({ kind: 1, content: "after", tags: [] })).ok).toBe(false);
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
        asking.close();
      }
    },
    240_000
  );

  it(
    "the optional lock: a PIN, the device's own unlock, Lock now, and signed out after too many wrong tries (§SW12)",
    async () => {
      const browser = await playwright!.chromium.launch();
      try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const cdp = await context.newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
          options: { protocol: "ctap2", ctap2Version: "ctap2_1", transport: "internal", hasResidentKey: true, hasUserVerification: true, hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true }
        });
        const errors: string[] = [];
        page.on("pageerror", (err) => errors.push(String(err)));
        await page.goto(`${origin}/account.html`, { waitUntil: "domcontentloaded" });
        const widget = page.locator("bitlogin-auth");
        const active = () => page.evaluate(() => window.bitlogin?.activeSession()?.publicKey ?? null);
        const setPin = async (pin: string) => {
          await widget.locator('form[data-form="lock-enable"] input[name="newLockPin"]').fill(pin);
          await widget.locator('form[data-form="lock-enable"] input[name="newLockPinAgain"]').fill(pin);
          await widget.locator('form[data-form="lock-enable"] button[type="submit"]').click();
        };
        const typePin = async (pin: string) => {
          await widget.locator('form[data-form="lock-open"] input[name="lockPin"]').fill(pin);
          await widget.locator('form[data-form="lock-open"] button[type="submit"]').click();
        };

        await widget.locator('[data-action="goto-create"]').click();
        await startPasswordSignUp(widget, "locker");
        await completeRecoveryCeremony(widget);
        await widget.locator(".pubkey").waitFor({ timeout: 90_000 });
        const me = await active();
        expect(me).toMatch(/^[0-9a-f]{64}$/u);

        // Off unless turned on: no Lock now, and a reload asks nothing.
        expect(await widget.locator('[data-action="lock-now"]').count()).toBe(0);
        await widget.locator('[data-action="goto-lock-settings"]').click();
        // A PIN too short, or typed two ways, turns nothing on.
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPin"]').fill("246810");
        await widget.locator('form[data-form="lock-enable"] input[name="newLockPinAgain"]').fill("246811");
        await widget.locator('form[data-form="lock-enable"] button[type="submit"]').click();
        await widget.locator(".notice.error").waitFor({ timeout: 10_000 });
        expect(await widget.locator('[data-action="lock-off"]').count()).toBe(0);
        await setPin("246810");
        await widget.locator('[data-action="lock-off"]').waitFor({ timeout: 60_000 });

        // A page load: locked. Nobody is signed in as far as the page can tell, and nothing signs.
        await page.reload({ waitUntil: "domcontentloaded" });
        await widget.locator('form[data-form="lock-open"]').waitFor({ timeout: 30_000 });
        expect(await active()).toBeNull();
        expect(await widget.locator('[data-action="lock-device-open"]').count()).toBe(0);
        expect(await page.evaluate(() => (window as any).nostr.signEvent({ kind: 1, created_at: 1, tags: [], content: "locked" }).then(() => "signed", () => "refused"))).toBe("refused");
        await typePin("000000");
        await widget.locator(".notice.error", { hasText: "4 tries left" }).waitFor({ timeout: 60_000 });
        expect(await active()).toBeNull();
        await typePin("246810");
        await widget.locator(".pubkey").waitFor({ timeout: 60_000 });
        expect(await active()).toBe(me);

        // The device's own unlock, added, is offered first; and Lock now locks without a page load.
        await widget.locator('[data-action="goto-lock-settings"]').click();
        await widget.locator('[data-action="lock-device-add"]').click();
        await widget.locator('[data-action="lock-device-remove"]').waitFor({ timeout: 30_000 });
        await widget.locator('[data-action="goto-dashboard"]').click();
        await widget.locator('[data-action="lock-now"]').click();
        await widget.locator('[data-action="lock-device-open"]').waitFor({ timeout: 30_000 });
        expect(await active()).toBeNull();
        await widget.locator('[data-action="lock-device-open"]').click();
        await widget.locator(".pubkey").waitFor({ timeout: 60_000 });
        expect(await active()).toBe(me);

        // What is at rest is sealed twice: the cached session is not the ordinary record.
        const kept = await page.evaluate(
          () =>
            new Promise<string>((resolve) => {
              const open = indexedDB.open("bitlogin");
              open.onerror = () => resolve("no database");
              open.onsuccess = () => {
                const db = open.result;
                const names = Array.from(db.objectStoreNames);
                const out: string[] = [];
                let left = names.length;
                if (!left) resolve("empty");
                for (const name of names) {
                  const all = db.transaction(name).objectStore(name).getAll();
                  all.onsuccess = () => {
                    out.push(JSON.stringify(all.result));
                    if (--left === 0) resolve(out.join("\n"));
                  };
                  all.onerror = () => {
                    if (--left === 0) resolve(out.join("\n"));
                  };
                }
              };
            })
        );
        if (kept !== "no database" && kept !== "empty") {
          expect(kept).toContain('\\"v\\":3');
          expect(kept).not.toContain("246810");
        }

        // Too many wrong tries: the lock and what was kept are removed, and it is an ordinary sign-in again.
        await page.reload({ waitUntil: "domcontentloaded" });
        await widget.locator('form[data-form="lock-open"]').waitFor({ timeout: 30_000 });
        for (let left = 4; left >= 1; left--) {
          await typePin("111111");
          await widget.locator(".notice.error", { hasText: `${left} ${left === 1 ? "try" : "tries"} left` }).waitFor({ timeout: 60_000 });
        }
        await typePin("111111");
        await widget.locator(".notice.error", { hasText: "Too many wrong tries" }).waitFor({ timeout: 60_000 });
        expect(await widget.locator('form[data-form="lock-open"]').count()).toBe(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        expect(await widget.locator('form[data-form="lock-open"]').count()).toBe(0);
        expect(await active()).toBeNull();
        expect(errors).toEqual([]);
      } finally {
        await browser.close();
      }
    },
    300_000
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
