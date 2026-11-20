import { describe, expect, it } from "vitest";
import {
  APP_LIMITS,
  APP_SITE_TAG,
  describePermissions,
  limitClass,
  KNOWN_APPS,
  knownAppName,
  mayDecryptFrom,
  mayEncryptTo,
  mayHold,
  RESERVED_KINDS,
  NEVER_FOR_APPS,
  prepareForApp,
  isLocalAddress,
  readPeerFor,
  reservedKindsFor,
  readPeersFor,
  readPermissions,
  type AppPermissions
} from "./permissions.js";

const SITE = "https://app.example";
const ME = "a".repeat(64);
const SERVICE = "b".repeat(64);
const OTHER = "c".repeat(64);
const NOW = 1_800_000_000;

const set = (extra: Record<string, unknown> = {}): AppPermissions => {
  const perms = readPermissions({ name: "Example", sign: [1, 7, 27235, 30078], appData: ["example:"], proofs: ["https://api.example"], read: [30078], peers: [SERVICE], ...extra });
  if (!perms) throw new Error("fixture is not a permission set");
  return perms;
};

describe("readPermissions", () => {
  it("reads a well-formed set, tidied", () => {
    expect(readPermissions({ name: " Example\u200b ", sign: [7, 1, 1], read: [], peers: [] })).toEqual({ name: "Example", sign: [1, 7], appData: [], proofs: [], read: [], peers: [] });
  });

  it("refuses a set that names anything on the never list, whole", () => {
    for (const kind of NEVER_FOR_APPS) expect(readPermissions({ sign: [1, kind] })).toBeNull();
    // Wallet and remote-signer traffic, and room signals.
    expect(NEVER_FOR_APPS).toEqual(expect.arrayContaining([13194, 23194, 23195, 24133, 27301]));
  });

  it("refuses BitLogin's own names under application data, and any prefix that would cover them", () => {
    for (const prefix of ["bitlogin:", "bitlogin:password:v1", "bitlogin", "bit", "b"]) {
      expect(readPermissions({ sign: [30078], appData: [prefix] })).toBeNull();
    }
    expect(readPermissions({ sign: [30078], appData: ["bitroad:"] })).not.toBeNull();
  });

  it("refuses anything malformed rather than approving part of it", () => {
    const bad: unknown[] = [
      null,
      [],
      "sign",
      { sign: "1" },
      { sign: [1.5] },
      { sign: [-1] },
      { sign: [70000] },
      { sign: [] },
      { sign: [1], appData: ["x:"] }, // prefixes without the kind
      { sign: [30078] }, // the kind without a prefix
      { sign: [30078], appData: [""] },
      { sign: [30078], appData: ["two\nlines"] },
      { sign: [1], proofs: ["https://api.example"] }, // origins without a web proof
      { sign: [27235], proofs: ["http://api.example"] },
      { sign: [27235], proofs: ["https://api.example/path"] },
      { sign: [27235], proofs: ["not a url"] },
      { sign: [1], peers: ["short"] },
      { sign: [1], peers: [ME.toUpperCase()] },
      { sign: Array.from({ length: 65 }, (_, i) => i + 100) },
      { sign: [27235], proofs: Array.from({ length: 9 }, (_, i) => `https://h${i}.example`) }
    ];
    for (const input of bad) expect(readPermissions(input), JSON.stringify(input)).toBeNull();
  });
});

