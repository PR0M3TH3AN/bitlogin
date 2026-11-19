import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { addAllowed, ALLOWED_KEY, ALLOWED_LIMITS, describeAllowed, loadAllowed, readAllowed, recordAllowed, removeAllowed, type AllowedSite } from "./allowed.js";
import { SIGN_LIMITS } from "./policy.js";
import { openAppHandoff, sealHandoff } from "../worker/handoff.js";

const pubkey = "a".repeat(64);
const entry = (site: string, at: number, more: Partial<AllowedSite> = {}): AllowedSite => ({ site, pubkey, at, until: at + 3600, remembered: false, ...more });

describe("the sign-in address's record of sites allowed (§SW18)", () => {
  it("reads back only what is an entry, newest first", () => {
    const raw = JSON.stringify([
      entry("https://a.example", 100),
      entry("https://b.example", 300, { remembered: true, wants: { name: "B", sign: [1] } as never }),
      { ...entry("https://c.example/path", 200) },
      { ...entry("javascript:alert(1)", 200) },
      { ...entry("https://d.example", 200), pubkey: "nope" },
      { ...entry("https://e.example", 200), until: 100 },
      { ...entry("https://f.example", 200), wants: { sign: ["x"] } },
      "junk",
      null
    ]);
    const list = readAllowed(raw, 400);
    expect(list.map((e) => e.site)).toEqual(["https://b.example", "https://a.example"]);
    expect(list[0]).toMatchObject({ remembered: true, wants: { name: "B", sign: [1] } });
    expect(readAllowed("not json", 0)).toEqual([]);
    expect(readAllowed(JSON.stringify({ site: "https://a.example" }), 0)).toEqual([]);
    expect(readAllowed(null, 0)).toEqual([]);
  });

  it("drops an entry thirty days after it ended, and keeps no more than its limit", () => {
    const raw = JSON.stringify([entry("https://a.example", 100)]);
    expect(readAllowed(raw, 3700 + ALLOWED_LIMITS.keepEndedSec - 1)).toHaveLength(1);
    expect(readAllowed(raw, 3700 + ALLOWED_LIMITS.keepEndedSec)).toHaveLength(0);
    const many = Array.from({ length: ALLOWED_LIMITS.entries + 50 }, (_, i) => entry(`https://s${i}.example`, i + 1));
    expect(readAllowed(JSON.stringify(many), 10)).toHaveLength(ALLOWED_LIMITS.entries);
  });

  it("replaces a site allowed again as the same account, and keeps another account's apart", () => {
    let list = addAllowed([], entry("https://a.example", 100));
    list = addAllowed(list, entry("https://a.example", 200, { remembered: true }));
    list = addAllowed(list, { ...entry("https://a.example", 300), pubkey: "b".repeat(64) });
    expect(list.map((e) => [e.pubkey[0], e.at, e.remembered])).toEqual([["b", 300, false], ["a", 200, true]]);
    expect(addAllowed(list, { ...entry("ftp://a.example", 1) })).toHaveLength(2);
    expect(removeAllowed(list, "https://a.example", pubkey).map((e) => e.pubkey[0])).toEqual(["b"]);
  });

  it("says what an entry is", () => {
    expect(describeAllowed(entry("https://bitvid.network", 100, { remembered: true }), 200)).toMatchObject({ known: "Bitvid", ended: false });
    expect(describeAllowed(entry("https://a.example", 100), 200).lasts).toContain("one visit");
    expect(describeAllowed(entry("https://a.example", 100), 9999)).toMatchObject({ known: null, ended: true, lasts: "Ended." });
  });

  it("is kept in the storage it is given, and never fails for want of one", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(recordAllowed(entry("https://a.example", 100), storage)).toBe(true);
    expect(recordAllowed(entry("https://b.example", 200), storage)).toBe(true);
    expect(JSON.parse(kept.get(ALLOWED_KEY)!)).toHaveLength(2);
    expect(loadAllowed(300, storage).map((e) => e.site)).toEqual(["https://b.example", "https://a.example"]);
    expect(recordAllowed(entry("https://a.example", 100), null)).toBe(false);
    const broken = { getItem: () => { throw new Error("no storage"); }, setItem: () => { throw new Error("no storage"); } };
    expect(loadAllowed(1, broken)).toEqual([]);
    expect(recordAllowed(entry("https://a.example", 100), broken)).toBe(false);
  });
});

describe("remembering a site (§SW11): decided in the worker that seals the hand-off", () => {
  const everyday = generatePrivateKey();
  const recipient = generatePrivateKey();
  const to = getPublicKeyHex(recipient);
  const open = (also: { site?: unknown; remember?: unknown }) => openAppHandoff(sealHandoff(everyday, to, generatePrivateKey(), undefined, also), recipient).remember;

  it("remembers a site BitLogin knows whatever is ticked, and any other only when ticked", () => {
    expect(open({ site: "https://bitvid.network" })).toBe(true);
    expect(open({ site: "https://bitvid.network", remember: false })).toBe(true);
    expect(open({ site: "https://world.example" })).toBe(false);
    expect(open({ site: "https://world.example", remember: true })).toBe(true);
    // Only a real tick counts, and a hand-off that names no site is never remembered.
    expect(open({ site: "https://world.example", remember: "yes" })).toBe(false);
    expect(open({ remember: true })).toBe(false);
    // A look-alike of a known address is not known.
    expect(open({ site: "https://bitvid.network.evil.example" })).toBe(false);
  });

  it("holds a world to three signatures a minute and twenty an hour, and a visit to twelve hours", () => {
    expect({ burst: SIGN_LIMITS.burst, hourly: SIGN_LIMITS.hourly, visitSec: SIGN_LIMITS.visitSec, grantSec: SIGN_LIMITS.grantSec }).toEqual({ burst: 3, hourly: 20, visitSec: 12 * 3600, grantSec: 30 * 24 * 3600 });
  });
});
