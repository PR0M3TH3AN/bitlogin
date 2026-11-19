/**
 * The device's own unlock for the optional lock (docs/sign-in-window.md
 * §SW12): a fingerprint, a face, or the device's PIN, through a prompt the
 * browser draws.
 *
 * It is a passkey used as a wrapping key and nothing else. Its PRF output,
 * with a salt of the lock's own, wraps the lock key in the worker
 * (worker/lock.ts). It is NOT a passkey account (passkey.ts): it derives no
 * login name, no password, no capsule, and nothing of it goes to a relay.
 * Losing it costs nothing: the PIN still opens the lock.
 */
import { bytesToBase64url, base64urlToBytes, randomBytes, utf8ToBytes } from "@bitlogin/core/crypto";
import { extractPrfOutput } from "./passkey.js";

/** Not the passkey-account salt: the same passkey, were one ever reused, gives a different secret here. */
export const LOCK_PRF_SALT = utf8ToBytes("bitlogin:lock:v1");

const source = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
const prf = { prf: { eval: { first: source(LOCK_PRF_SALT) } } } as AuthenticationExtensionsClientInputs;

export function lockGetOptions(credentialId: string): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: source(randomBytes(32)),
      // Exactly the passkey the lock was made with, and no other.
      allowCredentials: [{ type: "public-key", id: source(base64urlToBytes(credentialId)) }],
      userVerification: "required",
      extensions: prf
    }
  };
}

export function lockCreateOptions(): CredentialCreationOptions {
  const label = "BitLogin lock (this device)";
  return {
    publicKey: {
      challenge: source(randomBytes(32)),
      rp: { name: "BitLogin" },
      user: { id: source(randomBytes(16)), name: label, displayName: label },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 }
      ],
      // Not offered in the browser's list of accounts: it signs nobody in.
      authenticatorSelection: { residentKey: "discouraged", userVerification: "required" },
      extensions: prf
    }
  };
}

/** Ask the device to unlock. Resolves the PRF output (base64url), or null: cancelled, or a device that can't. */
export async function askLockDevice(credentialId: string): Promise<string | null> {
  try {
    const assertion = (await navigator.credentials.get(lockGetOptions(credentialId))) as PublicKeyCredential | null;
    const out = assertion ? extractPrfOutput(assertion) : null;
    return out ? bytesToBase64url(out) : null;
  } catch {
    return null;
  }
}

/** Make the device's unlock. Resolves what the worker needs to wrap the lock key, or null. */
export async function createLockDevice(): Promise<{ credentialId: string; prfOutput: string } | null> {
  try {
    const made = (await navigator.credentials.create(lockCreateOptions())) as PublicKeyCredential | null;
    if (!made) return null;
    const credentialId = bytesToBase64url(new Uint8Array(made.rawId));
    const out = extractPrfOutput(made);
    // Some authenticators give the PRF result only when asked again.
    const prfOutput = out ? bytesToBase64url(out) : await askLockDevice(credentialId);
    return prfOutput ? { credentialId, prfOutput } : null;
  } catch {
    return null;
  }
}
