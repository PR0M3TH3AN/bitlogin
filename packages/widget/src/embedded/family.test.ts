import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { addAllowed, declineFamily, describeAllowed, familyDeclined, familyOffer, readAllowed, type AllowedSite } from "./allowed.js";
import { familyDomain, inFamily, KNOWN_FAMILIES, knownFamily, readFamily } from "./family.js";
import { familyOf, publicSuffixOf, registrableDomain } from "./publicSuffix.js";
import { PUBLIC_SUFFIX_ICANN, PUBLIC_SUFFIX_PRIVATE } from "./publicSuffixList.js";
import { isTakenBack, readTakenBack, takeBack, writeTakenBack, NOTHING_TAKEN_BACK } from "./takeBack.js";
import { openAppHandoff, sealHandoff } from "../worker/handoff.js";
import { deleteSignerGrant, GRANT_LIMITS, grantKey, grantSite, keepSecFor, loadSignerGrant, saveSignerGrant } from "../worker/signerGrant.js";

const FAMILY = "https://*.bitblocks.network";
const PORTAL = "https://portal.bitblocks.network";
const TESSERA = "https://tessera.bitblocks.network";

describe("which family a site is in, by the Public Suffix List (docs/site-family.md SF3)", () => {
  it("ships the whole list, in ASCII", () => {
    expect(PUBLIC_SUFFIX_ICANN.split("\n").length).toBeGreaterThan(5000);
    expect(PUBLIC_SUFFIX_PRIVATE.split("\n").length).toBeGreaterThan(1000);
    expect(`${PUBLIC_SUFFIX_ICANN}\n${PUBLIC_SUFFIX_PRIVATE}`).toMatch(/^[a-z0-9.*!\n-]+$/u);
  });

  it("finds the registrable domain as the list's own test cases have it", () => {
    // From publicsuffix.org's test file: ordinary rules, wildcards, exceptions, and a name no rule covers.
    const cases: [string, string][] = [
      ["com", ""],
      ["example.com", "example.com"],
      ["b.example.com", "example.com"],
      ["a.b.example.com", "example.com"],
      ["uk.com", ""],
      ["example.uk.com", "example.uk.com"],
      ["a.b.example.uk.com", "example.uk.com"],
      ["test.ac", "test.ac"],
      ["mm", ""],
      ["c.mm", ""],
      ["b.c.mm", "b.c.mm"],
      ["a.b.c.mm", "b.c.mm"],
      ["jp", ""],
      ["test.jp", "test.jp"],
      ["ac.jp", ""],
      ["test.ac.jp", "test.ac.jp"],
      ["kyoto.jp", ""],
      ["ide.kyoto.jp", ""],
      ["b.ide.kyoto.jp", "b.ide.kyoto.jp"],
      ["c.kobe.jp", ""],
      ["b.c.kobe.jp", "b.c.kobe.jp"],
      ["city.kobe.jp", "city.kobe.jp"],
      ["www.city.kobe.jp", "city.kobe.jp"],
      ["ck", ""],
      ["test.ck", ""],
      ["b.test.ck", "b.test.ck"],
      ["www.ck", "www.ck"],
      ["www.www.ck", "www.ck"],
      ["us", ""],
      ["test.us", "test.us"],
      ["ak.us", ""],
      ["test.ak.us", "test.ak.us"],
      ["k12.ak.us", ""],
      ["test.k12.ak.us", "test.k12.ak.us"],
      ["xn--fiqs8s", ""],
      ["xn--85x722f.xn--fiqs8s", "xn--85x722f.xn--fiqs8s"],
      ["www.xn--85x722f.xn--55qx5d.cn", "xn--85x722f.xn--55qx5d.cn"],
      ["example.nosuchtld", "example.nosuchtld"],
      ["b.example.nosuchtld", "example.nosuchtld"]
    ];
    for (const [name, want] of cases) expect(registrableDomain(name), name).toBe(want);
    expect(registrableDomain("WWW.Example.COM")).toBe("example.com");
  });

  it("offers a family for a site on a domain of its own", () => {
    expect(familyOf(PORTAL)).toBe(FAMILY);
    expect(familyOf(TESSERA)).toBe(FAMILY);
    expect(familyOf("https://bitblocks.network")).toBe(FAMILY);
    expect(familyOf("https://a.b.c.bitblocks.network")).toBe(FAMILY);
    expect(familyOf("https://shop.example.co.uk")).toBe("https://*.example.co.uk");
  });

  it("offers none where each name under the suffix is someone else's", () => {
    // The list's private section: a service that hands names out.
    for (const site of ["https://alice.github.io", "https://x.vercel.app", "https://y.pages.dev", "https://shop.myshopify.com", "https://a.b.vercel.app", "https://bucket.s3.amazonaws.com"]) {
      expect(publicSuffixOf(new URL(site).hostname).isPrivate, site).toBe(true);
      expect(familyOf(site), site).toBe("");
    }
    // A public suffix itself is nobody's family.
    for (const site of ["https://co.uk", "https://com", "https://github.io"]) expect(familyOf(site), site).toBe("");
  });

  it("offers none for anything that is not an https site at a public name", () => {
    for (const site of [
      "http://portal.bitblocks.network",
      "https://portal.bitblocks.network:8443",
      "https://portal.bitblocks.network/",
      "https://portal.bitblocks.network/x",
      "https://127.0.0.1",
      "https://[::1]",
      "https://localhost",
      "https://printer.local",
      "https://box.internal",
      "https://192.168.68.84",
      "wss://portal.bitblocks.network",
      "portal.bitblocks.network",
      "",
      null,
      7,
      FAMILY
    ]) {
      expect(familyOf(site), String(site)).toBe("");
    }
  });
});

