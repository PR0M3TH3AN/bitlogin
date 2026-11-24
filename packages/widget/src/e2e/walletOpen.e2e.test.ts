/**
 * The wallet, opened in the panel as a shell frames it, while relays and the mint misbehave (2026-11-24: the owner's
 * wallet said "Your wallet couldn't be opened. Nothing was changed." in BitPortal's shell). Runs where Playwright's
 * Chromium is installed. What each opening showed is written out where asked:
 *
 *   BITLOGIN_WALLET_OUT=/tmp/wallet.json npx vitest run packages/widget/src/e2e/walletOpen.e2e.test.ts
 *
 * Found by it, 2026-11-24: ten changes that no relay had confirmed, on relays that read and never answer a write, were
 * sent again one at a time when the wallet was opened, each waited for; past the panel's minute the wallet said it
 * couldn't be opened, and put that over the balance it was already showing.
 *
 * Everything is on this machine: BitLogin's built pages, a client page that frames the panel, stand-in relays whose
 * behaviour can be changed between openings, and a pretend mint. A throwaway account and pretend sats only.
 * Every condition must end with the balance on screen. Where an opening is made to fail, the screen must say why, keep
 * what it showed, and open the wallet on "Try again".
 */
import { createServer, type Server } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { startMockMint } from "../ecash/mockMint.js";

const DIST = process.env.BITLOGIN_WALLET_DIST ?? fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const OUT = process.env.BITLOGIN_WALLET_OUT ?? "";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
/** noWrites: answers questions, and never answers a record sent to it (no OK), as a relay that only reads might. */
type Mode = "answer" | "refuse" | "silent" | "slow" | "noWrites";

