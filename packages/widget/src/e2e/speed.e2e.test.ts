/**
 * How long BitLogin's panels take, measured (NSWP docs/backlog/bitlogin-panels-feel-native.md). Opt-in:
 *
 *   BITLOGIN_SPEED_OUT=/tmp/speed.json npx vitest run packages/widget/src/e2e/speed.e2e.test.ts
 *
 * Everything is on this machine: BitLogin's built pages, a client page that frames the panel as a shell does, and
 * relays that answer as slowly as the real built-in ones were measured to (2026-11-23, from this machine): most in
 * 0.4 to 1.2 seconds, a few refusing at once, and one that accepts a connection and never answers. A throwaway
 * password account, a pretend mint and a pretend file host, slowed a little too. It measures; it checks only that
 * each panel did become usable.
 */
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer } from "node:net";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as NodeWebSocket } from "ws";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { startMockMint } from "../ecash/mockMint.js";
import { startMockBlossom } from "../drive/mockBlossom.js";

const DIST = fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const OUT = process.env.BITLOGIN_SPEED_OUT ?? "";
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}

/**
 * The relays, as measured from this machine on 2026-11-23: connect time in milliseconds for each that answers (and
 * about a tenth of a second more to answer); two that refuse at once (503); one that accepts and never answers.
 */
const ANSWERING_MS = [370, 414, 482, 525, 570, 613, 635, 728, 797, 1095, 1192];
const REFUSING = 3;
/** Accepts the connection and never finishes the handshake: relay.nostr.band, measured 2026-11-23. */
const SILENT = 1;
/** Connects, and then never answers a question: the same fault, one step later. Set to 0 to leave it out. */
const CONNECTED_SILENT = Number(process.env.BITLOGIN_SPEED_CONNECTED_SILENT ?? "1");
const ANSWER_MS = 110;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** BitLogin's built pages, served as bitlogin.network serves them: revalidated every time (max-age=0), with an ETag. */
function serveDist(relays: string): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const relative = url.pathname.endsWith("/") ? `${url.pathname}index.html` : url.pathname;
    const file = join(DIST, normalize(relative).replace(/^(\.\.[/\\])+/u, ""));
    if (!existsSync(file)) return void res.writeHead(404).end();
    let body: Buffer | string = await readFile(file);
    if (["/connect/index.html", "/connect/panel/index.html", "/signer/index.html"].includes(relative)) body = body.toString("utf8").replace('<html lang="en">', `<html lang="en" data-vault-relays="${relays}" data-discovery-relays="${relays}">`);
    const etag = `"${createHash("sha256").update(body).digest("hex").slice(0, 16)}"`;
    const headers = { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "public, max-age=0, must-revalidate", etag };
    if (req.headers["if-none-match"] === etag) return void res.writeHead(304, headers).end();
    res.writeHead(200, headers).end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `http://localhost:${(server.address() as { port: number }).port}` })));
}

