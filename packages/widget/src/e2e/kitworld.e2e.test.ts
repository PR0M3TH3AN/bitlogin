/**
 * A world built on the NSWP kit, against BitLogin's real signer: saves, scores and achievements
 * (NSWP-12, 15, 16). Opt-in, since it needs NSWP's built Arcade:
 *
 *   BITLOGIN_KIT_WORLD=~/Documents/GitHub/Nostr-Spatial-Web-Protocol--NSWP-/sites/arcade/dist npx vitest run packages/widget/src/e2e/kitworld.e2e.test.ts
 *
 * Everything is on this machine: the world and BitLogin's built pages are served here over https at localhost (a
 * certificate made for the run), every relay is a mock relay here, and any request to anywhere else is refused.
 * One throwaway password account is made, on localhost, with a password the page generates; it is read from the
 * page to sign in on the second "device" and goes nowhere else.
 */
import { createServer, type Server } from "node:https";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { verifyNostrEvent, type NostrEvent } from "../../../core/src/nostr/event.js";

const DIST = fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const WORLD_DIST = process.env.BITLOGIN_KIT_WORLD ? resolve(process.env.BITLOGIN_KIT_WORLD.replace(/^~/u, process.env.HOME ?? "")) : "";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}

/** Serve a folder over https at localhost, changing what `rewrite` says in each text file as it goes out. */
function serve(root: string, tls: { key: Buffer; cert: Buffer }, rewrite: (path: string, text: string) => string): Promise<{ server: Server; origin: string }> {
  const server = createServer(tls, async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "https://localhost");
      const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
      const file = join(root, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
      if (!existsSync(file)) return void res.writeHead(404).end("not found");
      const type = MIME[extname(file)] ?? (url.pathname.endsWith("nswp.json") ? MIME[".json"]! : "application/octet-stream");
      let body: string | Buffer = await readFile(file);
      if (/text|json/u.test(type)) body = rewrite(relative, body.toString("utf8"));
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `https://localhost:${(server.address() as { port: number }).port}` })));
}