describe("prepareForApp", () => {
  const perms = set();

  it("signs an approved kind, marked with the site that asked", () => {
    const out = prepareForApp(perms, { kind: 1, content: "hello", tags: [["t", "x"], [APP_SITE_TAG, "https://evil.example"], ["nswp:world", "https://evil.example"]] }, SITE, NOW);
    expect(out).toEqual({ kind: 1, created_at: NOW, content: "hello", tags: [["t", "x"], [APP_SITE_TAG, SITE]] });
  });

  it("refuses a kind that was not approved, and a never kind even if a set somehow held one", () => {
    expect(prepareForApp(perms, { kind: 0, content: "{}", tags: [] }, SITE, NOW)).toBeNull();
    const forged = { ...perms, sign: [...perms.sign, 24133, 27302] };
    expect(prepareForApp(forged, { kind: 24133, content: "", tags: [] }, SITE, NOW)).toBeNull();
    expect(prepareForApp(forged, { kind: 27302, content: "", tags: [] }, SITE, NOW)).toBeNull();
  });

  it("holds application data to the approved prefixes, and never to BitLogin's", () => {
    const data = (d: string, p = perms) => prepareForApp(p, { kind: 30078, content: "x", tags: [["d", d]] }, SITE, NOW);
    expect(data("example:settings")).not.toBeNull();
    expect(data("other:settings")).toBeNull();
    expect(prepareForApp(perms, { kind: 30078, content: "x", tags: [] }, SITE, NOW)).toBeNull();
    const any = set({ appData: ["*"] });
    expect(data("anything-at-all", any)).not.toBeNull();
    expect(data("bitlogin:password:v1", any)).toBeNull();
    expect(data("bitlogin:recovery:v1", any)).toBeNull();
  });

  it("binds a web-request proof to the asking site or an origin the user was shown", () => {
    const proof = (...urls: string[]) => prepareForApp(perms, { kind: 27235, content: "", tags: [...urls.map((u) => ["u", u]), ["method", "GET"]] }, SITE, NOW);
    expect(proof(`${SITE}/v1/me`)).not.toBeNull();
    expect(proof("https://api.example/v1/orders")).not.toBeNull();
    // The attack this exists for: a proof that would work at someone else's server.
    expect(proof("https://api.bitunlock.network/v1/orders")).toBeNull();
    expect(proof(`${SITE}/v1/me`, "https://bank.example/transfer")).toBeNull();
    expect(proof()).toBeNull();
    expect(proof("not a url")).toBeNull();
    // A look-alike host is another origin.
    expect(proof("https://api.example.evil.test/x")).toBeNull();
  });

  it("keeps a seal free of tags and of the mark", () => {
    const seals = set({ sign: [13], appData: [], proofs: [], read: [] });
    expect(prepareForApp(seals, { kind: 13, content: "ciphertext", tags: [] }, SITE, NOW)).toEqual({ kind: 13, created_at: NOW, content: "ciphertext", tags: [] });
    expect(prepareForApp(seals, { kind: 13, content: "ciphertext", tags: [["p", OTHER]] }, SITE, NOW)).toBeNull();
  });

  it("takes the site's time only when it is close to the signer's own", () => {
    const at = (created_at: unknown) => prepareForApp(perms, { kind: 1, content: "", tags: [], created_at }, SITE, NOW)?.created_at;
    expect(at(NOW + 5)).toBe(NOW + 5);
    expect(at(NOW - 600)).toBe(NOW - 600);
    expect(at(NOW + 601)).toBe(NOW);
    expect(at(0)).toBe(NOW);
    expect(at("soon")).toBe(NOW);
  });

  it("refuses what is too large or not an event", () => {
    expect(prepareForApp(perms, { kind: 1, content: "x".repeat(100_001), tags: [] }, SITE, NOW)).toBeNull();
    expect(prepareForApp(perms, { kind: 1, content: "", tags: Array.from({ length: 2501 }, () => ["t", "x"]) }, SITE, NOW)).toBeNull();
    expect(prepareForApp(perms, { kind: 1, content: "", tags: [["t", 5]] }, SITE, NOW)).toBeNull();
    expect(prepareForApp(perms, { kind: 1, content: 5, tags: [] }, SITE, NOW)).toBeNull();
    expect(prepareForApp(perms, null, SITE, NOW)).toBeNull();
    expect(prepareForApp(perms, { kind: 1, content: "", tags: [] }, "not an origin", NOW)).toBeNull();
  });
});

describe("kinds reserved to a named address", () => {
  const PORTAL = "https://portal.bitblocks.network";
  const passes = readPermissions({ sign: [27300, 27302, 27303] })!;

  it("lets only the named address hold a set with a reserved kind", () => {
    expect(RESERVED_KINDS).toEqual([27300, 27302, 27303]);
    expect(mayHold(PORTAL, passes)).toBe(true);
    // Anyone else: not at all, whatever they declare and whatever a user would press.
    for (const site of [SITE, "https://portal.bitblocks.network.evil.example", "http://portal.bitblocks.network", "https://bitvid.network", ""]) {
      expect(mayHold(site, passes), site).toBe(false);
    }
    // A set with no reserved kind is anyone's to ask for.
    expect(mayHold(SITE, set())).toBe(true);
  });

  it("signs a reserved kind only for the address it is reserved to, even from a set that names it", () => {
    const grant = { kind: 27302, content: "", tags: [] };
    expect(prepareForApp(passes, grant, PORTAL, NOW)).not.toBeNull();
    expect(prepareForApp(passes, grant, SITE, NOW)).toBeNull();
    expect(prepareForApp(passes, grant, "https://bitvid.network", NOW)).toBeNull();
  });

  it("knows an application by its address, never by what it calls itself", () => {
    expect(knownAppName("https://bitvid.network")).toBe("Bitvid");
    expect(knownAppName(PORTAL)).toBe("BitPortal");
    expect(knownAppName("https://bitvid.network.evil.example")).toBeNull();
    expect(knownAppName("http://bitvid.network")).toBeNull();
    // A name on Object.prototype is not an application.
    expect(knownAppName("constructor")).toBeNull();
    expect(knownAppName("__proto__")).toBeNull();
    // Only BitPortal's address has anything reserved to it.
    expect(Object.entries(KNOWN_APPS).filter(([, app]) => app.reserved?.length).map(([site]) => site)).toEqual([PORTAL]);
    for (const site of Object.keys(KNOWN_APPS)) expect(site, site).toMatch(/^https:\/\/[a-z0-9.-]+$/u);
  });

  it("says in the window what a pass or a grant is, with the sensitive ones", () => {
    expect(describePermissions(passes, PORTAL).sensitive).toEqual([
      "give worlds a pass that says who you are",
      "let a world open a terminal on a computer of yours",
      "give a world access you have granted it"
    ]);
  });
});

