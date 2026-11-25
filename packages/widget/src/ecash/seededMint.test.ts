/**
 * Two browsers of one account adding sats from the same seed (docs/ecash-seed-counter.md, rules 1 to 5), against the
 * mock mint that refuses an output it has signed before and the one that signs it again. No relay anywhere: each
 * browser's lane is kept in that browser alone. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, type Proof } from "@cashu/cashu-ts";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore, type KeyValueStore } from "@bitlogin/core/storage";
import { startMockMint, type MockMint } from "./mockMint.js";
import { createSeededMint, asOutputData, seedUsableHere, type Lock } from "./seededMint.js";
import { laneOf, laneStart, type LaneState } from "./seedLanes.js";
import { ecashSeed, seededOutputs } from "../worker/ecashSeed.js";
import { keepLane, readLane } from "../worker/ecashLanes.js";
import { standInLock as makeLock, standInSeedWorker } from "./seedWorkerStandIn.js";

/**
 * A stand-in for the browser's navigator.locks, which Node hasn't: one lock per name, for the workers of this test.
 * It keeps them in one process apart, as navigator.locks keeps tabs apart; it is a test's, never the wallet's.
 */
const standInLock: Lock = makeLock();
const total = (proofs: readonly Proof[]) => proofs.reduce((n, p) => n + Number(p.amount), 0);
const distinct = (proofs: readonly Proof[]) => new Set(proofs.map((p) => p.secret)).size;

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

/** One browser: its own page wallet with no seed, its own worker and storage, the account's seed. */
async function browser(mint: MockMint, seed: Uint8Array, opts: { random?: () => number; checkFirst?: boolean } = {}) {
  const wallet = new Wallet(mint.url, { unit: "sat" });
  await wallet.loadMint();
  const lanes = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore() };
  const minter = createSeededMint({ wallet, seed: standInSeedWorker({ ...lanes, seed, lock: standInLock }), ...opts });
  const held: Proof[] = [];
  return {
    wallet,
    /** This browser's lane, as its worker keeps it. */
    lane: () => readLane(lanes, wallet.keysetId) as Promise<LaneState>,
    /** Put this browser in a lane, as one that drew it before. */
    setLane: (lane: number, next = laneStart(lane)) => keepLane(lanes, wallet.keysetId, { lane, next }),
    minter,
    held,
    async add(sats: number) {
      const quote = await wallet.createMintQuoteBolt11(sats);
      mint.payAllFunding();
      held.push(...(await minter.add(sats, quote)));
    }
  };
}
/** Draws lane `n` first, whatever the shuffle. */
const first = (n: number) => {
  let i = 0;
  return () => (i++ === 0 ? (n + 0.5) / 32 : 0);
};

describe("two browsers of one account, adding sats from one seed", () => {
  for (const signsAgain of [false, true]) {
    it(`in different lanes, with no relay at all, lose nothing (${signsAgain ? "a mint that signs again" : "a refusing mint"})`, async () => {
      const mint = await startMockMint({ signsAgain });
      mints.push(mint);
      const seed = ecashSeed(generatePrivateKey());
      const a = await browser(mint, seed);
      const b = await browser(mint, seed);
      for (let i = 0; i < 3; i++) {
        await a.add(5);
        await b.add(6);
      }
      expect(total(a.held)).toBe(15);
      expect(total(b.held)).toBe(18);
      expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
      const lanes = [(await a.lane()).lane, (await b.lane()).lane];
      expect(lanes[0]).not.toBe(lanes[1]);
    });
  }

  it("never draw a lane the mint shows as used", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, { random: first(5) });
    await a.add(3);
    expect((await a.lane()).lane).toBe(5);
    // A second browser, or this one after its storage was cleared, that would draw lane 5 first: the mint shows it used.
    const b = await browser(mint, seed, { random: first(5) });
    await b.add(3);
    expect((await b.lane()).lane).not.toBe(5);
    expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
  });

  it("never draw a lane whose first counters were burned and whose later ones are used (finding 7)", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    // Lane 5's first 60 counters burned with nothing signed, as crashes would leave them, then used past them. A
    // probe of only the first 20 sees an empty lane; it must look far enough to find what was signed.
    const c = await browser(mint, seed, { random: first(5) });
    await c.setLane(5, laneStart(5) + 60);
    await c.add(3);
    const d = await browser(mint, seed, { random: first(5) });
    await d.add(3);
    expect((await d.lane()).lane).not.toBe(5);
  });

  it("in the same lane, on a refusing mint, have the clash refused whole and retried: nothing lost", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    // Both in lane 7 at its start, as two browsers that drew it before either used it. No check first: the mint's
    // own refusal is what is tested.
    const a = await browser(mint, seed, { checkFirst: false });
    const b = await browser(mint, seed, { checkFirst: false });
    for (const x of [a, b]) await x.setLane(7);
    await a.add(8);
    await b.add(8);
    expect(total(a.held) + total(b.held)).toBe(16);
    expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
    expect(laneOf((await b.lane()).next)).toBe(7);
  });

  it("in the same lane, on a mint that signs again, one after the other: the check first saves them", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed);
    const b = await browser(mint, seed);
    for (const x of [a, b]) await x.setLane(7);
    await a.add(8);
    await b.add(8);
    expect(total(a.held) + total(b.held)).toBe(16);
    expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
  });

  it("in the same lane, on a mint that signs again, in the same moment: one operation's sats are lost, which is why such a mint is kept off the seed", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed);
    const b = await browser(mint, seed);
    // Both reserve the same counters and both ask the mint first: nothing is signed yet, so both go on.
    const id = a.wallet.keysetId;
    const made = seededOutputs(seed, id, [8], laneStart(7));
    const quotes = await Promise.all([a, b].map((x) => x.wallet.createMintQuoteBolt11(8)));
    mint.payAllFunding();
    const [pa, pb] = await Promise.all([a.wallet.ops.mintBolt11(8, quotes[0]!).asCustom(made.outputs.map(asOutputData)).run(), b.wallet.ops.mintBolt11(8, quotes[1]!).asCustom(made.outputs.map(asOutputData)).run()]);
    // 16 sats paid in; the proofs are one set, twice: 8 sats are all there is.
    expect(total(pa) + total(pb)).toBe(16);
    expect(distinct([...pa, ...pb])).toBe(pa.length);
    expect(new Set([...pa, ...pb].map((p) => p.secret)).size).toBe(1);
  });
});