describe("a family, as it is kept and sent", () => {
  it("reads only `https://*.` and a public name in lower case", () => {
    expect(readFamily(FAMILY)).toBe(FAMILY);
    expect(familyDomain(FAMILY)).toBe("bitblocks.network");
    for (const not of [
      "https://*.Bitblocks.network",
      "http://*.bitblocks.network",
      "https://*.bitblocks.network/",
      "https://*.bitblocks.network:444",
      "https://*.*.bitblocks.network",
      "https://*.network",
      "https://*.localhost",
      "https://*.10.0.0.1",
      "https://*.",
      "https://*",
      "*.bitblocks.network",
      PORTAL,
      "",
      null,
      { site: FAMILY }
    ]) {
      expect(readFamily(not), String(not)).toBe("");
    }
  });

  it("holds the domain and every name under it, over https, and nothing that only looks like it", () => {
    for (const site of [PORTAL, TESSERA, "https://bitblocks.network", "https://a.b.bitblocks.network"]) expect(inFamily(site, FAMILY), site).toBe(true);
    for (const site of [
      "https://evilbitblocks.network",
      "https://bitblocks.network.evil.example",
      "https://bitblocks.network.",
      "http://portal.bitblocks.network",
      "https://portal.bitblocks.network:8443",
      "https://portal.bitblocks.network/",
      "https://bitblocks.net",
      FAMILY,
      "",
      null
    ]) {
      expect(inFamily(site, FAMILY), String(site)).toBe(false);
    }
    expect(inFamily(PORTAL, "https://*.Bitblocks.network")).toBe(false);
  });

  it("knows bitblocks.network, and no other, for thirty days", () => {
    expect(KNOWN_FAMILIES).toEqual(["bitblocks.network"]);
    expect(knownFamily(FAMILY)).toBe(true);
    expect(knownFamily("https://*.example.com")).toBe(false);
    expect(keepSecFor(FAMILY)).toBe(GRANT_LIMITS.keepSec);
    expect(keepSecFor("https://*.example.com")).toBe(GRANT_LIMITS.unknownKeepSec);
    // A site is still known by its own address, never by its family's.
    expect(keepSecFor("https://newworld.bitblocks.network")).toBe(GRANT_LIMITS.unknownKeepSec);
  });
});

class TestStore implements KeyValueStore {
  values = new Map<string, string>();
  keys = new Map<string, CryptoKey>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async getOrCreateDeviceKey(key: string): Promise<CryptoKey> {
    let value = this.keys.get(key);
    if (!value) {
      value = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      this.keys.set(key, value);
    }
    return value;
  }
}