describe.skipIf(!playwright || !WORLD_DIST || !existsSync(join(WORLD_DIST, "app.js")))("a world built on the kit, against BitLogin's real signer (NSWP-12, 15, 16)", () => {
  let relays: MockRelay[] = [];
  let signIn: { server: Server; origin: string };
  let world: { server: Server; origin: string };
  let certDir = "";

  beforeAll(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    certDir = mkdtempSync(join(tmpdir(), "bitlogin-kitworld-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem")], { stdio: "ignore" });
    const tls = { key: readFileSync(join(certDir, "key.pem")), cert: readFileSync(join(certDir, "cert.pem")) };
    const list = relays.map((r) => r.url).join(",");
    signIn = await serve(DIST, tls, (path, text) =>
      ["/connect/index.html", "/connect/panel/index.html", "/signer/index.html"].includes(path) ? text.replace('<html lang="en">', `<html lang="en" data-vault-relays="${list}" data-discovery-relays="${list}">`) : text
    );
    // The world names bitlogin.network as its sign-in address: here, the local copy.
    world = await serve(WORLD_DIST, tls, (_path, text) => text.replaceAll("https://bitlogin.network/", `${signIn.origin}/`).replaceAll("https://bitlogin.network", signIn.origin));
  }, 60_000);

  afterAll(async () => {
    signIn?.server.close();
    world?.server.close();
    await Promise.all(relays.map((r) => r.close()));
    if (certDir) rmSync(certDir, { recursive: true, force: true });
  });

  it(
    "a save follows the account to a second device; a score and an achievement are signed and read back; a forged save is refused",
    async () => {
      // A world draws in WebGL: in a headless browser that needs the software renderer.
      const browser = await playwright!.chromium.launch({ channel: process.env.BITLOGIN_KIT_CHANNEL || undefined, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
      const refused = new Set<string>();
      /** A browser profile of its own: nothing leaves this machine, and the world's relays are the mock ones. */
      const profile = async () => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        await context.route("**/*", (route) => {
          const url = new URL(route.request().url());
          if (url.protocol === "data:" || url.protocol === "blob:" || url.hostname === "localhost" || url.hostname === "127.0.0.1") return route.continue();
          refused.add(url.origin);
          return route.abort();
        });
        await context.routeWebSocket(
          (url) => !/^ws:\/\/127\.0\.0\.1:/u.test(url.href),
          (ws) => {
            const up = new WebSocket(relays[0]!.url);
            const waiting: string[] = [];
            up.onopen = () => waiting.splice(0).forEach((m) => up.send(m));
            up.onmessage = (m) => ws.send(String(m.data));
            ws.onMessage((m) => (up.readyState === 1 ? up.send(String(m)) : waiting.push(String(m))));
            ws.onClose(() => up.close());
          }
        );
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (e) => errors.push(String(e)));
        await page.goto(`${world.origin}/`, { waitUntil: "domcontentloaded", timeout: 60_000 });
        await page.waitForFunction(() => typeof (window as any).__nswpTest?.signer === "function" && !!(window as any).__nswpTest.signer(), null, { timeout: 60_000 });
        const signer = (what: string, ...args: unknown[]) => page.evaluate(([w, a]) => (window as any).__nswpTest.signer()[w as string](...(a as unknown[])), [what, args] as const);
        return { context, page, errors, signer };
      };
      /** At the visitor's press, the world opens BitLogin's window; it signs in there and allows the world. */
      const signInThere = async (p: Awaited<ReturnType<typeof profile>>, how: (widget: any) => Promise<void>) => {
        await p.page.waitForFunction(() => (window as any).__nswpTest.signer().state !== "none", null, { timeout: 90_000 });
        const popup = p.context.waitForEvent("page", { timeout: 60_000 });
        // A press, as the visitor's own: a popup is opened only from one.
        await p.page.mouse.click(5, 5);
        expect(await p.page.evaluate(() => (window as any).__nswpTest.signer().unlock())).toBe(true);
        const win = await popup;
        const widget = win.locator("#widget-slot bitlogin-auth");
        await widget.locator('[data-action="goto-login"]').waitFor({ timeout: 30_000 });
        await how(widget);
        await win.locator("#allow").waitFor({ state: "visible", timeout: 120_000 });
        await win.waitForTimeout(1000);
        await win.locator("#allow").click();
        await p.page.waitForFunction(() => (window as any).__nswpTest.signer().state === "unlocked", null, { timeout: 30_000 });
      };
      const query = async (filter: Record<string, unknown>): Promise<NostrEvent[]> =>
        new Promise((done) => {
          const ws = new WebSocket(relays[0]!.url);
          const got: NostrEvent[] = [];
          ws.onopen = () => ws.send(JSON.stringify(["REQ", "q", filter]));
          ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if (msg[0] === "EVENT") got.push(msg[2]);
            if (msg[0] === "EOSE") (ws.close(), done(got));
          };
        });
      const publish = async (event: NostrEvent) => {
        for (const relay of relays) {
          await new Promise<void>((done) => {
            const ws = new WebSocket(relay.url);
            ws.onopen = () => ws.send(JSON.stringify(["EVENT", event]));
            ws.onmessage = () => (ws.close(), done());
          });
        }
      };

      try {
        // The first device: a throwaway password account, made in BitLogin's window. Its generated password is read
        // from the page, for the second device, and goes nowhere else.
        const a = await profile();
        const name = `kit-${Date.now().toString(36)}`;
        let password = "";
        await signInThere(a, async (widget) => {
          await widget.locator('[data-action="goto-create"]').click();
          await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(name);
          await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
          password = ((await widget.locator("#credential-box").textContent()) ?? "").trim();
          await widget.locator("#saved-check").check();
          await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
          await widget.locator(".phrase-word").first().waitFor({ timeout: 120_000 });
          const words = (await widget.locator(".phrase-word").allTextContents()).map((c: string) => c.replace(/^\s*\d+\.\s*/u, "").trim());
          await widget.locator('[data-action="goto-verify-phrase"]').click();
          const inputs = widget.locator('form[data-form="verify-phrase"] input');
          for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill(words[Number((await inputs.nth(i).getAttribute("name")).replace("confirm-", ""))]);
          await widget.locator('form[data-form="verify-phrase"] button[type="submit"]').click();
        });
        expect(password.length).toBeGreaterThan(8);
        const pubkey = (await a.page.evaluate(() => (window as any).__nswpTest.signer().pubkey)) as string;
        expect(pubkey).toMatch(/^[0-9a-f]{64}$/u);

        // The world saves. Its signer signs it: kind 37304, the visitor's key, at an address only it can work out.
        const data = JSON.stringify({ best: 12.34, at: "the first device" });
        const saved = (await a.signer("save", "main", data)) as NostrEvent;
        expect(saved.kind).toBe(37304);
        expect(saved.pubkey).toBe(pubkey);
        expect(verifyNostrEvent(saved)).toBe(true);
        expect(saved.content).not.toContain("12.34");
        await publish(saved);

        // A score and an achievement, each signed for this world and marked with its address.
        // The world's coordinate, by the publisher its own manifest names.
        const publisher = (await a.page.evaluate(async () => Object.keys((await (await fetch("/.well-known/nswp.json")).json()).publishers ?? {})[0] ?? "")) as string;
        expect(publisher).toMatch(/^[0-9a-f]{64}$/u);
        const coordinate = `37300:${publisher}:arcade`;
        const score = (await a.signer("score", coordinate, "fastest", 12_340, { title: "Fastest run", format: "time" })) as NostrEvent;
        const achieved = (await a.signer("achieve", coordinate, "all-twelve", "Caught all twelve")) as NostrEvent;
        for (const note of [score, achieved]) {
          expect(note?.pubkey).toBe(pubkey);
          expect(verifyNostrEvent(note)).toBe(true);
          expect(note.tags).toContainEqual(["nswp:world", world.origin]);
          expect(note.tags).toContainEqual(["a", coordinate]);
          await publish(note);
        }
        // Read back by world, never by person, as a board is.
        // (The world itself puts other notes there too, by other keys.)
        const mine = (await query({ "#a": [coordinate] })).filter((e) => e.pubkey === pubkey);
        console.log("THE ACCOUNT'S NOTES FOR THIS WORLD, BY KIND:", JSON.stringify(mine.map((e) => e.kind)));
        const back = mine.filter((e) => e.kind === score.kind || e.kind === achieved.kind);
        expect(back.map((e) => e.id).sort()).toEqual([score.id, achieved.id].sort());

        // The second device: a fresh profile, signed in to the same account with its name and password.
        const b = await profile();
        await signInThere(b, async (widget) => {
          await widget.locator('[data-action="goto-login"]').click();
          await widget.locator('form[data-form="login"] input[name="loginName"]').fill(name);
          await widget.locator('form[data-form="login"] input[name="password"]').fill(password);
          await widget.locator('form[data-form="login"] button[type="submit"]').click();
        });
        expect(await b.page.evaluate(() => (window as any).__nswpTest.signer().pubkey)).toBe(pubkey);
        const d = (await b.signer("find", "main")) as string;
        expect(d).toBe(saved.tags.find((t) => t[0] === "d")?.[1]);
        const found = (await query({ kinds: [37304], authors: [pubkey], "#d": [d] }))[0]!;
        expect(await b.signer("open", found)).toEqual({ slot: "main", data, at: saved.created_at });

        // A forged save is refused: the same note with its words changed no longer opens.
        expect(await b.signer("open", { ...found, content: found.content.slice(0, -6) + "AAAAA=" })).toBeNull();
        // And a slot that was never saved is a different address.
        expect(await b.signer("find", "other")).not.toBe(d);

        expect(refused.size === 0 || [...refused].every((origin) => !/localhost|127\.0\.0\.1/u.test(origin))).toBe(true);
        console.log("REFUSED (never reached):", JSON.stringify([...refused]));
        console.log("ERRORS:", JSON.stringify([...a.errors, ...b.errors].slice(0, 5)));
      } finally {
        await browser.close();
      }
    },
    300_000
  );
});
