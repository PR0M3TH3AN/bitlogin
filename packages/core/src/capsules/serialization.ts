/** JCS + padding + AES-256-GCM envelope encryption for capsule payloads (§11.7, §11.8, §11.9, §13, §14). */
import { canonicalJsonBytes } from "../crypto/jcs.js";
import { padToBucket, unpadFromBucket } from "../crypto/padding.js";
import { aesGcmSeal, aesGcmOpen } from "../crypto/aesGcm.js";
import { bytesToBase64url, base64urlToBytes, bytesToUtf8, utf8ToBytes } from "../crypto/encoding.js";
import type { EncryptedEnvelope } from "./types.js";

export function credentialCapsuleAad(locatorPubkeyHex: string): Uint8Array {
  return utf8ToBytes(`bitlogin|password-capsule|v1|${locatorPubkeyHex}|30078|bitlogin:password:v1`);
}

export function recoveryCapsuleAad(recoveryPubkeyHex: string): Uint8Array {
  return utf8ToBytes(`bitlogin|recovery-capsule|v1|${recoveryPubkeyHex}|30078|bitlogin:recovery:v1`);
}

export async function encryptEnvelope(
  payload: unknown,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<EncryptedEnvelope> {
  const canonical = canonicalJsonBytes(payload);
  const padded = padToBucket(canonical);
  const sealed = await aesGcmSeal(key, padded, associatedData);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    nonce: bytesToBase64url(sealed.nonce),
    ciphertext: bytesToBase64url(sealed.ciphertext)
  };
}

export async function decryptEnvelope<T>(
  envelope: EncryptedEnvelope,
  key: Uint8Array,
  associatedData: Uint8Array
): Promise<T> {
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
    throw new Error(`Unsupported capsule envelope version/algorithm: ${envelope.version}/${envelope.algorithm}`);
  }
  const nonce = base64urlToBytes(envelope.nonce);
  const ciphertext = base64urlToBytes(envelope.ciphertext);
  const padded = await aesGcmOpen(key, nonce, ciphertext, associatedData);
  const payloadBytes = unpadFromBucket(padded);
  return JSON.parse(bytesToUtf8(payloadBytes)) as T;
}
