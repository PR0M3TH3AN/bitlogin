import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generatePrivateKey, getConversationKey, getPublicKeyHex, hexToBytes, bytesToHex, nip44Decrypt } from "@bitlogin/core/crypto";
import { signNostrEvent, verifyNostrEvent } from "@bitlogin/core/nostr";
import { cleanSlot, fitsInSave, openSave, SAVE_KIND, SAVE_LIMITS, saveAddress, sealSave } from "./saves.js";
import { readSignerRequest, prepareForSite, SIGNER_PROTOCOL } from "./policy.js";
import { prepareForApp, readPermissions } from "./permissions.js";

/** NSWP's own vectors (vectors/saves.json at 8400ac7), copied whole. Never edited here. */
const vectors = JSON.parse(readFileSync(new URL("./saves.vectors.json", import.meta.url), "utf8")) as {
  testKeys: { key1: { secretKey: string; pubkey: string } };
  conversationKey: string;
  nonce: string;
  addresses: { world: string; slot: string; d: string }[];
  sealed: { world: string; slot: string; data: string; now: number; event: { kind: number; created_at: number; tags: string[][]; content: string; pubkey: string; id: string; sig: string } };
  opening: { name: string; event: unknown; askedBy: string; expect: { slot: string; data: string; at: number } | null }[];
};
const key1 = hexToBytes(vectors.testKeys.key1.secretKey);
const pub1 = vectors.testKeys.key1.pubkey;
const ck = () => getConversationKey(key1, pub1);

describe("what a world keeps for its visitor (NSWP-12)", () => {
  it("makes the conversation key NSWP's vectors name", () => {
    expect(bytesToHex(ck())).toBe(vectors.conversationKey);
  });

  it("works out every address in NSWP's vectors", () => {
    for (const a of vectors.addresses) expect(saveAddress(ck(), a.world, a.slot), `${a.world} ${a.slot}`).toBe(a.d);
  });

  it("seals a save as NSWP's vectors have it: the same note, and the same words inside", () => {
    const s = vectors.sealed;
    expect(verifyNostrEvent(s.event)).toBe(true);
    const save = sealSave({ conversationKey: ck(), world: s.world, slot: s.slot, data: s.data, nowSeconds: s.now })!;
    // The nonce is fresh here, so the ciphertext differs: everything else is the vector's, and what is encrypted is
    // the same text, byte for byte. (NIP-44 itself is held to its own vectors in the core.)
    expect({ kind: save.kind, created_at: save.created_at, tags: save.tags }).toEqual({ kind: s.event.kind, created_at: s.event.created_at, tags: s.event.tags });
    expect(nip44Decrypt(ck(), save.content)).toBe(nip44Decrypt(ck(), s.event.content));
    expect(nip44Decrypt(ck(), s.event.content)).toBe(JSON.stringify({ v: 1, world: s.world, slot: s.slot, data: s.data }));
  });

  it("opens and refuses exactly what NSWP's vectors say", () => {
    expect(vectors.opening.length).toBeGreaterThanOrEqual(7);
    for (const c of vectors.opening) {
      expect(openSave(c.event, { conversationKey: ck(), pubkey: pub1, world: c.askedBy }), c.name).toEqual(c.expect);
    }
  });

  it("uses a fresh nonce each time, and opens what it sealed", () => {
    const key = generatePrivateKey();
    const me = getPublicKeyHex(key);
    const k = getConversationKey(key, me);
    const a = sealSave({ conversationKey: k, world: "https://arcade.example", slot: "main", data: "one", nowSeconds: 1_800_000_000 })!;
    const b = sealSave({ conversationKey: k, world: "https://arcade.example", slot: "main", data: "one", nowSeconds: 1_800_000_000 })!;
    expect(a.content).not.toBe(b.content);
    expect(a.tags).toEqual(b.tags);
    // Nothing on a relay names the world.
    expect(JSON.stringify(a.tags)).not.toContain("arcade");
    const signed = signNostrEvent({ ...a, pubkey: me }, key);
    expect(openSave(signed, { conversationKey: k, pubkey: me, world: "https://arcade.example" })).toEqual({ slot: "main", data: "one", at: 1_800_000_000 });
    expect(openSave(signed, { conversationKey: k, pubkey: me, world: "https://other.example" })).toBeNull();
  });

  it("holds a save to its limits", () => {
    const k = ck();
    expect(fitsInSave("x".repeat(SAVE_LIMITS.dataBytes))).toBe(true);
    expect(fitsInSave("x".repeat(SAVE_LIMITS.dataBytes + 1))).toBe(false);
    // Counted in bytes, not characters.
    expect(fitsInSave("é".repeat(SAVE_LIMITS.dataBytes / 2))).toBe(true);
    expect(fitsInSave("é".repeat(SAVE_LIMITS.dataBytes / 2 + 1))).toBe(false);
    expect(fitsInSave(7)).toBe(false);
    for (const bad of ["", "Main", "-a", "a b", "a".repeat(33), "a/b", 7, null]) expect(cleanSlot(bad), String(bad)).toBe("");
    expect(sealSave({ conversationKey: k, world: "https://arcade.example", slot: "Not A Slot", data: "x", nowSeconds: 1 })).toBeNull();
    expect(sealSave({ conversationKey: k, world: "not an address", slot: "main", data: "x", nowSeconds: 1 })).toBeNull();
    expect(sealSave({ conversationKey: k, world: "https://arcade.example", slot: "main", data: { a: 1 }, nowSeconds: 1 })).toBeNull();
  });

  it("reads the three messages, and nothing malformed", () => {
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "a1", ...more });
    expect(say({ t: "save", slot: "main", data: "{}" })).toEqual({ t: "save", id: "a1", slot: "main", data: "{}" });
    expect(say({ t: "find", slot: "run-2" })).toEqual({ t: "find", id: "a1", slot: "run-2" });
    expect(say({ t: "open", event: { kind: SAVE_KIND } })).toEqual({ t: "open", id: "a1", event: { kind: SAVE_KIND } });
    expect(say({ t: "save", slot: "Main", data: "{}" })).toBeNull();
    expect(say({ t: "save", slot: "main", data: "x".repeat(SAVE_LIMITS.dataBytes + 1) })).toBeNull();
    expect(say({ t: "save", slot: "main" })).toBeNull();
    expect(say({ t: "find" })).toBeNull();
    expect(say({ t: "open", event: "x" })).toBeNull();
  });

  it("can't be had any other way: not signed for a world, and not signed or read for an application", () => {
    expect(prepareForSite({ kind: SAVE_KIND, content: "x", tags: [["d", "a".repeat(64)]] }, "https://arcade.example", 1)).toBeNull();
    expect(readPermissions({ sign: [1, SAVE_KIND] })).toBeNull();
    expect(readPermissions({ read: [SAVE_KIND] })).toBeNull();
    const perms = readPermissions({ sign: [1] })!;
    expect(prepareForApp({ ...perms, sign: [1, SAVE_KIND] }, { kind: SAVE_KIND, content: "x", tags: [] }, "https://app.example", 1)).toBeNull();
  });
});
