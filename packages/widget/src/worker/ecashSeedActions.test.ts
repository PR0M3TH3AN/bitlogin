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
import { adoptPins, drawLane, forwardLane, pinKeyset, readCounters, readLane, readPins, repinKeyset, reserveOutputs, seedBlinded, seedLane, seedUnblind, trialOutput, type Lock } from "./ecashLanes.js";
import { ecashSeed, seededBlinded, seededUnblind } from "./ecashSeed.js";
import { laneStart, TRIAL_FROM } from "../ecash/seedLanes.js";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
/** A mint's keyset, made here: its id, its public keys as the mint lists them, and its private keys to sign with. */
const mintKeys = () => {
  const k = createNewMintKeys(4);
  return { id: k.keysetId, pub: Object.fromEntries(Object.entries(k.pubKeys).map(([a, p]) => [a, hex(p as Uint8Array)])), priv: k.privKeys as Record<string, Uint8Array> };
};
const REAL = mintKeys();
const KEYSET = REAL.id;
const GIVEN = { keys: REAL.pub, unit: "sat" };
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
    await expect(reserveOutputs(deps, KEYSET, [1], GIVEN)).rejects.toMatchObject({ code: "no-lane" });
    expect(await drawLane(deps, KEYSET, 4)).toEqual({ lane: 4, next: laneStart(4) });
    // Another tab's draw a moment later keeps the lane already drawn.
    expect(await drawLane(deps, KEYSET, 9)).toEqual({ lane: 4, next: laneStart(4) });
    const a = await reserveOutputs(deps, KEYSET, [1, 2], GIVEN);
    const b = await reserveOutputs(deps, KEYSET, [4], GIVEN);
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
    await expect(reserveOutputs(none, KEYSET, [1], GIVEN)).rejects.toMatchObject({ code: "no-seed-here" });
    await expect(trialOutput(none, KEYSET, GIVEN)).rejects.toMatchObject({ code: "no-seed-here" });
  });

  it("hands out each trial counter once, in order from the start of the trial range", async () => {
    const { deps } = worker();
    const counters = [];
    for (let i = 0; i < 3; i++) counters.push((await trialOutput(deps, KEYSET, GIVEN)).counter);
    expect(counters).toEqual([TRIAL_FROM, TRIAL_FROM + 1, TRIAL_FROM + 2]);
  });

  it("unblinds only a signature its mint proved (DLEQ), for the keyset its keys make: no oracle for r·K (fault 1)", () => {
    const seed = ecashSeed(generatePrivateKey());
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

  it("hands out no secret and no blinding factor before the mint has signed: reserve and the trial give blinded messages (third review 1)", async () => {
    const { deps } = worker();
    await drawLane(deps, KEYSET, 4);
    const made = await reserveOutputs(deps, KEYSET, [1, 2], GIVEN);
    for (const o of made.outputs) expect(Object.keys(o).sort()).toEqual(["B_", "amount", "counter", "id"]);
    const trial = await trialOutput(deps, KEYSET, GIVEN);
    expect(Object.keys(trial).sort()).toEqual(["B_", "amount", "counter", "id"]);
  });

  it("pins a keyset's keys the first time they are used, and refuses other keys under that id after (third review 2)", async () => {
    const { deps } = worker();
    const other = mintKeys();
    await pinKeyset(deps, KEYSET, GIVEN);
    await pinKeyset(deps, KEYSET, GIVEN);
    // Other keys under this id don't make it, and are refused before any pin is looked at.
    await expect(pinKeyset(deps, KEYSET, { keys: other.pub, unit: "sat" })).rejects.toThrow(/not this keyset's/u);
    // Another keyset is its own.
    await pinKeyset(deps, other.id, { keys: other.pub, unit: "sat" });
  });

  // The fourth review (2026-11-25), each failing before it was mended.
  it("finishes nothing the mint didn't prove, however fresh the counter: no exception for one just reserved (fourth review 1)", async () => {
    const { deps } = worker();
    await drawLane(deps, KEYSET, 3);
    const made = await reserveOutputs(deps, KEYSET, [2], GIVEN);
    const o = made.outputs[0]!;
    const sig = createBlindSignature(pointFromHex(o.B_), REAL.priv["2"]!, REAL.id);
    // The mint's own signature, a moment after the reserve, with no proof: refused, and so is a point the page chose.
    await expect(seedUnblind(deps, KEYSET, GIVEN, [{ counter: o.counter, amount: 2, C_: sig.C_.toHex(true) }])).rejects.toMatchObject({ code: "no-dleq" });
    const chosen = pointFromHex(REAL.pub["2"]!).multiply(7n).toHex(true);
    await expect(seedUnblind(deps, KEYSET, GIVEN, [{ counter: o.counter, amount: 1, C_: chosen }, { counter: o.counter, amount: 2, C_: chosen }])).rejects.toThrow();
    // One counter listed twice, with a proof: refused whole.
    const proof = createDLEQProof(pointFromHex(o.B_), REAL.priv["2"]!);
    const proved = { counter: o.counter, amount: 2, C_: sig.C_.toHex(true), dleq: { e: hex(proof.e), s: hex(proof.s) } };
    await expect(seedUnblind(deps, KEYSET, GIVEN, [proved, proved])).rejects.toThrow(/once/u);
    expect(await seedUnblind(deps, KEYSET, GIVEN, [proved])).toHaveLength(1);
  });

  it("checks keys against the id before it pins them, and before it makes any output the mint is asked to sign (fourth review 2)", async () => {
    const { deps } = worker();
    const garbage = { keys: { "1": "02" + "aa".repeat(32) }, unit: "sat" };
    // Keys that don't make the id: refused, and nothing pinned.
    await expect(seedUnblind(deps, KEYSET, garbage, [])).rejects.toThrow(/not this keyset's/u);
    expect(await readPins(deps)).toEqual({});
    await drawLane(deps, KEYSET, 5);
    await expect(reserveOutputs(deps, KEYSET, [1], garbage)).rejects.toThrow(/not this keyset's/u);
    await expect(trialOutput(deps, KEYSET, garbage)).rejects.toThrow(/not this keyset's/u);
    // Nothing reserved for it: the lane hasn't moved.
    expect(await readLane(deps, KEYSET)).toEqual({ lane: 5, next: laneStart(5) });
    // The real keys pin, at the first reserve.
    await reserveOutputs(deps, KEYSET, [1], GIVEN);
    expect(Object.keys(await readPins(deps))).toEqual([KEYSET]);
  });

  it("lets the owner put a pin on the keys the mint now gives, checked against the id, and the newer pin goes to every device (fourth review 2)", async () => {
    const { deps } = worker();
    const old = { keys: { ...REAL.pub, "8": "02" + "cc".repeat(32) }, unit: "sat" };
    // A pin of other keys, as an older device might have made.
    await adoptPins(deps, [{ keysetId: KEYSET, hash: "ab".repeat(32), at: 100 }]);
    await expect(reserveOutputs(deps, KEYSET, [1], GIVEN)).rejects.toMatchObject({ code: "pin-mismatch" });
    // Re-pinned only to keys that make the id.
    await expect(repinKeyset(deps, KEYSET, old)).rejects.toThrow(/not this keyset's/u);
    await repinKeyset(deps, KEYSET, GIVEN);
    await drawLane(deps, KEYSET, 6);
    expect((await reserveOutputs(deps, KEYSET, [1], GIVEN)).outputs).toHaveLength(1);
    const pin = (await readPins(deps))[KEYSET]!;
    expect(pin.at).toBeGreaterThan(100);
    // The older record, read again from a relay, doesn't put the old pin back; a newer one would.
    await adoptPins(deps, [{ keysetId: KEYSET, hash: "ab".repeat(32), at: 100 }]);
    expect((await readPins(deps))[KEYSET]).toEqual(pin);
    await adoptPins(deps, [{ keysetId: KEYSET, hash: "cd".repeat(32), at: pin.at + 10 }]);
    expect((await readPins(deps))[KEYSET]).toEqual({ hash: "cd".repeat(32), at: pin.at + 10 });
  });
});
