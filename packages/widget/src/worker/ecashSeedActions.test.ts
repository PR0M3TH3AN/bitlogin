/**
 * What the worker hands the wallet's page from the seed (the review's finding 3, 2026-11-25): never an output's secret
 * or blinding factor for a counter the page names. A script that ran once on the wallet's page could otherwise have
 * worked out outputs the wallet will use later, and taken the sats added to them from the mint's restore.
 */
import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import { WorkerClient } from "./workerClient.js";
import { drawLane, forwardLane, readCounters, readLane, reserveOutputs, trialOutput, type Lock } from "./ecashLanes.js";
import { ecashSeed } from "./ecashSeed.js";
import { laneStart, TRIAL_FROM } from "../ecash/seedLanes.js";

const KEYSET = "00ad268c4d1f5826";
/** A worker's deps, with a lock that records the names it is taken under. */
function worker(lock: Lock | null = null) {
  const taken: string[] = [];
  const seed = ecashSeed(generatePrivateKey());
  const recording: Lock = (name, fn) => (taken.push(name), fn());
  return { deps: { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), seed: () => seed.slice(), lock: lock === null ? recording : lock }, taken };
}

describe("the seed's outputs stay with the worker", () => {
  it("has no call that makes outputs, or moves a lane, at counters the page names", () => {
    const calls = Object.getOwnPropertyNames(WorkerClient.prototype);
    expect(calls).not.toContain("ecashOutputs");
    expect(calls).not.toContain("ecashLaneSet");
  });

  it("hands out outputs only at counters it reserves from this browser's lane, written down first, never twice", async () => {
    const { deps, taken } = worker();
    await expect(reserveOutputs(deps, KEYSET, [1])).rejects.toMatchObject({ code: "no-lane" });
    expect(await drawLane(deps, KEYSET, 4)).toEqual({ lane: 4, next: laneStart(4) });
    // Another tab's draw a moment later keeps the lane already drawn.
    expect(await drawLane(deps, KEYSET, 9)).toEqual({ lane: 4, next: laneStart(4) });
    const a = await reserveOutputs(deps, KEYSET, [1, 2]);
    const b = await reserveOutputs(deps, KEYSET, [4]);
    expect(a.outputs.map((o) => o.counter)).toEqual([laneStart(4), laneStart(4) + 1]);
    expect(b.outputs.map((o) => o.counter)).toEqual([laneStart(4) + 2]);
    expect(await readLane(deps, KEYSET)).toEqual({ lane: 4, next: laneStart(4) + 3 });
    // Recorded for the wallet record, only ever up.
    expect(await readCounters(deps)).toEqual({ [KEYSET]: { "4": laneStart(4) + 3 } });
    // Every read and change under the keyset's lock: the refused reserve, two draws, two reserves.
    expect(taken.filter((n) => n === `bitlogin:ecash-seed:${KEYSET}`)).toHaveLength(5);
  });

  it("moves a lane forward under the lock, never back (findings 8 and 10)", async () => {
    const { deps, taken } = worker();
    await drawLane(deps, KEYSET, 2);
    taken.length = 0;
    expect(await forwardLane(deps, KEYSET, laneStart(2) + 50)).toEqual({ lane: 2, next: laneStart(2) + 50 });
    expect(await forwardLane(deps, KEYSET, laneStart(2) + 10)).toEqual({ lane: 2, next: laneStart(2) + 50 });
    expect(taken).toEqual([`bitlogin:ecash-seed:${KEYSET}`, `bitlogin:ecash-seed:${KEYSET}`]);
  });

  it("makes nothing from the seed where there is no lock to keep tabs apart", async () => {
    const { deps } = worker();
    const none = { ...deps, lock: null };
    await expect(drawLane(none, KEYSET, 1)).rejects.toMatchObject({ code: "no-seed-here" });
    await expect(reserveOutputs(none, KEYSET, [1])).rejects.toMatchObject({ code: "no-seed-here" });
    await expect(trialOutput(none, KEYSET)).rejects.toMatchObject({ code: "no-seed-here" });
  });

  it("hands out each trial counter once, in order from the start of the trial range", async () => {
    const { deps } = worker();
    const counters = [];
    for (let i = 0; i < 3; i++) counters.push((await trialOutput(deps, KEYSET)).counter);
    expect(counters).toEqual([TRIAL_FROM, TRIAL_FROM + 1, TRIAL_FROM + 2]);
  });
});
