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

  beforeAll(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    signIn = await serveDist(relays.map((r) => r.url).join(","));
    shell = await serveShell(signIn.origin);
    refusing = await startMockMint();
    signingAgain = await startMockMint({ signsAgain: true });
  }, 60_000);
  afterAll(async () => {
    signIn?.server.close();
    shell?.server.close();
    await refusing?.close();
    await signingAgain?.close();
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
          await page.mouse.click(60, 20);
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
          const Real = window.Worker;
          (window as any).Worker = class extends Real {
            constructor(url: string | URL, options?: WorkerOptions) {
              super(url, options);
              const send = this.postMessage.bind(this);
              this.postMessage = (message: any, ...rest: any[]) => {
                if (message && typeof message.action === "string") log.push(message.action);
                return (send as any)(message, ...rest);
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

        // ---- Before any press: both relay-kept, each with its trial offered, and no trial run by opening.
        await open("wallet");
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await expect.poll(async () => (await rowOf(refusing).locator(".seed").textContent()) ?? "", { timeout: 30_000 }).toBe("Relay-kept: your key alone can't restore sats here.");
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Relay-kept: your key alone can't restore sats here.");
        expect(await rowOf(refusing).locator("button").textContent()).toBe("Try this mint");
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
        await sleep(1000);
        await frame().locator("#ecash-trial-yes").click();
        await note().filter({ hasText: /^Passed: nothing spent\./u }).waitFor({ timeout: 60_000 });
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
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Signed the same thing twice when tried, so it stays relay-kept.");
        expect(await rowOf(signingAgain).locator("button").count()).toBe(0);

        if (process.env.BITLOGIN_SEED_SHOT) await page.screenshot({ path: process.env.BITLOGIN_SEED_SHOT, fullPage: true });

        // ---- Sats added at the mint that passed are seeded: Restore finds nothing this wallet lacks, and says so.
        await fund(refusing, 5, 11);
        await frame().locator("#ecash-go-restore").click();
        await frame().locator('[data-ecash="restore"]').waitFor({ state: "visible", timeout: 10_000 });
        expect(await frame().locator("#ecash-restore-gap").textContent()).toMatch(/^If a crash left a long gap in a lane/u);
        await frame().locator("#ecash-restore-yes").click();
        await note().filter({ hasText: /^Nothing more was found at your mints\./u }).waitFor({ timeout: 120_000 });
        expect((await frame().locator("#ecash-total").textContent())?.trim()).toBe("11");

        // ---- Opened again: what the trials found is kept with the wallet, and no trial runs.
        await open("wallet");
        await frame().locator('[data-ecash="home"]').waitFor({ state: "visible", timeout: 60_000 });
        await expect.poll(async () => (await rowOf(refusing).locator(".seed").textContent()) ?? "", { timeout: 30_000 }).toBe("Sats added here can be restored from your key.");
        expect(await rowOf(signingAgain).locator(".seed").textContent()).toBe("Signed the same thing twice when tried, so it stays relay-kept.");
      } finally {
        await browser.close();
      }
      expect(errors).toEqual([]);
    },
    900_000
  );
});
