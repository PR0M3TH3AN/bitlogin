/**
 * The mock mint's restore (NUT-09) and its two ways with an output it has signed before (docs/ecash-seed-counter.md):
 * refusing it, as standard mints do, or signing it again. Driven with the Cashu library's own seeded outputs (NUT-13),
 * so what these show is what a seeded wallet would meet. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Wallet } from "@cashu/cashu-ts";
import { startMockMint, type MockMint } from "./mockMint.js";

const SEED = new Uint8Array(64).fill(7);
const sum = (proofs: readonly { amount: unknown }[]) => proofs.reduce((n, p) => n + Number(p.amount), 0);
const secrets = (proofs: readonly { secret: string }[]) => new Set(proofs.map((p) => p.secret));

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});
const start = async (signsAgain = false) => {
  const mint = await startMockMint({ signsAgain });
  mints.push(mint);
  const wallet = new Wallet(mint.url, { unit: "sat", bip39seed: SEED });
  await wallet.loadMint();
  return { mint, wallet };
};
/** Sats added with outputs made from the seed, from `counter` (0 is the library's "reserve for me"; 1 on is chosen). */
const add = async (mint: MockMint, wallet: Wallet, sats: number, counter: number) => {
  const quote = await wallet.createMintQuoteBolt11(sats);
  mint.payAllFunding();
  try {
    return { quote, proofs: await wallet.ops.mintBolt11(sats, quote).asDeterministic(counter).run() };
  } catch (err) {
    return { quote, error: err as Error };
  }
};

describe("the mock mint, for seeded wallets", () => {
  it("restores what it signed, from the seed alone", async () => {
    const { mint, wallet } = await start();
    const first = await add(mint, wallet, 8, 0);
    const second = await add(mint, wallet, 5, 10);
    expect(sum(first.proofs!) + sum(second.proofs!)).toBe(13);
    // Another wallet, the same seed, nothing else: the mint hands back all of it.
    const elsewhere = new Wallet(mint.url, { unit: "sat", bip39seed: SEED });
    await elsewhere.loadMint();
    const restored = await elsewhere.batchRestore(300, 100, 0);
    expect(sum(restored.proofs)).toBe(13);
    expect(secrets(restored.proofs)).toEqual(secrets([...first.proofs!, ...second.proofs!]));
  });

  it("refuses an output it has signed before, whole, and nothing is lost: the paid invoice is claimed again", async () => {
    const { mint, wallet } = await start();
    const first = await add(mint, wallet, 8, 1);
    expect(sum(first.proofs!)).toBe(8);
    // The same counters again, as two browsers in one lane would use them.
    const clash = await add(mint, wallet, 8, 1);
    expect(clash.error?.message).toMatch(/already signed/u);
    // Nothing was issued for it: the same paid invoice is claimed with counters past the clash.
    const retried = await wallet.ops.mintBolt11(8, clash.quote).asDeterministic(50).run();
    expect(sum(retried)).toBe(8);
    expect(secrets([...first.proofs!, ...retried]).size).toBe(first.proofs!.length + retried.length);
  });

  it("a mint that signs again loses the whole second operation: the proofs are ones already held", async () => {
    const { mint, wallet } = await start(true);
    const first = await add(mint, wallet, 8, 1);
    const clash = await add(mint, wallet, 8, 1);
    // It took the paid invoice and signed: but every proof is one the wallet already holds.
    expect(clash.error).toBeUndefined();
    expect(sum(clash.proofs!)).toBe(8);
    const held = secrets([...first.proofs!, ...clash.proofs!]);
    expect(held).toEqual(secrets(first.proofs!));
    // 16 sats paid in, 8 held: the 8 of the second invoice are gone.
    expect(sum([...first.proofs!])).toBe(8);
    await expect(wallet.ops.mintBolt11(8, clash.quote).asDeterministic(50).run()).rejects.toThrow();
  });
});