describe("encrypting and reading", () => {
  const perms = set({ read: [30078, 1573] });

  it("encrypts to the user's own key or one they were shown, and decrypts raw only against the latter", () => {
    expect(mayEncryptTo(perms, ME, ME)).toBe(true);
    expect(mayEncryptTo(perms, ME, SERVICE)).toBe(true);
    expect(mayEncryptTo(perms, ME, OTHER)).toBe(false);
    expect(mayDecryptFrom(perms, SERVICE)).toBe(true);
    // Raw decrypting against the user's own key would read everything they ever encrypted to themselves.
    expect(mayDecryptFrom(perms, ME)).toBe(false);
    expect(mayDecryptFrom(perms, OTHER)).toBe(false);
    expect(mayDecryptFrom(perms, 5)).toBe(false);
  });

  it("reads only the kinds approved, against the right key", () => {
    // Someone else's event: against its author.
    expect(readPeerFor(perms, ME, { kind: 1573, pubkey: OTHER, tags: [["p", ME]] })).toBe(OTHER);
    // The user's own, addressed to someone: against that someone. Addressed to nobody: against themselves.
    expect(readPeerFor(perms, ME, { kind: 1573, pubkey: ME, tags: [["p", OTHER]] })).toBe(OTHER);
    expect(readPeerFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "example:draft:1"]] })).toBe(ME);
  });

  it("tries the user's own key too, for a note of their own that names somebody", () => {
    // A note an application saved for the user alone is sealed to their own key, whatever tags it carries.
    expect(readPeersFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "example:settings"], ["p", OTHER]] })).toEqual([OTHER, ME]);
    expect(readPeersFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "example:settings"]] })).toEqual([ME]);
    // Never for somebody else's event, and never for one the set may not read at all.
    expect(readPeersFor(perms, ME, { kind: 1573, pubkey: OTHER, tags: [["p", ME]] })).toEqual([OTHER]);
    expect(readPeersFor(perms, ME, { kind: 7375, pubkey: ME, tags: [["p", OTHER]] })).toEqual([]);
    expect(readPeersFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "adzap:draft:1"], ["p", OTHER]] })).toEqual([]);
  });

  it("approval to read one kind is not approval to read another", () => {
    // The user's Cashu tokens, and their private messages, are other kinds.
    expect(readPeerFor(perms, ME, { kind: 7375, pubkey: ME, tags: [] })).toBeNull();
    expect(readPeerFor(perms, ME, { kind: 1059, pubkey: OTHER, tags: [["p", ME]] })).toBeNull();
    expect(readPeerFor(perms, ME, { kind: 4, pubkey: OTHER, tags: [["p", ME]] })).toBeNull();
    // Nor another application's data of the same kind.
    expect(readPeerFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "adzap:draft:1"]] })).toBeNull();
    expect(readPeerFor(perms, ME, { kind: 30078, pubkey: ME, tags: [["d", "bitlogin:anything"]] })).toBeNull();
    expect(readPeerFor(perms, ME, { kind: 30078, pubkey: "nope", tags: [] })).toBeNull();
  });
});

