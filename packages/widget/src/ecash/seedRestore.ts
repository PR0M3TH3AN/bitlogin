/**
 * Restore from the mints: what a mint still owes this seed, found with no relay at all (docs/ecash-seed-counter.md,
 * rule 3). The worker makes the outputs to ask about; the page asks the mint (NUT-09) and keeps what is unspent.
 *
 * Each of the 32 lanes is looked through from its start:
 * - a lane where nothing is found in its first 100 counters is empty, and is left there;
 * - a lane where something is found is followed 300 past the last counter signed, the library's own gap, well beyond
 *   what crashes can leave (rule 1);
 * - where a relay copy names a highest counter for the lane, at least that far.
 */
import { CheckStateEnum, type Proof, type Wallet } from "@cashu/cashu-ts";
import { LANES, laneEnd, laneStart } from "./seedLanes.js";
import { asOutputData } from "./seededMint.js";
import type { SeededOutput } from "../worker/ecashSeed.js";

/** How far an empty lane is looked into, and how far past the last found a used one is followed. */
export const EMPTY_LANE = 100;
export const PAST_LAST = 300;
const BATCH = 100;

export interface RestoreDeps {
  wallet: Wallet;
  outputs(keysetId: string, amounts: number[], from: number): Promise<{ outputs: SeededOutput[]; next: number }>;
  /** The highest counter a relay copy names for each lane, where one does. Optional: restore needs no relay. */
  highest?: Partial<Record<number, number>>;
}

export interface Restored {
  /** Unspent, as the mint says. */
  proofs: Proof[];
  /** For each lane where something was found, one past the last counter signed: where that lane goes on from. */
  next: Record<number, number>;
  /** How many outputs the mint was asked about, in all. */
  asked: number;
}

export async function restoreFromMint(deps: RestoreDeps): Promise<Restored> {
  const { wallet } = deps;
  const keysetId = wallet.keysetId;
  const keyset = wallet.keyChain.getKeyset(keysetId);
  const found: Proof[] = [];
  const next: Record<number, number> = {};
  let asked = 0;
  for (let lane = 0; lane < LANES; lane++) {
    const start = laneStart(lane);
    let at = start;
    let last: number | null = null;
    const atLeast = deps.highest?.[lane] ?? 0;
    for (;;) {
      const limit = last === null ? Math.max(start + EMPTY_LANE, atLeast + 1) : Math.max(last + 1 + PAST_LAST, atLeast + 1);
      if (at >= limit || at > laneEnd(lane)) break;
      const count = Math.min(BATCH, limit - at, laneEnd(lane) - at + 1);
      const made = await deps.outputs(keysetId, Array(count).fill(1), at);
      asked += made.outputs.length;
      const { outputs, signatures } = await wallet.mint.restore({ outputs: made.outputs.map((o) => ({ amount: o.amount as never, id: o.id, B_: o.B_ })) });
      const byB = new Map(outputs.map((o, i) => [o.B_, signatures[i]!]));
      for (const o of made.outputs) {
        const sig = byB.get(o.B_);
        if (!sig) continue;
        found.push(asOutputData({ ...o, amount: Number(sig.amount) }).toProof(sig, keyset));
        last = Math.max(last ?? 0, o.counter);
      }
      at = made.next;
    }
    if (last !== null) next[lane] = last + 1;
  }
  // What the mint has signed may have been spent since: only what it says is unspent is kept.
  const states = found.length ? await wallet.checkProofsStates(found) : [];
  const proofs = found.filter((_, i) => states[i]?.state !== CheckStateEnum.SPENT);
  return { proofs, next, asked };
}
