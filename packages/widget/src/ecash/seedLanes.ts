/**
 * The seed's counters and lanes (docs/ecash-seed-counter.md, rules 1 to 5). Pure rules, kept apart from where the
 * counters are stored and who asks the mint, so they can be read and tested on their own.
 *
 * - The counter space of each keyset is split into 32 lanes of 2²⁶ counters. A browser keeps to one lane, drawn at
 *   random and kept only in that browser, so two browsers stay apart with no relay between them (rule 3).
 * - A counter is reserved, exactly as many as an operation needs, and written down before the mint is asked; it only
 *   ever goes up (rules 1 and 2).
 */

/** How many lanes there are, and how many counters each holds. 32 × 2²⁶ stays below 2³¹ (a hardened BIP32 index). */
export const LANES = 32;
export const LANE_SIZE = 2 ** 26;
/** How many of a lane's first counters the mint is asked about before the lane is drawn (rule 3). */
export const LANE_PROBE = 20;

/** The first counter of a lane. Lane 0 starts at 1: the library takes 0 to mean "choose for me". */
export const laneStart = (lane: number): number => (lane === 0 ? 1 : lane * LANE_SIZE);
/** The last counter of a lane. */
export const laneEnd = (lane: number): number => (lane + 1) * LANE_SIZE - 1;
/** Which lane a counter is in. */
export const laneOf = (counter: number): number => Math.floor(counter / LANE_SIZE);

/** Where this browser is in one keyset: its lane, and the next counter not yet used. Kept in this browser only. */
export interface LaneState {
  lane: number;
  next: number;
}

export function validLane(lane: unknown): lane is number {
  return Number.isSafeInteger(lane) && (lane as number) >= 0 && (lane as number) < LANES;
}

/** A state that is what it says: a lane, and a next counter inside it. Anything else is not used. */
export function cleanState(state: unknown): LaneState | null {
  const s = state as Partial<LaneState> | null;
  if (!s || !validLane(s.lane) || !Number.isSafeInteger(s.next)) return null;
  if (s.next! < laneStart(s.lane!) || s.next! > laneEnd(s.lane!)) return null;
  return { lane: s.lane!, next: s.next! };
}

/** Take `n` counters: the range to use, and the state to write down before the mint is asked. */
export function reserve(state: LaneState, n: number): { from: number; state: LaneState } {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("Reserve at least one counter.");
  if (state.next + n > laneEnd(state.lane)) throw new Error("This lane is used up.");
  return { from: state.next, state: { lane: state.lane, next: state.next + n } };
}

/** Never backwards: the state moved to at least `next`, within its lane. */
export function advance(state: LaneState, next: number): LaneState {
  if (!Number.isSafeInteger(next) || next <= state.next) return state;
  return { lane: state.lane, next: Math.min(next, laneEnd(state.lane)) };
}

/**
 * Draw a lane the mint shows as empty (rule 3): lanes are tried in a random order, and the first whose first
 * counters the mint has signed nothing for is taken. `signedIn(lane)` asks the mint (restore) about those counters.
 * A lane the mint shows as used is never drawn: another browser of this account has it, or this one did before it
 * was cleared. With every lane used, null: the wallet stays unseeded and says so.
 */
export async function drawLane(signedIn: (lane: number) => Promise<boolean>, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32): Promise<number | null> {
  const left = Array.from({ length: LANES }, (_, i) => i);
  while (left.length) {
    // One at a time, at random, none twice.
    const lane = left.splice(Math.min(left.length - 1, Math.floor(random() * left.length)), 1)[0]!;
    if (!(await signedIn(lane))) return lane;
  }
  return null;
}

/** What the screen says where the seed isn't used in this browser (rule 3a). */
export const NO_SEED_HERE = "This browser can't keep two tabs from using the same counters, so the seed isn't used in it. Your sats are kept on relays as before.";
/** What the screen says beside restore (rule 3), plainly. */
export const RESTORE_GAP =
  "If a crash left a long gap in a lane and BitLogin's record of the counter is gone from every relay too, restore can miss what came after the gap. Those sats are still at the mint, but this wallet can't find them.";
