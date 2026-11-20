import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { signNostrEvent } from "@bitlogin/core/nostr";
import { believedList, changeFollows, cleanMore, followForWorld, FOLLOW_LIST_LIMITS, readFollowList } from "./follows.js";
import { prepareForSite, readHandoffMessage, readSignerRequest, HANDOFF_PROTOCOL, SIGNER_PROTOCOL } from "./policy.js";
import { prepareForApp, readPermissions, APP_SIGN_LIMITS } from "./permissions.js";
import { openAppHandoff, sealHandoff } from "../worker/handoff.js";

/** NSWP's own vectors (vectors/people.json at 13d5feb), copied whole. Never edited here. */
const vectors = JSON.parse(readFileSync(new URL("./follows.vectors.json", import.meta.url), "utf8")) as {
  testKeys: { key1: { pubkey: string } };
  fromAWorld: { name: string; list: unknown; add?: string; remove?: string; seen?: number; expect: unknown }[];
};
const NOW = 1794430860;
const key = generatePrivateKey();
const me = getPublicKeyHex(key);
const other = getPublicKeyHex(generatePrivateKey());
const third = getPublicKeyHex(generatePrivateKey());
const listOf = (tags: string[][], created_at = NOW - 100, content = "", by = key) => signNostrEvent({ kind: 3, pubkey: getPublicKeyHex(by), created_at, tags, content }, by);

