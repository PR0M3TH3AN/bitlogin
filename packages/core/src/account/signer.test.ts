import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { getConversationKey, nip44Decrypt, nip44Encrypt } from "../crypto/nip44.js";
import { NostrSigner } from "./signer.js";
import { verifyNostrEvent } from "../nostr/event.js";

describe("NIP-44 v2 conversation key + encrypt/decrypt round trip", () => {
  it("derives the same conversation key from both directions (ECDH symmetry)", () => {
    const alice = generatePrivateKey();
    const bob = generatePrivateKey();
    const keyAB = getConversationKey(alice, getPublicKeyHex(bob));
    const keyBA = getConversationKey(bob, getPublicKeyHex(alice));
    expect(keyAB).toEqual(keyBA);
  });

  it("round-trips plaintext of varying lengths", () => {
    const alice = generatePrivateKey();
    const bob = generatePrivateKey();
    const key = getConversationKey(alice, getPublicKeyHex(bob));
    for (const message of ["hi", "a".repeat(31), "a".repeat(32), "a".repeat(33), "a".repeat(1000), "unicode: 🚀 ñ"]) {
      const encrypted = nip44Encrypt(key, message);
      expect(nip44Decrypt(key, encrypted)).toBe(message);
    }
  });

  it("fails MAC verification when the payload is tampered", () => {
    const key = getConversationKey(generatePrivateKey(), getPublicKeyHex(generatePrivateKey()));
    const encrypted = nip44Encrypt(key, "secret message");
    const tampered = encrypted.slice(0, -4) + (encrypted.slice(-4) === "AAAA" ? "BBBB" : "AAAA");
    expect(() => nip44Decrypt(key, tampered)).toThrow();
  });

  it("fails to decrypt with the wrong conversation key", () => {
    const keyA = getConversationKey(generatePrivateKey(), getPublicKeyHex(generatePrivateKey()));
    const keyB = getConversationKey(generatePrivateKey(), getPublicKeyHex(generatePrivateKey()));
    const encrypted = nip44Encrypt(keyA, "secret message");
    expect(() => nip44Decrypt(keyB, encrypted)).toThrow();
  });
});

describe("NostrSigner (NIP-07-shaped API, §26.2)", () => {
  it("exposes the correct public key and signs a valid event", () => {
    const sk = generatePrivateKey();
    const signer = new NostrSigner(sk);
    expect(signer.getPublicKey()).toBe(getPublicKeyHex(sk));

    const event = signer.signEvent({ kind: 1, content: "hello nostr" });
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event.pubkey).toBe(signer.getPublicKey());
  });

  it("encrypts and decrypts NIP-44 messages between two signers", () => {
    const alice = new NostrSigner(generatePrivateKey());
    const bob = new NostrSigner(generatePrivateKey());
    const encrypted = alice.nip44Encrypt(bob.getPublicKey(), "hello bob");
    expect(bob.nip44Decrypt(alice.getPublicKey(), encrypted)).toBe("hello bob");
  });

  it("refuses to sign after destroy() (§21.4 logout)", () => {
    const signer = new NostrSigner(generatePrivateKey());
    signer.destroy();
    expect(() => signer.signEvent({ kind: 1, content: "x" })).toThrow();
    expect(() => signer.getPublicKey()).toThrow();
  });
});
