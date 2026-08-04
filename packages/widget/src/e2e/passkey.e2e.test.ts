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

        // Registration publishes capsules to the mock relay, then lands on the
        // dashboard showing the npub.
        const pubkeyLine = widget.locator(".pubkey");
        await pubkeyLine.waitFor({ timeout: 60_000 });
        const firstNpub = (await pubkeyLine.textContent())?.trim() ?? "";
        expect(firstNpub).toMatch(/^npub1[023456789acdefghjklmnpqrstuvwxyz]{58}$/u);

        // Not a UI-only illusion: the capsules really landed on the relays,
        // so this is a genuine protocol-level account.
        const capsuleKinds = relays.flatMap((r) => r.storedEventKinds());
        expect(capsuleKinds.filter((kind) => kind === 30078).length).toBeGreaterThan(0);

        // Tier B2: the phrase card is offered in the first session.
        expect(await widget.locator('[data-action="goto-confirm-phrase"]').count()).toBe(1);

        // The passkey session is reported to the host, method-aware.
        const session = await page.evaluate(() => window.bitlogin?.activeSession());
        expect(session?.method).toBe("bitlogin");
        expect(session?.npub).toBe(firstNpub);

        // Sign out, then sign IN with the same passkey: derivation must land
        // on the same account.
        await widget.locator('[data-action="logout"]').click();
        await openOptions();
        await widget.locator('[data-action="goto-passkey"]').click();
        await widget.locator('[data-action="passkey-auth"]').click();

        await pubkeyLine.waitFor({ timeout: 60_000 });
        const secondNpub = (await pubkeyLine.textContent())?.trim() ?? "";
        expect(secondNpub).toBe(firstNpub);

        // A returning session is NOT offered the first-session phrase card.
        expect(await widget.locator('[data-action="goto-confirm-phrase"]').count()).toBe(0);

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
});
