/**
 * Adding sats with outputs made from the seed (docs/ecash-seed-counter.md). The page's half: the worker keeps the seed
 * and the counters (worker/ecashLanes.ts), and hands the page an output's secret only for counters it has itself
 * reserved for that operation (2026-11-25, the review's finding 3). This keeps to the rules:
 *
 * - a lane the mint shows as empty, kept in this browser only (rule 3), its first 100 counters asked about;
 * - exactly the counters the operation needs, written down by the worker before the mint is asked, only ever forward
 *   (rules 1, 2), under the worker's lock, so two tabs are never handed the same ones (rule 3a);
 * - the mint asked first whether any of them are signed already, and those stepped past (rule 5);
 * - a request the mint refuses as already signed is retried past the clash, with the same paid invoice (rule 4).
 *
 * Only for a mint whose keyset passed the trial (rule 4). Tested against the mock mints only.
 */
import { Amount, OutputData, type Proof, type Wallet } from "@cashu/cashu-ts";
import { drawLane, LANE_PROBE, laneStart, NO_SEED_HERE, type LaneState } from "./seedLanes.js";
import type { BlindedAt, FoundAt, KeysetGiven, ReservedOutput, SeededOutput } from "../worker/ecashSeed.js";

/** The worker's seed actions, as the page has them (headless.ts): none hands out what unblinds a counter it names. */
export interface SeedWorker {
  /** This browser's lane for a keyset, or null. */
  lane(keysetId: string): Promise<LaneState | null>;
  /** Take a lane the mint shows as empty, where this browser has none; the lane kept is returned. */
  draw(keysetId: string, lane: number): Promise<LaneState>;
  /** Outputs for one operation, at counters the worker reserves and writes down first: blinded messages only. */
  reserve(keysetId: string, amounts: number[]): Promise<{ outputs: ReservedOutput[]; from: number; next: number }>;
  /** Move this browser's lane forward, never back. */
  forward(keysetId: string, next: number): Promise<LaneState | null>;
  /** Blinded messages at any counters: nothing that unblinds them. */
  blinded(keysetId: string, from: number, count: number): Promise<BlindedAt[]>;
  /** Finished proofs for what a mint signed at this seed's counters and proved it signed, unblinded in the worker. */
  unblind(keysetId: string, keyset: KeysetGiven, found: FoundAt[]): Promise<Proof[]>;
  /** One output for a trial, at the next trial counter not yet handed out: its blinded message only. */
  trialOutput(keysetId: string): Promise<ReservedOutput>;
}

export interface SeededMintDeps {
  /** The mint, as the page's wallet holds it: no seed. */
  wallet: Wallet;
  seed: SeedWorker;
  /** Draw order for lanes, for tests. */
  random?: () => number;
  /** Ask the mint about the counters before using them (rule 5). On, unless a test turns it off. */
  checkFirst?: boolean;
  /**
   * Lanes the wallet record names as this account's (its counters): never drawn, whatever the mint shows at their
   * start (the third review: a lane reserved from and never signed in looks empty to the mint).
   */
  used?: readonly number[];
}

const bytes = (h: string) => new Uint8Array(h.match(/../gu)!.map((x) => parseInt(x, 16)));
/** The library's own output, from an output with what unblinds it: for tests, which make outputs outside a worker. */
export const asOutputData = (o: SeededOutput) => new OutputData({ amount: Amount.from(o.amount), id: o.id, B_: o.B_ }, BigInt(`0x${o.blindingFactor}`), bytes(o.secret));
/** A keyset as the worker is handed it to check signatures: its keys, and what its id is made from besides. */
export const keysetGiven = (keyset: { keys: Record<number | string, string>; unit: string; fee?: number; expiry?: number }): KeysetGiven => ({
  keys: Object.fromEntries(Object.entries(keyset.keys).map(([a, k]) => [String(a), k])),
  unit: keyset.unit,
  ...(keyset.fee ? { input_fee_ppk: keyset.fee } : {}),
  ...(keyset.expiry ? { final_expiry: keyset.expiry } : {})
});
/** What the mint signed for these outputs, as the worker is asked to finish them. */
export const signedFor = (outputs: readonly ReservedOutput[], signatures: readonly { amount: unknown; C_: string; dleq?: { e?: unknown; s?: unknown } }[]): FoundAt[] =>
  outputs.map((o, i) => {
    const sig = signatures[i]!;
    const dleq = sig.dleq && typeof sig.dleq.e === "string" && typeof sig.dleq.s === "string" ? { e: sig.dleq.e, s: sig.dleq.s } : undefined;
    return { counter: o.counter, amount: Number(sig.amount), C_: sig.C_, ...(dleq ? { dleq } : {}) };
  });
