/**
 * The trial that shows a mint refuses an output it has signed before (docs/ecash-seed-counter.md, rule 4), against the
 * mock mints. Pretend sats, on this machine only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { Amount, CheckStateEnum, Wallet, type Proof } from "@cashu/cashu-ts";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import { standInLock, standInSeedWorker } from "./seedWorkerStandIn.js";
import { startMockMint, type MockMint, type MockMintOptions } from "./mockMint.js";
import { tryMint, TRIAL_FROM } from "./mintTrial.js";
import { LANES, laneEnd } from "./seedLanes.js";
import { ecashSeed } from "../worker/ecashSeed.js";

let mints: MockMint[] = [];
afterEach(async () => {
  await Promise.all(mints.map((m) => m.close()));
  mints = [];
});

/** A page wallet holding 1 + 2 sats as ordinary (unseeded) proofs, as a person's might. */
async function holding(options: MockMintOptions = {}) {
  const mint = await startMockMint(options);
  mints.push(mint);
  const wallet = new Wallet(mint.url, { unit: "sat" });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(3);
  mint.payAllFunding();
  const proofs = await wallet.ops.mintBolt11(3, quote).run();
  return { mint, wallet, proofs };
}
const seed = () => ecashSeed(generatePrivateKey());
const trial = (wallet: Wallet, s: Uint8Array, proof: Proof) =>
  tryMint({ wallet, seed: standInSeedWorker({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed: s, lock: standInLock() }), proof, keep: async () => {} });
const one = (proofs: Proof[]) => proofs.find((p) => Number(p.amount) === 1)!;

describe("the trial of a mint, at a press", () => {
  it("keeps its counters out of every lane's reach", () => {
    expect(TRIAL_FROM).toBeGreaterThan(laneEnd(LANES - 1) - 4096 * 2);
    expect(TRIAL_FROM).toBeGreaterThan(laneEnd(LANES - 2));
  });

  it("is passed by a mint that refuses an output it signed before, and costs nothing", async () => {
    const { wallet, proofs } = await holding();
    const result = await trial(wallet, seed(), one(proofs));
    expect(result.outcome).toBe("passed");
    expect(result.cost).toBe(0);
    // The sat is still the person's: the proof the trial hands back is unspent.
    if (result.outcome !== "passed") throw new Error("not passed");
    const [state] = await wallet.checkProofsStates([result.kept]);
    expect(state?.state).toBe(CheckStateEnum.UNSPENT);
    expect(Number(result.kept.amount)).toBe(1);
  });

  it("is failed by a mint that leaves the proof off the trial's own signature: a seeded mint is one known to give them (fourth review 1)", async () => {
    // It says it proves what it signs, and signs the trial's swap without the proof: its 3rd signature, after the 1 and 2 sats.
    const { wallet, proofs } = await holding({ dleqLeftOff: (n) => n === 3 });
    const result = await trial(wallet, seed(), one(proofs));
    expect(result).toMatchObject({ outcome: "failed", cost: 1 });
    expect((result as { why?: string }).why).toMatch(/didn't prove/u);
  });

  it("is tried at a mint that lists NUT-09 and NUT-12 but not NUT-13, as cdk does: 13 is the wallet's own (testnut run, 2026-11-25)", async () => {
    const { wallet, proofs } = await holding({ unlistedNut13: true });
    expect(await trial(wallet, seed(), one(proofs))).toMatchObject({ outcome: "passed", cost: 0 });
  });

  it("is failed by a mint that signs again, at the cost of exactly one sat", async () => {
    const { wallet, proofs } = await holding({ signsAgain: true });
    const result = await trial(wallet, seed(), one(proofs));
    expect(result).toMatchObject({ outcome: "failed", cost: 1 });
    // The 2 sats the trial didn't touch are untouched.
    const two = proofs.find((p) => Number(p.amount) === 2)!;
    expect((await wallet.checkProofsStates([two]))[0]?.state).toBe(CheckStateEnum.UNSPENT);
  });

  it("isn't tried, and nothing is spent, on a mint that doesn't say it can restore", async () => {
    const { wallet, proofs, mint } = await holding({ noRestore: true });
    const signedBefore = mint.signedCount();
    const result = await trial(wallet, seed(), one(proofs));
    expect(result).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect(mint.signedCount()).toBe(signedBefore);
    expect((await wallet.checkProofsStates([one(proofs)]))[0]?.state).toBe(CheckStateEnum.UNSPENT);
  });

  it("isn't tried on a mint that charges for each swap, or with anything but a 1-sat proof", async () => {
    // A mint whose keyset charges a sat for each input, as the wallet reads its fee.
    const charging = await holding();
    vi.spyOn(charging.wallet, "getFeesForKeyset").mockReturnValue(Amount.from(1));
    const before = charging.mint.signedCount();
    expect(await trial(charging.wallet, seed(), one(charging.proofs))).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect(charging.mint.signedCount()).toBe(before);
    const plain = await holding();
    const two = plain.proofs.find((p) => Number(p.amount) === 2)!;
    expect(await trial(plain.wallet, seed(), two)).toMatchObject({ outcome: "not-tried", cost: 0 });
    expect((await plain.wallet.checkProofsStates([two]))[0]?.state).toBe(CheckStateEnum.UNSPENT);
  });
});
