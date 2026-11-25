/**
 * The orchestrator's review of the seed (2026-11-25), each finding as a case that failed before its mend: restore
 * across a keyset rotation (1), past a gap the wallet record covers (2), and into the trial's own counters (5); the
 * trial's sat kept, and spent inputs never passed (4); a proof never counted twice (6); a trial whose relay write
 * failed kept and sent again (9). Against the mock mints, with the worker's store over relays held in memory.
 * Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { keepEcashTrial, loadEcash, peekEcash, rollEcash, setEcashMints, type EcashRelays } from "../worker/ecashStore.js";
import { Wallet } from "@cashu/cashu-ts";
import { ecashSeed } from "../worker/ecashSeed.js";
import { forwardLane, readLane } from "../worker/ecashLanes.js";
import { createEcashWallet, type EcashStore } from "./wallet.js";
import { startMockMint, type MockMint, type MockMintOptions } from "./mockMint.js";
import { standInLock, standInSeedWorker } from "./seedWorkerStandIn.js";

/** One browser's navigator.locks, stood in: Node hasn't. */
const lock = standInLock();

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});
async function mintWith(options: MockMintOptions = {}) {
  const mint = await startMockMint(options);
  mints.push(mint);
  return mint;
}

/** Relays held in memory, shared by every device of one account; `down` makes them refuse every write. */
function relaysOf() {
  const events = new Map<string, NostrEvent>();
  const control = { down: false, delayMs: 0 };
  const relays = {
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent) {
      if (control.delayMs) await new Promise((done) => setTimeout(done, control.delayMs));
      if (control.down) return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: false, message: "blocked" } })) as RelayPublishOutcome[];
      if (event.kind === 5) for (const tag of event.tags) if (tag[0] === "e") events.delete(tag[1]!);
      events.set(event.id, event);
      return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
    }
  } as EcashRelays;
  return { events, relays, control };
}

/** One device of an account: its own browser storage, the account's relays, the account's seed. */
function device(account: { signer: NostrSigner; seed: Uint8Array; relays: EcashRelays }, browser?: { kv: InMemoryKeyValueStore }) {
  const deps = { signer: account.signer, store: browser?.kv ?? new InMemoryKeyValueStore(), relays: account.relays, newKey: () => "cd".repeat(32) };
  const store: EcashStore = {
    load: () => loadEcash(deps),
    setMints: (m) => setEcashMints(deps, m),
    roll: (roll) => rollEcash(deps, roll),
    seed: standInSeedWorker({ signer: account.signer, store: deps.store, seed: account.seed, lock }),
    keepTrial: (t: { mint: string; keysetId: string; outcome: "passed" | "failed" }) => keepEcashTrial(deps, t)
  };
  const wallet = createEcashWallet(store, { locks: true });
  /** Counters burned with nothing signed, as crashes in a row would leave them in this device's lane. */
  const burn = async (keysetId: string, n: number) => {
    const s = (await readLane(deps, keysetId))!;
    await forwardLane({ ...deps, seed: () => account.seed.slice(), lock }, keysetId, s.next + n);
  };
  return { wallet, store, burn, deps, browser: { kv: deps.store } };
}
function newAccount() {
  const shared = relaysOf();
  return { signer: new NostrSigner(generatePrivateKey()), seed: ecashSeed(generatePrivateKey()), ...shared };
}
async function add(wallet: ReturnType<typeof createEcashWallet>, mint: MockMint, sats: number) {
  const funding = await wallet.fund(mint.url, sats);
  mint.payFunding(funding.quote);
  expect(await wallet.claim(funding)).toBe(true);
}
/** A wallet holding `sats` at a mint that passed the trial, the trial's sat among them. */
async function seededWallet(account: ReturnType<typeof newAccount>, mint: MockMint) {
  const one = device(account);
  await one.wallet.open();
  await one.wallet.addMint(mint.url);
  await add(one.wallet, mint, 1);
  expect(await one.wallet.tryMint(mint.url)).toEqual({ outcome: "passed", cost: 0 });
  return one;
}
const TOKEN_KIND = 7375;
/** Every token record gone from the relays: what is left is the wallet record, and the mint. */
const loseTokens = (account: ReturnType<typeof newAccount>) => {
  for (const [id, e] of account.events) if (e.kind === TOKEN_KIND || e.kind === 5) account.events.delete(id);
};

