/**
 * ScalarExpand — deterministic HKDF-Expand-based rejection sampling onto a
 * valid secp256k1 private scalar (§11.4). Exact byte layout is spec-fixed so
 * independent implementations agree, including the rare forced-retry case.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { hkdfExpand } from "./hkdf.js";
import { concatBytes, utf8ToBytes } from "./encoding.js";

const CURVE_ORDER = secp256k1.CURVE.n;

function bytesToBigIntBE(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  return value;
}

export function bigIntToBytes32(value: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = value;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

export interface ScalarExpandResult {
  scalar: Uint8Array;
  /** Number of HKDF-Expand attempts consumed (1 in the overwhelmingly common case). */
  counter: number;
}

/**
 * ScalarExpand(prk, info):
 *   for counter in 0x00..0xFF:
 *     candidate = HKDF-Expand(prk, info || 0x00 || counter, 32)
 *     d = candidate interpreted big-endian
 *     if 1 <= d < n: return d
 *   fail
 */
export function scalarExpand(prk: Uint8Array, info: string): ScalarExpandResult {
  const infoBytes = utf8ToBytes(info);
  for (let counter = 0; counter <= 0xff; counter++) {
    const infoWithCounter = concatBytes(infoBytes, new Uint8Array([0x00, counter]));
    const candidate = hkdfExpand(prk, infoWithCounter, 32);
    const d = bytesToBigIntBE(candidate);
    if (d >= 1n && d < CURVE_ORDER) {
      return { scalar: bigIntToBytes32(d), counter };
    }
  }
  throw new Error("ScalarExpand: exhausted 256 counters without a valid scalar (should not happen in practice).");
}
