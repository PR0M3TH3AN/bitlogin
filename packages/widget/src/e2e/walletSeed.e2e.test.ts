/**
 * The wallet's seed on its screen, in the panel as a shell frames it (docs/ecash-seed-counter.md, step 3): which mints
 * are restorable from the key, the trial at a press with its words before and after, and "Restore from your mints".
 * Runs where Playwright's Chromium is installed.
 *
 * Everything is on this machine: BitLogin's built pages, a client page that frames the panel, stand-in relays, and two
 * pretend mints, one that refuses an output it has signed before and one that signs it again. A throwaway account and
 * pretend sats only. Nothing here asks a real mint.
 */
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { startMockMint, type MockMint } from "../ecash/mockMint.js";

/** Where the screenshots for the owner are written, where asked: BITLOGIN_SEED_SHOTS=/some/dir. */
const SHOTS = process.env.BITLOGIN_SEED_SHOTS ?? "";
const DIST = process.env.BITLOGIN_WALLET_DIST ?? fileURLToPath(new URL("../../../demo/dist/", import.meta.url));
const MIME: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

let playwright: typeof import("playwright") | null = null;
try {
  playwright = await import("playwright");
  if (!existsSync(playwright.chromium.executablePath())) playwright = null;
} catch {
  playwright = null;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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

function serveShell(signIn: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(`<!doctype html><meta charset="utf-8"><title>a shell</title>
<button id="open" style="position:absolute;left:0;top:0;width:120px;height:40px">Open</button>
<div id="slot"></div>
<script type="module">
  const SIGNIN = "${signIn}";
  window.said = [];
  addEventListener("message", (e) => { if (e.origin === SIGNIN && e.data && e.data.bitlogin === "bitlogin-panel") window.said.push({ ...e.data, at: Date.now() }); });
  window.nextMode = "account";
  document.getElementById("open").addEventListener("click", () => {
    window.said = [];
    const panel = document.createElement("iframe");
    panel.id = "panel";
    panel.src = SIGNIN + "/connect/panel/";
    panel.style.cssText = "width:780px;height:900px;border:0";
    document.getElementById("slot").replaceChildren(panel);
    const again = setInterval(() => {
      if (window.said.some((m) => m.t === "ready")) return clearInterval(again);
      panel.contentWindow?.postMessage({ bitlogin: "bitlogin-panel", v: 1, t: "hello", mode: window.nextMode }, SIGNIN);
    }, 50);
  });
</script>`);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, origin: `http://127.0.0.1:${(server.address() as { port: number }).port}` })));
}

