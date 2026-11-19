import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { signNostrEvent } from "@bitlogin/core/nostr";
import {
  checkDue,
  cleanRelays,
  isTakenBack,
  mergeTakenBack,
  newestTakeBackEvent,
  NOTHING_TAKEN_BACK,
  readTakenBack,
  TAKE_BACK_D,
  TAKE_BACK_KIND,
  TAKE_BACK_LIMITS,
  takeBack,
  writeRelaysFrom,
  writeTakenBack
} from "./takeBack.js";
import { NEVER_KINDS, signClass } from "./policy.js";
import { prepareForApp, readPermissions } from "./permissions.js";
import { openAppHandoff, sealHandoff, SIGNER_ONLY_ACTIONS } from "../worker/handoff.js";

const key = generatePrivateKey();
const me = getPublicKeyHex(key);
const NOW = 1_800_000_000;
const DAY = 24 * 3600;
const A = "https://a.example";
const B = "https://b.example";

describe("the take-back record (docs/take-back.md)", () => {
  it("ends a grant made at or before the moment its site was taken back, and none made after", () => {
    const record = takeBack(NOTHING_TAKEN_BACK, { site: A }, NOW);
    expect(isTakenBack(record, A, NOW - 10)).toBe(true);
    expect(isTakenBack(record, A, NOW)).toBe(true);
    // Allowed again afterwards: the old entry does not touch it.
    expect(isTakenBack(record, A, NOW + 1)).toBe(false);
    // Another site, and a look-alike of this one, are not this one.
    expect(isTakenBack(record, B, NOW - 10)).toBe(false);
    expect(isTakenBack(record, "https://a.example.evil.example", NOW - 10)).toBe(false);
    expect(isTakenBack(NOTHING_TAKEN_BACK, A, 1)).toBe(false);
  });

  it("ends every grant made before 'sign out of every site'", () => {
    const record = takeBack(takeBack(NOTHING_TAKEN_BACK, { site: A }, NOW - 50), { all: true }, NOW);
    expect(record).toEqual({ allBefore: NOW, sites: [] });
    for (const site of [A, B, "https://never-listed.example"]) {
      expect(isTakenBack(record, site, NOW - 1)).toBe(true);
      expect(isTakenBack(record, site, NOW + 1)).toBe(false);
    }
  });

  it("never gives a site back when two records are joined", () => {
    const older = { allBefore: NOW - 500, sites: [{ site: A, before: NOW - 100 }, { site: B, before: NOW - 300 }] };
    const newer = { allBefore: NOW - 400, sites: [{ site: A, before: NOW - 200 }] };
    for (const merged of [mergeTakenBack(older, newer, NOW), mergeTakenBack(newer, older, NOW)]) {
      expect(merged.allBefore).toBe(NOW - 400);
      expect(merged.sites).toEqual([{ site: A, before: NOW - 100 }, { site: B, before: NOW - 300 }]);
    }
    // A writer who could not see the newest record still cannot undo it: what it publishes is the join.
    const stale = takeBack(mergeTakenBack(NOTHING_TAKEN_BACK, older, NOW), { site: "https://c.example" }, NOW);
    expect(isTakenBack(stale, A, NOW - 150)).toBe(true);
    expect(isTakenBack(stale, B, NOW - 350)).toBe(true);
  });

  it("drops only what can end nothing: covered by 'everything', or older than any grant that is left", () => {
    const old = NOW - TAKE_BACK_LIMITS.entrySec - 1;
    const merged = mergeTakenBack({ allBefore: NOW - 100, sites: [{ site: A, before: NOW - 200 }, { site: B, before: old }, { site: "https://c.example", before: NOW - 50 }] }, NOTHING_TAKEN_BACK, NOW);
    expect(merged.sites).toEqual([{ site: "https://c.example", before: NOW - 50 }]);
    const many = { allBefore: 0, sites: Array.from({ length: 300 }, (_, i) => ({ site: `https://s${i}.example`, before: NOW - i })) };
    const kept = mergeTakenBack(many, NOTHING_TAKEN_BACK, NOW);
    expect(kept.sites).toHaveLength(TAKE_BACK_LIMITS.sites);
    // The newest are the ones kept.
    expect(kept.sites[0]).toEqual({ site: "https://s0.example", before: NOW });
  });

  it("reads back only what is a record, entry by entry", () => {
    const record = takeBack(takeBack(NOTHING_TAKEN_BACK, { site: A }, NOW - 5), { site: B }, NOW);
    expect(readTakenBack(JSON.parse(writeTakenBack(record)))).toEqual(record);
    expect(
      readTakenBack({
        v: 1,
        all_before: "soon",
        sites: [{ site: A, before: 10 }, { site: A, before: 30 }, { site: `${A}/path`, before: 99 }, { site: "javascript:alert(1)", before: 99 }, { site: B, before: -1 }, { site: B }, null, "junk"]
      })
    ).toEqual({ allBefore: 0, sites: [{ site: A, before: 30 }] });
    for (const bad of [null, "x", [], { v: 2, sites: [] }, { v: 1 }, { v: 1, sites: "none" }]) expect(readTakenBack(bad), JSON.stringify(bad)).toBeNull();
    expect(takeBack(NOTHING_TAKEN_BACK, { site: "not a site" }, NOW)).toEqual(NOTHING_TAKEN_BACK);
  });

  it("believes only the newest record their own key signed, and none dated far ahead", () => {
    const record = (created_at: number, by = key, d = TAKE_BACK_D, kind = TAKE_BACK_KIND) =>
      signNostrEvent({ kind, pubkey: getPublicKeyHex(by), created_at, tags: [["d", d]], content: "sealed" }, by);
    const stranger = generatePrivateKey();
    const events = [
      record(NOW - 300),
      record(NOW - 100),
      record(NOW - 50, stranger),
      { ...record(NOW - 10), created_at: NOW - 9 },
      record(NOW - 20, key, "bitlogin:something-else"),
      record(NOW - 20, key, TAKE_BACK_D, 30079),
      record(NOW + TAKE_BACK_LIMITS.skewSec + 60),
      "junk"
    ];
    expect(newestTakeBackEvent(events, me, NOW)?.created_at).toBe(NOW - 100);
    expect(newestTakeBackEvent([], me, NOW)).toBeNull();
    // A clock a few minutes ahead is still believed.
    expect(newestTakeBackEvent([record(NOW + 60)], me, NOW)?.created_at).toBe(NOW + 60);
  });

  it("is a kind no site can ever have signed, and a name no application can write under", () => {
    expect(NEVER_KINDS).toContain(TAKE_BACK_KIND);
    expect(signClass(TAKE_BACK_KIND)).toBe("never");
    // Even an application approved to save data under any name: BitLogin's own names are not among them. A
    // newer, emptier record signed for an application would otherwise give back what was taken back.
    const anything = readPermissions({ name: "App", sign: [TAKE_BACK_KIND], appData: ["*"] })!;
    expect(anything).not.toBeNull();
    expect(prepareForApp(anything, { kind: TAKE_BACK_KIND, content: "x", tags: [["d", "app:notes"]] }, A, NOW)).not.toBeNull();
    expect(prepareForApp(anything, { kind: TAKE_BACK_KIND, content: "x", tags: [["d", TAKE_BACK_D]] }, A, NOW)).toBeNull();
  });
});

