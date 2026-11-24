/**
 * A panel kept open across a release (2026-11-24: the owner, signed in, couldn't open the wallet until he reloaded).
 * The shell keeps the panel's frame between openings; BitLogin is released meanwhile; the wallet, Files or Purchases
 * is then opened in that same frame, with no reload pressed. What is lazily loaded then comes from the new release,
 * into a page from the old one.
 *
 * Two builds are served from one address, one after the other, as a release does: the first ("before"), then the
 * second ("after"), with nothing of the first left. By default the second is the first with its shared chunks renamed
 * and one thing in the wallet's screen that only the second's page has, as two real releases differ. Or real builds:
 *
 *   BITLOGIN_STALE_BEFORE=<dist> BITLOGIN_STALE_AFTER=<dist> npx vitest run packages/widget/src/e2e/staleBuild.e2e.test.ts
 *
 * Runs where Playwright's Chromium is installed. A throwaway account; no mint, no relay but a mock one.
 */
import { createServer, type Server } from "node:http";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";

const DIST = fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

const filesBelow = (dir: string, prefix = ""): string[] =>
  readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesBelow(dir, join(prefix, e.name)) : [join(prefix, e.name)]));

/**
 * The next release, made from one build: every shared chunk renamed (a bundler names them anew each time), a new build
 * id, and one element in the wallet's screen that the new wallet code needs and only the new page has.
 */
function nextRelease(from: string): string {
  const to = mkdtempSync(join(tmpdir(), "bitlogin-next-"));
  cpSync(from, to, { recursive: true });
  const vendor = join(to, "vendor", "bitlogin");
  const renames = readdirSync(vendor)
    .filter((f) => /^bitlogin-shared-.{8}\.js$/u.test(f))
    .map((f) => [f, f.replace(/^bitlogin-shared-(.{8})\.js$/u, (_m, h: string) => `bitlogin-shared-${h.split("").reverse().join("")}.js`)] as const);
  for (const [a, b] of renames) renameSync(join(vendor, a), join(vendor, b));
  const oldBuild = existsSync(join(to, "build.json")) ? (JSON.parse(readFileSync(join(to, "build.json"), "utf8")).build as string) : "";
  const newBuild = `next${Date.now().toString(16)}`;
  for (const file of filesBelow(to).filter((f) => /\.(js|html|json)$/u.test(f))) {
    let text = readFileSync(join(to, file), "utf8");
    for (const [a, b] of renames) text = text.split(a).join(b);
    if (file === "build.json") text = JSON.stringify({ build: newBuild });
    if (oldBuild && file.endsWith(".html")) text = text.split(`content="${oldBuild}"`).join(`content="${newBuild}"`);
    if (file === join("connect", "index.html") || file === join("connect", "panel", "index.html"))
      text = text.replace('<div data-ecash="home" hidden>', '<p id="ecash-since" hidden></p>\n    <div data-ecash="home" hidden>');
    if (file === join("assets", "ecash-ui.js")) text = text.replace("export async function openEcash(", 'const SINCE = () => document.getElementById("ecash-since").hidden;\nexport async function openEcash(').replace('  if (request) request = { ...request };', '  SINCE();\n  if (request) request = { ...request };');
    writeFileSync(join(to, file), text);
  }
  return to;
}

