/**
 * Test-only entry points that accept caller-supplied nonces and IVs (§11.1).
 *
 * NOT EXPORTED FROM THE PACKAGE. This module is deliberately absent from
 * ./index.js and from the `exports` map in package.json, so it is unreachable
 * as `@bitlogin/core/crypto/testing.js` — Node's exports field blocks the deep
 * import, and the explicit re-export list in ./index.ts blocks the shallow one.
 * Reach it only by relative path from inside this package's own tests.
 *
 * WHY THIS FILE EXISTS RATHER THAN AN OPTIONAL PARAMETER: `nip44Encrypt` and
 * `nip04Encrypt` used to take `nonceOverride` / `ivOverride`. No production
 * caller ever passed one, but the parameters were on the public surface, which
 * meant "encrypt with a nonce I picked" was a discoverable feature of the
 * package. NIP-44 is ChaCha20 — a nonce repeated under one conversation key
 * recovers plaintext outright, not gradually. NIP-04 is AES-CBC, where a
 * repeated IV leaks block-equality between messages. Neither failure degrades
 * gracefully, so the capability lives here, behind a name no one types by
 * accident, instead of in an argument list.
 */
import { encryptWithNonce } from "./nip44.js";
import { encryptWithIv } from "./nip04.js";

/**
 * @internal Encrypts with a caller-supplied 32-byte nonce.
 * UNSAFE: reusing a nonce under one conversation key breaks confidentiality.
 * For test vectors and validation tests only.
 */
export function __unsafeNip44EncryptWithNonce(
  conversationKey: Uint8Array,
  plaintext: string,
  nonce: Uint8Array,
): string {
  return encryptWithNonce(conversationKey, plaintext, nonce);
}

/**
 * @internal Encrypts with a caller-supplied 16-byte IV.
 * UNSAFE: a predictable or repeated IV under one shared secret leaks structure.
 * For test vectors and validation tests only.
 */
export function __unsafeNip04EncryptWithIv(
  privateKey: Uint8Array,
  peerPublicKeyHex: string,
  plaintext: string,
  iv: Uint8Array,
): string {
  return encryptWithIv(privateKey, peerPublicKeyHex, plaintext, iv);
}
