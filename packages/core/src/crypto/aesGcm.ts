/** AES-256-GCM authenticated encryption via native WebCrypto (§11.1, §11.7). */
import { randomNonce96 } from "./random.js";

function webcrypto(): Crypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error("WebCrypto SubtleCrypto is not available in this environment.");
  return c;
}

async function importKey(key: Uint8Array): Promise<CryptoKey> {
  if (key.length !== 32) throw new Error("AES-256-GCM key must be exactly 32 bytes.");
  return webcrypto().subtle.importKey("raw", key as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export interface AesGcmSealed {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** Encrypts with a fresh random 96-bit nonce. A nonce must never be reused with the same key. */
export async function aesGcmSeal(
  key: Uint8Array,
  plaintext: Uint8Array,
  associatedData: Uint8Array
): Promise<AesGcmSealed> {
  const nonce = randomNonce96();
  const cryptoKey = await importKey(key);
  const sealed = await webcrypto().subtle.encrypt(
    { name: "AES-GCM", iv: nonce as BufferSource, additionalData: associatedData as BufferSource, tagLength: 128 },
    cryptoKey,
    plaintext as BufferSource
  );
  return { nonce, ciphertext: new Uint8Array(sealed) };
}

export async function aesGcmOpen(
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  associatedData: Uint8Array
): Promise<Uint8Array> {
  const cryptoKey = await importKey(key);
  try {
    const plaintext = await webcrypto().subtle.decrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, additionalData: associatedData as BufferSource, tagLength: 128 },
      cryptoKey,
      ciphertext as BufferSource
    );
    return new Uint8Array(plaintext);
  } catch {
    throw new Error("AES-256-GCM authentication failed: capsule is corrupted, tampered, or the wrong key was used.");
  }
}
