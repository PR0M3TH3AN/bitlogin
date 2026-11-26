/** This browser's lanes, kept by the worker (docs/ecash-seed-counter.md), and the seed's actions kept from sites. */
import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import { keepLane, readLane } from "./ecashLanes.js";
import { SIGNER_ONLY_ACTIONS } from "./handoff.js";
import { laneStart } from "../ecash/seedLanes.js";

const KEYSET = "00ad268c4d1f5826";
const setup = () => ({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore() });

describe("the worker's lanes", () => {
  it("are kept sealed, read back, and only ever go forward", async () => {
    const deps = setup();
    expect(await readLane(deps, KEYSET)).toBeNull();
    expect(await keepLane(deps, KEYSET, { lane: 4, next: laneStart(4) + 10 })).toEqual({ lane: 4, next: laneStart(4) + 10 });
    expect(await readLane(deps, KEYSET)).toEqual({ lane: 4, next: laneStart(4) + 10 });
    // Not backwards, not to another lane: what is kept stays.
    expect(await keepLane(deps, KEYSET, { lane: 4, next: laneStart(4) + 3 })).toEqual({ lane: 4, next: laneStart(4) + 10 });
    expect(await keepLane(deps, KEYSET, { lane: 9, next: laneStart(9) + 50 })).toEqual({ lane: 4, next: laneStart(4) + 10 });
    expect(await keepLane(deps, KEYSET, { lane: 4, next: laneStart(4) + 11 })).toEqual({ lane: 4, next: laneStart(4) + 11 });
    // Nothing in the clear: the stored value reads as nothing.
    const raw = await deps.store.get(`bitlogin:ecash-lane:v1:${deps.signer.getPublicKey()}:${KEYSET}`);
    expect(raw).not.toMatch(/lane|next|\d{6}/u);
  });

  it("are another account's own, and refuse what isn't a keyset or a lane", async () => {
    const deps = setup();
    await keepLane(deps, KEYSET, { lane: 2, next: laneStart(2) });
    expect(await readLane({ ...setup(), store: deps.store }, KEYSET)).toBeNull();
    await expect(keepLane(deps, "not a keyset", { lane: 2, next: laneStart(2) })).rejects.toThrow();
    await expect(keepLane(deps, KEYSET, { lane: 99, next: 1 })).rejects.toThrow();
  });

  it("and the seed's outputs, can't be asked by a handed-over session, and so by no site", () => {
    for (const action of ["ecashLaneGet", "ecashDraw", "ecashReserve", "ecashForward", "ecashBlinded", "ecashUnblind", "ecashTrialOutput"]) expect(SIGNER_ONLY_ACTIONS.has(action as never), action).toBe(false);
  });
});
