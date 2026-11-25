/**
 * The trial that shows a mint refuses an output it has signed before (docs/ecash-seed-counter.md, rule 4). Until a
 * mint's keyset has passed it, that mint is used as before, relay-kept, with no seed. It runs only when the person
 * presses for it, never on its own: the words beside the press say what it is, and that it can cost one sat.
 *
 * What it does, with nothing else of the person's at stake:
 * 1. one small proof of theirs is swapped into one output made from a counter kept for trials (the top of the counter
 *    space, which no lane reaches);
 * 2. the proof that comes back is swapped again into that same output.
 * A mint that refuses the second whole has kept nothing: it passes, and the proof is still theirs. A mint that signs
 * it again has taken that proof and handed back one that is already spent: it fails, at the cost of that proof.
 *
 * A mint that doesn't say it supports restore (NUT-09) and deterministic secrets (NUT-13) isn't tried at all.
 */
import { CheckStateEnum, type Proof, type Wallet } from "@cashu/cashu-ts";
import { asOutputData } from "./seededMint.js";
import type { SeededOutput } from "../worker/ecashSeed.js";

/** Counters kept for trials: the last 4096 below 2³¹, above every lane's reach in practice (a lane holds 2²⁶). */
export const TRIAL_FROM = 2 ** 31 - 1 - 4096;
export const TRIAL_TO = 2 ** 31 - 2;

export interface TrialDeps {
  wallet: Wallet;
  outputs(keysetId: string, amounts: number[], from: number): Promise<{ outputs: SeededOutput[]; next: number }>;
  /** A 1-sat proof of the person's to try with: all the trial can cost. */
  proof: Proof;
  random?: () => number;
}

export type TrialResult =
  | { keysetId: string; outcome: "passed"; cost: 0; kept: Proof }
  | { keysetId: string; outcome: "failed"; cost: number }
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
  if (!supports(info, 9) || !supports(info, 13)) return { keysetId, outcome: "not-tried", why: "This mint doesn't say it can restore what it signed.", cost: 0 };
  const keyset = wallet.keyChain.getKeyset(keysetId);
  // A mint that charges for each swap isn't tried: the trial would cost its fee twice over, and then more than a sat.
  if (Number(wallet.getFeesForKeyset(1, keysetId)) > 0) return { keysetId, outcome: "not-tried", why: "This mint charges for each swap, so it can't be tried for one sat.", cost: 0 };
  const amount = Number(deps.proof.amount);
  if (amount !== 1) return { keysetId, outcome: "not-tried", why: "The trial is made with a 1-sat proof, and none was given.", cost: 0 };
  // A counter of the trial range nobody has used: asked of the mint first.
  const random = deps.random ?? (() => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32);
  let made: SeededOutput | null = null;
  for (let i = 0; i < 8 && !made; i++) {
    const at = TRIAL_FROM + Math.floor(random() * (TRIAL_TO - TRIAL_FROM));
    const [o] = (await deps.outputs(keysetId, [amount], at)).outputs;
    const { outputs } = await wallet.mint.restore({ outputs: [{ amount: o!.amount as never, id: o!.id, B_: o!.B_ }] });
    if (outputs.length === 0) made = o!;
  }
  if (!made) return { keysetId, outcome: "not-tried", why: "No unused trial counter was found.", cost: 0 };
  const out = { amount: made.amount as never, id: made.id, B_: made.B_ };
  // 1. The person's proof, swapped into the trial output.
  const first = await wallet.mint.swap({ inputs: [deps.proof], outputs: [out] });
  const once = asOutputData(made).toProof(first.signatures[0]!, keyset);
  // 2. That proof, swapped into the same output again.
  try {
    await wallet.mint.swap({ inputs: [once], outputs: [out] });
  } catch (err) {
    if (alreadySigned(err)) return { keysetId, outcome: "passed", cost: 0, kept: once };
    throw err;
  }
  // It signed again: what it handed back is the proof it just took as spent.
  const [state] = await wallet.checkProofsStates([once]);
  return { keysetId, outcome: "failed", cost: state?.state === CheckStateEnum.SPENT ? 1 : 0 };
}
