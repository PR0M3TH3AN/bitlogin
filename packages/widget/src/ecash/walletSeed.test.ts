/**
 * The wallet adding sats by the seed (docs/ecash-seed-counter.md, step 3): only at a mint whose keyset passed the
 * trial, only at the person's press, and only where the browser can keep two tabs apart. Against the mock mints, with
 * the worker's store over relays held in memory. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "@cashu/cashu-ts";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { keepEcashTrial, loadEcash, rollEcash, setEcashMints, type EcashRelays } from "../worker/ecashStore.js";
import { ecashSeed } from "../worker/ecashSeed.js";
import { readCounters } from "../worker/ecashLanes.js";
import { createEcashWallet, type EcashStore } from "./wallet.js";
import { startMockMint, type MockMint, type MockMintOptions } from "./mockMint.js";
import { restoreFromMint } from "./seedRestore.js";
import { standInLock, standInSeedWorker } from "./seedWorkerStandIn.js";

/** The page has navigator.locks (stood in: Node hasn't), as every current browser does. */
const LOCKS = { locks: true };

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

/** One account's wallet in one browser: the worker's store, its seed, and its lanes kept in this browser. */
function account(opts: { seed?: boolean; from?: Uint8Array } = {}) {
  const signer = new NostrSigner(generatePrivateKey());
  const seed = opts.from ?? ecashSeed(generatePrivateKey());
  const events = new Map<string, NostrEvent>();
  const relays = {
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent) {
      if (event.kind === 5) for (const tag of event.tags) if (tag[0] === "e") events.delete(tag[1]!);
      events.set(event.id, event);
      return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
    }
  } as EcashRelays;
  const deps = { signer, store: new InMemoryKeyValueStore(), relays, newKey: () => "cd".repeat(32) };
  const lock = standInLock();
  const storeWith = (workerLock: typeof lock | null): EcashStore => ({
    load: () => loadEcash(deps),
    setMints: (m) => setEcashMints(deps, m),
    roll: (roll) => rollEcash(deps, roll),
    ...(opts.seed === false
      ? {}
      : {
          seed: standInSeedWorker({ signer, store: deps.store, seed, lock: workerLock }),
          keepTrial: (t: { mint: string; keysetId: string; outcome: "passed" | "failed" }) => keepEcashTrial(deps, t)
        })
  });
  /** How many keysets this browser has taken a lane in. */
  const lanesUsed = async () => Object.keys(await readCounters(deps)).length;
  /** The same browser's storage and relays, in a browser with no navigator.locks: its worker has none either. */
  const withoutLocks = () => storeWith(null);
  return { store: storeWith(lock), seed, lanesUsed, withoutLocks };
}

async function mintWith(options: MockMintOptions = {}) {
  const mint = await startMockMint(options);
  mints.push(mint);
  return mint;
}
async function add(wallet: ReturnType<typeof createEcashWallet>, mint: MockMint, sats: number) {
  const funding = await wallet.fund(mint.url, sats);
  mint.payFunding(funding.quote);
  expect(await wallet.claim(funding)).toBe(true);
}
/** What the mint still owes this seed, found from the key alone: no relay, no wallet record. The trial's sat too. */
async function restorable(mint: MockMint, seed: Uint8Array) {
  const wallet = new Wallet(mint.url, { unit: "sat" });
  await wallet.loadMint();
  const { proofs } = await restoreFromMint({ wallet, seed: standInSeedWorker({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed, lock: standInLock() }) });
  return proofs.reduce((n, p) => n + Number(p.amount), 0);
}

