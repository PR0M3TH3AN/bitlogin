/**
 * Two browsers of one account adding sats from the same seed (docs/ecash-seed-counter.md, rules 1 to 5), against the
 * mock mint that refuses an output it has signed before and the one that signs it again. No relay anywhere: each
 * browser's lane is kept in that browser alone. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, type Proof } from "@cashu/cashu-ts";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { startMockMint, type MockMint } from "./mockMint.js";
import { createSeededMint, asOutputData, defaultLock, type Lock } from "./seededMint.js";
import { laneOf, laneStart, type LaneState } from "./seedLanes.js";
import { ecashSeed, seededOutputs } from "../worker/ecashSeed.js";

const total = (proofs: readonly Proof[]) => proofs.reduce((n, p) => n + Number(p.amount), 0);
const distinct = (proofs: readonly Proof[]) => new Set(proofs.map((p) => p.secret)).size;

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

/** One browser: its own page wallet with no seed, its own lane state, the worker's outputs from the shared seed. */
async function browser(mint: MockMint, seed: Uint8Array, opts: { random?: () => number; checkFirst?: boolean } = {}) {
  const wallet = new Wallet(mint.url, { unit: "sat" });
  await wallet.loadMint();
  const kept = new Map<string, LaneState>();
  const minter = createSeededMint({
    wallet,
    outputs: async (keysetId, amounts, from) => seededOutputs(seed, keysetId, amounts, from),
    load: async (id) => kept.get(id) ?? null,
    save: async (id, state) => void kept.set(id, state),
    ...opts
  });
  const held: Proof[] = [];
  return {
    wallet,
    kept,
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
      const lanes = [a.kept, b.kept].map((k) => [...k.values()][0]!.lane);
      expect(lanes[0]).not.toBe(lanes[1]);
    });
  }

  it("never draw a lane the mint shows as used", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, { random: first(5) });
    await a.add(3);
    expect([...a.kept.values()][0]!.lane).toBe(5);
    // A second browser, or this one after its storage was cleared, that would draw lane 5 first: the mint shows it used.
    const b = await browser(mint, seed, { random: first(5) });
    await b.add(3);
    expect([...b.kept.values()][0]!.lane).not.toBe(5);
    expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
  });

  it("in the same lane, on a refusing mint, have the clash refused whole and retried: nothing lost", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    // Both in lane 7 at its start, as two browsers that drew it before either used it. No check first: the mint's
    // own refusal is what is tested.
    const a = await browser(mint, seed, { checkFirst: false });
    const b = await browser(mint, seed, { checkFirst: false });
    for (const x of [a, b]) x.kept.set(x.wallet.keysetId, { lane: 7, next: laneStart(7) });
    await a.add(8);
    await b.add(8);
    expect(total(a.held) + total(b.held)).toBe(16);
    expect(distinct([...a.held, ...b.held])).toBe(a.held.length + b.held.length);
    expect(laneOf([...b.kept.values()][0]!.next)).toBe(7);
  });

  it("in the same lane, on a mint that signs again, one after the other: the check first saves them", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed);
    const b = await browser(mint, seed);
    for (const x of [a, b]) x.kept.set(x.wallet.keysetId, { lane: 7, next: laneStart(7) });
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
  /** Two tabs: each its own page wallet and minter, the one browser's storage between them, slow as storage is. */
  async function tabs(mint: MockMint, seed: Uint8Array, lock: Lock) {
    const store = new Map<string, LaneState>();
    const pause = () => new Promise((done) => setTimeout(done, 5));
    const tab = async () => {
      const wallet = new Wallet(mint.url, { unit: "sat" });
      await wallet.loadMint();
      // The browser has used this mint before: its lane is chosen and stored, and both tabs read it.
      if (!store.has(wallet.keysetId)) store.set(wallet.keysetId, { lane: 7, next: laneStart(7) });
      const minter = createSeededMint({
        wallet,
        outputs: async (id, amounts, from) => seededOutputs(seed, id, amounts, from),
        load: async (id) => (await pause(), store.get(id) ?? null),
        save: async (id, state) => (await pause(), void store.set(id, state)),
        lock
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
    const [a, b] = await tabs(mint, seed, (_name, fn) => fn());
    const [pa, pb] = await Promise.all([a.add(8), b.add(8)]);
    expect(total(pa) + total(pb)).toBe(16);
    expect(distinct([...pa, ...pb])).toBeLessThan(pa.length + pb.length);
  });

  it("under the lock, adding at once, even on a mint that signs again, are handed different counters: nothing lost", async () => {
    const mint = await startMockMint({ signsAgain: true });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const [a, b] = await tabs(mint, seed, defaultLock);
    for (let i = 0; i < 3; i++) {
      const [pa, pb] = await Promise.all([a.add(8), b.add(5)]);
      expect(distinct([...pa, ...pb])).toBe(pa.length + pb.length);
    }
  });
});
