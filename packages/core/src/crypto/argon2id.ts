/**
 * `bitlogin-argon2id-v1` password derivation profile (§11.2).
 *
 * Memory 64 MiB, 3 iterations, parallelism 1, 32-byte output, version 0x13.
 * This is a BitLogin-specific browser-compatibility profile *inspired by*
 * RFC 9106's second recommended profile (which uses parallelism 4). It is
 * reduced to parallelism 1 because multithreaded Argon2 in browser WASM
 * requires SharedArrayBuffer and cross-origin-isolation headers, which are
 * unreliable across deployment targets, and a single fixed parameter set
 * must derive identically everywhere BitLogin runs. This tradeoff is
 * acceptable because generated high-entropy credentials (§9.2) carry most
 * of the defensive load, not the KDF's work factor alone.
 */
import { argon2id as argon2idHash } from "hash-wasm";

export const BITLOGIN_ARGON2ID_V1 = {
  id: "bitlogin-argon2id-v1",
  memoryKiB: 64 * 1024,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
  version: 0x13
} as const;

export async function deriveArgon2id(password: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  if (salt.length < 8) throw new Error("Argon2id salt must be at least 8 bytes.");
  const hash = await argon2idHash({
    password,
    salt,
    parallelism: BITLOGIN_ARGON2ID_V1.parallelism,
    iterations: BITLOGIN_ARGON2ID_V1.iterations,
    memorySize: BITLOGIN_ARGON2ID_V1.memoryKiB,
    hashLength: BITLOGIN_ARGON2ID_V1.hashLength,
    outputType: "binary"
  });
  return hash instanceof Uint8Array ? hash : new Uint8Array(hash);
}

/** NFKC-normalizes a password string to bytes before Argon2id (§11.4). */
export function normalizePasswordToBytes(password: string): Uint8Array {
  return new TextEncoder().encode(password.normalize("NFKC"));
}