const split = (sats: number): number[] => {
  const out: number[] = [];
  for (let bit = 1; sats > 0; bit *= 2, sats = Math.floor(sats / 2)) if (sats % 2) out.push(bit);
  return out;
};
const alreadySigned = (err: unknown): boolean => /already signed/iu.test(String((err as Error)?.message ?? "")) || (err as { code?: number })?.code === 10002;

/**
 * One lock per name, across every tab and worker of this site: `navigator.locks` (2026-11-24). The worker takes it for
 * every change to a lane (worker/ecashLanes.ts). Where a browser has none, the seed is not used in it at all: that
 * browser stays relay-kept, as a mint that hasn't passed the trial does, and the screen says so.
 */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
type Locks = { request(name: string, fn: () => Promise<unknown>): Promise<unknown> };
const browserLocks = (): Locks | null => (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks ?? null;
/** Whether this browser can keep two tabs apart, and so may add by the seed. */
export const seedUsableHere = (): boolean => typeof browserLocks()?.request === "function";
/** What the screen says where the seed isn't used in this browser. */
export { NO_SEED_HERE };

/** The counters among these blinded messages the mint has signed already: the highest, or null. */
export async function signedAmong(wallet: Wallet, blinded: readonly { B_: string; id: string; counter: number }[]): Promise<number | null> {
  const { outputs } = await wallet.mint.restore({ outputs: blinded.map((o) => ({ amount: Amount.from(1), id: o.id, B_: o.B_ })) as never });
  const taken = new Set(outputs.map((o) => o.B_));
  const hits = blinded.filter((o) => taken.has(o.B_)).map((o) => o.counter);
  return hits.length ? Math.max(...hits) : null;
}

export function createSeededMint(deps: SeededMintDeps) {
  const keysetId = () => deps.wallet.keysetId;

  /** This browser's lane, drawn the first time from lanes the mint shows as empty. Null where none can be had. */
  async function lane(id: string): Promise<LaneState | null> {
    const kept = await deps.seed.lane(id);
    if (kept) return kept;
    const used = new Set(deps.used ?? []);
    const drawn = await drawLane(async (l) => used.has(l) || (await signedAmong(deps.wallet, await deps.seed.blinded(id, laneStart(l), LANE_PROBE))) !== null, deps.random);
    if (drawn === null) return null;
    // Another tab may have drawn one a moment before: the worker keeps whichever came first, and says which.
    return deps.seed.draw(id, drawn);
  }

  return {
    lane: () => lane(keysetId()),
    /** Claim a paid funding quote's sats as seeded proofs. */
    async add(sats: number, quote: Parameters<Wallet["ops"]["mintBolt11"]>[1]): Promise<Proof[]> {
      const id = keysetId();
      const amounts = split(sats);
      if (!(await lane(id))) throw Object.assign(new Error("Every lane of this mint is in use: the wallet stays unseeded here."), { code: "no-lane" });
      for (let attempt = 0; attempt < 6; attempt++) {
        // Reserved and written down by the worker, under its lock: from here, a crash burns these counters and nothing
        // more, and no other tab can be handed them.
        const made = await deps.seed.reserve(id, amounts);
        if (deps.checkFirst !== false) {
          const signed = await signedAmong(deps.wallet, made.outputs);
          if (signed !== null) {
            await deps.seed.forward(id, signed + 1);
            continue;
          }
        }
        try {
          // The mint signs the blinded messages; the worker finishes them into proofs, checking the mint's proof of
          // each. Nothing that unblinds them was on this page before the mint had signed.
          const { signatures } = await deps.wallet.mint.mintBolt11({ quote: typeof quote === "string" ? quote : quote.quote, outputs: made.outputs.map((o) => ({ amount: o.amount, id: o.id, B_: o.B_ })) } as never);
          return await deps.seed.unblind(id, keysetGiven(deps.wallet.keyChain.getKeyset(id)), signedFor(made.outputs, signatures));
        } catch (err) {
          if (!alreadySigned(err)) throw err;
          // Refused whole, nothing issued: past the clash, and the same paid invoice claimed again.
          await deps.seed.forward(id, Math.max(...made.outputs.map((o) => o.counter)) + 1);
        }
      }
      throw new Error("The mint kept refusing these counters: nothing was spent, and the invoice can be claimed again.");
    }
  };
}