describe("two tabs of one browser, on one store", () => {
  /**
   * Two tabs: each its own page wallet, minter and worker, the one browser's storage between them, slow as storage
   * is. The worker reserves under `lock`.
   */
  async function tabs(mint: MockMint, seed: Uint8Array, lock: Lock, together = false) {
    const inner = new InMemoryKeyValueStore();
    const signer = new NostrSigner(generatePrivateKey());
    const pause = () => new Promise((done) => setTimeout(done, 5));
    // With no lock, both tabs read their lane before either goes on, whatever the machine's load: the moment the lock
    // is for. (Only there: under a lock the second read waits for the first tab, as it must.)
    const waiting: (() => void)[] = [];
    const meet = () => (together && waiting.length < 2 ? new Promise<void>((done) => (waiting.push(done), waiting.length === 2 && waiting.forEach((go) => go()))) : Promise.resolve());
    const store: KeyValueStore = {
      get: async (key: string) => {
        const read = (await pause(), await inner.get(key));
        if (key.includes(":ecash-lane:")) await meet();
        return read;
      },
      set: async (key: string, value: string) => (await pause(), inner.set(key, value)),
      delete: (key: string) => inner.delete(key)
    } as KeyValueStore;
    const tab = async () => {
      const wallet = new Wallet(mint.url, { unit: "sat" });
      await wallet.loadMint();
      // The browser has used this mint before: its lane is chosen and stored, and both tabs read it.
      if (!(await readLane({ signer, store: inner }, wallet.keysetId))) await keepLane({ signer, store: inner }, wallet.keysetId, { lane: 7, next: laneStart(7) });
      const minter = createSeededMint({
        wallet,
        seed: standInSeedWorker({ signer, store, seed, lock }),
        // The lock alone is what these show: with the check first on, a tab that comes second is sometimes saved by
        // it, and the test would be of the check, not the lock.
        checkFirst: false
      });
      return {
        async add(sats: number) {
          const quote = await wallet.createMintQuoteBolt11(sats);
          mint.payAllFunding();
          return minter.add(sats, quote);
        }
      };
    };
    return [await tab(), await tab()] as const;
  }

  it("with no lock, adding at once on a mint that signs again, hand both tabs the same counters: the loss the lock is for", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const [a, b] = await tabs(mint, seed, (_name, fn) => fn(), true);
    const [pa, pb] = await Promise.all([a.add(8), b.add(8)]);
    expect(total(pa) + total(pb)).toBe(16);
    expect(distinct([...pa, ...pb])).toBeLessThan(pa.length + pb.length);
  });

  it("under the lock, adding at once, even on a mint that signs again, are handed different counters: nothing lost", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const [a, b] = await tabs(mint, seed, standInLock);
    for (let i = 0; i < 3; i++) {
      const [pa, pb] = await Promise.all([a.add(8), b.add(5)]);
      expect(distinct([...pa, ...pb])).toBe(pa.length + pb.length);
    }
  });
});

describe("a browser with no navigator.locks", () => {
  it("doesn't add by the seed at all, and says why", async () => {
    // Node has no navigator.locks: as such a browser.
    expect(seedUsableHere()).toBe(false);
    const mint = await startMockMint();
    mints.push(mint);
    const wallet = new Wallet(mint.url, { unit: "sat" });
    await wallet.loadMint();
    const seed = ecashSeed(generatePrivateKey());
    // Its worker has no lock either: it reserves nothing, and nothing is signed.
    const minter = createSeededMint({ wallet, seed: standInSeedWorker({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed, lock: null }) });
    const quote = await wallet.createMintQuoteBolt11(3);
    mint.payAllFunding();
    await expect(minter.add(3, quote)).rejects.toMatchObject({ code: "no-seed-here" });
    expect(mint.signedCount()).toBe(0);
  });
});