describe("a grant kept for a family", () => {
  const NOW = 1_794_000_000;
  const key = new Uint8Array(32).fill(7);

  it("is kept under the family, and found by the family's name only", async () => {
    const store = new TestStore();
    expect(await saveSignerGrant(store, { site: FAMILY, everydayPrivateKey: key, until: NOW + 99 * 24 * 3600, signed: [1], signedPass: [2] }, NOW)).toBe(true);
    expect([...store.values.keys()]).toEqual([`bitlogin:signer-grant:v1:${FAMILY}`]);
    const back = await loadSignerGrant(store, FAMILY, NOW + 60);
    // Never longer than thirty days, whatever was asked.
    expect(back).toMatchObject({ site: FAMILY, until: NOW + GRANT_LIMITS.keepSec, signed: [1], signedPass: [2] });
    // A site of the family has no grant of its own because its family has one: the worker asks for the family by name.
    expect(await loadSignerGrant(store, PORTAL, NOW)).toBeNull();
    expect(await loadSignerGrant(store, "https://*.example.com", NOW)).toBeNull();
    await deleteSignerGrant(store, FAMILY);
    expect(await loadSignerGrant(store, FAMILY, NOW)).toBeNull();
  });

  it("is seven days for a family BitLogin does not know", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, { site: "https://*.example.com", everydayPrivateKey: key, until: NOW + 99 * 24 * 3600, signed: [] }, NOW);
    expect((await loadSignerGrant(store, "https://*.example.com", NOW))!.until).toBe(NOW + GRANT_LIMITS.unknownKeepSec);
  });

  it("never holds an application's permissions", async () => {
    const store = new TestStore();
    const permissions = { name: "App", sign: [1] } as never;
    expect(await saveSignerGrant(store, { site: FAMILY, everydayPrivateKey: key, until: NOW + 3600, signed: [], permissions }, NOW)).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it("is not a site: a hand-off and an application's set name an exact origin", () => {
    expect(grantSite(FAMILY)).toBe("");
    expect(grantKey(FAMILY)).toBe(FAMILY);
    expect(grantKey(PORTAL)).toBe(PORTAL);
    expect(grantKey("https://*.Bitblocks.network")).toBe("");
  });
});

describe("a hand-off for a family", () => {
  const everyday = generatePrivateKey();
  const recipient = generatePrivateKey();
  const seal = (also: Parameters<typeof sealHandoff>[4], app?: Parameters<typeof sealHandoff>[3]) => sealHandoff(everyday, getPublicKeyHex(recipient), generatePrivateKey(), app, also);

  it("carries the family with the site, when it is remembered", () => {
    const opened = openAppHandoff(seal({ site: PORTAL, remember: true, family: FAMILY }), recipient);
    expect(opened).toMatchObject({ site: PORTAL, remember: true, family: FAMILY, app: null });
    expect(openAppHandoff(seal({ site: PORTAL, remember: true }), recipient).family).toBeNull();
  });

  it("is refused whole where the family is not the site's, is not remembered, or is for an application", () => {
    expect(() => seal({ site: "https://portal.example.com", remember: true, family: FAMILY })).toThrow(/family/u);
    expect(() => seal({ site: "http://portal.bitblocks.network", remember: true, family: FAMILY })).toThrow(/family/u);
    expect(() => seal({ site: PORTAL, family: FAMILY })).toThrow(/family/u);
    // The lock is on: nothing is kept for any site, so nothing is kept for a family of them.
    expect(() => seal({ site: PORTAL, remember: true, visitOnly: true, family: FAMILY })).toThrow(/family/u);
    expect(() => seal({ site: PORTAL, remember: true, family: "https://*.Bitblocks.network" })).toThrow(/family/u);
    expect(() => seal({ remember: true, family: FAMILY })).toThrow(/family/u);
    expect(() => seal({ site: PORTAL, remember: true, family: FAMILY }, { site: PORTAL, permissions: { name: "App", sign: [1] } })).toThrow(/family/u);
  });
});

describe("taking a family back (docs/site-family.md SF6)", () => {
  const record = (site: string, before: number) => takeBack(NOTHING_TAKEN_BACK, { site }, before);

  it("a family taken back ends the family's grant and each of its sites' own", () => {
    const r = record(FAMILY, 500);
    expect(r.sites).toEqual([{ site: FAMILY, before: 500 }]);
    expect(isTakenBack(r, FAMILY, 400)).toBe(true);
    expect(isTakenBack(r, PORTAL, 400)).toBe(true);
    expect(isTakenBack(r, "https://bitblocks.network", 400)).toBe(true);
    // Not a grant made after it, and not another domain's.
    expect(isTakenBack(r, FAMILY, 501)).toBe(false);
    expect(isTakenBack(r, PORTAL, 501)).toBe(false);
    expect(isTakenBack(r, "https://portal.example.com", 400)).toBe(false);
    expect(isTakenBack(r, "https://*.example.com", 400)).toBe(false);
    expect(isTakenBack(r, "https://evilbitblocks.network", 400)).toBe(false);
  });

  it("one site of a family taken back ends the family's grant, and not its other sites' own", () => {
    const r = record(PORTAL, 500);
    expect(isTakenBack(r, PORTAL, 400)).toBe(true);
    expect(isTakenBack(r, FAMILY, 400)).toBe(true);
    expect(isTakenBack(r, FAMILY, 501)).toBe(false);
    expect(isTakenBack(r, TESSERA, 400)).toBe(false);
  });

  it("survives being written and read, and a family that does not read as one is dropped", () => {
    const r = readTakenBack(JSON.parse(writeTakenBack(record(FAMILY, 500))));
    expect(r).toEqual({ allBefore: 0, sites: [{ site: FAMILY, before: 500 }] });
    expect(readTakenBack({ v: 1, all_before: 0, sites: [{ site: "https://*.Bitblocks.network", before: 5 }, { site: "https://*.localhost", before: 5 }, { site: "https://*", before: 5 }] })!.sites).toEqual([]);
  });
});

