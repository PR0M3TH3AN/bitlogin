/**
 * Restore from the mints, from the account's key alone (docs/ecash-seed-counter.md, rule 3), against the mock mint.
 * Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, type Proof } from "@cashu/cashu-ts";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { startMockMint, type MockMint } from "./mockMint.js";
import { createSeededMint } from "./seededMint.js";
import { advance, laneStart, type LaneState } from "./seedLanes.js";
import { restoreFromMint } from "./seedRestore.js";
import { ecashSeed, seededOutputs } from "../worker/ecashSeed.js";

const total = (proofs: readonly Proof[]) => proofs.reduce((n, p) => n + Number(p.amount), 0);

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

async function pageWallet(mint: MockMint) {
  const wallet = new Wallet(mint.url, { unit: "sat" });
  await wallet.loadMint();
  return wallet;
}
/** A browser in `lane`, adding sats from the seed. */
async function browser(mint: MockMint, seed: Uint8Array, lane: number) {
  const wallet = await pageWallet(mint);
  const kept = new Map<string, LaneState>([[wallet.keysetId, { lane, next: laneStart(lane) }]]);
  const minter = createSeededMint({ wallet, outputs: async (id, amounts, from) => seededOutputs(seed, id, amounts, from), load: async (id) => kept.get(id) ?? null, save: async (id, s) => void kept.set(id, s) });
  const held: Proof[] = [];
  return {
    wallet,
    kept,
    held,
    async add(sats: number) {
      const quote = await wallet.createMintQuoteBolt11(sats);
      mint.payAllFunding();
      held.push(...(await minter.add(sats, quote)));
    },
    /** A crash after counters were written down and before the mint was asked: they are burned. */
    burn(n: number) {
      const s = kept.get(wallet.keysetId)!;
      kept.set(wallet.keysetId, advance(s, s.next + n));
    }
  };
}
const restore = async (mint: MockMint, seed: Uint8Array, highest?: Partial<Record<number, number>>) =>
  restoreFromMint({ wallet: await pageWallet(mint), outputs: async (id, amounts, from) => seededOutputs(seed, id, amounts, from), highest });

describe("restore from the mints, from the key alone", () => {
  it("brings back what two browsers in two lanes added, with every relay gone", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 3);
    const b = await browser(mint, seed, 20);
    await a.add(13);
    await b.add(9);
    await a.add(4);
    const back = await restore(mint, seed);
    expect(total(back.proofs)).toBe(26);
    expect(new Set(back.proofs.map((p) => p.secret))).toEqual(new Set([...a.held, ...b.held].map((p) => p.secret)));
    expect(Object.keys(back.next).map(Number).sort((x, y) => x - y)).toEqual([3, 20]);
    // Where each lane goes on from: past everything it signed.
    expect(back.next[3]).toBe(a.kept.get(a.wallet.keysetId)!.next);
  });

  it("finds what lies beyond two crashes in a row", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 6);
    await a.add(5);
    a.burn(40);
    a.burn(40);
    await a.add(7);
    expect(total((await restore(mint, seed)).proofs)).toBe(12);
  });

  it("goes as far as the relay copy names, where a gap is wider than restore steps over", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 9);
    await a.add(5);
    a.burn(500);
    await a.add(7);
    // With no relay at all: the first 5 sats, and the rest beyond the gap missed.
    expect(total((await restore(mint, seed)).proofs)).toBe(5);
    // With the relay copy's highest counter for the lane: all of it.
    expect(total((await restore(mint, seed, { 9: a.kept.get(a.wallet.keysetId)!.next })).proofs)).toBe(12);
  });

  it("keeps only what the mint says is unspent", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 2);
    await a.add(8);
    await a.add(3);
    // The 8 is spent: swapped at the mint (5 sent, 3 change) for fresh proofs nobody's seed made.
    const eight = a.held.filter((p) => Number(p.amount) === 8);
    await a.wallet.ops.send(5, eight).run();
    expect(total((await restore(mint, seed)).proofs)).toBe(3);
  });
});
