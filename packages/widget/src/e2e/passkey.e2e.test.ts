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
      const relative = url.pathname === "/" ? "/index.html" : url.pathname;
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
});
