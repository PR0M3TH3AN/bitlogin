/** Login name normalization (§8.2) and password-derived key hierarchy (§7.3, §11.3, §11.4). */
import { sha256 } from "@noble/hashes/sha2";
import { hkdfExtract, hkdfExpand, labelSalt } from "../crypto/hkdf.js";
import { scalarExpand } from "../crypto/scalarExpand.js";
import { deriveArgon2id, normalizePasswordToBytes } from "../crypto/argon2id.js";
import { concatBytes, utf8ToBytes } from "../crypto/encoding.js";

export class LoginNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoginNameError";
  }
}

const LOGIN_NAME_MIN = 3;
const LOGIN_NAME_MAX = 32;
const ASCII_ONLY = /^[\x00-\x7F]*$/u;
const ALLOWED_CHARS = /^[a-z0-9._-]+$/u;
const CONSECUTIVE_PUNCTUATION = /[._-]{2,}/u;
const ALNUM = /[a-z0-9]/u;

/** Login name is a derivation input and usability aid only; it contributes no security (§4.4, §8.1, §11.3). */
export function normalizeLoginName(raw: string): string {
  const normalized = raw.trim().toLowerCase();
  if (!ASCII_ONLY.test(normalized)) throw new LoginNameError("Login name must contain ASCII characters only.");
  if (normalized.length < LOGIN_NAME_MIN || normalized.length > LOGIN_NAME_MAX) {
    throw new LoginNameError(`Login name must be between ${LOGIN_NAME_MIN} and ${LOGIN_NAME_MAX} characters.`);
  }
  if (!ALLOWED_CHARS.test(normalized)) {
    throw new LoginNameError("Login name may only contain a-z, 0-9, '.', '_', and '-'.");
  }
  const first = normalized[0]!;
  const last = normalized[normalized.length - 1]!;
  if (!ALNUM.test(first) || !ALNUM.test(last)) {
    throw new LoginNameError("Login name must not begin or end with punctuation.");
  }
  if (CONSECUTIVE_PUNCTUATION.test(normalized)) {
    throw new LoginNameError("Login name must not contain consecutive punctuation.");
  }
  return normalized;
}

export function isValidLoginName(raw: string): boolean {
  try {
    normalizeLoginName(raw);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic Argon2id salt (§11.3): SHA256("bitlogin/password-salt/v1" || 0x00 || login_name), first 16 bytes.
 * Honesty requirement: users sharing a login name share this salt. All credential
 * entropy comes from the password, not the login name.
 */
export function derivePasswordSalt(normalizedLoginName: string): Uint8Array {
  const digest = sha256(
    concatBytes(utf8ToBytes("bitlogin/password-salt/v1"), new Uint8Array([0x00]), utf8ToBytes(normalizedLoginName))
  );
  return digest.slice(0, 16);
}

export interface PasswordDerivedKeys {
  /** ScalarExpand output for the locator identity's private key. */
  locatorPrivateKey: Uint8Array;
  /** AES-256-GCM key for the credential capsule. */
  capsuleKey: Uint8Array;
}

/**
 * Full password derivation chain (§11.4):
 *   password_root = Argon2id(NFKC(password), salt, bitlogin-argon2id-v1)
 *   password_prk  = HKDF-Extract(salt=SHA256("bitlogin/password-root/v1"), IKM=password_root)
 *   locator_material = ScalarExpand(password_prk, "bitlogin/password-locator-signing/v1")
 *   password_capsule_key = HKDF-Expand(password_prk, "bitlogin/password-capsule-encryption/v1", 32)
 */
export async function derivePasswordKeys(password: string, normalizedLoginName: string): Promise<PasswordDerivedKeys> {
  const salt = derivePasswordSalt(normalizedLoginName);
  const passwordBytes = normalizePasswordToBytes(password);
  const passwordRoot = await deriveArgon2id(passwordBytes, salt);
  const passwordPrk = hkdfExtract(labelSalt("bitlogin/password-root/v1"), passwordRoot);
  const locator = scalarExpand(passwordPrk, "bitlogin/password-locator-signing/v1");
  const capsuleKey = hkdfExpand(passwordPrk, "bitlogin/password-capsule-encryption/v1", 32);
  return { locatorPrivateKey: locator.scalar, capsuleKey };
}

export interface RecoveryDerivedKeys {
  recoveryPrivateKey: Uint8Array;
  capsuleKey: Uint8Array;
}

/**
 * Recovery root derivation (§11.5):
 *   recovery_prk = HKDF-Extract(salt=SHA256("bitlogin/recovery-root/v1"), IKM=bip39_seed)
 *   recovery_signing_material = ScalarExpand(recovery_prk, "bitlogin/recovery-signing/v1")
 *   recovery_capsule_key = HKDF-Expand(recovery_prk, "bitlogin/recovery-capsule-encryption/v1", 32)
 */
export function deriveRecoveryKeys(bip39Seed: Uint8Array): RecoveryDerivedKeys {
  const recoveryPrk = hkdfExtract(labelSalt("bitlogin/recovery-root/v1"), bip39Seed);
  const signing = scalarExpand(recoveryPrk, "bitlogin/recovery-signing/v1");
  const capsuleKey = hkdfExpand(recoveryPrk, "bitlogin/recovery-capsule-encryption/v1", 32);
  return { recoveryPrivateKey: signing.scalar, capsuleKey };
}