describe("the family question, and the list (SF4, SF6)", () => {
  const pubkey = "a".repeat(64);
  const entry = (site: string, at: number, more: Partial<AllowedSite> = {}): AllowedSite => ({ site, pubkey, at, until: at + 3600, remembered: true, ...more });

  it("is asked only where another site of the family was allowed before, remembered, as the same account", () => {
    const list = [entry(PORTAL, 300), entry("https://bitvid.network", 200)];
    expect(familyOffer(list, TESSERA, FAMILY, pubkey)?.site).toBe(PORTAL);
    // The first site of a family: nothing says there is one.
    expect(familyOffer([entry("https://bitvid.network", 200)], PORTAL, FAMILY, pubkey)).toBeNull();
    // The same site again is not a second site.
    expect(familyOffer(list, PORTAL, FAMILY, pubkey)).toBeNull();
    // Allowed for one visit, or as another account.
    expect(familyOffer([entry(PORTAL, 300, { remembered: false })], TESSERA, FAMILY, pubkey)).toBeNull();
    expect(familyOffer(list, TESSERA, FAMILY, "b".repeat(64))).toBeNull();
    // A site that is not in the family it is asked about.
    expect(familyOffer(list, "https://tessera.example.com", FAMILY, pubkey)).toBeNull();
  });

  it("keeps a family as one entry, with the sites it was allowed from", () => {
    const first = addAllowed([entry(PORTAL, 100)], entry(FAMILY, 200, { members: [TESSERA, PORTAL, "https://elsewhere.example", TESSERA] }));
    expect(first[0]).toMatchObject({ site: FAMILY, members: [TESSERA, PORTAL] });
    // Allowed again from a third site: the earlier ones stay on its row.
    const again = addAllowed(first, entry(FAMILY, 300, { members: ["https://garden.bitblocks.network"] }));
    expect(again.filter((e) => e.site === FAMILY)).toHaveLength(1);
    expect(again[0]!.members).toEqual(["https://garden.bitblocks.network", TESSERA, PORTAL]);
    expect(readAllowed(JSON.stringify(again), 300)[0]).toMatchObject({ site: FAMILY, members: ["https://garden.bitblocks.network", TESSERA, PORTAL] });
    expect(describeAllowed(again[0]!, 300)).toMatchObject({ family: "bitblocks.network", known: "every site at bitblocks.network" });
    expect(describeAllowed(entry("https://*.example.com", 300), 300)).toMatchObject({ family: "example.com", known: null });
    expect(describeAllowed(entry(PORTAL, 300), 300).family).toBeNull();
    // A family is never an application's.
    expect(readAllowed(JSON.stringify([entry(FAMILY, 300, { wants: { name: "App", sign: [1] } as never })]), 300)).toEqual([]);
    expect(readAllowed(JSON.stringify([entry("https://*.Bitblocks.network", 300)]), 300)).toEqual([]);
  });

  it("is not asked again for thirty days after \"Just this one\"", () => {
    const kept = new Map<string, string>();
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
    expect(familyDeclined(FAMILY, 1000, storage)).toBe(false);
    expect(declineFamily(FAMILY, 1000, storage)).toBe(true);
    expect(familyDeclined(FAMILY, 1000 + 29 * 24 * 3600, storage)).toBe(true);
    expect(familyDeclined(FAMILY, 1000 + 30 * 24 * 3600, storage)).toBe(false);
    expect(familyDeclined("https://*.example.com", 1001, storage)).toBe(false);
    expect(declineFamily("https://*.Bitblocks.network", 1000, storage)).toBe(false);
    kept.set("bitlogin:family-declined:v1", "not json");
    expect(familyDeclined(FAMILY, 1001, storage)).toBe(false);
  });
});
