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
import { keepEcashTrial, loadEcash, rollEcash, setEcashMints, type EcashRelays } from "../worker/ecashStore.js";
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
  const control = { down: false };
  const relays = {
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent) {
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

describe("the review's findings, each failing before its mend", () => {
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
