/** Capsule payload schemas (§12). Earlier draft identifiers (bitlogin.account.v1/v2, bitlogin.recovery.v2) are void and never accepted. */
import type { NostrEvent } from "../nostr/event.js";
import { SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import { BITLOGIN_ARGON2ID_V1 } from "../crypto/argon2id.js";

export const PROTOCOL_PASSWORD_KDF = BITLOGIN_ARGON2ID_V1.id;
export const PROTOCOL_CAPSULE_ENCRYPTION = "aes-256-gcm-v1";
export const PROTOCOL_RECOVERY_DERIVATION = "bitlogin-bip39-hkdf-v1";

export interface EncryptedEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  nonce: string; // base64url
  ciphertext: string; // base64url
}

/** §12.1 — the credential capsule: infrequently changed access material only. */
export interface CredentialPayload {
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
  };
}

/** §12.3 — the recovery capsule: minimal and immutable outside the write moments of §14.1. */
export interface RecoveryPayload {
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
  };
}
