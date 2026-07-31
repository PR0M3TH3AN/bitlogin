/**
 * NIP-44 v2 encrypted payloads (ChaCha20 + HMAC-SHA256, secp256k1 ECDH key agreement).
 * Implemented from the published NIP-44 algorithm description and cross-checked
 * byte-for-byte against the `nostr-tools` reference implementation: conversation-key
 * agreement, padding at every bucket boundary from 1 byte to the extended-length
 * threshold, and round trips in both directions (BitLogin encrypt -> nostr-tools
 * decrypt, and back) all match. Used by the widget's window.nostr.nip44 provider
 * surface; BitLogin's own capsules use AES-256-GCM (§11.7) and do not depend on
 * this module.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { chacha20 } from "@noble/ciphers/chacha.js";
import { base64 } from "@scure/base";
import { hkdfExpand, hkdfExtract } from "./hkdf.js";
import { concatBytes, hexToBytes, utf8ToBytes, bytesToUtf8, constantTimeEqual } from "./encoding.js";
import { randomBytes } from "./random.js";

const NIP44_VERSION = 0x02;
const MIN_PLAINTEXT_LEN = 1;
/** Payloads at or above this length use the 6-byte extended-length prefix instead of 2 bytes. */
const EXTENDED_PREFIX_THRESHOLD = 0x10000;
/** Absolute ceiling for the 4-byte extended-length prefix (2^32 - 1). */
const MAX_PLAINTEXT_LEN = 0xffffffff;
const MIN_ENCODED_PAYLOAD_LEN = 132;
const MIN_DECODED_PAYLOAD_LEN = 99;
/**
 * Browser-safe implementation ceiling. NIP-44's wire format can represent
 * nearly 4 GiB, but decoding and crypto require several simultaneous copies.
 * One MiB is ample for signed Nostr event content and bounds memory DoS.
 */
export const MAX_NIP44_BROWSER_PLAINTEXT_LEN = 1024 * 1024;

export function getConversationKey(privateKey: Uint8Array, peerPublicKeyHex: string): Uint8Array {
  const peerPoint = concatBytes(new Uint8Array([0x02]), hexToBytes(peerPublicKeyHex));
  const shared = secp256k1.getSharedSecret(privateKey, peerPoint, true);
  const sharedX = shared.slice(1, 33); // drop the compressed-point prefix byte
  return hkdfExtract(utf8ToBytes("nip44-v2"), sharedX);
}

interface MessageKeys {
  chachaKey: Uint8Array;
  chachaNonce: Uint8Array;
  hmacKey: Uint8Array;
}

function deriveMessageKeys(conversationKey: Uint8Array, nonce: Uint8Array): MessageKeys {
  if (conversationKey.length !== 32) throw new Error("NIP-44 conversation key must be exactly 32 bytes.");
  if (nonce.length !== 32) throw new Error("NIP-44 nonce must be exactly 32 bytes.");
  const expanded = hkdfExpand(conversationKey, nonce, 76);
  return {
    chachaKey: expanded.slice(0, 32),
    chachaNonce: expanded.slice(32, 44),
    hmacKey: expanded.slice(44, 76)
  };
}

function calcPaddedLen(unpaddedLen: number): number {
  if (unpaddedLen <= 32) return 32;
  const nextPower = 2 ** Math.floor(Math.log2(unpaddedLen - 1) + 1);
  const chunk = nextPower <= 256 ? 32 : nextPower / 8;
  return chunk * (Math.floor((unpaddedLen - 1) / chunk) + 1);
}

const MAX_NIP44_DECODED_PAYLOAD_LEN = 1 + 32 + 6 + calcPaddedLen(MAX_NIP44_BROWSER_PLAINTEXT_LEN) + 32;
/** Maximum accepted base64 characters, checked before allocating decoded bytes. */
export const MAX_NIP44_ENCODED_PAYLOAD_LEN = Math.ceil(MAX_NIP44_DECODED_PAYLOAD_LEN / 3) * 4;

/**
 * Length prefix: 2-byte big-endian length below the extended threshold, matching every
 * other NIP-44 implementation's common case; at or above it, two zero bytes (which can
 * never be a valid 2-byte length here, since the threshold exceeds 0xffff) followed by a
 * 4-byte big-endian length, so a reader can distinguish the two forms from the first two
 * bytes alone.
 */
function lengthPrefix(len: number): Uint8Array {
  if (len < EXTENDED_PREFIX_THRESHOLD) {
    const prefix = new Uint8Array(2);
    new DataView(prefix.buffer).setUint16(0, len, false);
    return prefix;
  }
  const prefix = new Uint8Array(6);
  new DataView(prefix.buffer).setUint32(2, len, false);
  return prefix;
}