describe.skipIf(!playwright)("the wallet's seed on its screen", () => {
  let relays: MockRelay[] = [];
  let signIn: { server: Server; origin: string };
  let shell: { server: Server; origin: string };
  let refusing: MockMint;
  let signingAgain: MockMint;
  let unproven: MockMint;

  beforeAll(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    signIn = await serveDist(relays.map((r) => r.url).join(","));
    shell = await serveShell(signIn.origin);
    refusing = await startMockMint();
    signingAgain = await startMockMint({ signsAgain: true });
    unproven = await startMockMint({ noDleq: true });
  }, 60_000);
  afterAll(async () => {
    signIn?.server.close();
    shell?.server.close();
    await refusing?.close();
    await signingAgain?.close();
    await unproven?.close();
    await Promise.all(relays.map((r) => r.close()));
  });

  it(
    "names each mint, tries one only at a press, says what happened, and restores",
    async () => {
      const browser = await playwright!.chromium.launch();
      const errors: string[] = [];
      try {
        const context = await browser.newContext({ serviceWorkers: "block" });
        const page = await context.newPage();
        page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
        await page.goto(`${shell.origin}/`);
        const frame = () => page.frameLocator("#panel");
        const panelFrame = () => page.frames().find((f) => f.url().startsWith(`${signIn.origin}/connect/panel/`))!;
        /** The panel drops a press in its first 0.9 s after it is shown (§SW19.8): a press waits past that. */
        const pressable = async () => {
          await page.waitForFunction(() => (window as any).said.some((m: { t: string }) => m.t === "ready"), undefined, { timeout: 120_000 });
          const last = (await page.evaluate(() => Math.max(0, ...(window as any).said.filter((m: { t: string }) => m.t === "ready" || m.t === "size").map((m: { at: number }) => m.at)))) as number;
          const wait = last + 1100 - Date.now();
          if (wait > 0) await sleep(wait);
        };
        const open = async (mode: string) => {
          await page.evaluate((m) => ((window as any).nextMode = m), mode);
          // The shell's own button, pressed as the shell's: once the panel is framed it lies over the button, and a
          // click at the button's place would land in the panel instead of opening it anew.
          await page.evaluate(() => document.getElementById("open")!.click());
          if (mode !== "wallet") return;
          // Where the panel opens on the account page, the wallet is its own door there, as a person would press it.
          const first = frame().locator('[data-ecash="setup"], [data-ecash="home"], #open-ecash').filter({ visible: true }).first();
          await first.waitFor({ timeout: 60_000 });
          if ((await first.getAttribute("id")) === "open-ecash") {
            await pressable();
            await first.click();
          }
        };
        const note = () => frame().locator("#ecash-note");
        const rowOf = (mint: MockMint) => frame().locator("#ecash-mints li").filter({ hasText: new URL(mint.url).host });
        /** The worker's calls the page made: so a trial can be shown never to run on opening. */
        await context.addInitScript(() => {
          if (!location.pathname.startsWith("/connect/")) return;
          const log: string[] = [];
          (window as any).workerLog = log;
          (window as any).seedOutputs = [];
          /**
           * On the test's word (`holdReserves`), a tab's first reserve is held until the other tab has one waiting too,
           * and then both are sent in the same moment: two workers reserving at once from the one lane, as two tabs
           * adding together would. Only the lock in the workers keeps them apart then.
           */
          const channel = new BroadcastChannel("bitlogin-seed-test");
          let otherWaiting = false;
          let waiting: (() => void) | null = null;
          channel.onmessage = (e) => {
            if (e.data !== "waiting") return;
            otherWaiting = true;
            if (waiting) (waiting(), (waiting = null));
          };
          const Real = window.Worker;
          (window as any).Worker = class extends Real {
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              const send = this.postMessage.bind(this);
              const reserves = new Set<string>();
              // The counters each reserve was handed, from the worker's answer: two tabs must never get the same ones.
              this.addEventListener("message", (e: MessageEvent) => {
                if (e.data?.ok && reserves.has(e.data.id)) (window as any).seedOutputs.push({ from: e.data.result.from, n: e.data.result.next - e.data.result.from });
              });
              this.postMessage = (message: any, ...rest: any[]) => {
                if (message && typeof message.action === "string") log.push(message.action);
                if (message?.action !== "ecashReserve") return (send as any)(message, ...rest);
                reserves.add(message.id);
                if (!(window as any).holdReserves) return (send as any)(message, ...rest);
                (window as any).holdReserves = false;
                channel.postMessage("waiting");
                if (otherWaiting) return (send as any)(message, ...rest);
                waiting = () => (send as any)(message, ...rest);
              };
            }
          };
        });

        // ---- A throwaway account, made in the panel.
        await open("account");
        const widget = frame().locator("#account-slot bitlogin-auth");
        await widget.locator('[data-action="goto-create"]').waitFor({ timeout: 60_000 });
        await pressable();
        await widget.locator('[data-action="goto-create"]').click();
        await widget.locator('form[data-form="create-name"] input[name="loginName"]').fill(`seed-${Date.now().toString(36)}`);
        await widget.locator('form[data-form="create-name"] button[type="submit"]').click();
        await widget.locator("#saved-check").check({ timeout: 120_000 });
        await widget.locator('form[data-form="create-credential"] button[type="submit"]').click();
        await widget
          .locator(".phrase-word")
          .first()
          .waitFor({ timeout: 120_000 })
          .catch(async (err) => {
            // What the account page showed instead: the widget draws in a shadow root.
            const said = (await frame().locator("#account-slot bitlogin-auth").evaluate((e) => (e as HTMLElement).shadowRoot?.textContent ?? e.textContent ?? "").catch(() => "")) as string;
            throw new Error(`No recovery phrase came. The account page said: ${said.replace(/\s+/gu, " ").slice(0, 600)} | ${(err as Error).message.slice(0, 80)}`);
          });
        const words = (await widget.locator(".phrase-word").allTextContents()).map((c) => c.replace(/^\s*\d+\.\s*/u, "").trim());
        await widget.locator('[data-action="goto-verify-phrase"]').click();
        const inputs = widget.locator('form[data-form="verify-phrase"] input');
        for (let i = 0; i < (await inputs.count()); i++) await inputs.nth(i).fill(words[Number((await inputs.nth(i).getAttribute("name"))!.replace("confirm-", ""))]!);
        await widget.locator('form[data-form="verify-phrase"] button[type="submit"]').click();
        await widget.locator(".pubkey").waitFor({ timeout: 120_000 });

        // ---- A wallet with both mints, sats at each.
        await open("wallet");
        await frame()
          .locator('[data-ecash="setup"]')
          .waitFor({ state: "visible", timeout: 60_000 })
          .catch(async (err) => {
            const said = await panelFrame().evaluate(() => document.body.innerText.replace(/\s+/gu, " ").slice(0, 600));
            throw new Error(`The wallet's first screen never came. The panel said: ${said} | ${(err as Error).message.slice(0, 80)}`);
          });
        await frame().locator("#ecash-mint").fill(refusing.url);
        await pressable();
        await frame().locator('#ecash-mint-form button[type="submit"]').click();
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        const fund = async (mint: MockMint, sats: number, total: number) => {
          await frame().locator("#ecash-go-fund").click();
          await frame().locator("#ecash-fund-amount").fill(String(sats));
          if (await frame().locator("#ecash-fund-mint").isVisible()) await frame().locator("#ecash-fund-mint").selectOption(mint.url);
          await frame().locator('#ecash-fund-form button[type="submit"]').click();
          await frame().locator("#ecash-qr svg").waitFor({ timeout: 30_000 });
          mint.payAllFunding();
          await note().filter({ hasText: `Added ${sats} ${sats === 1 ? "sat" : "sats"}.` }).waitFor({ timeout: 60_000 });
          await expect.poll(async () => (await frame().locator("#ecash-total").textContent())?.trim(), { timeout: 30_000 }).toBe(String(total));
        };
        await fund(refusing, 4, 4);
        await frame().locator("#ecash-go-mint").click();
        await frame().locator("#ecash-mint").fill(signingAgain.url);
        await frame().locator('#ecash-mint-form button[type="submit"]').click();
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await fund(signingAgain, 3, 7);
        // A third mint, that doesn't prove what it signs (no DLEQ): never tried, never restored from, and it says so.
        await frame().locator("#ecash-go-mint").click();
        await frame().locator("#ecash-mint").fill(unproven.url);
        await frame().locator('#ecash-mint-form button[type="submit"]').click();
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });

        // ---- Before any press: both relay-kept, each with its trial offered, and no trial run by opening.
        await open("wallet");
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await expect.poll(async () => (await rowOf(refusing).locator(".seed").textContent()) ?? "", { timeout: 30_000 }).toBe("Relay-kept: your key alone can't restore sats here.");
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Relay-kept: your key alone can't restore sats here.");
        expect(await rowOf(refusing).locator("button").textContent()).toBe("Try this mint");
        await expect.poll(async () => (await rowOf(unproven).locator(".seed").textContent()) ?? "", { timeout: 30_000 }).toBe("This mint doesn't prove what it signs, so your key can't restore sats here. They are kept on relays.");
        expect(await rowOf(unproven).locator("button").count()).toBe(0);
        expect(await frame().locator("#ecash-go-restore").isVisible()).toBe(true);
        const calls = (await panelFrame().evaluate(() => (window as any).workerLog)) as string[];
        expect(calls).not.toContain("ecashKeepTrial");
        expect(refusing.signedCount() + signingAgain.signedCount()).toBeGreaterThan(0);
        const signedBefore = [refusing.signedCount(), signingAgain.signedCount()];

        // ---- The trial's words, before the press; nothing is signed by opening the screen.
        await pressable();
        await rowOf(refusing).locator("button").click();
        await frame().locator('[data-ecash="trial"]').waitFor({ state: "visible", timeout: 10_000 });
        const before = (await frame().locator('[data-ecash="trial"]').textContent()) ?? "";
        expect(before).toContain(new URL(refusing.url).host);
        expect(before).toContain("It may cost that 1 sat, and only if the mint turns out to be one that can't be trusted with your key this way. Otherwise nothing is spent.");
        expect([refusing.signedCount(), signingAgain.signedCount()]).toEqual(signedBefore);
        if (SHOTS) await page.locator("#panel").screenshot({ path: join(SHOTS, "trial-before-the-press.png") });
        await sleep(1000);
        await frame().locator("#ecash-trial-yes").click();
        await note().filter({ hasText: /^Passed: nothing spent\./u }).waitFor({ timeout: 60_000 });
        // For the owner: one mint restorable from the key, one relay-kept with its trial offered.
        if (SHOTS) await page.locator("#panel").screenshot({ path: join(SHOTS, "wallet-one-seeded-one-relay-kept.png") });
        expect((await frame().locator("#ecash-total").textContent())?.trim()).toBe("7");
        expect(await rowOf(refusing).locator(".seed").textContent()).toBe("Sats added here can be restored from your key.");
        expect(await rowOf(refusing).locator("button").count()).toBe(0);

        // ---- The mint that signs again: the words after, and the one sat.
        await rowOf(signingAgain).locator("button").click();
        await frame().locator('[data-ecash="trial"]').waitFor({ state: "visible", timeout: 10_000 });
        await sleep(1000);
        await frame().locator("#ecash-trial-yes").click();
        await note().filter({ hasText: /signed the same thing twice/u }).waitFor({ timeout: 60_000 });
        expect((await note().textContent())?.trim()).toBe("This mint signed the same thing twice. 1 sat was spent finding out, and this mint stays relay-kept.");
        expect((await frame().locator("#ecash-total").textContent())?.trim()).toBe("6");
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Failed its trial, so it stays relay-kept.");
        expect(await rowOf(signingAgain).locator("button").count()).toBe(0);

        // ---- Sats added at the mint that passed are seeded: Restore finds nothing this wallet lacks, and says so.
        await fund(refusing, 5, 11);
        await frame().locator("#ecash-go-restore").click();
        await frame().locator('[data-ecash="restore"]').waitFor({ state: "visible", timeout: 10_000 });
        expect(await frame().locator("#ecash-restore-gap").textContent()).toMatch(/^If a crash left a long gap in a lane/u);
        await frame().locator("#ecash-restore-yes").click();
        await note().filter({ hasText: /^Nothing more was found at your mints\./u }).waitFor({ timeout: 120_000 });
        expect((await note().textContent())?.trim()).toBe(`Nothing more was found at your mints. Not restored from: ${new URL(unproven.url).host}: it doesn't prove what it signs, so it isn't restored from.`);
        expect((await frame().locator("#ecash-total").textContent())?.trim()).toBe("11");

        // ---- Opened again: what the trials found is kept with the wallet, and no trial runs.
        await open("wallet");
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await expect.poll(async () => (await rowOf(refusing).locator(".seed").textContent()) ?? "", { timeout: 30_000 }).toBe("Sats added here can be restored from your key.");
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Failed its trial, so it stays relay-kept.");

        // ---- Two tabs of this browser, adding at the same moment at the mint that passed (rule 3a). They share this
        // browser's lane: under navigator.locks each is handed its own counters, so the mint never sees one twice.
        const second = await context.newPage();
        second.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
        await second.goto(`${shell.origin}/`);
        const tabs = [
          { page, frame: () => page.frameLocator("#panel"), panel: panelFrame },
          { page: second, frame: () => second.frameLocator("#panel"), panel: () => second.frames().find((f) => f.url().startsWith(`${signIn.origin}/connect/panel/`))! }
        ];
        const pressableIn = async (p: typeof page) => {
          await p.waitForFunction(() => (window as any).said.some((m: { t: string }) => m.t === "ready"), undefined, { timeout: 120_000 });
          const last = (await p.evaluate(() => Math.max(0, ...(window as any).said.filter((m: { t: string }) => m.t === "ready" || m.t === "size").map((m: { at: number }) => m.at)))) as number;
          const wait = last + 1100 - Date.now();
          if (wait > 0) await sleep(wait);
        };
        for (const tab of tabs) {
          await tab.page.evaluate(() => ((window as any).nextMode = "wallet"));
          await tab.page.evaluate(() => document.getElementById("open")!.click());
          const first = tab.frame().locator('[data-ecash="home"], #open-ecash').filter({ visible: true }).first();
          await first.waitFor({ timeout: 60_000 });
          if ((await first.getAttribute("id")) === "open-ecash") {
            await pressableIn(tab.page);
            await first.click();
          }
          await tab.frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
          await expect.poll(async () => (await tab.frame().locator("#ecash-total").textContent())?.trim(), { timeout: 30_000 }).toBe("11");
          await pressableIn(tab.page);
        }
        const amounts = [6, 7];
        for (const [i, tab] of tabs.entries()) {
          await tab.frame().locator("#ecash-go-fund").click();
          await tab.frame().locator("#ecash-fund-amount").fill(String(amounts[i]));
          await tab.frame().locator("#ecash-fund-mint").selectOption(refusing.url);
          await tab.frame().locator('#ecash-fund-form button[type="submit"]').click();
          await tab.frame().locator("#ecash-qr svg").waitFor({ timeout: 30_000 });
        }
        const callsBefore = await Promise.all(tabs.map(async (t) => ((await t.panel().evaluate(() => (window as any).workerLog.length)) as number)));
        const outputsBefore = await Promise.all(tabs.map(async (t) => ((await t.panel().evaluate(() => ((window as any).holdReserves = true, (window as any).seedOutputs.length))) as number)));
        const refusedBefore = refusing.refusedCount();
        // Both invoices paid at once: each tab claims its sats on its next look, within the same second.
        refusing.payAllFunding();
        await Promise.all(tabs.map((t, i) => t.frame().locator("#ecash-note").filter({ hasText: `Added ${amounts[i]} sats.` }).waitFor({ timeout: 60_000 })));
        // Each tab added by the seed: its worker made the outputs.
        for (const [i, t] of tabs.entries()) {
          const made = ((await t.panel().evaluate(() => (window as any).workerLog)) as string[]).slice(callsBefore[i]);
          expect(made, `tab ${i + 1}`).toContain("ecashReserve");
        }
        // Never the same counters in both tabs, though both workers reserved in the same moment.
        const handed = await Promise.all(tabs.map(async (t, i) => ((await t.panel().evaluate(() => (window as any).seedOutputs)) as { from: number; n: number }[]).slice(outputsBefore[i])));
        expect(handed[0]!.length && handed[1]!.length).toBeGreaterThan(0);
        const overlaps = handed[0]!.filter((a) => handed[1]!.some((b) => a.from < b.from + b.n && b.from < a.from + a.n));
        expect(overlaps, JSON.stringify(handed)).toEqual([]);
        // Nothing asked of the mint twice, and every sat there.
        expect(refusing.refusedCount() - refusedBefore).toBe(0);
        await tabs[1]!.page.evaluate(() => ((window as any).nextMode = "wallet"));
        await tabs[1]!.page.evaluate(() => document.getElementById("open")!.click());
        const firstAgain = tabs[1]!.frame().locator('[data-ecash="home"], #open-ecash').filter({ visible: true }).first();
        await firstAgain.waitFor({ timeout: 60_000 });
        if ((await firstAgain.getAttribute("id")) === "open-ecash") {
          await pressableIn(tabs[1]!.page);
          await firstAgain.click();
        }
        await expect.poll(async () => (await tabs[1]!.frame().locator("#ecash-total").textContent())?.trim(), { timeout: 60_000 }).toBe("24");
        await pressableIn(tabs[1]!.page);
        await tabs[1]!.frame().locator("#ecash-go-restore").click();
        await tabs[1]!.frame().locator("#ecash-restore-yes").click();
        await tabs[1]!.frame().locator("#ecash-note").filter({ hasText: /^Nothing more was found at your mints\./u }).waitFor({ timeout: 120_000 });
        expect((await tabs[1]!.frame().locator("#ecash-total").textContent())?.trim()).toBe("24");
      } finally {
        await browser.close();
      }
      expect(errors).toEqual([]);
    },
    900_000
  );
});