function serveDist(relays: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const file = join(DIST, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
    if (!existsSync(file)) return void res.writeHead(404).end();
    let body: Buffer | string = await readFile(file);
    if (["/connect/index.html", "/connect/panel/index.html", "/signer/index.html"].includes(relative)) body = body.toString("utf8").replace('<html lang="en">', `<html lang="en" data-vault-relays="${relays}" data-discovery-relays="${relays}">`);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" }).end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` })));
}

describe.skipIf(!playwright)("the wallet opened while relays and the mint misbehave", () => {
  let upstream: MockRelay;
  const proxies: { wss: WebSocketServer; mode: Mode }[] = [];
  const relayUrls: string[] = [];
  let signIn: { server: Server; origin: string };
  let client: { server: Server; origin: string };
  const RELAYS = 5;

  beforeAll(async () => {
    upstream = await MockRelay.start();
    for (let i = 0; i < RELAYS; i++) {
      const entry: { wss: WebSocketServer; mode: Mode } = { wss: null as unknown as WebSocketServer, mode: "answer" };
      entry.wss = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient: (_info, done) => (entry.mode === "refuse" ? done(false, 503) : done(true)) });
      entry.wss.on("connection", (ws) => {
        const up = new NodeWebSocket(upstream.url);
        const waiting: string[] = [];
        up.on("open", () => waiting.splice(0).forEach((m) => up.send(m)));
        up.on("message", (m) => {
          if (entry.mode === "silent") return;
          setTimeout(() => ws.readyState === 1 && ws.send(String(m)), entry.mode === "slow" ? 9000 : 100);
        });
        ws.on("message", (m) => {
          if (entry.mode === "silent") return;
          if (entry.mode === "noWrites" && String(m).startsWith('["EVENT"')) return;
          up.readyState === 1 ? up.send(String(m)) : waiting.push(String(m));
        });
        ws.on("close", () => up.terminate());
        up.on("error", () => ws.close());
      });
      await new Promise((done) => entry.wss.once("listening", done));
      proxies.push(entry);
      relayUrls.push(`ws://127.0.0.1:${(entry.wss.address() as { port: number }).port}`);
    }
    signIn = await serveDist(relayUrls.join(","));
    client = await new Promise((done) => {
      const server = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end(`<!doctype html><meta charset="utf-8"><title>a shell</title>
<button id="open" style="position:absolute;left:0;top:0;width:120px;height:40px">Open</button>
<div id="slot"></div>
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
    window.said = [];
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
  }, 60_000);

  afterAll(async () => {
    signIn?.server.close();
    client?.server.close();
    for (const p of proxies) p.wss.close();
    await upstream?.close();
  });

  it(
    "each condition",
    async () => {
      const browser = await playwright!.chromium.launch();
      const mint = await startMockMint();
      const results: Record<string, unknown>[] = [];
      let mintDown = false;
      try {
        // No service worker: what the test blocks must not be answered from its cache.
        const context = await browser.newContext({ serviceWorkers: "block" });
        await context.route(`${mint.url}/**`, (route) => (mintDown ? route.abort("connectionrefused") : route.continue()));
        await context.addInitScript(() => {
          if (!location.pathname.startsWith("/connect/")) return;
          const log: { action: string; start: number; end?: number; ok?: boolean; error?: string }[] = [];
          (window as any).workerLog = log;
          const Real = window.Worker;
          (window as any).Worker = class extends Real {
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              const byId = new Map<string, number>();
              const send = this.postMessage.bind(this);
              this.postMessage = (message: any, ...rest: any[]) => {
                if (message && typeof message.id === "string" && typeof message.action === "string") byId.set(message.id, log.push({ action: message.action, start: Date.now() }) - 1);
                // Made to fail, on the test's word: the worker's read of the wallet answers as a timed-out call does.
                if (message?.action === "ecashLoad" && (window as any).failEcashLoad) {
                  setTimeout(() => this.dispatchEvent(new MessageEvent("message", { data: { id: message.id, ok: false, error: "BitLogin's ecashLoad call timed out.", errorName: "Error" } })), 300);
                  return;
                }
                return (send as any)(message, ...rest);
              };
              this.addEventListener("message", (e: MessageEvent) => {
                const i = e.data && typeof e.data.id === "string" ? byId.get(e.data.id) : undefined;
                if (i !== undefined) Object.assign(log[i]!, { end: Date.now(), ok: e.data.ok, ...(e.data.ok ? {} : { error: String(e.data.error).slice(0, 200) }) });
              });
            }
          };
        });
        let page = await context.newPage();
        let errors: string[] = [];
        const watch = (p: typeof page) => {
          p.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
          p.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
        };
        watch(page);
        await page.goto(`${client.origin}/`);
        const frame = () => page.frameLocator("#panel");
        const panelFrame = () => page.frames().find((f) => f.url().startsWith(`${signIn.origin}/connect/panel/`));

        const press = async (mode: string, how: "again" | "kept") => {
          if (how === "kept") {
            await page.evaluate((signin) => {
              const kept = document.getElementById("panel") as HTMLIFrameElement | null;
              kept?.contentWindow!.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hide" }, signin);
              if (kept) kept.style.display = "none";
              (window as any).keep = true;
            }, signIn.origin);
            await sleep(300);
          } else await page.evaluate(() => ((window as any).keep = false, document.getElementById("slot")!.replaceChildren()));
          await page.evaluate((m) => ((window as any).nextMode = m), mode);
          await page.mouse.click(60, 20);
        };

        /** Open the wallet and say what it showed: its balance, or the screen that it couldn't be opened. */
        const wallet = async (condition: string, how: "again" | "kept" = "again") => {
          errors = [];
          const at = Date.now();
          await press("wallet", how);
          const shown = await frame()
            .locator('[data-ecash="home"] #ecash-total, [data-ecash="done"], [data-ecash="setup"]')
            .filter({ visible: true })
            .first()
            .waitFor({ state: "visible", timeout: 90_000 })
            .then(() => true)
            .catch(() => false);
          // Past what this browser held: until the relays' answer is on screen, or the wallet said it couldn't open.
          const settled = shown
            ? await panelFrame()!
                .waitForFunction(() => {
                  const done = document.querySelector('[data-ecash="done"]') as HTMLElement | null;
                  if (done && !done.hidden) return true;
                  const setup = document.querySelector('[data-ecash="setup"]') as HTMLElement | null;
                  if (setup && !setup.hidden) return true;
                  return !/^Checking with your relays/u.test(document.getElementById("ecash-note")?.textContent ?? "");
                }, undefined, { timeout: 90_000 })
                .then(() => true)
                .catch(() => false)
            : false;
          await sleep(200);
          const screen = !settled && shown ? { screen: "still checking after 90 s" } : shown
            ? await panelFrame()!.evaluate(() => {
                const visible = (sel: string) => {
                  const e = document.querySelector(sel) as HTMLElement | null;
                  return !!e && !e.closest("[hidden]") && e.offsetParent !== null;
                };
                if (visible('[data-ecash="done"]')) return { screen: "done", text: document.getElementById("ecash-done-text")?.textContent };
                if (visible('[data-ecash="setup"]')) return { screen: "setup" };
                return { screen: "home", balance: document.getElementById("ecash-total")?.textContent?.trim(), note: document.getElementById("ecash-note")?.textContent?.trim() };
              })
            : { screen: "nothing within 90 s" };
          const log = ((await panelFrame()?.evaluate(() => (window as any).workerLog).catch(() => [])) ?? []) as { action: string; start: number; end?: number; ok?: boolean; error?: string }[];
          const worker = log.filter((w) => w.start >= at - 500 && w.action.startsWith("ecash")).map((w) => ({ action: w.action, tookMs: w.end ? w.end - w.start : null, ok: w.ok, ...(w.error ? { error: w.error } : {}) }));
          const result: Record<string, unknown> = { condition, how, tookMs: Date.now() - at, ...screen, worker, errors: errors.filter((e) => /ecash|wallet|bitlogin/iu.test(e)) };
          results.push(result);
          return result;
        };
        const relays = (...modes: Mode[]) => proxies.forEach((p, i) => (p.mode = modes[i] ?? modes[modes.length - 1]!));

        // ---- A throwaway account, made in the panel.
        await page.mouse.click(60, 20);
        const widget = frame().locator("#account-slot bitlogin-auth");
        await widget.locator('[data-action="goto-create"]').waitFor({ timeout: 60_000 });
        await sleep(1000);
        await widget.locator('[data-action="goto-create"]').click();
        await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(`wallet-${Date.now().toString(36)}`);
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

        // ---- A wallet with a mint and 20 pretend sats.
        await press("wallet", "again");
        await frame().locator('[data-ecash="setup"], [data-ecash="home"]').filter({ visible: true }).first().waitFor({ timeout: 60_000 });
        await frame().locator("#ecash-mint").fill(mint.url);
        await sleep(1000);
        await frame().locator('#ecash-mint-form button[type="submit"]').click();
        await frame()
          .locator('[data-ecash="home"]')
          .waitFor({ state: "visible", timeout: 60_000 })
          .catch(async (err) => {
            const said = await panelFrame()!.evaluate(() => [...document.querySelectorAll("#ecash p, #ecash .error, #ecash [role=alert]")].filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => e.textContent?.trim()).filter(Boolean));
            const log = await panelFrame()!.evaluate(() => (window as any).workerLog.filter((w: any) => w.action.startsWith("ecash")));
            results.push({ condition: "setup failed", said, log, errors });
            throw err;
          });
        await frame().locator("#ecash-go-fund").click();
        await frame().locator("#ecash-fund-amount").fill("20");
        await frame().locator('#ecash-fund-form button[type="submit"]').click();
        await frame().locator("#ecash-qr svg").waitFor({ timeout: 30_000 });
        mint.payAllFunding();
        await frame().locator("#ecash-note").filter({ hasText: /^Added 20 sats\.$/u }).waitFor({ timeout: 60_000 });

        // ---- The conditions.
        await wallet("every relay answering");
        await wallet("every relay answering", "kept");
        relays("answer", "refuse");
        await wallet("one relay answering, the rest refusing");
        relays("refuse");
        await wallet("every relay refusing");
        relays("silent");
        await wallet("every relay connecting and never answering");
        relays("slow");
        await wallet("every relay answering after 9 s");
        relays("answer", "silent");
        await wallet("one relay answering, the rest silent");
        relays("answer");
        mintDown = true;
        await wallet("the mint down");
        mintDown = false;
        // Sats added while no relay takes a record: each stays in this browser only, to be sent again at every opening.
        relays("noWrites");
        for (let i = 0; i < Number(process.env.BITLOGIN_WALLET_UNSAVED ?? "10"); i++) {
          // A press in the first 0.9 s after the panel is shown is ignored (§SW19.8).
          await sleep(1000);
          await frame().locator("#ecash-go-fund").click();
          await frame().locator("#ecash-fund-amount").fill("1");
          await frame().locator('#ecash-fund-form button[type="submit"]').click();
          await frame().locator("#ecash-qr svg").waitFor({ timeout: 30_000 });
          mint.payAllFunding();
          await frame().locator("#ecash-note").filter({ hasText: /^Added 1 sats?\. Kept in this browser/u }).waitFor({ timeout: 60_000 });
          await sleep(1000);
        }
        await wallet("records only in this browser, relays that read and never answer a write");
        relays("answer");
        await wallet("the same records, every relay answering");
        // ---- Made to fail. The wallet's own code can't be loaded: the screen says why, and opens on "Try again".
        await context.route("**/vendor/bitlogin/bitlogin-ecash.js", (route) => route.abort("failed"));
        const broken = await wallet("the wallet's code couldn't be loaded");
        expect(broken).toMatchObject({ screen: "done" });
        expect(String(broken.text)).toMatch(/^Your wallet couldn't be opened\. Part of BitLogin's page couldn't be loaded.* Nothing was changed\.$/u);
        expect(await frame().locator("#ecash-retry").isVisible()).toBe(true);
        await context.unroute("**/vendor/bitlogin/bitlogin-ecash.js");
        await sleep(1000);
        await frame().locator("#ecash-retry").click();
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        expect(await frame().locator("#ecash-total").textContent()).toBe("30");
        expect(await frame().locator("#ecash-retry").isVisible()).toBe(false);
        // The relays' read fails while this browser's copy is on screen: the balance stays, held, with the reason.
        // A new frame is a new page: the switch is read in it before it asks.
        await context.addInitScript(() => {
          if (location.pathname.startsWith("/connect/") && sessionStorage.getItem("failEcashLoad")) (window as any).failEcashLoad = true;
        });
        await panelFrame()!.evaluate(() => sessionStorage.setItem("failEcashLoad", "1"));
        const held = await wallet("the relays' read fails, this browser's copy on screen");
        expect(held).toMatchObject({ screen: "home", balance: "30" });
        expect(String(held.note)).toMatch(/^Your relays took too long to answer\. This is what this browser held last time, and it is still yours\. Nothing was changed\.$/u);
        expect(await frame().locator("#ecash-retry").isVisible()).toBe(true);
        expect(await frame().locator("#ecash-go-fund").isDisabled()).toBe(true);
        await panelFrame()!.evaluate(() => ((window as any).failEcashLoad = false, sessionStorage.removeItem("failEcashLoad")));
        await sleep(1000);
        await frame().locator("#ecash-retry").click();
        await frame().locator("#ecash-note").filter({ hasText: "Kept with your account" }).waitFor({ timeout: 60_000 });
        expect(await frame().locator("#ecash-go-fund").isDisabled()).toBe(false);
        expect(await frame().locator("#ecash-retry").isVisible()).toBe(false);

        // The shell's page loaded again: the panel restores its session.
        await page.close();
        page = await context.newPage();
        watch(page);
        await page.goto(`${client.origin}/`);
        await wallet("after the shell's page is loaded again");
        await wallet("after the shell's page is loaded again", "kept");
      } finally {
        if (OUT) await writeFile(OUT, JSON.stringify(results, null, 2));
        await browser.close();
        await mint.close();
      }
      // Every condition but the two made to fail ends with the balance on screen.
      const made = ["the wallet's code couldn't be loaded", "the relays' read fails, this browser's copy on screen"];
      expect(results.filter((r) => !made.includes(String(r.condition))).map((r) => [r.condition, r.how, r.screen])).toEqual(
        results.filter((r) => !made.includes(String(r.condition))).map((r) => [r.condition, r.how, "home"])
      );
    },
    1_200_000
  );
});
