/**
 * Restore from the mints, from the account's key alone (docs/ecash-seed-counter.md, rule 3), against the mock mint.
 * Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet, type Proof } from "@cashu/cashu-ts";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import { startMockMint, type MockMint } from "./mockMint.js";
import { createSeededMint } from "./seededMint.js";
import { laneStart, type LaneState } from "./seedLanes.js";
import { restoreFromMint } from "./seedRestore.js";
import { ecashSeed } from "../worker/ecashSeed.js";
import { forwardLane, keepLane, readLane } from "../worker/ecashLanes.js";
import { standInLock, standInSeedWorker } from "./seedWorkerStandIn.js";

const lock = standInLock();
/** The worker's seed actions for a seed, with no lane of any browser: what restore uses. */
const keyOnly = (seed: Uint8Array) => standInSeedWorker({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed, lock });
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
  const lanes = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore() };
  await keepLane(lanes, wallet.keysetId, { lane, next: laneStart(lane) });
  const minter = createSeededMint({ wallet, seed: standInSeedWorker({ ...lanes, seed, lock }) });
  const held: Proof[] = [];
  return {
    wallet,
    lane: () => readLane(lanes, wallet.keysetId) as Promise<LaneState>,
    held,
    async add(sats: number) {
      const quote = await wallet.createMintQuoteBolt11(sats);
      mint.payAllFunding();
      held.push(...(await minter.add(sats, quote)));
    },
    /** A crash after counters were written down and before the mint was asked: they are burned. */
    async burn(n: number) {
      const s = (await readLane(lanes, wallet.keysetId))!;
      await forwardLane({ ...lanes, seed: () => seed.slice(), lock }, wallet.keysetId, s.next + n);
    }
  };
}
const restore = async (mint: MockMint, seed: Uint8Array, highest?: Partial<Record<number, number>>) =>
  restoreFromMint({ wallet: await pageWallet(mint), seed: keyOnly(seed), ...(highest ? { highest: () => highest } : {}) });

// A restore asks each mint about thousands of outputs, each made from the seed: seconds of work, more under load.
const RESTORE_MS = 120_000;

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
    const id = a.wallet.keysetId;
    expect(Object.keys(back.next[id]!).map(Number).sort((x, y) => x - y)).toEqual([3, 20]);
    // Where each lane goes on from: past everything it signed.
    expect(back.next[id]![3]).toBe((await a.lane()).next);
  }, RESTORE_MS);

  it("finds what lies beyond two crashes in a row", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 6);
    await a.add(5);
    await a.burn(40);
    await a.burn(40);
    await a.add(7);
    expect(total((await restore(mint, seed)).proofs)).toBe(12);
  }, RESTORE_MS);

  it("goes as far as the relay copy names, where a gap is wider than restore steps over", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 9);
    await a.add(5);
    await a.burn(500);
    await a.add(7);
    // With no relay at all: the first 5 sats, and the rest beyond the gap missed.
    expect(total((await restore(mint, seed)).proofs)).toBe(5);
    // With the relay copy's highest counter for the lane: all of it.
    expect(total((await restore(mint, seed, { 9: (await a.lane()).next })).proofs)).toBe(12);
  }, RESTORE_MS);

  it("brings back a keyset with more than a thousand signed outputs (fault 2)", async () => {
    const mint = await startMockMint();
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const wallet = await pageWallet(mint);
    const worker = standInSeedWorker({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed, lock });
    await worker.draw(wallet.keysetId, 2);
    // 1,100 one-sat outputs signed, as a long history at one mint leaves them.
    for (let i = 0; i < 11; i++) {
      const made = await worker.reserve(wallet.keysetId, Array(100).fill(1));
      const quote = await wallet.createMintQuoteBolt11(100);
      mint.payAllFunding();
      await wallet.mint.mintBolt11({ quote: quote.quote, outputs: made.outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })) } as never);
    }
    expect(total((await restore(mint, seed)).proofs)).toBe(1100);
  }, RESTORE_MS * 2);

  it("skips a signature its mint gave no proof for, says how many, and restores the rest (third review 3)", async () => {
    // The mint leaves the proof off its second signature: the 5 sats' first output is proved, the 4's is not.
    const mint = await startMockMint({ dleqLeftOff: (n) => n === 2 });
    mints.push(mint);
    const seed = ecashSeed(generatePrivateKey());
    const a = await browser(mint, seed, 2);
    await a.add(5);
    const back = await restore(mint, seed);
    expect(back.skipped).toBe(1);
    expect(total(back.proofs)).toBe(1);
  }, RESTORE_MS);

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
  }, RESTORE_MS);
});
