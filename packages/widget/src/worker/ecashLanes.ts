/**
 * This browser's lane for each mint keyset (docs/ecash-seed-counter.md, rules 1 to 3), kept by the worker. Sealed to
 * the account's own key, as the wallet's copy is: nothing new is kept in the clear. Only ever forward: a lane once kept
 * is not changed, and its counter is never set lower here, whatever the page asks.
 *
 * The worker owns the counters (2026-11-25, the review's finding 3). The page is handed an output's secret and
 * blinding factor only for counters the worker has itself just reserved, and written down, for that operation; it can
 * never name a counter and be handed what unblinds it. Every read and change of a lane is made under one lock per
 * keyset (`navigator.locks`, shared by every tab and worker of the site): reserving, drawing, moving forward, and so
 * restore's move too. Where the worker has no such lock, nothing is made from the seed at all.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanState, laneEnd, laneStart, TRIAL_FROM, TRIAL_TO, validLane, type LaneState } from "../ecash/seedLanes.js";
import { seededBlinded, seededOutputs, seededUnblind, type BlindedAt, type SeededOutput } from "./ecashSeed.js";
import type { Proof } from "@cashu/cashu-ts";

const KEYSET = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/u;
const checkKeyset = (keysetId: unknown): string => {
  if (typeof keysetId !== "string" || !KEYSET.test(keysetId)) throw new Error("That is not a keyset id.");
  return keysetId;
};
const keyFor = (me: string, keysetId: unknown): string => `bitlogin:ecash-lane:v1:${me}:${checkKeyset(keysetId)}`;
const trialKeyFor = (me: string, keysetId: string): string => `bitlogin:ecash-trial-next:v1:${me}:${keysetId}`;
const countersKey = (me: string): string => `bitlogin:ecash-counters:v1:${me}`;

export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;
type Locks = { request(name: string, fn: () => Promise<unknown>): Promise<unknown> };
/** The worker's own `navigator.locks`, shared with every tab of the site; null where it has none. */
export const workerLock = (): Lock | null => {
  const locks = (globalThis as { navigator?: { locks?: Locks } }).navigator?.locks;
  return locks && typeof locks.request === "function" ? ((name, fn) => locks.request(name, fn) as Promise<never>) : null;
};

export interface LaneDeps {
  signer: NostrSigner;
  store: KeyValueStore;
}
export interface SeedDeps extends LaneDeps {
  /** The seed, made fresh for this call; it is zeroed after. */
  seed: () => Uint8Array;
  /** The lock that keeps tabs apart; null where there is none, and then nothing is made from the seed. */
  lock: Lock | null;
}

const NO_LOCK = "This browser can't keep two tabs from using the same counters, so the seed isn't used in it.";
const locked = <T>(deps: SeedDeps, name: string, fn: () => Promise<T>): Promise<T> => {
  if (!deps.lock) return Promise.reject(Object.assign(new Error(NO_LOCK), { code: "no-seed-here" }));
  return deps.lock(name, fn);
};
const laneLock = (keysetId: string) => `bitlogin:ecash-seed:${keysetId}`;

async function readSealed(deps: LaneDeps, key: string): Promise<unknown> {
  const me = deps.signer.getPublicKey();
  const sealed = await deps.store.get(key);
  if (!sealed) return null;
  try {
    return JSON.parse(deps.signer.nip44Decrypt(me, sealed));
  } catch {
    return null;
  }
}
async function writeSealed(deps: LaneDeps, key: string, value: unknown): Promise<void> {
  const me = deps.signer.getPublicKey();
  await deps.store.set(key, deps.signer.nip44Encrypt(me, JSON.stringify(value)));
}

export async function readLane(deps: LaneDeps, keysetId: unknown): Promise<LaneState | null> {
  return cleanState(await readSealed(deps, keyFor(deps.signer.getPublicKey(), keysetId)));
}

/** Nothing at all is done with the seed where there is no lock to keep tabs apart (the review's second finding 1). */
const needLock = (deps: SeedDeps): void => {
  if (!deps.lock) throw Object.assign(new Error(NO_LOCK), { code: "no-seed-here" });
};
/** This browser's lane for a keyset, as the page asks it: only where the seed may be used. */
export async function seedLane(deps: SeedDeps, keysetId: unknown): Promise<LaneState | null> {
  needLock(deps);
  return readLane(deps, keysetId);
}
/** Blinded messages at any counters: only where the seed may be used. */
export async function seedBlinded(deps: SeedDeps, keysetId: unknown, from: unknown, count: unknown): Promise<BlindedAt[]> {
  needLock(deps);
  const seed = deps.seed();
  try {
    return seededBlinded(seed, keysetId, from, count);
  } finally {
    seed.fill(0);
  }
}
/** Finished proofs for signatures the mint proved: only where the seed may be used. */
export async function seedUnblind(deps: SeedDeps, keysetId: unknown, keyset: unknown, found: unknown): Promise<Proof[]> {
  needLock(deps);
  const seed = deps.seed();
  try {
    return seededUnblind(seed, keysetId, keyset, found);
  } finally {
    seed.fill(0);
  }
}

/** Keep a lane's state, forward only. Returns what is kept after: the one asked for, or the one already there. */
export async function keepLane(deps: LaneDeps, keysetId: unknown, state: unknown): Promise<LaneState | null> {
  const key = keyFor(deps.signer.getPublicKey(), keysetId);
  const asked = cleanState(state);
  if (!asked) throw new Error("That is not a lane.");
  const kept = await readLane(deps, keysetId);
  if (kept && (kept.lane !== asked.lane || asked.next <= kept.next)) return kept;
  await writeSealed(deps, key, asked);
  await noteCounter(deps, keysetId as string, asked);
  return asked;
}

