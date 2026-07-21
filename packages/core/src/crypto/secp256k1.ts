/** secp256k1 Schnorr signing per BIP-340 / NIP-01 (§11.1, §11.6). */
import { schnorr, secp256k1 } from "@noble/curves/secp256k1";
import { randomBytes } from "./random.js";
import { bytesToHex } from "./encoding.js";

const CURVE_ORDER = secp256k1.CURVE.n;

export function isValidScalar(scalar: Uint8Array): boolean {
  if (scalar.length !== 32) return false;
  let value = 0n;
  for (const b of scalar) value = (value << 8n) | BigInt(b);
  return value >= 1n && value < CURVE_ORDER;
}

/** Generates 32 random bytes, rejecting and retrying if not a valid scalar (§11.6). */
export function generatePrivateKey(): Uint8Array {
  for (;;) {
    const candidate = randomBytes(32);
    if (isValidScalar(candidate)) return candidate;
  }
}

/** 32-byte x-only public key (BIP-340) in raw bytes. */
export function getPublicKey(privateKey: Uint8Array): Uint8Array {
  return schnorr.getPublicKey(privateKey);
}

export function getPublicKeyHex(privateKey: Uint8Array): string {
  return bytesToHex(getPublicKey(privateKey));
}

export function sign(messageHash32: Uint8Array, privateKey: Uint8Array): Uint8Array {
  return schnorr.sign(messageHash32, privateKey);
}

export function verify(signature: Uint8Array, messageHash32: Uint8Array, publicKey: Uint8Array): boolean {
  try {
    return schnorr.verify(signature, messageHash32, publicKey);
  } catch {
    return false;
  }
}