// Each restore asks a mint about thousands of outputs, made in the worker: a minute or more under load.
describe("the wallet adds by the seed only at a mint that passed the trial", { timeout: 120_000 }, () => {
  it("adds as before at a mint not yet tried, and opening the wallet tries nothing", async () => {
    const mint = await mintWith();
    const { store, seed, lanesUsed } = account();
    const wallet = createEcashWallet(store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    await add(wallet, mint, 5);
    await wallet.open();
    expect(wallet.state().trials ?? []).toEqual([]);
    expect(await wallet.seededMint(mint.url)).toBe(false);
    expect(await lanesUsed()).toBe(0);
    expect(await restorable(mint, seed)).toBe(0);
    expect(wallet.balance()).toBe(5);
  });

  it("passes a refusing mint at a press, keeps the sat, and from then adds what the key alone brings back", async () => {
    const mint = await mintWith();
    const { store, seed, lanesUsed } = account();
    const wallet = createEcashWallet(store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    // 4 sats: no 1-sat proof, so one is split off for the trial.
    await add(wallet, mint, 4);
    expect(await wallet.tryMint(mint.url)).toEqual({ outcome: "passed", cost: 0 });
    expect(wallet.balance()).toBe(4);
    expect(wallet.state().trials).toMatchObject([{ mint: mint.url, outcome: "passed" }]);
    expect(await wallet.seededMint(mint.url)).toBe(true);
    await add(wallet, mint, 21);
    expect(wallet.balance()).toBe(25);
    expect(await lanesUsed()).toBe(1);
    // The 21 added, and the trial's sat: made at a trial counter, which restore follows too.
    expect(await restorable(mint, seed)).toBe(22);
    // Another device of the account reads the trial with the wallet record, and the sats.
    const other = createEcashWallet(store, LOCKS);
    await other.open();
    expect(other.balance()).toBe(25);
    expect(await other.seededMint(mint.url)).toBe(true);
    // What it holds is spendable: checked with the mint, all of it unspent.
    await other.check();
    expect(other.balance()).toBe(25);
  });

  it("fails a mint that signs again, at the cost of exactly one sat, and goes on adding as before", async () => {
    const mint = await mintWith({ signsAgain: true });
    const { store, seed, lanesUsed } = account();
    const wallet = createEcashWallet(store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    await add(wallet, mint, 3);
    expect(await wallet.tryMint(mint.url)).toEqual({ outcome: "failed", cost: 1 });
    expect(wallet.balance()).toBe(2);
    expect(wallet.state().trials).toMatchObject([{ mint: mint.url, outcome: "failed" }]);
    await add(wallet, mint, 8);
    expect(wallet.balance()).toBe(10);
    expect(await lanesUsed()).toBe(0);
    expect(await restorable(mint, seed)).toBe(0);
    await wallet.check();
    expect(wallet.balance()).toBe(10);
  });

  it("doesn't try a mint that can't restore, and spends nothing", async () => {
    const mint = await mintWith({ noRestore: true });
    const { store } = account();
    const wallet = createEcashWallet(store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    await add(wallet, mint, 1);
    const signed = mint.signedCount();
    expect(await wallet.tryMint(mint.url)).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect(mint.signedCount()).toBe(signed);
    expect(wallet.balance()).toBe(1);
    expect(wallet.state().trials ?? []).toEqual([]);
  });

  it("adds as before, even after a passed trial, in a browser that can't keep two tabs apart", async () => {
    const mint = await mintWith();
    const { store, seed, lanesUsed, withoutLocks } = account();
    const tried = createEcashWallet(store, LOCKS);
    await tried.open();
    await tried.addMint(mint.url);
    await add(tried, mint, 2);
    expect(await tried.tryMint(mint.url)).toEqual({ outcome: "passed", cost: 0 });
    // The same wallet in a browser with no navigator.locks: neither the page nor its worker has one.
    const wallet = createEcashWallet(withoutLocks());
    await wallet.open();
    expect(wallet.seedHere()).toBe("no-locks");
    await add(wallet, mint, 6);
    expect(wallet.balance()).toBe(8);
    expect(await lanesUsed()).toBe(0);
    // Only the trial's sat is the seed's.
    expect(await restorable(mint, seed)).toBe(1);
  });

  it("restores from the mints with the key alone, every relay emptied, and never twice", async () => {
    const mint = await mintWith();
    const first = account();
    const wallet = createEcashWallet(first.store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    await add(wallet, mint, 1);
    expect(await wallet.tryMint(mint.url)).toEqual({ outcome: "passed", cost: 0 });
    await add(wallet, mint, 13);
    await add(wallet, mint, 8);
    // Restore where everything is held already: nothing new, nothing doubled.
    expect(await wallet.restore()).toEqual({ found: 0, mints: [{ mint: mint.url, sats: 0 }] });
    expect(wallet.balance()).toBe(22);
    // The same key in a new browser whose relays hold nothing of the wallet: its record is made anew, with the mint.
    const fresh = account({ from: first.seed });
    const again = createEcashWallet(fresh.store, LOCKS);
    await again.open();
    await again.addMint(mint.url);
    expect(again.balance()).toBe(0);
    expect(again.seedHere()).toBe("yes");
    // The 21 added and the trial's sat.
    expect(await again.restore()).toEqual({ found: 22, mints: [{ mint: mint.url, sats: 22 }] });
    expect(again.balance()).toBe(22);
    expect(await again.restore()).toMatchObject({ found: 0 });
    // What came back is spendable.
    await again.pay(await again.quote(mint.invoice(10)));
    expect(again.balance()).toBe(11);
  }, 60_000);

  it("says why the seed isn't used here", async () => {
    expect(createEcashWallet(account().store).seedHere()).toBe("no-locks");
    expect(createEcashWallet(account({ seed: false }).store, LOCKS).seedHere()).toBe("no-seed");
    expect(createEcashWallet(account().store, LOCKS).seedHere()).toBe("yes");
  });

  it("never seeds where the store has no seed", async () => {
    const mint = await mintWith();
    const { store } = account({ seed: false });
    const wallet = createEcashWallet(store, LOCKS);
    await wallet.open();
    await wallet.addMint(mint.url);
    await add(wallet, mint, 2);
    expect(await wallet.tryMint(mint.url)).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect(await wallet.seededMint(mint.url)).toBe(false);
    expect(wallet.balance()).toBe(2);
  });
});
