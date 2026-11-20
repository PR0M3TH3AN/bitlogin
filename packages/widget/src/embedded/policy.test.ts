import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  cleanName,
  cleanOrigin,
  createSignGate,
  handoffMessage,
  NEVER_KINDS,
  prepareForSite,
  readHandoffMessage,
  readSignerRequest,
  SIGN_LIMITS,
  signClass,
  signerMessage,
  SITE_TAG
} from "./policy.js";

const SITE = "https://app.example";
const at = (code: number) => String.fromCodePoint(code);

describe("which kinds a site may have signed", () => {
  it("is a note and a reaction, once the user has said yes", () => {
    expect(signClass(1)).toBe("ordinary");
    expect(signClass(7)).toBe("ordinary");
  });

  it("is never what proves who they are, reads their messages, moves their money, or holds an account", () => {
    for (const kind of [4, 13, 14, 1059, 13194, 22242, 23194, 24133, 27235, 27300, 30078]) expect(signClass(kind), String(kind)).toBe("never");
    for (const kind of NEVER_KINDS) expect(signClass(kind)).toBe("never");
    // 30078 is where an account's capsules live: a site that could have one signed could overwrite an account.
    expect(NEVER_KINDS).toContain(30078);
    for (const not of [-1, 1.5, 70000, "1", null, undefined, NaN]) expect(signClass(not)).toBe("never");
  });

  it("is with their say each time for what rewrites what they have, and for anything unnamed", () => {
    for (const kind of [0, 3, 5, 6, 10002, 30023, 9734, 31922]) expect(signClass(kind), String(kind)).toBe("careful");
  });
});

describe("an event as it is signed for a site", () => {
  it("is marked with the site that asked, and dated by the signer", () => {
    const ready = prepareForSite({ kind: 1, content: "hello", tags: [["t", "a"]], created_at: 5, pubkey: "x" }, `${SITE}/page?x=1`, 1_794_430_800.9);
    expect(ready).toEqual({ kind: 1, created_at: 1_794_430_800, content: "hello", tags: [["t", "a"], [SITE_TAG, SITE]] });
  });

  it("drops a mark of the site's own making", () => {
    expect(prepareForSite({ kind: 1, content: "hi", tags: [[SITE_TAG, "https://trusted.example"]] }, SITE, 10)!.tags).toEqual([[SITE_TAG, SITE]]);
  });

  it("is nothing for a kind that isn't ordinary, or for anything misshapen or too large", () => {
    for (const kind of [0, 3, 4, 5, 10002, 27300, 30078, 9734]) expect(prepareForSite({ kind, content: "", tags: [] }, SITE, 10), String(kind)).toBeNull();
    const ok = { kind: 1, content: "hi", tags: [] as unknown[] };
    expect(prepareForSite(ok, SITE, 10)).not.toBeNull();
    expect(prepareForSite({ ...ok, content: "x".repeat(SIGN_LIMITS.contentChars + 1) }, SITE, 10)).toBeNull();
    expect(prepareForSite({ ...ok, content: 7 }, SITE, 10)).toBeNull();
    expect(prepareForSite({ ...ok, tags: [["t", 7]] }, SITE, 10)).toBeNull();
    expect(prepareForSite({ ...ok, tags: [[]] }, SITE, 10)).toBeNull();
    expect(prepareForSite({ ...ok, tags: Array.from({ length: SIGN_LIMITS.tags + 1 }, () => ["t", "a"]) }, SITE, 10)).toBeNull();
    expect(prepareForSite(ok, "javascript:alert(1)", 10)).toBeNull();
    expect(prepareForSite(null, SITE, 10)).toBeNull();
  });
});

describe("how much is signed for one site", () => {
  it("is a few in a minute, and so many in an hour", () => {
    const gate = createSignGate();
    for (let i = 0; i < SIGN_LIMITS.burst; i++) expect(gate.take(i * 100)).toBe(true);
    expect(gate.take(1000)).toBe(false);
    expect(gate.take(SIGN_LIMITS.perMs + 700)).toBe(true);
    const slow = createSignGate();
    let signed = 0;
    for (let t = 0; t < 3_600_000; t += 11_000) if (slow.take(t)) signed++;
    expect(signed).toBe(SIGN_LIMITS.hourly);
  });

  it("carries on counting across a page load", () => {
    const first = createSignGate();
    for (let i = 0; i < SIGN_LIMITS.burst; i++) first.take(i * 100);
    expect(first.times()).toHaveLength(SIGN_LIMITS.burst);
    // The page is loaded again: what was counted before still counts.
    const again = createSignGate(SIGN_LIMITS, first.times());
    expect(again.take(1000)).toBe(false);
    expect(again.take(SIGN_LIMITS.perMs + 700)).toBe(true);
    expect(createSignGate(SIGN_LIMITS, [NaN, "x" as never]).take(0)).toBe(true);
  });
});

