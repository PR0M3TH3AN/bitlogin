/**
 * Signing in a headset from your phone (docs/pair-a-headset.md): the code, the offer, the numbers to match, and a
 * take-back for one device. Each failing before it was built.
 */
import { describe, expect, it } from "vitest";
import { codeHash, deviceLabel, makeCode, normalizeCode, numberChoices, PAIR_KIND, pairUrl, readOffer } from "./pair.js";
import { isTakenBack, mergeTakenBack, NOTHING_TAKEN_BACK, readTakenBack, takeBack, writeTakenBack } from "./takeBack.js";

const SITE = "https://portal.bitblocks.network";
const KEY = "aa".repeat(32);

describe("a pairing code", () => {
  it("is eight characters a person can read out, in two groups, from an alphabet with nothing to confuse", () => {
    for (let i = 0; i < 50; i++) {
      const code = makeCode();
      expect(code).toMatch(/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{4}$/u);
    }
    // Typed by hand, as people do: lower case, spaces, the letters that look like digits.
    expect(normalizeCode(" k7qf 3mpx ")).toBe("K7QF-3MPX");
    expect(normalizeCode("K7QF-3MPO")).toBe("K7QF-3MP0");
    expect(normalizeCode("i1lL-0000")).toBe("1111-0000");
    expect(normalizeCode("K7QF-3MP")).toBe("");
    expect(normalizeCode("K7QF-3MPU")).toBe("");
    expect(codeHash("k7qf 3mpx")).toBe(codeHash("K7QF-3MPX"));
    expect(codeHash("K7QF-3MPX")).toMatch(/^[0-9a-f]{64}$/u);
    expect(codeHash("K7QF-3MPX")).not.toBe(codeHash("K7QF-3MPY"));
    // The QR's address: the code in the fragment, which reaches no server.
    expect(pairUrl("https://bitlogin.network", "K7QF-3MPX")).toBe("https://bitlogin.network/pair/#K7QF-3MPX");
  });

  it("is found by an offer that says nothing secret, read only while it is in date", () => {
    const now = 1_000_000;
    const offer = (o: Partial<{ kind: number; tags: string[][]; content: string; pubkey: string }> = {}) => ({
      id: "bb".repeat(32),
      kind: PAIR_KIND,
      pubkey: KEY,
      created_at: now - 10,
      tags: [["nswp:pair", codeHash("K7QF-3MPX")], ["nswp:origin", SITE], ["expiration", String(now + 290)]],
      content: JSON.stringify({ device: "Meta Quest Browser" }),
      sig: "cc".repeat(64),
      ...o
    });
    expect(readOffer(offer(), now)).toEqual({ id: "bb".repeat(32), key: KEY, hash: codeHash("K7QF-3MPX"), site: SITE, device: "Meta Quest Browser", expires: now + 290 });
    expect(readOffer(offer({ tags: [["nswp:pair", codeHash("K7QF-3MPX")], ["nswp:origin", SITE], ["expiration", String(now - 1)]] }), now)).toBeNull();
    expect(readOffer(offer({ tags: [["nswp:pair", codeHash("K7QF-3MPX")], ["nswp:origin", "javascript:x"], ["expiration", String(now + 10)]] }), now)).toBeNull();
    expect(readOffer(offer({ kind: 1 }), now)).toBeNull();
    // A device label that is too long, or not text, is said as "a device".
    expect(readOffer(offer({ content: JSON.stringify({ device: "x".repeat(200) }) }), now)?.device).toBe("a device");
    // An offer that lasts more than five minutes is not one.
    expect(readOffer(offer({ tags: [["nswp:pair", codeHash("K7QF-3MPX")], ["nswp:origin", SITE], ["expiration", String(now + 3600)]] }), now)).toBeNull();
  });

  it("names the headset's browser, and offers three numbers, the right one among them", () => {
    expect(deviceLabel("Mozilla/5.0 (X11; Linux x86_64; Quest 3) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/35.1 Chrome/126 VR Safari/537.36")).toBe("Meta Quest Browser");
    expect(deviceLabel("Mozilla/5.0 (Windows NT 10.0) Chrome/126 Safari/537.36")).toBe("a browser");
    for (let i = 0; i < 50; i++) {
      const choices = numberChoices(47);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(3);
      expect(choices).toContain(47);
      for (const n of choices) expect(n >= 10 && n <= 99).toBe(true);
    }
  });
});

describe("a take-back for one device", () => {
  it("ends that device's grant, and no other's, and is kept when records are joined", () => {
    const device = "0123456789abcdef0123456789abcdef";
    const record = takeBack(NOTHING_TAKEN_BACK, { device }, 500);
    expect(isTakenBack(record, SITE, 400, device)).toBe(true);
    expect(isTakenBack(record, SITE, 400, "fe".repeat(16))).toBe(false);
    expect(isTakenBack(record, SITE, 400)).toBe(false);
    // A grant made after it is not ended.
    expect(isTakenBack(record, SITE, 501, device)).toBe(false);
    // Written, read back and joined with an older copy: still there.
    const read = readTakenBack(JSON.parse(writeTakenBack(record)))!;
    expect(isTakenBack(mergeTakenBack(read, NOTHING_TAKEN_BACK, 600), SITE, 400, device)).toBe(true);
  });
});

describe("what a site may ask the signer about pairing", () => {
  it("is to begin one and to cancel it, by id, and nothing more is read from it", async () => {
    const { readSignerRequest, SIGNER_PROTOCOL } = await import("./policy.js");
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "p1", ...more });
    expect(say({ t: "pair" })).toEqual({ t: "pair", id: "p1" });
    // A site can't name the code, the relays or the device: the signer makes and reads those itself.
    expect(say({ t: "pair", code: "K7QF-3MPX", relays: ["wss://x"], device: "me" })).toEqual({ t: "pair", id: "p1" });
    expect(say({ t: "pairCancel" })).toEqual({ t: "pairCancel", id: "p1" });
  });
});

describe("a headset on the phone's list of sites", () => {
  it("is kept apart from the phone's own grant for the same site, with its label, and removed alone", async () => {
    const { addAllowed, readAllowed, removeAllowed } = await import("./allowed.js");
    const pubkey = "ab".repeat(32);
    const device = "0123456789abcdef0123456789abcdef";
    const own = { site: SITE, pubkey, at: 100, until: 200, remembered: true };
    const headset = { ...own, at: 150, device, deviceLabel: "Meta Quest Browser" };
    const list = addAllowed(addAllowed([], own), headset);
    expect(list).toHaveLength(2);
    expect(readAllowed(JSON.stringify(list), 160).find((e) => e.device)).toEqual(headset);
    // A device id that isn't one is no entry; a label that isn't text is left out.
    expect(readAllowed(JSON.stringify([{ ...own, device: "nope" }]), 160)).toEqual([]);
    expect(readAllowed(JSON.stringify([{ ...headset, deviceLabel: "<b>x</b>" }]), 160)[0]?.deviceLabel).toBeUndefined();
    expect(removeAllowed(list, SITE, pubkey, device)).toEqual([own]);
    expect(removeAllowed(list, SITE, pubkey)).toEqual([headset]);
  });
});
