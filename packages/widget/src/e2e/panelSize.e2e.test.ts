/**
 * The panel's sizes on a first opening (2026-11-24, from BitPortal's measurements on the live portal): opened to sign
 * in after a page load, the panel said `ready`, was shown at the client's default, and then said three sizes as its
 * screen drew itself. A client that holds presses for a moment after every change of size then held them for about
 * three seconds. The panel must be shown once at the size its first screen needs: `ready` comes with the first screen
 * drawn, and says how tall it is, and nothing changes after it while that screen stays as it is.
 *
 * Runs where Playwright's Chromium is installed.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { appendFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";

const DIST = process.env.BITLOGIN_PANEL_DIST ?? fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe.skipIf(!playwright)("the panel's sizes on a first opening", () => {
  let relay: MockRelay;
  let signIn: { server: Server; origin: string };
  let client: { server: Server; origin: string };
  let world: { server: Server; origin: string };

  beforeAll(async () => {
    relay = await MockRelay.start();
    const relays = relay.url;
    signIn = await new Promise((done) => {
      const server = createServer(async (req, res) => {
        const url = new URL(req.url ?? "/", "http://x");
        const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
        const file = join(DIST, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
        if (!existsSync(file)) return void res.writeHead(404).end();
        let body: Buffer | string = await readFile(file);
        if (["/connect/index.html", "/connect/panel/index.html"].includes(relative)) body = body.toString("utf8").replace('<html lang="en">', `<html lang="en" data-vault-relays="${relays}" data-discovery-relays="${relays}">`);
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
      });
      server.listen(0, "127.0.0.1", () => done({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` }));
    });
    // A world, on an address of its own: it carries BitLogin's embedded signer, as a world does.
    world = await new Promise((done) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a world</title><iframe id="signer" src="${signIn.origin}/signer/" style="width:1px;height:1px;border:0"></iframe>`);
      });
      server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
    // A client as BitPortal's shell is: it frames the panel, says hello until `ready`, and records what it hears.
    client = await new Promise((done) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a shell</title><div id="slot"></div>
<iframe id="world" src="${world.origin}/" style="width:300px;height:200px;border:0"></iframe>
<script type="module">
  const SIGNIN = "${signIn.origin}";
  window.said = [];
  addEventListener("message", (e) => { if (e.origin === SIGNIN && e.data && e.data.bitlogin === "bitlogin-panel") window.said.push({ t: e.data.t, size: e.data.size, height: e.data.height, at: Date.now() }); });
  window.open = (mode, world) => {
    window.said = [];
    window.openedAt = Date.now();
    const panel = document.createElement("iframe");
    panel.id = "panel";
    panel.src = SIGNIN + "/connect/panel/";
    // How the client keeps the frame until \`ready\`: drawn (as BitPortal does), not drawn at all, or far out of view.
    panel.style.cssText = "width:420px;height:640px;border:0;" + (window.frameStyle || "");
    if (window.frameStyle) {
      const show = (e) => {
        if (e.origin !== SIGNIN || !e.data || e.data.t !== "ready") return;
        removeEventListener("message", show);
        panel.style.cssText = "width:420px;height:640px;border:0";
      };
      addEventListener("message", show);
    }
    document.getElementById("slot").replaceChildren(panel);
    const again = setInterval(() => {
      if (window.said.some((m) => m.t === "ready")) return clearInterval(again);
      panel.contentWindow?.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hello", mode, ...(world ? { world } : {}) }, SIGNIN);
    }, 50);
  };
</script>`);
      });
      server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` }));
    });
  }, 60_000);

  afterAll(async () => {
    signIn?.server.close();
    client?.server.close();
    world?.server.close();
    await relay?.close();
  });

  /** Open the panel in a mode, wait for `usable`, and say what it said: its sizes, and when. */
  const opening = async (mode: string, usable: string, worldAsked = false, kept: { frameStyle?: string; background?: boolean } = {}) => {
    const browser = await playwright!.chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`${client.origin}/`);
      await page.frameLocator("#world").frameLocator("#signer").locator("body").waitFor({ state: "attached", timeout: 30_000 });
      if (kept.frameStyle) await page.evaluate((style) => ((window as any).frameStyle = style), kept.frameStyle);
      await page.evaluate(([m, w]) => (window as any).open(m, w || undefined), [mode, worldAsked ? world.origin : ""]);
      // The visitor looks at another tab from the press until after the cap, then comes back.
      let hiddenSaid = "";
      if (kept.background) {
        const other = await context.newPage();
        await other.goto("about:blank");
        await other.bringToFront();
        hiddenSaid = (await page.evaluate(() => document.visibilityState)) as string;
        await sleep(4500);
        await page.bringToFront();
      }
      await page.frameLocator("#panel").locator(usable).first().waitFor({ timeout: 60_000 });
      // Past any late change.
      await sleep(2500);
      const said = (await page.evaluate(() => (window as any).said)) as { t: string; size?: string; height?: number; at: number }[];
      const openedAt = (await page.evaluate(() => (window as any).openedAt)) as number;
      const readyAt = said.findIndex((m) => m.t === "ready");
      return {
        ...(kept.background ? { hiddenSaid } : {}),
        ready: readyAt >= 0 ? said[readyAt]!.at - openedAt : null,
        sizes: said.filter((m) => m.t === "size").map((m) => ({ size: m.size, height: m.height, atMs: m.at - openedAt })),
        afterReady: said.slice(readyAt + 1).filter((m) => m.t === "size").length,
        said: said.map((m) => `${m.t}${m.height ? `:${m.height}` : ""}@${m.at - openedAt}`)
      };
    } finally {
      await browser.close();
    }
  };
  const once = (r: Awaited<ReturnType<typeof opening>>) => {
    if (process.env.BITLOGIN_PANEL_SAY) appendFileSync(process.env.BITLOGIN_PANEL_SAY, `${JSON.stringify(r)}\n`);
    expect(r.ready, JSON.stringify(r)).not.toBeNull();
    // Its size is said before `ready`, once, and never changes after it while the screen stays as it is.
    expect(r.afterReady, JSON.stringify(r)).toBe(0);
    expect(r.sizes.length, JSON.stringify(r)).toBe(1);
  };

  /** `ready` is said by the cap, whatever the browser does with a frame it isn't drawing. */
  const byTheCap = (r: Awaited<ReturnType<typeof opening>>) => {
    if (process.env.BITLOGIN_PANEL_SAY) appendFileSync(process.env.BITLOGIN_PANEL_SAY, `${JSON.stringify(r)}\n`);
    expect(r.ready, JSON.stringify(r)).not.toBeNull();
    expect(r.ready!, JSON.stringify(r)).toBeLessThan(4000);
    expect(r.sizes.length, JSON.stringify(r)).toBeGreaterThanOrEqual(1);
  };
  it("says ready by the cap when the client keeps the frame undrawn (display: none) until then", async () => {
    byTheCap(await opening("ask", '#widget-slot bitlogin-auth [data-action="goto-create"]', true, { frameStyle: "display:none" }));
  }, 120_000);
  it("says ready by the cap when the client keeps the frame far out of view until then", async () => {
    byTheCap(await opening("ask", '#widget-slot bitlogin-auth [data-action="goto-create"]', true, { frameStyle: "position:absolute;left:-20000px;top:-20000px" }));
  }, 120_000);
  it("says ready by the cap when the visitor is on another tab from the press until after it", async () => {
    byTheCap(await opening("ask", '#widget-slot bitlogin-auth [data-action="goto-create"]', true, { background: true }));
  }, 120_000);

  it("is shown once, at the size its first screen needs: the account page, nobody signed in", async () => {
    once(await opening("account", '#account-slot bitlogin-auth [data-action="goto-create"]'));
  }, 120_000);

  it("is shown once, at the size its first screen needs: a world asks, nobody signed in", async () => {
    once(await opening("ask", '#widget-slot bitlogin-auth [data-action="goto-create"]', true));
  }, 120_000);
});