// Each restore asks a mint about thousands of outputs, made in the worker: a minute or more under load.
describe("the review's findings, each failing before its mend", { timeout: 120_000 }, () => {
  it("1: restore finds what was added under a keyset the mint has since rotated away from", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = await seededWallet(account, mint);
    await add(one.wallet, mint, 13);
    mint.rotate();
    loseTokens(account);
    const two = device(account);
    await two.wallet.open();
    expect(two.wallet.balance()).toBe(0);
    const restored = await two.wallet.restore();
    // The 13 added and the trial's sat, both under the old keyset.
    expect(restored.found).toBe(14);
  }, 120_000);

  it("2 and 5: restore goes past a gap the wallet record covers, and into the trial's counters", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = await seededWallet(account, mint);
    await add(one.wallet, mint, 13);
    // More counters burned than restore would look past with nothing to go on.
    await one.burn((await import("@cashu/cashu-ts").then(async ({ Wallet }) => { const w = new Wallet(mint.url, { unit: "sat" }); await w.loadMint(); return w.keysetId; })), 400);
    await add(one.wallet, mint, 8);
    loseTokens(account);
    const two = device(account);
    await two.wallet.open();
    expect((await two.wallet.restore()).found).toBe(22);
  }, 120_000);

  it("4: the trial's sat is kept when its second swap fails for another reason", async () => {
    const mint = await mintWith({ swapTrouble: (n) => (n === 2 ? "fail-before" : "ok") });
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 1);
    await expect(one.wallet.tryMint(mint.url)).rejects.toThrow();
    await one.wallet.open();
    expect(one.wallet.balance()).toBe(1);
    expect(one.wallet.state().trials ?? []).toEqual([]);
  }, 60_000);

  it("4 and 5: a trial whose first answer was lost is found again by restore", async () => {
    const mint = await mintWith({ swapTrouble: (n) => (n === 1 ? "act-then-fail" : "ok") });
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 1);
    await expect(one.wallet.tryMint(mint.url)).rejects.toThrow();
    expect((await one.wallet.restore()).found).toBe(1);
    expect(one.wallet.balance()).toBe(1);
  }, 120_000);

  it("4: a mint that spends the inputs before refusing the outputs doesn't pass", async () => {
    const mint = await mintWith({ spendsThenRefuses: true });
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 1);
    expect(await one.wallet.tryMint(mint.url)).toEqual({ outcome: "failed", cost: 1 });
    expect(await one.wallet.seededMint(mint.url)).toBe(false);
  }, 60_000);

  it("6: a proof restored in one tab while another tab holds it unsent is counted once", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = await seededWallet(account, mint);
    // A second tab of the same browser, opened before the first adds.
    const two = device(account, one.browser);
    await two.wallet.open();
    // Added in the first tab while no relay takes a record: kept in this browser only.
    account.control.down = true;
    await add(one.wallet, mint, 13);
    account.control.down = false;
    const restored = await two.wallet.restore();
    expect(restored.found).toBe(13);
    expect(two.wallet.balance()).toBe(14);
    await two.wallet.open();
    expect(two.wallet.balance()).toBe(14);
  }, 120_000);

  it("9: a trial whose relay write failed is kept, and sent again at the next opening", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 1);
    account.control.down = true;
    expect(await one.wallet.tryMint(mint.url)).toEqual({ outcome: "passed", cost: 0 });
    account.control.down = false;
    await one.wallet.open();
    expect(await one.wallet.seededMint(mint.url)).toBe(true);
    // Another device reads it from the relays.
    const two = device(account);
    await two.wallet.open();
    expect(await two.wallet.seededMint(mint.url)).toBe(true);
  }, 60_000);
});

// Each restore asks a mint about thousands of outputs, made in the worker: a minute or more under load.
describe("the second review's findings, each failing before its mend", { timeout: 120_000 }, () => {
  it("1: a mint that doesn't prove its signatures (no DLEQ) is neither tried nor restored from, and says so", async () => {
    const mint = await mintWith({ noDleq: true });
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 2);
    const signed = mint.signedCount();
    expect(await one.wallet.tryMint(mint.url)).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect(mint.signedCount()).toBe(signed);
    const restored = await one.wallet.restore();
    expect(restored.found).toBe(0);
    expect(restored.mints[0]?.trouble).toMatch(/doesn't prove what it signs/u);
  }, 60_000);

  it("a failed trial whose sat the mint left unspent keeps it", async () => {
    const mint = await mintWith({ signsAgain: true, swapsWithoutTaking: true });
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 1);
    expect(await one.wallet.tryMint(mint.url)).toEqual({ outcome: "failed", cost: 0 });
    await one.wallet.check();
    expect(one.wallet.balance()).toBe(1);
  }, 60_000);

  it("a record whose every proof another record holds is deleted, not left hidden", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    await add(one.wallet, mint, 13);
    // Another device, knowing nothing yet, writes the same proofs again, as an older build could.
    const two = device(account);
    await two.store.roll({ destroy: [], keep: [{ mint: mint.url, proofs: one.wallet.state().tokens.flatMap((t) => t.proofs) }] });
    expect([...account.events.values()].filter((e) => e.kind === TOKEN_KIND)).toHaveLength(2);
    const three = device(account);
    await three.wallet.open();
    expect(three.wallet.balance()).toBe(13);
    expect([...account.events.values()].filter((e) => e.kind === TOKEN_KIND)).toHaveLength(1);
  }, 60_000);

  it("a seeded add on a device with an older mint list doesn't send that list over a newer one", async () => {
    const [m1, m2] = [await mintWith(), await mintWith()];
    const account = newAccount();
    const one = await seededWallet(account, m1);
    const two = device(account);
    await two.wallet.open();
    expect(await two.wallet.seededMint(m1.url)).toBe(true);
    // The first device adds a mint: the relays' record names both. The second still holds the older list.
    await one.wallet.addMint(m2.url);
    await add(two.wallet, m1, 5);
    const three = device(account);
    await three.wallet.open();
    expect(three.wallet.state().mints).toEqual([m1.url, m2.url]);
    // And the counters the second device's add reached are in the record.
    expect((three.wallet.state().counters ?? []).length).toBeGreaterThan(0);
  }, 120_000);
});