describe.skipIf(!playwright || !OUT)("how long BitLogin's panels take (bitlogin-panels-feel-native)", () => {
  let upstream: MockRelay;
  const proxies: WebSocketServer[] = [];
  const others: (Server | TcpServer)[] = [];
  const relayUrls: string[] = [];
  /** Every question a relay was asked: which relay, when, and what for. */
  const asked: { relay: number; at: number; kinds: number[] }[] = [];
  let signIn: { server: Server; origin: string };
  let client: { server: Server; origin: string };

  beforeAll(async () => {
    upstream = await MockRelay.start();
    for (const [i, connectMs] of ANSWERING_MS.entries()) {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1", verifyClient: (_info, done) => void setTimeout(() => done(true), connectMs) });
      wss.on("connection", (ws) => {
        const up = new NodeWebSocket(upstream.url);
        const waiting: string[] = [];
        up.on("open", () => waiting.splice(0).forEach((m) => up.send(m)));
        up.on("message", (m) => setTimeout(() => ws.readyState === 1 && ws.send(String(m)), ANSWER_MS));
        ws.on("message", (m) => {
          const text = String(m);
          try {
            const msg = JSON.parse(text);
            if (msg[0] === "REQ") asked.push({ relay: i, at: Date.now(), kinds: msg.slice(2).flatMap((f: { kinds?: number[] }) => f.kinds ?? []) });
          } catch {
            /* not ours to read */
          }
          up.readyState === 1 ? up.send(text) : waiting.push(text);
        });
        ws.on("close", () => up.terminate());
        up.on("error", () => ws.close());
      });
      await new Promise((done) => wss.once("listening", done));
      proxies.push(wss);
      relayUrls.push(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    }
    for (let i = 0; i < REFUSING; i++) {
      const s = createServer((_req, res) => res.writeHead(503).end());
      s.on("upgrade", (_req, socket) => socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n"));
      await new Promise<void>((done) => s.listen(0, "127.0.0.1", () => done()));
      others.push(s);
      relayUrls.push(`ws://127.0.0.1:${(s.address() as { port: number }).port}`);
    }
    for (let i = 0; i < SILENT; i++) {
      // Accepts the connection, and says nothing ever after.
      const s = createTcpServer(() => {});
      await new Promise<void>((done) => s.listen(0, "127.0.0.1", () => done()));
      others.push(s);
      relayUrls.push(`ws://127.0.0.1:${(s.address() as { port: number }).port}`);
    }
    for (let i = 0; i < CONNECTED_SILENT; i++) {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      wss.on("connection", () => {});
      await new Promise((done) => wss.once("listening", done));
      proxies.push(wss);
      relayUrls.push(`ws://127.0.0.1:${(wss.address() as { port: number }).port}`);
    }
    signIn = await serveDist(relayUrls.join(","));
    // A client that keeps the screen, as BitPortal's shell does: it frames the panel at a press, says hello, and
    // records when each thing it heard arrived.
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
  // keep: the frame is kept between openings and shown again (sign-in-window.md §SW19.8), as the shell may do.
  window.keep = false;
  document.getElementById("open").addEventListener("click", () => {
    window.pressedAt = Date.now();
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
    for (const p of proxies) p.close();
    for (const s of others) s.close();
    await upstream?.close();
  });

  it(
    "each panel, opened cold and again",
    async () => {
      const browser = await playwright!.chromium.launch();
      const mint = await startMockMint();
      const blossom = await startMockBlossom();
      const results: Record<string, unknown>[] = [];
      try {
        const context = await browser.newContext();
        // Every call to the mint and the file host takes a quarter of a second more, as a real one far away might.
        const mintCalls: { path: string; at: number }[] = [];
        for (const host of [mint.url, blossom.url])
          await context.route(`${host}/**`, async (route) => {
            if (host === mint.url) mintCalls.push({ path: new URL(route.request().url()).pathname, at: Date.now() });
            await sleep(250);
            await route.continue();
          });
        // What the page asks its worker, and when it is answered, recorded inside every frame of BitLogin's.
        await context.addInitScript(() => {
          if (!location.pathname.startsWith("/connect/")) return;
          const log: { action: string; start: number; end?: number; ok?: boolean }[] = [];
          (window as any).workerLog = log;
          const Real = window.Worker;
          (window as any).Worker = class extends Real {
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              const byId = new Map<string, number>();
              const send = this.postMessage.bind(this);
              this.postMessage = (message: any, ...rest: any[]) => {
                if (message && typeof message.id === "string" && typeof message.action === "string") byId.set(message.id, log.push({ action: message.action, start: Date.now() }) - 1);
                return (send as any)(message, ...rest);
              };
              this.addEventListener("message", (e: MessageEvent) => {
                const i = e.data && typeof e.data.id === "string" ? byId.get(e.data.id) : undefined;
                if (i !== undefined) Object.assign(log[i]!, { end: Date.now(), ok: e.data.ok });
              });
            }
          };
        });
        const page = await context.newPage();
        const pageErrors: string[] = [];
        page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
        page.on("console", (m) => m.type() === "error" && pageErrors.push(m.text().slice(0, 300)));
        const cdp = await context.newCDPSession(page);
        await cdp.send("Network.enable");
        await page.goto(`${client.origin}/`);
        const frame = () => page.frameLocator("#panel");
        const panelFrame = () => page.frames().find((f) => f.url().startsWith(`${signIn.origin}/connect/panel/`))!;

        const downloads: { url: string; status: number; bytes: number; at: number }[] = [];
        page.on("response", async (response) => {
          if (!response.url().startsWith(signIn.origin)) return;
          const sizes = await response.request().sizes().catch(() => ({ responseBodySize: 0, responseHeadersSize: 0 }));
          downloads.push({ url: response.url().slice(signIn.origin.length), status: response.status(), bytes: sizes.responseBodySize, at: Date.now() });
        });

        /** Open the panel in a mode, at a real press, and time it until `usable` is on screen. */
        const open = async (mode: string, usable: string, how: "cold" | "again" | "kept", shownFirst?: string) => {
          if (how === "cold") await cdp.send("Network.clearBrowserCache");
          if (how === "kept") {
            // Hidden since the last opening, as a shell keeping it would: then shown again for this mode.
            await page.evaluate((signin) => {
              const kept = document.getElementById("panel") as HTMLIFrameElement;
              kept.contentWindow!.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hide" }, signin);
              kept.style.display = "none";
              (window as any).keep = true;
            }, signIn.origin);
            await sleep(300);
          } else await page.evaluate(() => ((window as any).keep = false, document.getElementById("slot")!.replaceChildren()));
          await page.evaluate((m) => ((window as any).nextMode = m), mode);
          downloads.length = 0;
          const askedFrom = asked.length;
          await page.mouse.click(60, 20);
          const pressedAt = (await page.evaluate(() => (window as any).pressedAt)) as number;
          let shownAt: number | null = null;
          if (shownFirst) {
            await frame().locator(shownFirst).waitFor({ state: "visible", timeout: 60_000 });
            shownAt = Date.now();
          }
          // Whichever of the screens named shows: the first of them that is visible.
          const reached = await frame()
            .locator(usable)
            .filter({ visible: true })
            .first()
            .waitFor({ state: "visible", timeout: 60_000 })
            .then(() => true)
            .catch(() => false);
          if (!reached) {
            // Never usable: what the panel said instead, and what went wrong in it, are kept for the report.
            const said = await panelFrame().evaluate(() => [...document.querySelectorAll("#status, #library-note, #ecash-note, #files-note, .connect-warning:not([hidden])")].map((e) => e.textContent?.trim()).filter(Boolean)).catch(() => []);
            // And what its worker was asked and when it answered, from the press: an action with no answer is where it stuck.
            const stuck = await panelFrame()
              .evaluate((from) => ((window as any).workerLog as { action: string; start: number; end?: number; ok?: boolean }[]).filter((w) => w.start >= from - 120_000).map((w) => ({ action: w.action, startMs: w.start - from, tookMs: w.end ? w.end - w.start : null, ok: w.ok })), pressedAt)
              .catch(() => []);
            const openRelayConnections = proxies.reduce((sum, wss) => sum + wss.clients.size, 0);
            results.push({ mode, how, usable, failed: true, said, errors: pageErrors.splice(0), worker: stuck, openRelayConnections });
            return null;
          }
          const usableAt = Date.now();
          const f = panelFrame();
          const paint = (await f.evaluate(() => {
            const fcp = performance.getEntriesByName("first-contentful-paint")[0];
            return fcp ? performance.timeOrigin + fcp.startTime : null;
          })) as number | null;
          const said = (await page.evaluate(() => (window as any).said)) as { t: string; at: number }[];
          const log = (await f.evaluate(() => (window as any).workerLog)) as { action: string; start: number; end?: number }[];
          const work = log.filter((w) => w.start >= pressedAt).map((w) => ({ action: w.action, startMs: w.start - pressedAt, tookMs: w.end ? w.end - w.start : null }));
          // Asked before the press and not answered by then: what a panel kept between openings may still be doing.
          const stillRunning = log.filter((w) => w.start < pressedAt && (!w.end || w.end > pressedAt)).map((w) => ({ action: w.action, startMs: w.start - pressedAt, endMs: w.end ? w.end - pressedAt : null }));
          const questions = asked.slice(askedFrom).map((q) => ({ relay: q.relay, atMs: q.at - pressedAt, kinds: q.kinds }));
          const result = {
            mode,
            how,
            usable,
            pressToReadyMs: how === "kept" ? null : (said.find((m) => m.t === "ready")?.at ?? 0) - pressedAt,
            pressToFirstPaintMs: how === "kept" ? null : paint ? Math.round(paint - pressedAt) : null,
            pressToSomethingShownMs: shownAt ? shownAt - pressedAt : null,
            pressToUsableMs: usableAt - pressedAt,
            files: downloads.length,
            downloadedBytes: downloads.reduce((sum, d) => sum + d.bytes, 0),
            notModified: downloads.filter((d) => d.status === 304).length,
            worker: work,
            ...(stillRunning.length ? { stillRunning } : {}),
            relayQuestions: questions.length,
            /** Connections to the test's relays still open when it was usable: a pool not closed shows here. */
            openRelayConnections: proxies.reduce((sum, wss) => sum + wss.clients.size, 0),
            /** When each kind was first and last asked, from the press: a load that asks in rounds shows here. */
            relayQuestionTimes: Object.entries(questions.reduce<Record<string, [number, number]>>((acc, q) => {
              const k = q.kinds.join(",");
              acc[k] = acc[k] ? [Math.min(acc[k]![0], q.atMs), Math.max(acc[k]![1], q.atMs)] : [q.atMs, q.atMs];
              return acc;
            }, {})).map(([k, [first, last]]) => `${k}@${first}-${last}`),
            relayQuestionsByKind: Object.entries(questions.reduce<Record<string, number>>((acc, q) => ((acc[q.kinds.join(",")] = (acc[q.kinds.join(",")] ?? 0) + 1), acc), {})).map(([k, n]) => `${k}:${n}`)
          };
          results.push(result);
          return result;
        };

        // ---- A throwaway account, made in the panel; its sign-in measured.
        await page.evaluate(() => ((window as any).nextMode = "account"));
        await page.mouse.click(60, 20);
        const widget = frame().locator("#account-slot bitlogin-auth");
        await widget.locator('[data-action="goto-create"]').waitFor({ timeout: 60_000 });
        // A press in the first 0.9 s after the panel is shown is ignored (§SW19.8), as a person's would be.
        await sleep(1000);
        await widget.locator('[data-action="goto-create"]').click();
        await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(`speed-${Date.now().toString(36)}`);
        await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
        await widget.locator("#saved-check").check();
        const signUpAt = Date.now();
        await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
        await widget.locator(".phrase-word").first().waitFor({ timeout: 120_000 });
        const derivedMs = Date.now() - signUpAt;
        const words = (await widget.locator(".phrase-word").allTextContents()).map((c) => c.replace(/^\s*\d+\.\s*/u, "").trim());
        await widget.locator('[data-action="goto-verify-phrase"]').click();
        const inputs = widget.locator('form[data-form="verify-phrase"] input');
        for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill(words[Number((await inputs.nth(i).getAttribute("name"))!.replace("confirm-", ""))]!);
        const publishAt = Date.now();
        await widget.locator('form[data-form="verify-phrase"] button[type="submit"]').click();
        await widget.locator(".pubkey").waitFor({ timeout: 120_000 });
        results.push({ mode: "sign-up", keyAndPhraseMs: derivedMs, publishAccountMs: Date.now() - publishAt });

        // ---- A wallet with a mint and some pretend sats, and a file server: so the panels have something to load.
        await open("wallet", '[data-ecash="setup"], [data-ecash="home"]', "again");
        await frame().locator("#ecash-mint").fill(mint.url);
        await frame().locator('#ecash-mint-form button[type="submit"]').click();
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await frame().locator("#ecash-go-fund").click();
        await frame().locator("#ecash-fund-amount").fill("100");
        const quoteAt = Date.now();
        await frame().locator('#ecash-fund-form button[type="submit"]').click();
        await frame().locator("#ecash-qr svg").waitFor({ timeout: 30_000 });
        results.push({ mode: "wallet: an invoice to add sats", tookMs: Date.now() - quoteAt });
        mint.payAllFunding();
        const claimAt = Date.now();
        await frame().locator("#ecash-note").filter({ hasText: "Added 100 sats." }).waitFor({ timeout: 60_000 });
        const claimLog = ((await panelFrame().evaluate(() => (window as any).workerLog)) as { action: string; start: number; end?: number }[])
          .filter((w) => w.start >= claimAt - 3000)
          .map((w) => ({ action: w.action, startMs: w.start - claimAt, tookMs: w.end ? w.end - w.start : null }));
        const mintAsked = mintCalls.filter((a) => a.at >= claimAt - 3000).map((a) => `${a.path}@${a.at - claimAt}`);
        results.push({ mode: "wallet: sats arrive after the invoice is paid", tookMs: Date.now() - claimAt, note: "polled every 2.5 s", worker: claimLog, mintAsked });
        // Past "Checking with your relays": the folders are shown before the server list is read, and only then is
        // the screen for choosing a server shown, for an account with none.
        await open("files", '[data-files="servers"], #files:not(.files-checking) [data-files="browse"]', "again");
        if (await frame().locator('[data-files="servers"]').isVisible()) {
          await frame().locator("#files-server").fill(blossom.url);
          const addAt = Date.now();
          await frame().locator('#files-server-form button[type="submit"]').click();
          await frame().locator(`#files-mine li[data-server="${blossom.url}"] .files-tag`).first().waitFor({ timeout: 60_000 });
          results.push({ mode: "files: a server added and checked", tookMs: Date.now() - addAt });
        }
        results.length = results.length; // setup done

        // ---- The measurements.
        for (const how of ["cold", "again", "again"] as const) {
          await open("account", "#account-slot bitlogin-auth .pubkey", how, "#account");
          await open("wallet", '[data-ecash="home"]', how, "#ecash");
          await open("files", '[data-files="browse"]', how, "#files");
          await open("library", "#library-list, #library-empty:not([hidden])", how, "#library");
        }
        // Library is usable when its note has changed from "Opening": measured apart, as the list is there from the start.
        await open("library", '#library-note:not(:text("Opening your receipts."))', "again", "#library");
        // Kept between openings, hidden and shown again (§SW19.8), as the shell would. Not for a build from before
        // `show` existed (BITLOGIN_SPEED_BEFORE).
        for (let i = 0; i < (process.env.BITLOGIN_SPEED_BEFORE ? 0 : 2); i++) {
          await open("account", "#account-slot bitlogin-auth .pubkey", "kept", "#account");
          await open("wallet", '[data-ecash="home"]', "kept", "#ecash");
          await open("files", '[data-files="browse"]', "kept", "#files");
          await open("library", "#library-list, #library-empty:not([hidden])", "kept", "#library");
        }
        // What is usable for changing, past "Checking with your relays": the wallet's buttons and the folders' tools.
        if (!process.env.BITLOGIN_SPEED_BEFORE) {
          await open("wallet", "#ecash-go-fund:enabled", "again", "#ecash");
          await open("files", '#files:not(.files-checking) [data-files="browse"]', "again", "#files");
        }
        await writeFile(OUT, JSON.stringify({ measuredAt: new Date().toISOString(), relays: { answeringConnectMs: ANSWERING_MS, answerMs: ANSWER_MS, refusing: REFUSING, silent: SILENT, connectedSilent: CONNECTED_SILENT }, mintAndHostDelayMs: 250, results }, null, 1));
        expect(results.length).toBeGreaterThan(10);
      } finally {
        await browser.close();
        await mint.close();
        await blossom.close();
      }
    },
    900_000
  );
});
