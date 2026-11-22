import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { applyChange, isListAsked, type GuestChange, keepersOf, ownerListTemplate, readOwnerList, resolveOwnerList, scopeOf } from "./guests.js";

// BitGate's vectors for the list's shape, as NSWP copied them unchanged (vectors/governance-lists.json at NSWP 655ed5f,
// from BitGate 8b98ed9), copied here unchanged on 2026-11-22. The kit's reader is run against the same file.
const vectors = JSON.parse(readFileSync(new URL("./governance-lists.vectors.json", import.meta.url), "utf8"));

describe("a world owner's lists, by BitGate's vectors", () => {
  for (const c of vectors.decode) {
    it(`reads one: ${c.name}`, () => {
      const got = readOwnerList(c.event, { now: vectors.now, ...(c.reader?.root ? { root: c.reader.root } : {}) });
      // A case with many names gives their count (`entryCount`) in place of the names themselves.
      if (c.expect.entryCount !== undefined && got.ok) {
        const { entries, ...rest } = got;
        expect({ ...rest, entryCount: entries.length }).toEqual(c.expect);
      } else expect(got).toEqual(c.expect);
    });
  }
  for (const c of vectors.resolve) {
    it(`finds the one that stands: ${c.name}`, () => {
      expect(resolveOwnerList(c.events, { ...c.query, now: vectors.now })).toEqual(c.expect);
    });
  }
});

describe("the one change, and what BitLogin writes", () => {
  const keeper = new NostrSigner(generatePrivateKey());
  const world = `37300:${"5a".repeat(32)}:home: a place, with colons`;
  const ana = "01".repeat(32);
  const bo = "02".repeat(32);
  const now = 1_800_000_000;
  const signed = (scope: "user-allow" | "user-deny", people: string[], at = now) => keeper.signEvent(ownerListTemplate({ scope, subject: world, people, createdAt: at })!);

  it("writes a list the readers take, with the keeper as root", () => {
    const list = signed("user-allow", [bo, ana, ana]);
    expect(readOwnerList(list, { root: [keeper.getPublicKey()], now })).toEqual({ ok: true, scope: "user-allow", subject: world, signer: keeper.getPublicKey(), entries: [ana, bo], skipped: 0 });
    // Not by the world's own key's default root: a keeper who isn't the publisher names themselves as root.
    expect(readOwnerList(list, { now })).toEqual({ ok: false, reason: "wrong_signer" });
    expect(ownerListTemplate({ scope: "user-allow", subject: world, people: Array.from({ length: 501 }, (_, i) => i.toString(16).padStart(64, "0")), createdAt: now })).toBeNull();
    expect(ownerListTemplate({ scope: "user-deny", subject: "not a subject", people: [], createdAt: now })).toBeNull();
  });

  it("makes one change, and nothing where it changes nothing", () => {
    expect(applyChange([], "allow", ana)).toEqual([ana]);
    expect(applyChange([ana], "allow", ana)).toBeNull();
    expect(applyChange([ana, bo], "unallow", ana)).toEqual([bo]);
    expect(applyChange([bo], "unblock", ana)).toBeNull();
    expect(scopeOf("block")).toBe("user-deny");
    expect(scopeOf("unallow")).toBe("user-allow");
  });

  it("passes a signed list to the world only if it is exactly the list handed over with the one change", () => {
    const pubkey = keeper.getPublicKey();
    const before = signed("user-allow", [bo], now - 100);
    const right = signed("user-allow", [ana, bo]);
    expect(isListAsked(right, { pubkey, world, change: "allow", key: ana, list: before, now })).toBe(true);
    // Another person added, one taken off, the wrong list, the wrong world, another signer: refused.
    expect(isListAsked(signed("user-allow", [ana, bo, "03".repeat(32)]), { pubkey, world, change: "allow", key: ana, list: before, now })).toBe(false);
    expect(isListAsked(signed("user-allow", [ana]), { pubkey, world, change: "allow", key: ana, list: before, now })).toBe(false);
    expect(isListAsked(signed("user-deny", [ana, bo]), { pubkey, world, change: "allow", key: ana, list: before, now })).toBe(false);
    expect(isListAsked(right, { pubkey, world: `37300:${"5a".repeat(32)}:other`, change: "allow", key: ana, list: before, now })).toBe(false);
    expect(isListAsked(right, { pubkey: "ff".repeat(32), world, change: "allow", key: ana, list: before, now })).toBe(false);
    // From no list: the change alone.
    expect(isListAsked(signed("user-deny", [ana]), { pubkey, world, change: "block", key: ana, list: null, now })).toBe(true);
    // Signed long ago is not this answer.
    expect(isListAsked(signed("user-allow", [ana, bo], now - 3600), { pubkey, world, change: "allow", key: ana, list: before, now })).toBe(false);
  });
});

