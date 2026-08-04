/** Passkey sign-in (docs/passkey-login.md) — pure logic.
 *
 * The zero-registration on-ramp: no OAuth client, no console, no server, no
 * stored credential file anywhere. A passkey with the WebAuthn PRF extension
 * deterministically derives this site's BitLogin credential client-side; the
 * platform (Google Password Manager, iCloud Keychain, a hardware key, …)
 * syncs and guards the passkey, and the ordinary password flows do the rest.
 *
 * ── COMPATIBILITY CONTRACT ──────────────────────────────────────────────
 * deriveCredentialFromPrf is one-way and FROZEN: the same PRF output must
 * derive the same login name and password forever, or every passkey account
 * is orphaned. Treat a failure in passkey.test.ts's known-answer pin exactly
 * like a knownAnswer.test.ts failure: the change is account-breaking and
 * needs a migration plan or rejection — never "update the expected value".
 * ────────────────────────────────────────────────────────────────────────
 */
import { hkdfExtract, hkdfExpand, bytesToHex, bytesToBase64url, utf8ToBytes, randomBytes } from "@bitlogin/core/crypto";

/** PRF evaluation input, domain-separated so no other application evaluating
 *  the same passkey's PRF can arrive at BitLogin's secret. Fixed forever. */
export const PASSKEY_PRF_SALT = utf8ToBytes("bitlogin:passkey-credential:v1");

const HKDF_SALT = utf8ToBytes("bitlogin:passkey-derive:v1");
const INFO_LOGIN_NAME = "bitlogin passkey login-name v1";
const INFO_PASSWORD = "bitlogin passkey password v1";

export interface PasskeyCredentialParts {
  loginName: string;
  password: string;
}

/** Copies into a plain ArrayBuffer-backed view: WebAuthn's BufferSource typing
 *  rejects views that could sit on a SharedArrayBuffer. */
function asBufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

/**
 * PRF output (32 bytes from the authenticator) -> login name + password for
 * the standard flows. The login name is recognizably passkey-flavored
 * ("pk-<12 hex>") so support conversations can tell the rails apart; the
 * password carries the full 256 bits.
 */
export function deriveCredentialFromPrf(prfOutput: Uint8Array): PasskeyCredentialParts {
  if (prfOutput.length !== 32) {
    throw new Error(`Passkey PRF output must be 32 bytes, got ${prfOutput.length}.`);
  }
  const prk = hkdfExtract(HKDF_SALT, prfOutput);
  const loginName = `pk-${bytesToHex(hkdfExpand(prk, INFO_LOGIN_NAME, 6))}`;
  const password = bytesToBase64url(hkdfExpand(prk, INFO_PASSWORD, 32));
  return { loginName, password };
}

/** Whether this browser can even attempt passkey sign-in. PRF support cannot
 *  be feature-detected without a ceremony; absence surfaces as a clear error
 *  at that point instead. */
export function passkeySupported(w: { PublicKeyCredential?: unknown } = window): boolean {
  return typeof w.PublicKeyCredential === "function";
}

/** Options for the sign-in ceremony: discoverable credential, user
 *  verification required, PRF evaluated in the same step. */
export function buildPasskeyGetOptions(rpId?: string): CredentialRequestOptions {
  return {
    publicKey: {
      // The challenge protects sign-count/liveness in server-verified
      // WebAuthn; here the PRF OUTPUT is the secret and the "verification"
      // is whether the derived credential opens the capsule. Random anyway.
      challenge: asBufferSource(randomBytes(32)),
      ...(rpId ? { rpId } : {}),
      userVerification: "required",
      extensions: { prf: { eval: { first: PASSKEY_PRF_SALT } } } as AuthenticationExtensionsClientInputs
    }
  };
}

/** Options for creating the passkey. Discoverable + user-verified, so later
 *  sign-ins need no username at all. */
export function buildPasskeyCreateOptions(rpName: string, rpId?: string): CredentialCreationOptions {
  return {
    publicKey: {
      challenge: asBufferSource(randomBytes(32)),
      rp: { name: rpName, ...(rpId ? { id: rpId } : {}) },
      user: {
        // Opaque handle; the account identity is DERIVED from the PRF, not
        // from this. Random so re-creates don't silently overwrite.
        id: asBufferSource(randomBytes(16)),
        name: rpName,
        displayName: rpName
      },
      pubKeyCredParams: [
        { type: "public-key", alg: -7 }, // ES256
        { type: "public-key", alg: -257 } // RS256
      ],
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required"
      },
      extensions: { prf: { eval: { first: PASSKEY_PRF_SALT } } } as AuthenticationExtensionsClientInputs
    }
  };
}

/**
 * Pulls the PRF result out of a completed ceremony. Null when the
 * authenticator or browser doesn't do PRF — the caller shows the honest
 * "this passkey can't be used here yet" message.
 */
export function extractPrfOutput(credential: {
  getClientExtensionResults(): AuthenticationExtensionsClientOutputs;
}): Uint8Array | null {
  const extensions = credential.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer | Uint8Array } };
  };
  const first = extensions.prf?.results?.first;
  if (!first) return null;
  const bytes = first instanceof Uint8Array ? first : new Uint8Array(first);
  return bytes.length === 32 ? bytes : null;
}