describe("following from inside a world (NSWP-14)", () => {
  it("signs and refuses exactly what NSWP's vectors say", () => {
    expect(vectors.fromAWorld.length).toBeGreaterThanOrEqual(6);
    for (const c of vectors.fromAWorld) {
      const got = followForWorld({ list: c.list, add: c.add, remove: c.remove, pubkey: vectors.testKeys.key1.pubkey, nowSeconds: NOW, ...(c.seen ? { seen: c.seen } : {}) });
      expect(got, c.name).toEqual(c.expect);
    }
  });

  it("changes one line and keeps the rest as it was, in its order", () => {
    const list = listOf([["p", other, "wss://relay.example", "Other"], ["t", "worlds"], ["nswp:world", "https://old.example"], ["bitlogin:site", "https://old.example"]], NOW - 100, '{"wss://relay.example":{"read":true}}');
    const added = followForWorld({ list, add: third, pubkey: me, nowSeconds: NOW })!;
    expect(added.tags).toEqual([["p", other, "wss://relay.example", "Other"], ["t", "worlds"], ["p", third]]);
    expect(added.content).toBe(list.content);
    const removed = followForWorld({ list, remove: other, pubkey: me, nowSeconds: NOW })!;
    expect(removed.tags).toEqual([["t", "worlds"]]);
    // No mark of any site is carried on, or put on.
    expect(JSON.stringify([added.tags, removed.tags])).not.toContain("old.example");
  });

  it("is never older than the list it replaces", () => {
    const list = listOf([["p", other]], NOW + 500);
    expect(followForWorld({ list, add: third, pubkey: me, nowSeconds: NOW })!.created_at).toBe(NOW + 501);
  });

  it("refuses anything that is not one real change to their own list", () => {
    const list = listOf([["p", other]]);
    const refused = (o: Record<string, unknown>) => expect(followForWorld({ list, pubkey: me, nowSeconds: NOW, ...o }), JSON.stringify(Object.keys(o))).toBeNull();
    refused({});
    refused({ add: third, remove: other });
    refused({ add: other }); // already followed
    refused({ remove: third }); // not followed
    refused({ add: me }); // themselves
    refused({ add: "not a key" });
    refused({ add: third, list: { ...list, tags: [] } }); // changed after signing
    refused({ add: third, list: listOf([["p", other]], NOW - 100, "", generatePrivateKey()) }); // someone else's
    refused({ add: third, list: signNostrEvent({ kind: 1, pubkey: me, created_at: NOW, tags: [], content: "" }, key) });
    refused({ add: third, seen: NOW }); // older than one seen
    refused({ add: third, list: null, seen: NOW });
    expect(followForWorld({ list: null, add: me, pubkey: me, nowSeconds: NOW })).toBeNull();
    expect(changeFollows(null, { add: third, nowSeconds: NOW })).toBeNull();
  });

  it("reads a list of thousands, and none past its limits", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ["p", i.toString(16).padStart(64, "0")]);
    expect(followForWorld({ list: listOf(many), add: third, pubkey: me, nowSeconds: NOW })!.tags).toHaveLength(5001);
    expect(readFollowList({ kind: 3, pubkey: me, content: "", tags: Array.from({ length: FOLLOW_LIST_LIMITS.tags + 1 }, () => ["p", other]) }, me)).toBeNull();
    expect(readFollowList({ ...listOf([]), content: "x".repeat(FOLLOW_LIST_LIMITS.contentChars + 1) }, me)).toBeNull();
  });

  it("believes a world about a list only as far as the user's own relays allow", () => {
    const list = { created_at: 1000 };
    // No relay answered: a list handed over stands; "they have none" does not.
    expect(believedList(list, { answered: 0, newestAt: 0 })).toBe(true);
    expect(believedList(null, { answered: 0, newestAt: 0 })).toBe(false);
    // A relay answered and had none: a first list may be written.
    expect(believedList(null, { answered: 2, newestAt: 0 })).toBe(true);
    // A relay has a list: "none" is refused, and so is an older one. The same one stands.
    expect(believedList(null, { answered: 2, newestAt: 1000 })).toBe(false);
    expect(believedList(list, { answered: 2, newestAt: 1001 })).toBe(false);
    expect(believedList(list, { answered: 2, newestAt: 1000 })).toBe(true);
  });

  it("reads what a world asks, by name, and nothing else", () => {
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "a1", ...more });
    expect(cleanMore(["follows", "everything", "follows"])).toEqual(["follows"]);
    expect(cleanMore("follows")).toEqual([]);
    expect(say({ t: "want", more: ["follows", "sign-anything"] })).toEqual({ t: "wantMore", id: "a1", more: ["follows"] });
    // A message with a permission set is an application's: it is never also a world asking for more.
    expect(say({ t: "want", more: ["follows"], permissions: { sign: [1] } })!.t).toBe("want");
    expect(say({ t: "follow", list: null, add: other })).toEqual({ t: "follow", id: "a1", list: null, add: other });
    expect(say({ t: "follow", list: { kind: 3 }, remove: other })).toEqual({ t: "follow", id: "a1", list: { kind: 3 }, remove: other });
    expect(say({ t: "follow", list: null })).toBeNull();
    expect(say({ t: "follow", list: null, add: other, remove: third })).toBeNull();
    expect(say({ t: "follow", add: other })).toBeNull();
    expect(say({ t: "follow", list: "x", add: other })).toBeNull();
    const frame = { nswp: HANDOFF_PROTOCOL, v: 1, nonce: "n1", t: "frame", world: "https://arcade.example", recipient: other };
    expect(readHandoffMessage({ ...frame, more: ["follows", "x"] })).toMatchObject({ more: ["follows"] });
    expect(readHandoffMessage(frame)).not.toHaveProperty("more");
  });

  it("is handed over only for one world by its own address: never with a family or an application", () => {
    const sender = generatePrivateKey();
    const recipient = generatePrivateKey();
    const to = getPublicKeyHex(recipient);
    const site = "https://arcade.bitblocks.network";
    const sealed = sealHandoff(key, to, sender, undefined, { site, remember: true, more: ["follows"] });
    expect(openAppHandoff(sealed, recipient).more).toEqual(["follows"]);
    expect(openAppHandoff(sealHandoff(key, to, sender, undefined, { site, remember: true }), recipient).more).toEqual([]);
    expect(() => sealHandoff(key, to, sender, undefined, { site, remember: true, family: "https://*.bitblocks.network", more: ["follows"] })).toThrow();
    expect(() => sealHandoff(key, to, sender, { site, permissions: { sign: [1] } }, { site, more: ["follows"] })).toThrow();
    expect(() => sealHandoff(key, to, sender, undefined, { site, more: ["everything"] })).toThrow();
    expect(() => sealHandoff(key, to, sender, undefined, { more: ["follows"] })).toThrow();
  });

  it("can't be had any other way: a world's `sign` still refuses a follow list", () => {
    expect(prepareForSite({ kind: 3, content: "", tags: [["p", other]] }, "https://arcade.example", NOW)).toBeNull();
  });
});

describe("what the sign-in window has words and room for", () => {
  it("lets an application that may sign follow lists sign a long one", () => {
    const perms = readPermissions({ sign: [1, 3] })!;
    const long = Array.from({ length: 6000 }, (_, i) => ["p", i.toString(16).padStart(64, "0")]);
    expect(prepareForApp(perms, { kind: 3, content: "", tags: long }, "https://app.example", NOW)!.tags).toHaveLength(6001);
    expect(prepareForApp(perms, { kind: 1, content: "", tags: long }, "https://app.example", NOW)).toBeNull();
    expect(prepareForApp(perms, { kind: 3, content: "", tags: Array.from({ length: APP_SIGN_LIMITS.followTags + 1 }, () => ["p", other]) }, "https://app.example", NOW)).toBeNull();
  });
});