describe("who keeps a world's lists, by its own manifest", () => {
  const pub = "5a".repeat(32);
  const keeper = "7b".repeat(32);
  const manifest = (extra: Record<string, unknown> = {}) => ({ publishers: { [pub]: { worlds: ["home"] } }, worlds: { home: { entry: { url: "https://home.example/" }, ...extra } } });

  it("is the publishers that list it, unless its entry names keepers", () => {
    expect(keepersOf(manifest(), "https://home.example", `37300:${pub}:home`)).toEqual({ coordinate: `37300:${pub}:home`, keepers: [pub], d: "home" });
    expect(keepersOf(manifest({ keepers: [keeper, "nonsense", keeper] }), "https://home.example", `37300:${pub}:home`)?.keepers).toEqual([keeper]);
    expect(keepersOf(manifest({ keepers: ["nonsense"] }), "https://home.example", `37300:${pub}:home`)?.keepers).toEqual([pub]);
    expect(keepersOf(manifest({ keepers: ["1", "2", "3", "4", "5"].map((n) => n.repeat(64)) }), "https://home.example", `37300:${pub}:home`)?.keepers).toHaveLength(4);
  });

  it("answers only for a world that is the site asking", () => {
    expect(keepersOf(manifest(), "https://evil.example", `37300:${pub}:home`)).toBeNull();
    expect(keepersOf(manifest(), "https://home.example", `37300:${"ab".repeat(32)}:home`)).toBeNull();
    expect(keepersOf(manifest(), "https://home.example", `37300:${pub}:other`)).toBeNull();
    expect(keepersOf(manifest(), "https://home.example", `37300:${pub}:toString`)).toBeNull();
    expect(keepersOf(null, "https://home.example", `37300:${pub}:home`)).toBeNull();
  });
});

// NSWP's vectors for writing a list from one change (vectors/owner-list-writing.json at NSWP 89494eb), copied
// unchanged on 2026-11-22. BitLogin's worker builds with `ownerListTemplate` from `applyChange`'s people.
const writing = JSON.parse(readFileSync(new URL("./owner-list-writing.vectors.json", import.meta.url), "utf8"));

describe("writing a list from one change, by NSWP's vectors", () => {
  for (const v of writing.vectors) {
    it(`writes: ${v.name}`, () => {
      const change: GuestChange = v.change.op === "add" ? (v.scope === "user-allow" ? "allow" : "block") : v.scope === "user-allow" ? "unallow" : "unblock";
      const people = applyChange([...(v.before?.people ?? [])].sort(), change, v.change.person);
      const made = people ? ownerListTemplate({ scope: v.scope, subject: v.subject, people, createdAt: v.now, ...(v.before ? { notBefore: v.before.createdAt } : {}) }) : null;
      if (v.expect.refused || v.expect.event === null || v.expect.ok === false) return void expect(made).toBeNull();
      expect(made).toEqual(v.expect.event);
      // What the readers make of it, signed (the vectors give the parts of it that matter).
      if (v.expect.signed && v.expect.readBack) expect(readOwnerList(v.expect.signed, { now: v.now + 1 })).toMatchObject({ ok: true, ...v.expect.readBack });
    });
  }
});