describe("where a signer looks (NIP-65)", () => {
  const list = (tags: string[][], created_at = NOW, by = key) => signNostrEvent({ kind: 10002, pubkey: getPublicKeyHex(by), created_at, tags, content: "" }, by);

  it("takes their write relays from the newest list their own key signed", () => {
    const events = [
      list([["r", "wss://old.example"]], NOW - 100),
      list([["r", "wss://both.example"], ["r", "wss://write.example/", "write"], ["r", "wss://read.example", "read"], ["p", "wss://not-a-relay-tag.example"]], NOW),
      list([["r", "wss://forged.example"]], NOW + 50, generatePrivateKey()),
      { ...list([["r", "wss://tampered.example"]], NOW + 60), created_at: NOW + 61 }
    ];
    expect(writeRelaysFrom(events, me)).toEqual(["wss://both.example", "wss://write.example"]);
    expect(writeRelaysFrom([], me)).toEqual([]);
  });

  it("carries only addresses a signer may be handed, and no more than four", () => {
    expect(
      cleanRelays([
        "wss://one.example",
        "wss://one.example/",
        // Not over TLS: refused. (Written in two parts so that a scanner does not take it for a connection.)
        `${"ws"}://plain.example`,
        "https://not-a-relay.example",
        "wss://user:pw@creds.example",
        "wss://query.example/?x=1",
        "wss://frag.example/#x",
        `wss://${"a".repeat(250)}.example`,
        7,
        "wss://two.example/path",
        "wss://three.example",
        "wss://four.example",
        "wss://five.example"
      ])
    ).toEqual(["wss://one.example", "wss://two.example/path", "wss://three.example", "wss://four.example"]);
    expect(cleanRelays("wss://one.example")).toEqual([]);
    // A stranger's list of five hundred relays is four relays.
    expect(writeRelaysFrom([list(Array.from({ length: 500 }, (_, i) => ["r", `wss://r${i}.example`]))], me)).toHaveLength(TAKE_BACK_LIMITS.relays);
  });
});

