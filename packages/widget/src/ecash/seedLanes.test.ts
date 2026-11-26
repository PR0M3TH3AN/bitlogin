/** The seed's counters and lanes, as rules (docs/ecash-seed-counter.md, rules 1 to 3). */
import { describe, expect, it } from "vitest";
import { advance, cleanState, drawLane, LANES, laneEnd, laneOf, laneStart, reserve } from "./seedLanes.js";

describe("the seed's lanes and counters", () => {
  it("split the counter space into 32 lanes that never overlap and stay below 2³¹", () => {
    expect(laneStart(0)).toBe(1);
    for (let lane = 0; lane < LANES; lane++) {
      expect(laneOf(laneStart(lane))).toBe(lane);
      expect(laneOf(laneEnd(lane))).toBe(lane);
      if (lane > 0) expect(laneStart(lane)).toBe(laneEnd(lane - 1) + 1);
    }
    expect(laneEnd(LANES - 1)).toBeLessThan(2 ** 31);
  });

  it("reserve exactly what is asked, and only ever go forward", () => {
    const start = { lane: 3, next: laneStart(3) };
    const taken = reserve(start, 4);
    expect(taken.from).toBe(laneStart(3));
    expect(taken.state.next).toBe(laneStart(3) + 4);
    // Never backwards, never out of the lane.
    expect(advance(taken.state, laneStart(3))).toEqual(taken.state);
    expect(advance(taken.state, laneStart(9)).next).toBe(laneEnd(3));
    expect(() => reserve(start, 0)).toThrow();
    expect(() => reserve({ lane: 3, next: laneEnd(3) }, 2)).toThrow();
  });

  it("use a kept state only when it is what it says", () => {
    expect(cleanState({ lane: 2, next: laneStart(2) + 5 })).toEqual({ lane: 2, next: laneStart(2) + 5 });
    for (const bad of [null, {}, { lane: 32, next: 1 }, { lane: 2, next: laneStart(3) }, { lane: 2, next: 1.5 }, { lane: -1, next: 1 }]) expect(cleanState(bad)).toBeNull();
  });

  it("draw only lanes the mint shows empty, each at most once, and none when all are used", async () => {
    const asked: number[] = [];
    const used = new Set([0, 1, 2, 3]);
    const lane = await drawLane(async (l) => (asked.push(l), used.has(l)), () => 0);
    expect(lane).toBe(4);
    expect(asked).toEqual([0, 1, 2, 3, 4]);
    const all: number[] = [];
    expect(await drawLane(async (l) => (all.push(l), true))).toBeNull();
    expect(new Set(all).size).toBe(LANES);
  });
});
