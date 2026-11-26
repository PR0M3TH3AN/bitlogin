/**
 * Guest accounts (docs/guest-accounts.md, the owner's decisions of 2026-11-23 and 2026-11-25): an account BitLogin
 * makes, with no press, for a visitor who arrives signed out at a site of a family it knows. Each part, failing
 * before it was built.
 */
import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { getPublicKeyHex } from "@bitlogin/core/crypto";
import { deriveEverydayPrivateKey } from "@bitlogin/core/account";
import { recoveryPhraseToSeed } from "@bitlogin/core/crypto";
import { readSignerRequest, prepareForGuest, passAllowed } from "./policy.js";
import { buildRoomPass } from "./profile.js";
import { forgetGuest, loadGuest, makeGuest } from "../worker/guestRecord.js";

const FAMILY = "https://*.bitblocks.network";
const SITE = "https://portal.bitblocks.network";
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

class TestStore implements KeyValueStore {
  values = new Map<string, string>();
  keys = new Map<string, CryptoKey>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
  async getOrCreateDeviceKey(key: string): Promise<CryptoKey> {
    let value = this.keys.get(key);
    if (!value) {
      value = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      this.keys.set(key, value);
    }
    return value;
  }
}

describe("a guest account", () => {
  it("is asked for with the family, and only as `guest: true`", () => {
    const wrap = (m: Record<string, unknown>) => ({ nswp: "nswp-signer", v: 1, ...m });
    expect(readSignerRequest(wrap({ t: "want", id: "g1", family: FAMILY, guest: true }))).toEqual({ t: "wantFamily", id: "g1", family: FAMILY, guest: true });
    expect(readSignerRequest(wrap({ t: "want", id: "g2", family: FAMILY, guest: "yes" }))).toEqual({ t: "wantFamily", id: "g2", family: FAMILY });
    expect(readSignerRequest(wrap({ t: "want", id: "g3", family: FAMILY }))).toEqual({ t: "wantFamily", id: "g3", family: FAMILY });
  });

  it("may have its bag written with no press, and nothing else beyond a note and a reaction", () => {
    const bag = prepareForGuest({ kind: 37308, content: "{}", tags: [["d", "bag"]] }, SITE, 1000);
    expect(bag).toMatchObject({ kind: 37308 });
    expect(bag!.tags).toContainEqual(["d", "bag"]);
    expect(prepareForGuest({ kind: 1, content: "hello", tags: [] }, SITE, 1000)).toMatchObject({ kind: 1 });
    // Another address of the same kind, an item's description, a profile, a follow list: no.
    expect(prepareForGuest({ kind: 37308, content: "{}", tags: [["d", "other"]] }, SITE, 1000)).toBeNull();
    expect(prepareForGuest({ kind: 37308, content: "{}", tags: [] }, SITE, 1000)).toBeNull();
    for (const kind of [0, 3, 37303, 30078]) expect(prepareForGuest({ kind, content: "{}", tags: [["d", "bag"]] }, SITE, 1000), String(kind)).toBeNull();
  });

  it("is said on the room pass a world gets", () => {
    const identity = "aa".repeat(32);
    const session = "bb".repeat(32);
    const guest = buildRoomPass({ session, site: SITE, identity, nowSeconds: 1000, guest: true })!;
    expect(guest.tags.slice(0, 3)).toEqual([["nswp:session", session], ["nswp:origin", SITE], ["nswp:guest", "1"]]);
    const account = buildRoomPass({ session, site: SITE, identity, nowSeconds: 1000 })!;
    expect(account.tags.some((t) => t[0] === "nswp:guest")).toBe(false);
  });

  it("is made from a recovery phrase of its own, kept sealed, one for each family", async () => {
    const store = new TestStore();
    expect(await loadGuest(store, FAMILY)).toBeNull();
    const made = await makeGuest(store, FAMILY);
    // Its key is the one its phrase makes, as any new account's is: securing it later gives an ordinary account.
    expect(hex(deriveEverydayPrivateKey(await recoveryPhraseToSeed(made.phrase)))).toBe(hex(made.key));
    // Asked again: the same guest, never another while one exists.
    const again = await makeGuest(store, FAMILY);
    expect(getPublicKeyHex(again.key)).toBe(getPublicKeyHex(made.key));
    expect(getPublicKeyHex((await loadGuest(store, FAMILY))!.key)).toBe(getPublicKeyHex(made.key));
    // Nothing of it in the clear.
    for (const value of store.values.values()) {
      expect(value).not.toContain(hex(made.key));
      expect(value).not.toContain(made.phrase.split(" ")[0]! + " " + made.phrase.split(" ")[1]!);
    }
    // Another family's is its own; and a guest is only for a family.
    expect(await loadGuest(store, "https://*.other.example")).toBeNull();
    await expect(makeGuest(store, SITE)).rejects.toThrow();
    await forgetGuest(store, FAMILY);
    expect(await loadGuest(store, FAMILY)).toBeNull();
  });

  it("a room pass: for a world or a guest, and for an application only where its approved set signs the pass's kind", () => {
    expect(passAllowed(null)).toBe(true);
    const app = (sign: number[]) => ({ name: "App", sign, appData: [], proofs: [], read: [], peers: [] });
    expect(passAllowed(app([1, 27300]))).toBe(true);
    expect(passAllowed(app([1, 30078]))).toBe(false);
  });

  it("a site asks for a pass with its session key alone: it can't add or take away what the pass says", () => {
    const wrap = (m: Record<string, unknown>) => ({ nswp: "nswp-signer", v: 1, ...m });
    const session = "bb".repeat(32);
    expect(readSignerRequest(wrap({ t: "pass", id: "p1", session, tags: [["nswp:guest", "0"]], guest: false }))).toEqual({ t: "pass", id: "p1", session });
  });
});
