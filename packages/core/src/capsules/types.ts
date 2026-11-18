/** Capsule payload schemas (§12). Earlier draft identifiers (bitlogin.account.v1/v2, bitlogin.recovery.v2) are void and never accepted. */
import type { NostrEvent } from "../nostr/event.js";
import { SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import { BITLOGIN_ARGON2ID_V1 } from "../crypto/argon2id.js";

export const PROTOCOL_PASSWORD_KDF = BITLOGIN_ARGON2ID_V1.id;
export const PROTOCOL_CAPSULE_ENCRYPTION = "aes-256-gcm-v1";
export const PROTOCOL_RECOVERY_DERIVATION = "bitlogin-bip39-hkdf-v1";
/**
 * Marks a capsule whose everyday key is the one §11.6 derives from the
 * recovery phrase. Absent for imported, rotated, and pre-v0.7 keys, which the
 * phrase cannot rebuild. A hint only (§12.1): code holding the phrase compares
 * keys instead of trusting it.
 */
export const PROTOCOL_EVERYDAY_DERIVATION = "bitlogin-recovery-hkdf-v1";

/** The `protocol` entry to spread into a payload for a derived everyday key. */
export function everydayDerivationField(derived: boolean): {
  everyday_derivation?: string;
} {
  return derived ? { everyday_derivation: PROTOCOL_EVERYDAY_DERIVATION } : {};
}

export function isEverydayKeyDerived(payload: {
  protocol?: { everyday_derivation?: unknown };
}): boolean {
  return payload.protocol?.everyday_derivation === PROTOCOL_EVERYDAY_DERIVATION;
}

export interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string; // base64url
  ciphertext: string; // base64url
}

/**
 * Connection Vault key material (connection-vault.md §5.2). Two independent
 * 32-byte random roots, base64url:
 *
 * - `connection_vault_root` locates, signs, and encrypts connectable-tier
 *   connection records (NWC, scoped S3). Cacheable for the session, so daily
 *   wallet use never re-prompts.
 * - `vault_sudo_key` is REQUIRED additional key material for personal-tier
 *   records (stored passwords, secure notes). The honest-client contract: it
 *   is stored only in the phrase-gated recovery capsule and held in memory
 *   only for the duration of a sudo window. It is intentionally absent from
 *   newly-written password credential capsules, so a password/offline
 *   credential-capsule compromise does not unlock personal-tier records.
 *
 * Recovery capsules carry both fields together. Credential capsules carry
 * only `connection_vault_root`; `vault_sudo_key` remains optional here solely
 * so pre-hardening credential capsules can be read and scrubbed on rotation.
 */
export interface VaultCapsuleFields {
  connection_vault_root?: string; // base64url, 32 bytes
  vault_sudo_key?: string; // base64url, 32 bytes
}

/** §12.1 — the credential capsule: infrequently changed access material only. */
export interface CredentialPayload extends VaultCapsuleFields {
  schema: typeof SCHEMA_CREDENTIAL_V1;
  account_id: string; // base64url, 128-bit random
  generation: number;
  operational_private_key: string; // base64url, 32 bytes
  operational_public_key: string; // lowercase hex
  recovery_public_key: string; // lowercase hex
  recovery_capsule_event: NostrEvent;
  created_at: number;
  vault_relay_hints: string[];
  protocol: {
    password_kdf: string;
    capsule_encryption: string;
    recovery_derivation: string;
    everyday_derivation?: string;
  };
}

/** §12.3 — the recovery capsule: minimal and immutable outside the write moments of §14.1. */
export interface RecoveryPayload extends VaultCapsuleFields {
  schema: typeof SCHEMA_RECOVERY_V1;
  account_id: string;
  recovery_generation: number;
  previous_recovery_event_id: string | null;
  operational_private_key: string;
  operational_public_key: string;
  recovery_public_key: string;
  created_at: number;
  vault_relay_hints: string[];
  protocol: {
    capsule_encryption: string;
    recovery_derivation: string;
    everyday_derivation?: string;
  };
}