/**
 * The highest counter this browser has reached in each keyset and lane: what the wallet record carries, so restore on
 * another device knows how far a lane goes, gaps and all (rule 3, the review's finding 2). Only ever up.
 */
export type Counters = Record<string, Record<string, number>>;
export async function readCounters(deps: LaneDeps): Promise<Counters> {
  const raw = (await readSealed(deps, countersKey(deps.signer.getPublicKey()))) as Counters | null;
  const out: Counters = {};
  for (const [keysetId, lanes] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (!KEYSET.test(keysetId) || !lanes || typeof lanes !== "object") continue;
    for (const [lane, next] of Object.entries(lanes)) if (validLane(Number(lane)) && Number.isSafeInteger(next)) (out[keysetId] ??= {})[lane] = next;
  }
  return out;
}
/** Each tab of this browser shares the record of counters: one change at a time. */
const countersChain = new Map<string, Promise<unknown>>();
async function noteCounter(deps: LaneDeps, keysetId: string, state: LaneState): Promise<void> {
  const me = deps.signer.getPublicKey();
  const change = async () => {
    const counters = await readCounters(deps);
    const lanes = (counters[keysetId] ??= {});
    if ((lanes[String(state.lane)] ?? 0) >= state.next) return;
    lanes[String(state.lane)] = state.next;
    await writeSealed(deps, countersKey(me), counters);
  };
  const lock = workerLock();
  if (lock) return lock(`bitlogin:ecash-counters:${me}`, change);
  // No browser lock (tests, Node): one at a time within this worker.
  const run = (countersChain.get(me) ?? Promise.resolve()).then(change, change);
  countersChain.set(me, run.catch(() => {}));
  return run;
}

/**
 * Take this lane for a keyset, where this browser has none yet: the lane the page found the mint shows as empty. A
 * lane already kept stays, whatever is asked (another tab may have drawn it a moment before): what is kept is returned.
 */
export function drawLane(deps: SeedDeps, keysetId: unknown, lane: unknown): Promise<LaneState> {
  const id = checkKeyset(keysetId);
  if (!validLane(lane)) return Promise.reject(new Error("That is not a lane."));
  return locked(deps, laneLock(id), async () => {
    const kept = await readLane(deps, id);
    if (kept) return kept;
    const state = { lane, next: laneStart(lane) };
    await writeSealed(deps, keyFor(deps.signer.getPublicKey(), id), state);
    await noteCounter(deps, id, state);
    return state;
  });
}

/**
 * The outputs for one operation, at counters taken from this browser's lane and written down before they are handed
 * over (rules 1 and 2): exactly as many as the amounts need, and never the same ones twice. Where this browser has no
 * lane for the keyset yet, it says so ("no-lane"), and the page draws one first.
 */
export function reserveOutputs(deps: SeedDeps, keysetId: unknown, amounts: unknown): Promise<{ outputs: SeededOutput[]; from: number; next: number }> {
  const id = checkKeyset(keysetId);
  return locked(deps, laneLock(id), async () => {
    const state = await readLane(deps, id);
    if (!state) throw Object.assign(new Error("No lane is drawn for this keyset in this browser yet."), { code: "no-lane" });
    const seed = deps.seed();
    let made: { outputs: SeededOutput[]; next: number };
    try {
      made = seededOutputs(seed, id, amounts, state.next);
    } finally {
      seed.fill(0);
    }
    if (made.next - 1 > laneEnd(state.lane)) throw Object.assign(new Error("This lane is used up."), { code: "no-lane" });
    const after = { lane: state.lane, next: made.next };
    // Written down first: from here, a crash burns these counters and nothing more.
    await writeSealed(deps, keyFor(deps.signer.getPublicKey(), id), after);
    await noteCounter(deps, id, after);
    return { outputs: made.outputs, from: state.next, next: made.next };
  });
}

/** Move this browser's lane forward to at least `next` (past counters a mint shows as signed), under the lock. */
export function forwardLane(deps: SeedDeps, keysetId: unknown, next: unknown): Promise<LaneState | null> {
  const id = checkKeyset(keysetId);
  if (!Number.isSafeInteger(next)) return Promise.reject(new Error("That is not a counter."));
  return locked(deps, laneLock(id), async () => {
    const state = await readLane(deps, id);
    if (!state || (next as number) <= state.next) return state;
    return keepLane(deps, id, { lane: state.lane, next: Math.min(next as number, laneEnd(state.lane)) });
  });
}

/**
 * One output for a trial (rule 4), at the next trial counter this browser hasn't handed out: each is handed out once,
 * in order from the start of the trial range, so restore can follow them as it follows a lane. The page asks the mint
 * that it is unused before using it, and asks again for another where it isn't.
 */
export function trialOutput(deps: SeedDeps, keysetId: unknown): Promise<SeededOutput> {
  const id = checkKeyset(keysetId);
  return locked(deps, `bitlogin:ecash-trial:${id}`, async () => {
    const key = trialKeyFor(deps.signer.getPublicKey(), id);
    const kept = (await readSealed(deps, key)) as { next?: unknown } | null;
    const next = Number.isSafeInteger(kept?.next) && (kept!.next as number) >= TRIAL_FROM ? (kept!.next as number) : TRIAL_FROM;
    if (next > TRIAL_TO) throw new Error("Every trial counter of this keyset has been used.");
    const seed = deps.seed();
    let made: { outputs: SeededOutput[]; next: number };
    try {
      made = seededOutputs(seed, id, [1], next);
    } finally {
      seed.fill(0);
    }
    await writeSealed(deps, key, { next: made.next });
    return made.outputs[0]!;
  });
}
