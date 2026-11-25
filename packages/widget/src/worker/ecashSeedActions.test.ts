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
import { createBlindSignature, createDLEQProof, createNewMintKeys, pointFromHex } from "@cashu/cashu-ts";
import { drawLane, forwardLane, readCounters, readLane, reserveOutputs, seedBlinded, seedLane, seedUnblind, trialOutput, type Lock } from "./ecashLanes.js";
import { ecashSeed, seededBlinded, seededUnblind } from "./ecashSeed.js";
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

  it("unblinds only a signature its mint proved (DLEQ), for the keyset its keys make: no oracle for r·K (fault 1)", () => {
    const seed = ecashSeed(generatePrivateKey());
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const mintKeys = () => {
      const k = createNewMintKeys(4);
      return { id: k.keysetId, pub: Object.fromEntries(Object.entries(k.pubKeys).map(([a, p]) => [a, hex(p as Uint8Array)])), priv: k.privKeys as Record<string, Uint8Array> };
    };
    const real = mintKeys();
    const [b] = seededBlinded(seed, real.id, 9, 1);
    const signed = (keys: ReturnType<typeof mintKeys>, dleq = true) => {
      const sig = createBlindSignature(pointFromHex(b!.B_), keys.priv["2"]!, keys.id);
      const proof = createDLEQProof(pointFromHex(b!.B_), keys.priv["2"]!);
      return { counter: b!.counter, amount: 2, C_: sig.C_.toHex(true), ...(dleq ? { dleq: { e: hex(proof.e), s: hex(proof.s) } } : {}) };
    };
    // A point the page chose, with the mint's real keys: refused, so nothing of r·K comes back.
    const chosen = { counter: b!.counter, amount: 2, C_: pointFromHex(real.pub["2"]!).multiply(7n).toHex(true) };
    expect(() => seededUnblind(seed, real.id, { keys: real.pub, unit: "sat" }, [chosen])).toThrow();
    // The mint's real signature with no proof: refused too.
    expect(() => seededUnblind(seed, real.id, { keys: real.pub, unit: "sat" }, [signed(real, false)])).toThrow();
    // Proved by a key of the page's own, passed as this keyset's keys: they don't make this keyset's id.
    const own = mintKeys();
    expect(() => seededUnblind(seed, real.id, { keys: own.pub, unit: "sat" }, [signed(own)])).toThrow();
    // Proved by the mint, under its own keys: the proof.
    const [proof] = seededUnblind(seed, real.id, { keys: real.pub, unit: "sat" }, [signed(real)]);
    expect(Number(proof!.amount)).toBe(2);
  });

  it("does nothing with the seed where there is no lock: not even blinded messages or a lane read (fault 1)", async () => {
    const { deps } = worker();
    const none = { ...deps, lock: null };
    await expect(seedLane(none, KEYSET)).rejects.toMatchObject({ code: "no-seed-here" });
    await expect(seedBlinded(none, KEYSET, 1, 1)).rejects.toMatchObject({ code: "no-seed-here" });
    await expect(seedUnblind(none, KEYSET, {}, [])).rejects.toMatchObject({ code: "no-seed-here" });
  });
});
