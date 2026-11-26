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
import { labelSalt } from "@bitlogin/core/crypto";
import { checkKeys, seededBlinded, seededOutputs, seededUnblind, type BlindedAt, type KeysetGiven, type ReservedOutput, type SeededOutput } from "./ecashSeed.js";
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
/**
 * Finished proofs for signatures the mint proved (DLEQ), under keys that make the keyset's id and match its pin: only
 * where the seed may be used. Never one without a proof (2026-11-25, the fourth review's 1): a mint that lapses gives
 * nothing to finish here, and restore finds the sats once it proves them.
 */
export async function seedUnblind(deps: SeedDeps, keysetId: unknown, keyset: unknown, found: unknown): Promise<Proof[]> {
  needLock(deps);
  const id = checkKeyset(keysetId);
  await pinKeyset(deps, id, keyset as KeysetGiven);
  const seed = deps.seed();
  try {
    return seededUnblind(seed, id, keyset, found);
  } finally {
    seed.fill(0);
  }
}

/** The page's view of an output: its blinded message, never what unblinds it. */
const outward = (o: SeededOutput): ReservedOutput => ({ amount: o.amount, id: o.id, B_: o.B_, counter: o.counter });

/**
 * The keys a keyset was first used with here, by a hash of them, kept and never replaced (2026-11-25, the third
 * review): an older keyset id is only 56 bits of a hash of its keys, so keys made to match it, passed later as the
 * mint's, are refused once the real ones were used. Carried to other devices in the wallet record (pins).
 */
const pinsKey = (me: string) => `bitlogin:ecash-keypins:v1:${me}`;
/** A pin: the hash of the keys, and when it was made, in seconds. The newer wins between devices (an owner's re-pin). */
export interface KeyPin {
  hash: string;
  at: number;
}
const HASH = /^[0-9a-f]{64}$/u;
export const keysetHash = (keyset: KeysetGiven): string => {
  const keys = Object.entries(keyset?.keys ?? {}).sort(([a], [b]) => Number(a) - Number(b) || a.localeCompare(b));
  return Array.from(labelSalt(JSON.stringify(keys)), (b) => b.toString(16).padStart(2, "0")).join("");
};
export async function readPins(deps: LaneDeps): Promise<Record<string, KeyPin>> {
  const raw = (await readSealed(deps, pinsKey(deps.signer.getPublicKey()))) as Record<string, unknown> | null;
  const out: Record<string, KeyPin> = {};
  for (const [id, pin] of Object.entries(raw && typeof raw === "object" ? raw : {})) {
    if (!KEYSET.test(id)) continue;
    // One kept before pins had a date is the oldest there is.
    if (typeof pin === "string" && HASH.test(pin)) out[id] = { hash: pin, at: 0 };
    const p = pin as Partial<KeyPin> | null;
    if (p && typeof p === "object" && typeof p.hash === "string" && HASH.test(p.hash) && Number.isSafeInteger(p.at) && p.at! >= 0) out[id] = { hash: p.hash, at: p.at! };
  }
  return out;
}
const writePins = (deps: LaneDeps, pins: Record<string, KeyPin>) => writeSealed(deps, pinsKey(deps.signer.getPublicKey()), pins);
const PIN_MISMATCH = "These aren't the keys this mint's keyset was first used with here.";
const pinsChain = new Map<string, Promise<unknown>>();
function withPins<T>(deps: LaneDeps, fn: () => Promise<T>): Promise<T> {
  const me = deps.signer.getPublicKey();
  const lock = workerLock();
  if (lock) return lock(`bitlogin:ecash-keypins:${me}`, fn);
  const run = (pinsChain.get(me) ?? Promise.resolve()).then(fn, fn);
  pinsChain.set(me, run.catch(() => {}));
  return run;
}
/**
 * Check a keyset's keys, and pin them the first time: the keys must make the keyset's id before anything is pinned
 * (2026-11-25, the fourth review's 2), so keys that don't can't be pinned for a real keyset's id and strand what it
 * signs later. Keys that make the id but aren't the pinned ones are refused ("pin-mismatch").
 */
export async function pinKeyset(deps: LaneDeps, keysetId: string, keyset: KeysetGiven): Promise<void> {
  checkKeys(keysetId, keyset);
  const hash = keysetHash(keyset);
  return withPins(deps, async () => {
    const pins = await readPins(deps);
    if (pins[keysetId] && pins[keysetId].hash !== hash) throw Object.assign(new Error(PIN_MISMATCH), { code: "pin-mismatch" });
    if (!pins[keysetId]) await writePins(deps, { ...pins, [keysetId]: { hash, at: Math.floor(Date.now() / 1000) } });
  });
}
/**
 * The owner's press: pin the keys the mint gives now in place of the pin there (the fourth review's 2), where they make
 * the keyset's id. Dated now, so it goes to every device and is not undone by an older record.
 */
export async function repinKeyset(deps: LaneDeps, keysetId: unknown, keyset: unknown): Promise<KeyPin> {
  const id = checkKeyset(keysetId);
  checkKeys(id, keyset as KeysetGiven);
  const pin = { hash: keysetHash(keyset as KeysetGiven), at: Math.floor(Date.now() / 1000) };
  return withPins(deps, async () => {
    const pins = await readPins(deps);
    // Never dated before the one it replaces, whatever this device's clock says.
    const at = Math.max(pin.at, (pins[id]?.at ?? 0) + 1);
    await writePins(deps, { ...pins, [id]: { hash: pin.hash, at } });
    return { hash: pin.hash, at };
  });
}
/** Take up pins another device wrote into the wallet record: where none is here, or the record's is newer. */
export function adoptPins(deps: LaneDeps, record: readonly { keysetId: string; hash: string; at?: number }[]): Promise<void> {
  return withPins(deps, async () => {
    const pins = await readPins(deps);
    const add = record.filter((p) => KEYSET.test(p.keysetId) && HASH.test(p.hash) && (!pins[p.keysetId] || (p.at ?? 0) > pins[p.keysetId]!.at));
    if (add.length) await writePins(deps, { ...pins, ...Object.fromEntries(add.map((p) => [p.keysetId, { hash: p.hash, at: p.at ?? 0 }])) });
  });
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
export async function reserveOutputs(deps: SeedDeps, keysetId: unknown, amounts: unknown, keyset: unknown): Promise<{ outputs: ReservedOutput[]; from: number; next: number }> {
  needLock(deps);
  const id = checkKeyset(keysetId);
  // The keys checked against the id and the pin before any output is made (the fourth review's 2): the mint is never
  // asked to sign for keys the worker would then refuse to finish with.
  await pinKeyset(deps, id, keyset as KeysetGiven);
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
    return { outputs: made.outputs.map(outward), from: state.next, next: made.next };
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
export async function trialOutput(deps: SeedDeps, keysetId: unknown, keyset: unknown): Promise<ReservedOutput> {
  needLock(deps);
  const id = checkKeyset(keysetId);
  await pinKeyset(deps, id, keyset as KeysetGiven);
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
    return outward(made.outputs[0]!);
  });
}