function pad(plaintext: Uint8Array): Uint8Array {
  const len = plaintext.length;
  if (len < MIN_PLAINTEXT_LEN || len > MAX_NIP44_BROWSER_PLAINTEXT_LEN) {
    throw new Error(`NIP-44 plaintext length must be between ${MIN_PLAINTEXT_LEN} and ${MAX_NIP44_BROWSER_PLAINTEXT_LEN} bytes on this platform.`);
  }
  const prefix = lengthPrefix(len);
  const paddedLen = calcPaddedLen(len);
  const out = new Uint8Array(prefix.length + paddedLen);
  out.set(prefix, 0);
  out.set(plaintext, prefix.length);
  return out;
}

function unpad(padded: Uint8Array): Uint8Array {
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const firstTwo = view.getUint16(0, false);
  let len: number;
  let prefixLen: number;
  if (firstTwo === 0) {
    len = view.getUint32(2, false);
    prefixLen = 6;
    if (len < EXTENDED_PREFIX_THRESHOLD) throw new Error("NIP-44 payload has inconsistent padding.");
  } else {
    len = firstTwo;
    prefixLen = 2;
  }
  if (len < MIN_PLAINTEXT_LEN || len > MAX_PLAINTEXT_LEN || padded.length !== prefixLen + calcPaddedLen(len)) {
    throw new Error("NIP-44 payload has inconsistent padding.");
  }
  return padded.slice(prefixLen, prefixLen + len);
}

function calcMac(hmacKey: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return hmac(sha256, hmacKey, concatBytes(nonce, ciphertext));
}

/**
 * Encrypts with a fresh 32-byte nonce from the CSPRNG.
 *
 * There is deliberately no caller-supplied-nonce parameter on this function
 * (§11.1). NIP-44 is ChaCha20: reusing a nonce under one conversation key
 * recovers plaintext outright, so "pass your own nonce" is not a knob that
 * belongs on the public surface. Tests that must pin a nonce use
 * `__unsafeNip44EncryptWithNonce` from ./testing.js, which is not exported from
 * the package.
 */
export function nip44Encrypt(conversationKey: Uint8Array, plaintext: string): string {
  return encryptWithNonce(conversationKey, plaintext, randomBytes(32));
}

/** @internal Shared by nip44Encrypt and the test-only entry point. */
export function encryptWithNonce(
  conversationKey: Uint8Array,
  plaintext: string,
  nonce: Uint8Array,
): string {
  if (nonce.length !== 32) throw new Error("NIP-44 nonce must be exactly 32 bytes.");
  const { chachaKey, chachaNonce, hmacKey } = deriveMessageKeys(conversationKey, nonce);
  const padded = pad(utf8ToBytes(plaintext));
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = calcMac(hmacKey, nonce, ciphertext);
  return base64.encode(concatBytes(new Uint8Array([NIP44_VERSION]), nonce, ciphertext, mac));
}

export function nip44Decrypt(conversationKey: Uint8Array, payload: string): string {
  if (payload.startsWith("#")) throw new Error("Unsupported NIP-44 non-base64 encoding.");
  if (payload.length < MIN_ENCODED_PAYLOAD_LEN || payload.length > MAX_NIP44_ENCODED_PAYLOAD_LEN) {
    throw new Error("NIP-44 payload size is outside this platform's supported range.");
  }
  const decoded = base64.decode(payload);
  if (decoded.length < MIN_DECODED_PAYLOAD_LEN || decoded.length > MAX_NIP44_DECODED_PAYLOAD_LEN) {
    throw new Error("NIP-44 decoded payload size is outside this platform's supported range.");
  }
  if (decoded[0] !== NIP44_VERSION) throw new Error(`Unsupported NIP-44 version: ${decoded[0]}`);
  const nonce = decoded.slice(1, 33);
  if (nonce.length !== 32) throw new Error("NIP-44 nonce must be exactly 32 bytes.");
  const mac = decoded.slice(decoded.length - 32);
  const ciphertext = decoded.slice(33, decoded.length - 32);

  const { chachaKey, chachaNonce, hmacKey } = deriveMessageKeys(conversationKey, nonce);
  const expectedMac = calcMac(hmacKey, nonce, ciphertext);
  if (!constantTimeEqual(mac, expectedMac)) {
    throw new Error("NIP-44 MAC verification failed: payload is corrupted, tampered, or uses the wrong key.");
  }
  const padded = chacha20(chachaKey, chachaNonce, ciphertext);
  return bytesToUtf8(unpad(padded));
}