describe("a world grant keeps the world it is for (NSWP kind 27303)", () => {
  const PORTAL = "https://portal.bitblocks.network";
  const portal = readPermissions({ name: "BitPortal", sign: [1, 27300, 27302, 27303] })!;
  const grant = (world: string[][]) => ({ kind: 27303, content: "", tags: [["nswp:session", OTHER], ["nswp:bridge", ME], ...world, ["expiration", "1794003600"]] });

  it("is signed with its one nswp:world, which is the grant's subject and not the signer's mark", () => {
    const out = prepareForApp(portal, grant([["nswp:world", "https://garden.example"]]), PORTAL, NOW);
    expect(out!.tags).toEqual([["nswp:session", OTHER], ["nswp:bridge", ME], ["nswp:world", "https://garden.example"], ["expiration", "1794003600"], [APP_SITE_TAG, PORTAL]]);
    // Prepared again, as the worker does, it is the same.
    expect(prepareForApp(portal, out, PORTAL, NOW)!.tags).toEqual(out!.tags);
  });

  it("is refused whole where that tag is not exactly one origin", () => {
    for (const world of [
      [["nswp:world", "https://a.example"], ["nswp:world", "https://b.example"]],
      [["nswp:world", "https://a.example/path"]],
      [["nswp:world", "https://a.example", "extra"]],
      [["nswp:world", "not an address"]],
      [["nswp:world"]]
    ]) {
      expect(prepareForApp(portal, grant(world), PORTAL, NOW), JSON.stringify(world)).toBeNull();
    }
  });

  it("is still the signer's to write in every other kind, and the grant only at the address it is reserved to", () => {
    for (const kind of [1, 27300, 27302]) {
      const out = prepareForApp(portal, { kind, content: "", tags: [["nswp:world", "https://evil.example"]] }, PORTAL, NOW);
      expect(out!.tags, String(kind)).toEqual([[APP_SITE_TAG, PORTAL]]);
    }
    expect(prepareForApp(portal, grant([["nswp:world", "https://garden.example"]]), SITE, NOW)).toBeNull();
    // The signer's own mark can never be written by the application, in a grant or anywhere.
    const marked = prepareForApp(portal, { ...grant([["nswp:world", "https://garden.example"]]), tags: [...grant([["nswp:world", "https://garden.example"]]).tags, [APP_SITE_TAG, "https://evil.example"]] }, PORTAL, NOW);
    expect(marked!.tags.filter((t) => t[0] === APP_SITE_TAG)).toEqual([[APP_SITE_TAG, PORTAL]]);
  });
});

describe("reserved kinds at a local address (a developer's own copy of BitLogin)", () => {
  const REAL = "https://bitlogin.network";
  const LOCAL_SIGNIN = "https://192.168.68.84:4311";
  const LOCAL_SITE = "https://192.168.68.84:4300";

  it("knows this machine and this network from the internet, whatever a name is made to look like", () => {
    for (const local of ["http://localhost:4300", "https://app.localhost", "http://127.0.0.1:8080", "http://127.9.9.9", "http://[::1]:4300", "https://10.0.0.5", "https://172.16.0.1", "https://172.31.255.255", LOCAL_SITE]) {
      expect(isLocalAddress(local), local).toBe(true);
    }
    for (const not of [
      "https://portal.bitblocks.network",
      "https://192.168.68.84.evil.example",
      "https://127.0.0.1.nip.io",
      "https://localhost.evil.example",
      "https://notlocalhost",
      "https://172.15.0.1",
      "https://172.32.0.1",
      "https://11.0.0.1",
      "https://192.169.0.1",
      "https://999.1.1.1",
      "ftp://localhost",
      "localhost",
      "",
      null,
      7
    ]) {
      expect(isLocalAddress(not), String(not)).toBe(false);
    }
  });

  it("at BitLogin's real address they are the named site's and nobody else's, local or not", () => {
    expect(reservedKindsFor("https://portal.bitblocks.network", REAL)).toEqual([27300, 27302, 27303]);
    expect(reservedKindsFor(LOCAL_SITE, REAL)).toEqual([]);
    expect(reservedKindsFor("http://localhost:4300", REAL)).toEqual([]);
    expect(reservedKindsFor("https://evil.example", REAL)).toEqual([]);
    // With no address at all (a test, a script): the same.
    expect(reservedKindsFor(LOCAL_SITE, "")).toEqual([]);
  });

  it("at a local copy, a local site may hold them, and a site on the internet still may not", () => {
    expect(reservedKindsFor(LOCAL_SITE, LOCAL_SIGNIN)).toEqual([27300, 27302, 27303]);
    expect(reservedKindsFor("http://localhost:4300", "http://localhost:4311")).toEqual([27300, 27302, 27303]);
    expect(reservedKindsFor("https://evil.example", LOCAL_SIGNIN)).toEqual([]);
    expect(reservedKindsFor("https://192.168.68.84.evil.example", LOCAL_SIGNIN)).toEqual([]);
    // A named site keeps exactly what it was given, wherever BitLogin runs.
    expect(reservedKindsFor("https://bitvid.network", LOCAL_SIGNIN)).toEqual([]);
  });

  it("where this code runs with no address of its own, as here, nothing local is assumed", () => {
    const set = readPermissions({ name: "Local", sign: [1, 27300] })!;
    expect(mayHold(LOCAL_SITE, set)).toBe(false);
    expect(prepareForApp(set, { kind: 27300, content: "", tags: [] }, LOCAL_SITE, NOW)).toBeNull();
  });
});