describe("names and addresses, as they may be shown", () => {
  it("an address is an origin and nothing more", () => {
    expect(cleanOrigin("https://app.example/x?y#z")).toBe(SITE);
    for (const not of ["javascript:alert(1)", "data:text/html,x", "null", "", 7, null, "file:///etc/passwd"]) expect(cleanOrigin(not)).toBe("");
  });

  it("a name is one line with nothing that hides or reorders it", () => {
    expect(cleanName(`  Ali${at(0x202e)}ce\n Smith `)).toBe("Ali ce Smith");
    expect([...cleanName("z".repeat(200))]).toHaveLength(48);
    expect(cleanName(7)).toBe("");
  });
});

describe("the messages", () => {
  const key = "cd".repeat(32);
  it("a site's request is read back as sent, and nothing else is read", () => {
    const wrap = (m: Record<string, unknown>) => ({ nswp: "nswp-signer", v: 1, ...m });
    expect(readSignerRequest(wrap({ t: "state", id: "a1" }))).toEqual({ t: "state", id: "a1" });
    expect(readSignerRequest(wrap({ t: "lock", id: "a1" }))).toEqual({ t: "lock", id: "a1" });
    expect(readSignerRequest(wrap({ t: "sign", id: "a2", event: { kind: 1 } }))).toEqual({ t: "sign", id: "a2", event: { kind: 1 } });
    for (const not of [null, "state", {}, { t: "state", id: "a" }, wrap({ t: "state", id: "has spaces" }), wrap({ t: "sign", id: "a" }), { ...wrap({ t: "state", id: "a" }), v: 2 }, wrap({ t: "export", id: "a" })]) {
      expect(readSignerRequest(not)).toBeNull();
    }
    expect(signerMessage({ t: "refused", id: "a2" })).toEqual({ nswp: "nswp-signer", v: 1, t: "refused", id: "a2" });
  });

  it("the window's and the signer's are read back as sent, and nothing misshapen is read", () => {
    expect(readHandoffMessage(handoffMessage({ t: "hello", nonce: "n1" }))).toEqual({ t: "hello", nonce: "n1" });
    expect(readHandoffMessage(handoffMessage({ t: "frame", nonce: "n1", world: `${SITE}/x`, recipient: key }))).toEqual({ t: "frame", nonce: "n1", world: SITE, recipient: key });
    const grant = { t: "grant" as const, nonce: "n1", world: SITE, sealed: { senderPublicKey: key, payload: "ciphertext" }, name: "Alice" };
    expect(readHandoffMessage(handoffMessage(grant))).toEqual(grant);
    expect(readHandoffMessage(handoffMessage({ t: "frame", nonce: "n1", world: "javascript:x", recipient: key }))).toBeNull();
    expect(readHandoffMessage(handoffMessage({ t: "grant", nonce: "n1", world: SITE, sealed: { senderPublicKey: "x", payload: "y" } }))).toBeNull();
    expect(readHandoffMessage({ nswp: "nswp-signer", v: 1, t: "hello", nonce: "n1" })).toBeNull();
  });
});

describe("the embedded signer and the window, as written", () => {
  const signer = readFileSync(new URL("./signer.ts", import.meta.url), "utf8");
  const win = readFileSync(new URL("./window.ts", import.meta.url), "utf8");

  it("the signer never restores this origin's own session, and reaches storage only through the worker", () => {
    expect(signer).not.toMatch(/\.restore\(\)|readCachedSession|localStorage|indexedDB|sessionStorage/u);
    // What it takes up is only what it kept for the site it is in, or for that site's family (docs/site-family.md):
    // and the family is worked out here, from the address the browser gave, never taken from a message.
    expect(signer).toContain("restoreSignerGrant(site, familyOf(site) || undefined)");
    expect(signer.split("restoreSignerGrant(").length - 1).toBe(1);
    expect(signer.split("familyOf(").length - 1).toBe(signer.split("familyOf(site)").length - 1);
    // A hand-off for a family is refused unless it is this site's own family.
    expect(signer).toContain('if (got.family && got.family !== familyOf(site)) throw new Error("for another family");');
    expect(signer).toContain("keepSignerGrant({ site, until");
    // Locking forgets the site.
    expect(signer.slice(signer.indexOf("const lock = ()"), signer.indexOf("let remembering"))).toContain("forgetSignerGrant(forSite)");
  });

  it("the signer answers the site only at the address the browser gave, and the window only at its own origin", () => {
    // Nothing is ever addressed to "any origin": not even "ready", which says nothing.
    expect(signer).not.toContain('"*"');
    expect(signer).toContain('window.parent.postMessage(signerMessage({ t: "ready" }), site);');
    expect(win).not.toContain('"*"');
    expect(win.split("postMessage(").length - 1).toBe(win.split(", me)").length - 1);
  });

  it("the signer takes a grant only from the window that said hello, with its word, for the site it is in", () => {
    expect(signer).toContain("asking.nonce !== msg.nonce || asking.from !== e.source || msg.world !== site");
  });
});
