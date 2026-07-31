/**
 * NIP-04 encrypted DMs (AES-256-CBC, secp256k1 ECDH shared secret). Legacy relative to NIP-44
 * (no MAC, deterministic per-message only via a random IV, shared secret is the raw ECDH X
 * coordinate rather than an HKDF-derived key) but still what many older Nostr clients and
 * relays expect from window.nostr.nip04 -- implemented for drop-in parity with a real NIP-07
 * extension, cross-checked byte-for-byte against the `nostr-tools` reference implementation.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { cbc } from "@noble/ciphers/aes.js";
import { base64 } from "@scure/base";
import { concatBytes, hexToBytes, utf8ToBytes, bytesToUtf8 } from "./encoding.js";
import { randomBytes } from "./random.js";

export function getSharedSecret(privateKey: Uint8Array, peerPublicKeyHex: string): Uint8Array {
  const peerPoint = concatBytes(new Uint8Array([0x02]), hexToBytes(peerPublicKeyHex));
  const shared = secp256k1.getSharedSecret(privateKey, peerPoint, true);
  return shared.slice(1, 33); // drop the compressed-point prefix byte, keep the X coordinate
}

/**
 * Encrypts with a fresh 16-byte IV from the CSPRNG.
 *
 * As with nip44Encrypt, there is deliberately no caller-supplied-IV parameter
 * here (§11.1). NIP-04 is AES-CBC: a repeated IV under the same shared secret
 * leaks whether two messages share a leading block, and CBC gives an attacker
 * far more leverage than that once IVs are predictable. Tests use
 * `__unsafeNip04EncryptWithIv` from ./testing.js, which the package does not
 * export.
 */
export function nip04Encrypt(
  privateKey: Uint8Array,
  peerPublicKeyHex: string,
  plaintext: string,
): string {
  return encryptWithIv(privateKey, peerPublicKeyHex, plaintext, randomBytes(16));
}

/** @internal Shared by nip04Encrypt and the test-only entry point. */
export function encryptWithIv(
  privateKey: Uint8Array,
  peerPublicKeyHex: string,
  plaintext: string,
  iv: Uint8Array,
): string {
  if (iv.length !== 16) throw new Error("NIP-04 iv must be exactly 16 bytes.");
  const key = getSharedSecret(privateKey, peerPublicKeyHex);
  const ciphertext = cbc(key, iv).encrypt(utf8ToBytes(plaintext));
  return `${base64.encode(ciphertext)}?iv=${base64.encode(iv)}`;
}

export function nip04Decrypt(privateKey: Uint8Array, peerPublicKeyHex: string, payload: string): string {
  const separatorIndex = payload.indexOf("?iv=");
  if (separatorIndex === -1) throw new Error("NIP-04 payload is missing its \"?iv=\" suffix.");
  const ciphertext = base64.decode(payload.slice(0, separatorIndex));
  const iv = base64.decode(payload.slice(separatorIndex + 4));
  const key = getSharedSecret(privateKey, peerPublicKeyHex);
  const plaintext = cbc(key, iv).decrypt(ciphertext);
  return bytesToUtf8(plaintext);
}