describe.skipIf(!playwright)("a panel kept open across a release", () => {
  let relaySet: MockRelay[] = [];
  let signIn: { server: Server; origin: string };
  let client: { server: Server; origin: string };
  let serving = "";
  let before = "";
  let after = "";

  beforeAll(async () => {
    relaySet = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    before = process.env.BITLOGIN_STALE_BEFORE ?? DIST;
    after = process.env.BITLOGIN_STALE_AFTER ?? nextRelease(before);
    serving = before;
    const relays = relaySet.map((r) => r.url).join(",");
    signIn = await new Promise((done) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
        const file = join(serving, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
        if (!existsSync(file)) return void res.writeHead(404).end();
        let body: Buffer | string = await readFile(file);
        if (["/connect/index.html", "/connect/panel/index.html", "/signer/index.html"].includes(relative)) body = body.toString("utf8").replace('<html lang="en">', `<html lang="en" data-vault-relays="${relays}" data-discovery-relays="${relays}">`);
        // As bitlogin.network serves them: revalidated every time.
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate" }).end(body);
      });
      server.listen(0, "127.0.0.1", () => done({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` }));
    });
    client = await new Promise((done) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a shell</title>
<button id="open" style="position:absolute;left:0;top:0;width:120px;height:40px">Open</button><div id="slot"></div>
<script type="module">
  const SIGNIN = "${signIn.origin}";
  window.said = [];
  addEventListener("message", (e) => { if (e.origin === SIGNIN && e.data && e.data.bitlogin === "bitlogin-panel") window.said.push({ ...e.data, at: Date.now() }); });
  window.nextMode = "account";
  window.keep = false;
  document.getElementById("open").addEventListener("click", () => {
    const kept = document.getElementById("panel");
    if (window.keep && kept) {
      kept.style.display = "";
      kept.contentWindow.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "show", mode: window.nextMode }, SIGNIN);
      return;
    }
    const panel = document.createElement("iframe");
    panel.id = "panel";
    panel.src = SIGNIN + "/connect/panel/";
    panel.style.cssText = "width:780px;height:700px;border:0";
    document.getElementById("slot").replaceChildren(panel);
    const again = setInterval(() => {
      if (window.said.some((m) => m.t === "ready")) return clearInterval(again);
      panel.contentWindow?.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hello", mode: window.nextMode }, SIGNIN);
    }, 50);
  });
</script>`);
      });
      server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
  }, 120_000);

  afterAll(async () => {
    signIn?.server.close();
    client?.server.close();
    await Promise.all(relaySet.map((r) => r.close()));
  });

  it(
    "opens the wallet, Files and Purchases after a release, in the frame kept from before it, with no reload pressed",
    async () => {
      const browser = await playwright!.chromium.launch();
      const results: Record<string, unknown>[] = [];
      try {
        const page = await browser.newPage();
        const errors: string[] = [];
        page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 240)));
        page.on("pageerror", (e) => errors.push(String(e).slice(0, 240)));
        await page.goto(`${client.origin}/`);
        const frame = () => page.frameLocator("#panel");
        const panel = () => page.frames().find((f) => f.url().startsWith(`${signIn.origin}/connect/panel/`));

        // ---- Signed in, on the release before.
        await page.mouse.click(60, 20);
        const widget = frame().locator("#account-slot bitlogin-auth");
        await widget.locator('[data-action="goto-create"]').waitFor({ timeout: 60_000 });
        await sleep(1000);
        await widget.locator('[data-action="goto-create"]').click();
        await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(`stale-${Date.now().toString(36)}`);
        await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
        await widget.locator("#saved-check").check();
        await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
        await widget.locator(".phrase-word").first().waitFor({ timeout: 120_000 });
        const words = (await widget.locator(".phrase-word").allTextContents()).map((c) => c.replace(/^\s*\d+\.\s*/u, "").trim());
        await widget.locator('[data-action="goto-verify-phrase"]').click();
        const inputs = widget.locator('form[data-form="verify-phrase"] input');
        for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill(words[Number((await inputs.nth(i).getAttribute("name"))!.replace("confirm-", ""))]!);
        await widget.locator('form[data-form="verify-phrase"] button[type="submit"]').click();
        await widget.locator(".pubkey").waitFor({ timeout: 120_000 });
        const controlled = await panel()!.evaluate(() => !!navigator.serviceWorker?.controller);

        // ---- Kept, hidden, as the shell keeps it. Then BitLogin is released: only the release after is served.
        await page.evaluate((signin) => {
          const kept = document.getElementById("panel") as HTMLIFrameElement;
          kept.contentWindow!.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hide" }, signin);
          kept.style.display = "none";
          (window as any).keep = true;
        }, signIn.origin);
        await sleep(500);
        serving = after;

        // ---- Each of the person's own pages, opened in the kept frame. Usable means its screen came up.
        const usable: Record<string, string> = {
          wallet: '[data-ecash="setup"]:not([hidden]), [data-ecash="home"]:not([hidden])',
          files: '#files:not([hidden]) [data-files]:not([hidden])',
          library: '#library:not([hidden])'
        };
        for (const mode of ["wallet", "files", "library"] as const) {
          errors.length = 0;
          await page.evaluate((m) => ((window as any).nextMode = m), mode);
          await sleep(1000);
          await page.mouse.click(60, 20);
          const opened = await frame()
            .locator(usable[mode]!)
            .first()
            .waitFor({ state: "visible", timeout: 30_000 })
            .then(() => true)
            .catch(() => false);
          const said = opened ? "" : ((await panel()?.evaluate(() => document.body.innerText.replace(/\s+/gu, " ").slice(0, 300)).catch(() => "")) ?? "");
          results.push({ mode, opened, said, errors: [...errors], controlled });
          // Put away again, for the next.
          await page.evaluate((signin) => {
            const kept = document.getElementById("panel") as HTMLIFrameElement;
            kept.contentWindow!.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hide" }, signin);
            kept.style.display = "none";
          }, signIn.origin);
          await sleep(300);
        }

        // ---- The panel left open on the account page across a second release, and the wallet pressed there: the
        // person may have typed something, so it is said, with one press that reloads and opens the wallet.
        serving = before;
        await page.evaluate((m) => ((window as any).nextMode = m), "account");
        await sleep(1000);
        await page.mouse.click(60, 20);
        await frame().locator("#account-slot bitlogin-auth").locator(".pubkey").waitFor({ timeout: 60_000 }).catch(() => {});
        await sleep(1500);
        serving = after;
        await frame().locator("#open-ecash").click();
        const told = await frame()
          .locator("#reload-updated")
          .waitFor({ state: "visible", timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        const toldSaid = (await panel()?.evaluate(() => document.getElementById("status")?.textContent ?? "").catch(() => "")) ?? "";
        let thenOpened = false;
        if (told) {
          await frame().locator("#reload-updated").click();
          thenOpened = await frame()
            .locator(usable.wallet!)
            .first()
            .waitFor({ state: "visible", timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
        }
        results.push({ mode: "wallet, pressed in a panel open across a release", opened: told && thenOpened, told, toldSaid, thenOpened });
      } finally {
        if (process.env.BITLOGIN_STALE_OUT) writeFileSync(process.env.BITLOGIN_STALE_OUT, JSON.stringify(results, null, 2));
        await browser.close();
      }
      expect(results.map((r) => [r.mode, r.opened]), JSON.stringify(results)).toEqual([
        ["wallet", true],
        ["files", true],
        ["library", true],
        ["wallet, pressed in a panel open across a release", true]
      ]);
    },
    600_000
  );
});