describe("when a kept grant is checked", () => {
  it("is asked about on its first page load, then once a day, and locked after three days of silence", () => {
    // Never checked: due at once, and overdue only when the grant itself is three days old.
    expect(checkDue(NOW, NOW - 5, 0)).toBe("due");
    expect(checkDue(NOW, NOW - 3 * DAY + 1, 0)).toBe("due");
    expect(checkDue(NOW, NOW - 3 * DAY, 0)).toBe("overdue");
    // Checked: nothing more for a day, then due, then overdue at three days.
    expect(checkDue(NOW, NOW - 20 * DAY, NOW - 60)).toBe("fresh");
    expect(checkDue(NOW, NOW - 20 * DAY, NOW - DAY + 1)).toBe("fresh");
    expect(checkDue(NOW, NOW - 20 * DAY, NOW - DAY)).toBe("due");
    expect(checkDue(NOW, NOW - 20 * DAY, NOW - 3 * DAY)).toBe("overdue");
    expect({ every: TAKE_BACK_LIMITS.checkEverySec, stale: TAKE_BACK_LIMITS.staleSec }).toEqual({ every: DAY, stale: 3 * DAY });
  });

  it("travels with the key: when it was allowed, and where they write, inside the seal", () => {
    const everyday = generatePrivateKey();
    const recipient = generatePrivateKey();
    const to = getPublicKeyHex(recipient);
    const opened = openAppHandoff(sealHandoff(everyday, to, generatePrivateKey(), undefined, { site: A, remember: true, at: NOW + 0.7, relays: ["wss://mine.example", "http://nope.example"] }), recipient);
    expect(opened.at).toBe(NOW);
    expect(opened.relays).toEqual(["wss://mine.example"]);
    const bare = openAppHandoff(sealHandoff(everyday, to, generatePrivateKey()), recipient);
    expect(bare.at).toBeNull();
    expect(bare.relays).toEqual([]);
  });

  it("is something a handed-over key may ask, and publishing a take-back is not", () => {
    expect(SIGNER_ONLY_ACTIONS.has("signerCheck")).toBe(true);
    expect(SIGNER_ONLY_ACTIONS.has("takeBack")).toBe(false);
  });
});
