/**
 * Restore from the mints: what a mint still owes this seed, found with no relay at all (docs/ecash-seed-counter.md,
 * rule 3). The worker makes the blinded messages to ask about and unblinds what the mint hands back (2026-11-25, the
 * review's finding 3): the page never holds what unblinds a counter it asked about. It keeps what is unspent.
 *
 * Every keyset the mint lists in sats, active or not (the review's finding 1: sats added under a keyset the mint has
 * since rotated away from are still its to restore). In each, the 32 lanes, looked through from their start:
 * - a lane where nothing is found in its first 100 counters is empty, and is left there;
 * - a lane where something is found is followed 300 past the last counter signed, the library's own gap, well beyond
 *   what crashes can leave (rule 1);
 * - where the wallet record names a highest counter for the lane, at least that far, gaps and all (finding 2).
 * And the trial counters (finding 5), from their start, followed 100 past the last found: the proof a trial ends with
 * is made at one of them.
 */
import { Amount, CheckStateEnum, type Proof, type Wallet } from "@cashu/cashu-ts";
import { LANES, laneEnd, laneStart, TRIAL_FROM, TRIAL_TO } from "./seedLanes.js";
import type { SeedWorker } from "./seededMint.js";
import type { FoundAt } from "../worker/ecashSeed.js";

/** How far an empty lane is looked into, and how far past the last found a used one is followed. */
export const EMPTY_LANE = 100;
export const PAST_LAST = 300;
const BATCH = 100;

export interface RestoreDeps {
  wallet: Wallet;
  seed: SeedWorker;
  /** The highest counter the wallet record names for each lane of a keyset, where it does. Restore needs no relay. */
  highest?: (keysetId: string) => Partial<Record<number, number>>;
}

export interface Restored {
  /** Unspent, as the mint says. */
  proofs: Proof[];
  /** For each keyset and lane where something was found, one past the last counter signed. */
  next: Record<string, Record<number, number>>;
  /** How many blinded messages the mint was asked about, in all. */
  asked: number;
  /** The keysets looked through. */
  keysets: string[];
}

export async function restoreFromMint(deps: RestoreDeps): Promise<Restored> {
  const { wallet } = deps;
  const keysets = wallet.keyChain.getKeysets().filter((k) => k.unit === "sat" && k.hasHexId);
  const proofs: Proof[] = [];
  const next: Record<string, Record<number, number>> = {};
  let asked = 0;

  for (const listed of keysets) {
    const keyset = await wallet.keyChain.ensureKeysetKeys(listed.id);
    const id = keyset.id;
    const found: FoundAt[] = [];
    /** Follow a run of counters from `start` until `limit(last)` says stop: what was signed is gathered. */
    const follow = async (start: number, end: number, limit: (last: number | null) => number): Promise<number | null> => {
      let at = start;
      let last: number | null = null;
      for (;;) {
        const stop = Math.min(limit(last), end + 1);
        if (at >= stop) break;
        const count = Math.min(BATCH, stop - at);
        const blinded = await deps.seed.blinded(id, at, count);
        asked += blinded.length;
        if (blinded.length) {
          const { outputs, signatures } = await wallet.mint.restore({ outputs: blinded.map((b) => ({ amount: Amount.from(1), id: b.id, B_: b.B_ })) as never });
          const byB = new Map(outputs.map((o, i) => [o.B_, signatures[i]!]));
          for (const b of blinded) {
            const sig = byB.get(b.B_);
            if (!sig) continue;
            found.push({ counter: b.counter, amount: Number(sig.amount), C_: sig.C_ });
            last = Math.max(last ?? 0, b.counter);
          }
        }
        at += count;
      }
      return last;
    };
    const known = deps.highest?.(id) ?? {};
    for (let lane = 0; lane < LANES; lane++) {
      const start = laneStart(lane);
      const atLeast = known[lane] ?? 0;
      const last = await follow(start, laneEnd(lane), (l) => (l === null ? Math.max(start + EMPTY_LANE, atLeast + 1) : Math.max(l + 1 + PAST_LAST, atLeast + 1)));
      if (last !== null) (next[id] ??= {})[lane] = last + 1;
    }
    await follow(TRIAL_FROM, TRIAL_TO, (l) => (l === null ? TRIAL_FROM + EMPTY_LANE : l + 1 + EMPTY_LANE));
    if (found.length) {
      const keys = Object.fromEntries(Object.entries(keyset.keys).map(([a, k]) => [String(a), k]));
      proofs.push(...(await deps.seed.unblind(id, keys, found)));
    }
  }
  // What the mint has signed may have been spent since: only what it says is unspent is kept.
  const states = proofs.length ? await wallet.checkProofsStates(proofs) : [];
  return { proofs: proofs.filter((_, i) => states[i]?.state !== CheckStateEnum.SPENT), next, asked, keysets: keysets.map((k) => k.id) };
}
