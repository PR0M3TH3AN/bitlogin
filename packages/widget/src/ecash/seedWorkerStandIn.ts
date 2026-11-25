/**
 * The worker's seed actions, run in-process over a store and a lock of the test's own: for tests on this machine, as
 * the mock mint is. The functions are the worker's own (worker/ecashLanes.ts, worker/ecashSeed.ts); only the message
 * passing between page and worker is left out. Never used by the wallet itself.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { drawLane, forwardLane, reserveOutputs, seedBlinded, seedLane, seedUnblind, trialOutput, type Lock } from "../worker/ecashLanes.js";
import type { SeedWorker } from "./seededMint.js";

/** A stand-in for navigator.locks, which Node hasn't: one lock per name, within this process. */
export function standInLock(): Lock {
  const held = new Map<string, Promise<unknown>>();
  return (name, fn) => {
    const run = (held.get(name) ?? Promise.resolve()).then(fn, fn);
    held.set(name, run.catch(() => {}));
    return run;
  };
}

export function standInSeedWorker(deps: { signer: NostrSigner; store: KeyValueStore; seed: Uint8Array; lock: Lock | null }): SeedWorker {
  const worker = { signer: deps.signer, store: deps.store, seed: () => deps.seed.slice(), lock: deps.lock };
  return {
    lane: (id) => seedLane(worker, id),
    draw: (id, lane) => drawLane(worker, id, lane),
    reserve: (id, amounts) => reserveOutputs(worker, id, amounts),
    forward: (id, next) => forwardLane(worker, id, next),
    blinded: (id, from, count) => seedBlinded(worker, id, from, count),
    unblind: (id, keyset, found) => seedUnblind(worker, id, keyset, found),
    trialOutput: (id) => trialOutput(worker, id)
  };
}
