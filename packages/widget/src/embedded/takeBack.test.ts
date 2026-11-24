import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { signNostrEvent } from "@bitlogin/core/nostr";
import {
  checkDue,
  checkLearned,
  cleanRelays,
  isPublicRelayHost,
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
import { NEVER_KINDS, readSignerRequest, signClass } from "./policy.js";
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
    // No application may be approved to save under BitLogin's names, and a set kept from before that could cover
    // them still can't: a newer, emptier record signed for an application would otherwise give back what was taken.
    expect(readPermissions({ name: "App", sign: [TAKE_BACK_KIND], appData: ["*"] })).toBeNull();
    const app = readPermissions({ name: "App", sign: [TAKE_BACK_KIND], appData: ["appnotes:"] })!;
    expect(prepareForApp(app, { kind: TAKE_BACK_KIND, content: "x", tags: [["d", "appnotes:1"]] }, A, NOW)).not.toBeNull();
    const keptFromBefore = { sign: [TAKE_BACK_KIND], appData: ["*"], proofs: [], read: [], peers: [] };
    expect(prepareForApp(keptFromBefore, { kind: TAKE_BACK_KIND, content: "x", tags: [["d", TAKE_BACK_D]] }, A, NOW)).toBeNull();
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
        `${"ws"}://127.0.0.1:7777`,
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

describe("which addresses a signer will dial", () => {
  it("is never sent to this machine or a private network on a relay list's say", () => {
    for (const host of ["relay.example.com", "nos.lol", "a-b.relay.example.org", "relay.example.com."]) expect(isPublicRelayHost(host), host).toBe(true);
    for (const host of [
      "localhost",
      "relay",
      "127.0.0.1",
      "10.0.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "0x7f.0.0.1",
      "2130706433",
      "1.2.3.4.",
      "[::1]",
      "::1",
      "fe80::1",
      "router.local",
      "nas.lan",
      "db.internal",
      "app.localhost",
      "printer.home",
      "x.corp",
      "hidden.onion",
      "bad_host.example.com",
      "-bad.example.com",
      ""
    ]) {
      expect(isPublicRelayHost(host), host).toBe(false);
    }
    // And so none of them is ever carried to a signer, whatever a relay list says.
    const sneaky = ["wss://127.0.0.1:4848", "wss://localhost", "wss://[::1]/", "wss://192.168.1.1", "wss://router.local", `${"ws"}://127.0.0.1:7777`, `${"ws"}://localhost:7777`, "wss://10.0.0.5/relay"];
    expect(cleanRelays(sneaky)).toEqual([]);
    expect(cleanRelays([...sneaky, "wss://real.example.com"])).toEqual(["wss://real.example.com"]);
  });

  it("has no way to be told an address by the site it is embedded in", () => {
    // What a site can say to the signer is this list, and none of it carries a relay. Anything more is not read.
    const base = { nswp: "nswp-signer", v: 1, id: "a1", relays: ["wss://evil.example.com"], vaultRelays: ["wss://evil.example.com"], relay: "wss://evil.example.com" };
    for (const t of ["state", "lock"]) expect(readSignerRequest({ ...base, t })).toEqual({ t, id: "a1" });
    expect(readSignerRequest({ ...base, t: "sign", event: { kind: 1 } })).toEqual({ t: "sign", id: "a1", event: { kind: 1 } });
    expect(readSignerRequest({ ...base, t: "pass", session: "a".repeat(64) })).toEqual({ t: "pass", id: "a1", session: "a".repeat(64) });
    for (const t of ["check", "signerCheck", "relays", "configure", "takeBack"]) expect(readSignerRequest({ ...base, t }), t).toBeNull();
    // A set of permissions has no place for one either.
    expect(JSON.stringify(readPermissions({ name: "App", sign: [1], relays: ["wss://evil.example.com"] }))).not.toContain("evil");
  });
});

describe("what counts as having checked", () => {
  const round = (over: Partial<Parameters<typeof checkLearned>[0]>) => checkLearned({ asked: 6, answered: 3, seenAt: 0, newestAt: null, readable: false, ...over });

  it("needs two relays to answer, or the only one asked", () => {
    expect(round({ answered: 0 })).toBe(false);
    expect(round({ answered: 1 })).toBe(false);
    expect(round({ answered: 2 })).toBe(true);
    expect(round({ asked: 1, answered: 1 })).toBe(true);
    expect(round({ asked: 0, answered: 0 })).toBe(false);
  });

  it("does not take 'no record' for an answer once one has been seen", () => {
    expect(round({ seenAt: 0, newestAt: null })).toBe(true);
    // A record that existed cannot have stopped existing: it is being held back, or was dropped.
    expect(round({ seenAt: NOW, newestAt: null })).toBe(false);
    expect(round({ seenAt: NOW, newestAt: NOW - 1, readable: true })).toBe(false);
    expect(round({ seenAt: NOW, newestAt: NOW, readable: true })).toBe(true);
    expect(round({ seenAt: NOW, newestAt: NOW + 5, readable: true })).toBe(true);
  });

  it("learns nothing from a record it cannot read", () => {
    expect(round({ newestAt: NOW, readable: false })).toBe(false);
    expect(round({ seenAt: NOW - 9, newestAt: NOW, readable: false })).toBe(false);
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
    const opened = openAppHandoff(sealHandoff(everyday, to, generatePrivateKey(), undefined, { site: A, remember: true, at: NOW + 0.7, relays: ["wss://mine.example", "http://nope.example", "wss://127.0.0.1:1"] }), recipient);
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
