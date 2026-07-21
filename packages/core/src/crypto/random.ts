/** Cryptographically secure randomness (§11.1, §11.6). */

function webcrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || typeof c.getRandomValues !== "function") {
    throw new Error("No cryptographically secure random source available in this environment.");
  }
  return c;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  webcrypto().getRandomValues(out);
  return out;
}

/** 128 bits of entropy for a 12-word BIP-39 mnemonic (§10.1). */
export function randomEntropy128(): Uint8Array {
  return randomBytes(16);
}

/** Fresh 96-bit AES-GCM nonce (§11.7). Never reuse with the same key. */
export function randomNonce96(): Uint8Array {
  return randomBytes(12);
}

/** 128-bit random account id (§12.1, §12.3). */
export function randomAccountId(): Uint8Array {
  return randomBytes(16);
}

/**
 * Uniform random integer in [0, maxExclusive) via rejection sampling, avoiding
 * modulo bias for wordlist and charset selection (§9.2).
 */
export function randomUniformInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 0x100000000) {
    throw new Error("randomUniformInt: maxExclusive must be an integer in (0, 2^32].");
  }
  const bytesNeeded = maxExclusive <= 0x100 ? 1 : maxExclusive <= 0x10000 ? 2 : 4;
  const range = 256 ** bytesNeeded;
  const limit = range - (range % maxExclusive);
  for (;;) {
    const buf = randomBytes(bytesNeeded);
    let value = 0;
    for (const b of buf) value = value * 256 + b;
    if (value < limit) return value % maxExclusive;
  }
}