describe("limits", () => {
  it("counts what applications sign on timers apart from what the world sees", () => {
    expect(limitClass(27235)).toBe("quiet");
    expect(limitClass(24242)).toBe("quiet");
    expect(limitClass(30310)).toBe("quiet");
    expect(limitClass(1)).toBe("public");
    expect(limitClass(0)).toBe("sensitive");
    // A pass, a terminal on the user's computer, and access granted to a world: counted as the window warns of them.
    for (const kind of [27300, 27302, 27303]) expect(limitClass(kind), String(kind)).toBe("sensitive");
    expect(limitClass(5)).toBe("sensitive");
    expect(limitClass(10002)).toBe("sensitive");
    // Sized to what the applications do today: about eighty proofs a minute, a hundred entries at once.
    expect(APP_LIMITS.quiet.burst).toBeGreaterThanOrEqual(120);
    expect(APP_LIMITS.sensitive.burst).toBeLessThan(APP_LIMITS.public.burst);
  });
});

describe("describePermissions", () => {
  it("has plain words for everything BitPortal asks at home, and warns only about what deserves it", () => {
    // BitPortal's whole set, everything it asks on first use included (its src/shared/session.ts, 2026-11-20).
    const words = describePermissions(readPermissions({ name: "BitPortal", sign: [1, 3, 13, 10050, 27300, 27302, 27303, 30004, 30078, 37300, 37305, 37308], appData: ["bitportal/"], read: [30078, 13, 1059] })!, "https://portal.bitblocks.network");
    expect(JSON.stringify(words)).not.toMatch(/no words for|own kind of data|kind \d/u);
    expect(words.ordinary).toContain("change what is in your bag: the items you carry between worlds");
    // A bag is public, like a rating: it is not put under the warning.
    expect(words.sensitive.join(" ")).not.toContain("bag");
    expect(words.sensitive).toContain("read your private messages");
  });

  it("has words for a score and an achievement, should an application ask to sign them", () => {
    const words = describePermissions(set({ sign: [1, 37306, 37307], appData: [], proofs: [], read: [], peers: [] }), SITE);
    expect(words.ordinary).toEqual(expect.arrayContaining(["post your scores on worlds' boards", "show which achievements you hold in worlds"]));
    expect(JSON.stringify(words)).not.toMatch(/own kind of data/u);
  });

  it("has words for a rating of a world, as an ordinary thing to sign", () => {
    const words = describePermissions(set({ sign: [1, 37305], appData: [], proofs: [], read: [], peers: [] }), SITE);
    expect(words.ordinary).toContain("rate worlds, from one to five stars");
    expect(JSON.stringify(words)).not.toContain("no words for");
    expect(words.sensitive).toEqual([]);
  });

  it("puts a set into words, the ones that deserve a second look apart", () => {
    const words = describePermissions(set({ sign: [0, 1, 5, 7, 24242, 27235, 30078, 30310, 9999], read: [30078, 1059, 7375] }), SITE);
    expect(words.ordinary).toEqual([
      "prove who you are to app.example, api.example",
      "post notes",
      "post reactions",
      "save its own data (example:)",
      "save its own kind of data (kind 30310)",
      "sign kinds BitLogin has no words for: 9999",
      "read its own saved data",
      "exchange encrypted messages with one service it names (bbbbbbbb…)"
    ]);
    expect(words.sensitive).toEqual([
      "change your profile",
      "delete what you have posted",
      "upload, list and delete your files at file hosts",
      "read your private messages",
      "read the money in your Cashu wallet"
    ]);
  });

  it("says plainly what any-name application data means", () => {
    const words = describePermissions(set({ appData: ["*"] }), SITE);
    expect(words.sensitive).toEqual(["save application data under any name, including other applications' data", "read application data saved under any name"]);
  });

  it("never shows a site's own text beyond its cleaned name and prefixes", () => {
    const perms = readPermissions({ name: "<b>Bank</b>\u202e", sign: [1] });
    expect(perms?.name).toBe("<b>Bank</b>");
    // Markup is the page's to escape; what matters here is that nothing invisible or multi-line survives.
    expect(describePermissions(perms!, SITE).ordinary).toEqual(["post notes"]);
  });
});
