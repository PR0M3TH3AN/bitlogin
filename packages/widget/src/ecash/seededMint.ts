/**
 * Adding sats with outputs made from the seed (docs/ecash-seed-counter.md). The page's half: the worker makes the
 * outputs (worker/ecashSeed.ts) and the seed never comes here. This keeps to the rules:
 *
 * - a lane the mint shows as empty, kept in this browser only (rule 3);
 * - exactly the counters the operation needs, written down before the mint is asked, only ever forward (rules 1, 2);
 * - the mint asked first whether any of them are signed already, and those stepped past (rule 5);
 * - a request the mint refuses as already signed is retried past the clash, with the same paid invoice (rule 4).
 *
 * Only for a mint shown to refuse outputs it has signed before (rule 4): that trial, and wiring this into the wallet,
 * are not here yet. Tested against the mock mints only.
 */
import { Amount, OutputData, type Proof, type Wallet } from "@cashu/cashu-ts";
import { advance, cleanState, drawLane, LANE_PROBE, laneStart, reserve, type LaneState } from "./seedLanes.js";
import type { SeededOutput } from "../worker/ecashSeed.js";

export interface SeededMintDeps {
  /** The mint, as the page's wallet holds it: no seed. */
  wallet: Wallet;
  /** The worker's outputs for one operation, and the next counter it didn't use. */
  outputs(keysetId: string, amounts: number[], from: number): Promise<{ outputs: SeededOutput[]; next: number }>;
  /** This browser's lane state for the keyset: read, and written before any use. */
  load(keysetId: string): Promise<LaneState | null>;
  save(keysetId: string, state: LaneState): Promise<void>;
  /** Draw order for lanes, for tests. */
  random?: () => number;
  /** Ask the mint about the counters before using them (rule 5). On, unless a test turns it off. */
  checkFirst?: boolean;
  /** The lock every change to the lane state is made under: the browser's own, unless a test stands one in. */
  lock?: Lock;
}

const bytes = (h: string) => new Uint8Array(h.match(/../gu)!.map((x) => parseInt(x, 16)));
/** The library's own output, from what the worker handed over. */
export const asOutputData = (o: SeededOutput) => new OutputData({ amount: Amount.from(o.amount), id: o.id, B_: o.B_ }, BigInt(`0x${o.blindingFactor}`), bytes(o.secret));
const blinded = (o: SeededOutput) => ({ amount: Amount.from(o.amount), id: o.id, B_: o.B_ });
const split = (sats: number): number[] => {
  const out: number[] = [];
  for (let bit = 1; sats > 0; bit *= 2, sats = Math.floor(sats / 2)) if (sats % 2) out.push(bit);
  return out;
};
const alreadySigned = (err: unknown): boolean => /already signed/iu.test(String((err as Error)?.message ?? "")) || (err as { code?: number })?.code === 10002;

/**
 * One lock per name, across every tab and worker of this site: `navigator.locks` (2026-11-24). Two tabs of one
 * browser share its storage, and must not reserve from the same lane in the same moment. A lock within one page would
 * not stop two tabs, so where a browser has no `navigator.locks` the seed is not used in it at all: that browser stays
 * relay-kept, as a mint that hasn't passed the trial does, and the screen says so.
 */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
type Locks = { request(name: string, fn: () => Promise<unknown>): Promise<unknown> };
const browserLocks = (): Locks | null => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? null;
/** Whether this browser can keep two tabs apart, and so may add by the seed. */
export const seedUsableHere = (): boolean => typeof browserLocks()?.request === "function";
/** The browser's own lock, shared by every tab and worker of the site. Null where it has none. */
export const browserLock = (): Lock | null => {
  const locks = browserLocks();
  return locks && typeof locks.request === "function" ? ((name, fn) => locks.request(name, fn) as Promise<never>) : null;
};
/** What the screen says where the seed isn't used in this browser. */
export const NO_SEED_HERE = "This browser can't keep two tabs from using the same counters, so the seed isn't used in it. Your sats are kept on relays as before.";

export function createSeededMint(deps: SeededMintDeps) {
  const keysetId = () => deps.wallet.keysetId;
  // No lock that keeps two tabs apart: nothing is added by the seed in this browser.
  const lock = deps.lock ?? browserLock();
  if (!lock) throw Object.assign(new Error(NO_SEED_HERE), { code: "no-seed-here" });
  /** Every read-and-write of a keyset's lane state, under that keyset's lock: nothing in between. */
  const locked = <T>(id: string, fn: () => Promise<T>) => lock(`bitlogin:ecash-seed:${id}`, fn);
  /** The counters among these the mint has signed already: the highest, or null. */
  const signedAmong = async (outs: SeededOutput[]): Promise<number | null> => {
    const { outputs } = await deps.wallet.mint.restore({ outputs: outs.map(blinded) });
    const taken = new Set(outputs.map((o) => o.B_));
    const hits = outs.filter((o) => taken.has(o.B_)).map((o) => o.counter);
    return hits.length ? Math.max(...hits) : null;
  };

  /** The lane state, drawn the first time from lanes the mint shows as empty. Call under the lock. */
  async function laneLocked(id: string): Promise<LaneState | null> {
    const kept = cleanState(await deps.load(id));
    if (kept) return kept;
    const drawn = await drawLane(async (l) => {
      const { outputs } = await deps.outputs(id, Array(LANE_PROBE).fill(1), laneStart(l));
      return (await signedAmong(outputs)) !== null;
    }, deps.random);
    if (drawn === null) return null;
    const state = { lane: drawn, next: laneStart(drawn) };
    await deps.save(id, state);
    return state;
  }
  /** Take `n` counters: read, reserve and write back as one, under the lock. Null where no lane can be had. */
  const take = (id: string, n: number) =>
    locked(id, async () => {
      const state = await laneLocked(id);
      if (!state) return null;
      const taken = reserve(state, n);
      await deps.save(id, taken.state);
      return taken.from;
    });
  /** Move forward to at least `next`, never below what is stored, under the lock. */
  const forward = (id: string, next: number) =>
    locked(id, async () => {
      const state = cleanState(await deps.load(id));
      if (state) await deps.save(id, advance(state, next));
    });

  return {
    lane: () => locked(keysetId(), () => laneLocked(keysetId())),
    /** Claim a paid funding quote's sats as seeded proofs. */
    async add(sats: number, quote: Parameters<Wallet["ops"]["mintBolt11"]>[1]): Promise<Proof[]> {
      const id = keysetId();
      const amounts = split(sats);
      for (let attempt = 0; attempt < 6; attempt++) {
        // Written down first, under the lock: from here, a crash burns these counters and nothing more, and no other
        // tab can be handed them.
        const from = await take(id, amounts.length);
        if (from === null) throw new Error("Every lane of this mint is in use: the wallet stays unseeded here.");
        const made = await deps.outputs(id, amounts, from);
        await forward(id, made.next);
        if (deps.checkFirst !== false) {
          const signed = await signedAmong(made.outputs);
          if (signed !== null) {
            await forward(id, signed + 1);
            continue;
          }
        }
        try {
          return await deps.wallet.ops.mintBolt11(sats, quote).asCustom(made.outputs.map(asOutputData)).run();
        } catch (err) {
          if (!alreadySigned(err)) throw err;
          // Refused whole, nothing issued: past the clash, and the same paid invoice claimed again.
          await forward(id, Math.max(...made.outputs.map((o) => o.counter)) + 1);
        }
      }
      throw new Error("The mint kept refusing these counters: nothing was spent, and the invoice can be claimed again.");
    }
  };
}
