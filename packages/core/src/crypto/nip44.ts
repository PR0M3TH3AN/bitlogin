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
  if (len < MIN_PLAINTEXT_LEN || len > MAX_PLAINTEXT_LEN) {
    throw new Error(`NIP-44 plaintext length must be between ${MIN_PLAINTEXT_LEN} and ${MAX_PLAINTEXT_LEN} bytes.`);
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

export function nip44Encrypt(conversationKey: Uint8Array, plaintext: string, nonceOverride?: Uint8Array): string {
  const nonce = nonceOverride ?? randomBytes(32);
  const { chachaKey, chachaNonce, hmacKey } = deriveMessageKeys(conversationKey, nonce);
  const padded = pad(utf8ToBytes(plaintext));
  const ciphertext = chacha20(chachaKey, chachaNonce, padded);
  const mac = calcMac(hmacKey, nonce, ciphertext);
  return base64.encode(concatBytes(new Uint8Array([NIP44_VERSION]), nonce, ciphertext, mac));
}

export function nip44Decrypt(conversationKey: Uint8Array, payload: string): string {
  const decoded = base64.decode(payload);
  if (decoded[0] !== NIP44_VERSION) throw new Error(`Unsupported NIP-44 version: ${decoded[0]}`);
  const nonce = decoded.slice(1, 33);
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
