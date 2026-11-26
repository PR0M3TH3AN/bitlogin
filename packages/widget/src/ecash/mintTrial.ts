/**
 * The trial that shows a mint refuses an output it has signed before (docs/ecash-seed-counter.md, rule 4). Until a
 * mint's keyset has passed it, that mint is used as before, relay-kept, with no seed. It runs only when the person
 * presses for it, never on its own: the words beside the press say what it is, and that it can cost one sat.
 *
 * What it does, with nothing else of the person's at stake:
 * 1. one small proof of theirs is swapped into one output made from a counter kept for trials (the top of the counter
 *    space, which no lane reaches);
 * 2. the proof that comes back is swapped again into that same output.
 * A mint that refuses the second whole, and leaves the proof unspent, has kept nothing: it passes, and the proof is
 * still theirs. A mint that signs it again, or spends the proof before refusing, has taken it: it fails, at the cost
 * of that proof.
 *
 * A mint that doesn't say it supports restore (NUT-09) and proofs (NUT-12) isn't tried at all. NUT-13, deterministic
 * secrets, is the wallet's own: mints needn't list it.
 */
import { CheckStateEnum, type Proof, type Wallet } from "@cashu/cashu-ts";
import { keysetGiven, signedFor, type SeedWorker } from "./seededMint.js";
import type { ReservedOutput } from "../worker/ecashSeed.js";

/** Counters kept for trials (seedLanes.ts). */
export { TRIAL_FROM, TRIAL_TO } from "./seedLanes.js";

export interface TrialDeps {
  wallet: Wallet;
  /** The worker's seed actions: a trial output at the next trial counter it hasn't handed out. */
  seed: Pick<SeedWorker, "trialOutput" | "unblind">;
  /** A 1-sat proof of the person's to try with: all the trial can cost. */
  proof: Proof;
  /**
   * Keep the proof the first swap made, in place of the one it took, before the second swap is asked (2026-11-25, the
   * review's finding 4): where the second fails for another reason, or its answer is lost, the sat is still held.
   */
  keep(once: Proof): Promise<void>;
}

export type TrialResult =
  | { keysetId: string; outcome: "passed"; cost: 0; kept: Proof }
  | { keysetId: string; outcome: "failed"; cost: number; why?: string }
  | { keysetId: string; outcome: "not-tried"; why: string; cost: 0 };

const supports = (info: { nuts?: Record<string, { supported?: boolean; disabled?: boolean } | undefined> }, n: number) => {
  const nut = info.nuts?.[String(n)];
  return !!nut && nut.supported !== false && nut.disabled !== true;
};
const alreadySigned = (err: unknown): boolean => /already signed/iu.test(String((err as Error)?.message ?? "")) || (err as { code?: number })?.code === 10002;

export async function tryMint(deps: TrialDeps): Promise<TrialResult> {
  const { wallet } = deps;
  const keysetId = wallet.keysetId;
  const info = (await wallet.mint.getInfo()) as unknown as { nuts?: Record<string, { supported?: boolean; disabled?: boolean }> };
  // NUT-13 is the wallet's own way of making secrets, not something a mint does: cdk doesn't list it (the testnut run,
  // 2026-11-25). What the seed needs of a mint is restore (NUT-09) and proofs (NUT-12).
  if (!supports(info, 9)) return { keysetId, outcome: "not-tried", why: "This mint doesn't say it can restore what it signed.", cost: 0 };
  // Restore unblinds only what a mint proves it signed (NUT-12): a mint that doesn't could never be restored from.
  if (!supports(info, 12)) return { keysetId, outcome: "not-tried", why: "This mint doesn't prove what it signs, so it can't be restored from.", cost: 0 };
  const keyset = wallet.keyChain.getKeyset(keysetId);
  // A mint that charges for each swap isn't tried: the trial would cost its fee twice over, and then more than a sat.
  if (Number(wallet.getFeesForKeyset(1, keysetId)) > 0) return { keysetId, outcome: "not-tried", why: "This mint charges for each swap, so it can't be tried for one sat.", cost: 0 };
  const amount = Number(deps.proof.amount);
  if (amount !== 1) return { keysetId, outcome: "not-tried", why: "The trial is made with a 1-sat proof, and none was given.", cost: 0 };
  // The next trial counter the worker hasn't handed out, asked of the mint first: one another browser used is passed by.
  let made: ReservedOutput | null = null;
  for (let i = 0; i < 8 && !made; i++) {
    const o = await deps.seed.trialOutput(keysetId, keysetGiven(keyset));
    const { outputs } = await wallet.mint.restore({ outputs: [{ amount: o.amount as never, id: o.id, B_: o.B_ }] });
    if (outputs.length === 0) made = o;
  }
  if (!made) return { keysetId, outcome: "not-tried", why: "No unused trial counter was found.", cost: 0 };
  const out = { amount: made.amount as never, id: made.id, B_: made.B_ };
  // 1. The person's proof, swapped into the trial output; what comes back is kept at once.
  const first = await wallet.mint.swap({ inputs: [deps.proof], outputs: [out] });
  // Finished into a proof by the worker, which checks the mint's proof of it: nothing that unblinds it was here before.
  // A mint that didn't prove the trial's own signature fails (2026-11-25, the fourth review's 1): it is not known to give
  // proofs, and nothing it signed without one is finished, so its seeded adds couldn't be. That costs the sat.
  let once: Proof | undefined;
  try {
    [once] = await deps.seed.unblind(keysetId, keysetGiven(keyset), signedFor([made], first.signatures));
  } catch (err) {
    if ((err as { code?: string })?.code === "no-dleq") return { keysetId, outcome: "failed", cost: 1, why: "This mint signed the trial's sat but didn't prove it, so the sat couldn't be kept." };
    throw err;
  }
  if (!once) throw new Error("The mint's answer could not be finished into a proof.");
  await deps.keep(once);
  // 2. That proof, swapped into the same output again.
  try {
    await wallet.mint.swap({ inputs: [once], outputs: [out] });
  } catch (err) {
    if (!alreadySigned(err)) throw err;
    // Refused: it passes only if the proof is still unspent. A mint that took it before refusing has cost the sat,
    // and would lose a whole invoice the same way on a retried claim.
    const [state] = await wallet.checkProofsStates([once]);
    if (state?.state === CheckStateEnum.UNSPENT) return { keysetId, outcome: "passed", cost: 0, kept: once };
    return { keysetId, outcome: "failed", cost: 1 };
  }
  // It signed again: what it handed back is the proof it just took as spent.
  const [state] = await wallet.checkProofsStates([once]);
  return { keysetId, outcome: "failed", cost: state?.state === CheckStateEnum.SPENT ? 1 : 0 };
}
