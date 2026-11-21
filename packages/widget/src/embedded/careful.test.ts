import { describe, expect, it } from "vitest";
import { describeAsked } from "./careful.js";
import { ASKED_KINDS, cleanWalletUri, handoffMessage, prepareAsked, prepareForSite, readHandoffMessage, readSignerRequest } from "./policy.js";
import { isSignInAddress } from "./permissions.js";

const SITE = "https://gallery.bitblocks.network";
const HEX = "ab".repeat(32);
const NONCE = "0123456789abcdef01234567";

describe("what a site may put to the person (sign-in-window.md §SW20)", () => {
  it("is a profile, a deletion or a relay list, and nothing else", () => {
    expect(ASKED_KINDS).toEqual([0, 5, 10002]);
    for (const kind of ASKED_KINDS) {
      const asked = prepareAsked({ kind, content: "{}", tags: [["nswp:world", "https://evil.example"]] }, SITE, 1000);
      // Marked with the site that asked, whatever the site wrote, and never signable the ordinary way.
      expect(asked).toEqual({ kind, created_at: 1000, tags: [["nswp:world", SITE]], content: "{}" });
      expect(prepareForSite({ kind, content: "{}", tags: [] }, SITE, 1000)).toBeNull();
    }
    // Not a note (that is ordinary), not a follow list (one person at a time), not a never-kind, not anything unnamed.
    for (const kind of [1, 7, 3, 4, 1059, 13194, 22242, 30078, 30023, 9735]) expect(prepareAsked({ kind, content: "", tags: [] }, SITE, 1000), String(kind)).toBeNull();
  });

  it("reads the two requests, and the answer BitLogin's own page brings back", () => {
    const ask = (m: Record<string, unknown>) => readSignerRequest({ nswp: "nswp-signer", v: 1, id: "q1", ...m });
    expect(ask({ t: "propose", event: { kind: 0 } })).toEqual({ t: "propose", id: "q1", event: { kind: 0 } });
    expect(ask({ t: "propose" })).toBeNull();
    expect(ask({ t: "wallet" })).toEqual({ t: "wallet", id: "q1" });

    const uri = `nostr+walletconnect://${HEX}?relay=wss%3A%2F%2Frelay.example&secret=${HEX}`;
    expect(cleanWalletUri(uri)).toBe(uri);
    for (const bad of ["", "https://evil.example", `nostr+walletconnect://${HEX}`, `nostr+walletconnect://${HEX}?a b`, `${uri}${"x".repeat(2000)}`, 7]) expect(cleanWalletUri(bad)).toBe("");

    const shape = handoffMessage({ t: "hello", nonce: NONCE });
    const answer = (m: Record<string, unknown>) => readHandoffMessage({ ...shape, t: "answer", world: SITE, ...m });
    expect(readHandoffMessage(shape)).toEqual({ t: "hello", nonce: NONCE });
    expect(answer({})).toEqual({ t: "answer", nonce: NONCE, world: SITE });
    expect(answer({ wallet: uri })).toEqual({ t: "answer", nonce: NONCE, world: SITE, wallet: uri });
    expect(answer({ wallet: "https://evil.example" })).toBeNull();
    expect(answer({ wallet: uri, event: { kind: 0 } })).toBeNull();

    // The signer says what is waiting, and who the site is signed in as. Anything it did not prepare is not a question.
    const frame = (m: Record<string, unknown>) => readHandoffMessage({ ...shape, t: "frame", world: SITE, recipient: HEX, ...m });
    const event = prepareAsked({ kind: 0, content: "{}", tags: [] }, SITE, 1000)!;
    expect(frame({ ask: { what: "sign", event }, pubkey: HEX })).toMatchObject({ ask: { what: "sign", event }, pubkey: HEX });
    expect(frame({ ask: { what: "wallet" }, pubkey: HEX })).toMatchObject({ ask: { what: "wallet" } });
    expect(frame({ ask: { what: "wallet" } })).not.toHaveProperty("ask");
    expect(frame({ ask: { what: "sign", event: { ...event, kind: 1 } }, pubkey: HEX })).not.toHaveProperty("ask");
    expect(frame({ ask: { what: "sign", event: { ...event, tags: [] } }, pubkey: HEX })).not.toHaveProperty("ask");
    expect(frame({ ask: { what: "sign", event: { ...event, tags: [["nswp:world", "https://other.example"]] } }, pubkey: HEX })).not.toHaveProperty("ask");
  });

  it("says a profile in words, field by field, and that it replaces the whole of it", () => {
    const words = describeAsked({ kind: 0, content: JSON.stringify({ name: "Ada\nLovelace", about: "x".repeat(400), lud16: "thief@evil.example", zzz: 1, yyy: 2 }), tags: [] });
    expect(words.title).toBe("Replace your Nostr profile?");
    expect(words.warning).toContain("whole profile");
    expect(words.lines[0]).toBe("Name: Ada Lovelace");
    expect(words.lines[1]!.length).toBeLessThan(215);
    expect(words.lines).toContain("Lightning address: thief@evil.example");
    expect(words.lines.at(-1)).toBe("And 2 other fields: zzz, yyy");
    expect(describeAsked({ kind: 0, content: "not json", tags: [] }).lines).toEqual(["An empty profile: no name, no picture, nothing about you."]);
  });

  it("says a deletion and a relay list in words", () => {
    const gone = describeAsked({ kind: 5, content: "tidying", tags: [["e", HEX], ["a", `30023:${HEX}:post`], ["nswp:world", SITE]] });
    expect(gone.title).toBe("Ask relays to delete these 2 things?");
    expect(gone.lines).toEqual([`Note ${HEX}`, `Item 30023:${HEX}:post`, "Reason given: tidying"]);
    expect(gone.warning).toContain("can't be undone");
    const relays = describeAsked({ kind: 10002, content: "", tags: [["r", "wss://a.example"], ["r", "wss://b.example", "read"]] });
    expect(relays.lines).toEqual(["wss://a.example", "wss://b.example (read only)"]);
    expect(describeAsked({ kind: 10002, content: "", tags: [] }).lines).toEqual(["An empty list: no relays at all."]);
  });

  it("lets only BitLogin's own addresses, and local copies, name the site a wallet is for", () => {
    for (const origin of ["https://bitlogin.network", "https://bitlogin-beta.vercel.app", "http://localhost:4173", "https://192.168.68.84:4311"]) expect(isSignInAddress(origin), origin).toBe(true);
    for (const origin of ["https://bitvid.network", "https://portal.bitblocks.network", "https://bitlogin.network.evil.example", "https://evil.vercel.app", "", null]) expect(isSignInAddress(origin), String(origin)).toBe(false);
  });
});
