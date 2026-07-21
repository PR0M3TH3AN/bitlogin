/**
 * Fixed plaintext bucket padding (§11.8). Buckets are sized against final
 * encoded event size (~2/3.5/6 KiB events for 1024/2048/4096-byte plaintext
 * buckets) so ciphertext length does not fingerprint capsule contents or
 * growth over time. Padding hides contents and growth only — the public
 * `d` tag already distinguishes credential from recovery capsules.
 */
export const PADDING_BUCKETS = [1024, 2048, 4096] as const;
const LENGTH_PREFIX_BYTES = 4;

export function padToBucket(payload: Uint8Array): Uint8Array {
  const needed = LENGTH_PREFIX_BYTES + payload.length;
  const bucket = PADDING_BUCKETS.find((size) => size >= needed);
  if (bucket === undefined) {
    throw new Error(
      `Payload of ${payload.length} bytes exceeds the largest padding bucket ` +
        `(${PADDING_BUCKETS[PADDING_BUCKETS.length - 1]} bytes minus ${LENGTH_PREFIX_BYTES}-byte length prefix).`
    );
  }
  const out = new Uint8Array(bucket);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length, false);
  out.set(payload, LENGTH_PREFIX_BYTES);
  return out;
}

export function unpadFromBucket(padded: Uint8Array): Uint8Array {
  if (!(PADDING_BUCKETS as readonly number[]).includes(padded.length)) {
    throw new Error(`Padded plaintext length ${padded.length} does not match a known bucket.`);
  }
  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
  const length = view.getUint32(0, false);
  if (length > padded.length - LENGTH_PREFIX_BYTES) {
    throw new Error("Declared payload length exceeds the padded bucket size.");
  }
  const payload = padded.slice(LENGTH_PREFIX_BYTES, LENGTH_PREFIX_BYTES + length);
  const tail = padded.slice(LENGTH_PREFIX_BYTES + length);
  for (const b of tail) {
    if (b !== 0) throw new Error("Padding bytes are not all zero; capsule plaintext is malformed.");
  }
  return payload;
}

/** Estimated final encoded event size for a given plaintext bucket (§11.8), for relay NIP-11 checks. */
export function estimatedEventBytesForBucket(bucket: number): number {
  // AES-GCM adds a 16-byte tag; base64url expands ~4/3; plus JSON envelope + Nostr event overhead.
  const ciphertextBytes = bucket + 16;
  const base64Bytes = Math.ceil((ciphertextBytes * 4) / 3);
  const envelopeOverhead = 128; // version/algorithm/nonce fields + JSON punctuation
  const eventOverhead = 320; // id/pubkey/sig/kind/tags/created_at JSON overhead
  return base64Bytes + envelopeOverhead + eventOverhead;
}