// Each restore asks a mint about thousands of outputs, made in the worker: a minute or more under load.
describe("the third review's findings, each failing before its mend", { timeout: 120_000 }, () => {
  /** Proofs of a mint, made by an ordinary wallet: nothing of any seed. */
  async function proofsAt(mint: MockMint, sats: number) {
    const w = new Wallet(mint.url, { unit: "sat" });
    await w.loadMint();
    const quote = await w.createMintQuoteBolt11(sats);
    mint.payAllFunding();
    return (await w.ops.mintBolt11(sats, quote).run()).map((p) => ({ id: p.id, amount: Number(p.amount), secret: p.secret, C: p.C }));
  }

  it("4: two tabs rolling over at once on one browser's storage keep what each wrote", async () => {
    const mint = await mintWith();
    const account = newAccount();
    const one = device(account);
    await one.wallet.open();
    await one.wallet.addMint(mint.url);
    const two = device(account, one.browser);
    const [first, second] = [await proofsAt(mint, 3), await proofsAt(mint, 4)];
    // Relays slow to answer: each tab's roll is between its two writes when the other's begins.
    account.control.delayMs = 60;
    await Promise.all([
      rollEcash(one.deps, { destroy: [], keep: [{ mint: mint.url, proofs: first }] }),
      rollEcash(two.deps, { destroy: [], keep: [{ mint: mint.url, proofs: second }] })
    ]);
    account.control.delayMs = 0;
    const kept = await peekEcash(one.deps);
    expect(kept.tokens.flatMap((t) => t.proofs).reduce((n, p) => n + p.amount, 0)).toBe(7);
  }, 60_000);

  it("5a: a record is deleted as a duplicate only where the relays holding it also hold the record that covers it", async () => {
    const mint = await mintWith();
    const signer = new NostrSigner(generatePrivateKey());
    const r1 = new Map<string, NostrEvent>();
    const r2 = new Map<string, NostrEvent>();
    const relays = {
      relayUrls: ["wss://one.example", "wss://two.example"],
      async queryQuorum(filter: NostrFilter) {
        const pick = (m: Map<string, NostrEvent>) => [...m.values()].filter((e) => (filter.kinds ?? []).includes(e.kind));
        return { outcomes: [{ events: pick(r1) }, { events: pick(r2) }], respondedCount: 2 };
      },
      async publishAll(event: NostrEvent) {
        for (const m of [r1, r2]) {
          if (event.kind === 5) for (const tag of event.tags) if (tag[0] === "e") m.delete(tag[1]!);
          m.set(event.id, event);
        }
        return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
      }
    } as EcashRelays;
    const deps = (kv = new InMemoryKeyValueStore()) => ({ signer, store: kv, relays, newKey: () => "cd".repeat(32) });
    const proofs = await proofsAt(mint, 5);
    // The older record, on both relays; then a newer one with the same proofs, which the second relay lost.
    await rollEcash(deps(), { destroy: [], keep: [{ mint: mint.url, proofs }] });
    const older = [...r2.values()].find((e) => e.kind === 7375)!;
    await new Promise((done) => setTimeout(done, 1100));
    await rollEcash(deps(), { destroy: [], keep: [{ mint: mint.url, proofs }] });
    const newer = [...r1.values()].find((e) => e.kind === 7375 && e.id !== older.id)!;
    r2.delete(newer.id);
    await loadEcash(deps());
    // The second relay's only record of those proofs stays.
    expect(r2.has(older.id)).toBe(true);
  }, 60_000);

  it("1: a lane the wallet record names as used is not drawn, though the mint shows its start empty", async () => {
    const { createSeededMint } = await import("./seededMint.js");
    const mint = await mintWith();
    const account = newAccount();
    const w = new Wallet(mint.url, { unit: "sat" });
    await w.loadMint();
    const seed = standInSeedWorker({ signer: account.signer, store: new InMemoryKeyValueStore(), seed: account.seed, lock });
    // Lane 5 would be drawn first; the record says this account has gone 300 into it.
    const minter = createSeededMint({ wallet: w, seed, random: (() => { let i = 0; return () => (i++ === 0 ? 5.5 / 32 : 0); })(), used: [5] });
    expect((await minter.lane())!.lane).not.toBe(5);
  }, 60_000);
});
