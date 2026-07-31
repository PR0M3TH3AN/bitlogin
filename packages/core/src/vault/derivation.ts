/**
 * Connection Vault key hierarchy (connection-vault.md §6, finalized).
 *
 * Everything derives from the two 32-byte roots carried by the capsules:
 *
 *   vault_prk           = HKDF-Extract(SHA256("bitlogin/connection-vault-root/v1"), root)
 *   vault signing key   = ScalarExpand(vault_prk, "bitlogin/connection-vault-signing/v1")
 *   record_key(id)      = HKDF-Expand(vault_prk,
 *                           "bitlogin/connection-record-encryption/v1" || 0x00 || id_bytes, 32)
 *
 * Personal-tier records (stored passwords, secure notes) additionally require
 * the sudo key as IKM — decrypting them without a fresh capsule unlock is
 * impossible by construction, which is what makes sudo mode real (§SF2):
 *
 *   personal_prk        = HKDF-Extract(SHA256("bitlogin/connection-vault-personal/v1"),
 *                           root || sudo_key)
 *   personal record key = HKDF-Expand(personal_prk, same info layout, 32)
 *
 * The same raw material is never used for both signing and content
 * encryption: signing comes only from ScalarExpand on vault_prk, content keys
 * only from HKDF-Expand with the record-encryption info label.
 */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { hkdfExtract, hkdfExpand, labelSalt } from "../crypto/hkdf.js";
import { scalarExpand } from "../crypto/scalarExpand.js";
import { base64urlToBytes, bytesToBase64url, concatBytes, utf8ToBytes } from "../crypto/encoding.js";
import { randomBytes } from "../crypto/random.js";
import { wipe } from "../crypto/memory.js";

export const VAULT_ROOT_LABEL = "bitlogin/connection-vault-root/v1";
export const VAULT_SIGNING_INFO = "bitlogin/connection-vault-signing/v1";
export const VAULT_RECORD_KEY_INFO = "bitlogin/connection-record-encryption/v1";
export const VAULT_PERSONAL_LABEL = "bitlogin/connection-vault-personal/v1";
export const VAULT_MIGRATION_LABEL = "bitlogin/connection-vault-migration/v1";
export const VAULT_MIGRATION_ROOT_INFO = "bitlogin/connection-vault-migration-root/v1";
export const VAULT_MIGRATION_SUDO_INFO = "bitlogin/connection-vault-migration-sudo/v1";

/** `d` tag prefix (§CV8.1): generic on purpose — it must not reveal the credential type. */
export const D_TAG_CONNECTION_PREFIX = "bitlogin:connection:";

export function deriveVaultPrk(connectionVaultRoot: Uint8Array): Uint8Array {
  if (connectionVaultRoot.length !== 32) {
    throw new Error("connection_vault_root must be exactly 32 bytes.");
  }
  return hkdfExtract(labelSalt(VAULT_ROOT_LABEL), connectionVaultRoot);
}

/** The derived Nostr identity that signs every connection record (§CV8.1) —
 *  deliberately NOT the everyday identity, so a public profile never betrays
 *  the existence or timing of stored credentials. */
export function deriveVaultSigningKey(vaultPrk: Uint8Array): Uint8Array {
  return scalarExpand(vaultPrk, VAULT_SIGNING_INFO).scalar;
}

export function deriveVaultPublicKey(vaultPrk: Uint8Array): string {
  const signingKey = deriveVaultSigningKey(vaultPrk);
  try {
    return getPublicKeyHex(signingKey);
  } finally {
    wipe(signingKey);
  }
}

export function derivePersonalPrk(connectionVaultRoot: Uint8Array, vaultSudoKey: Uint8Array): Uint8Array {
  if (vaultSudoKey.length !== 32) throw new Error("vault_sudo_key must be exactly 32 bytes.");
  if (connectionVaultRoot.length !== 32) throw new Error("connection_vault_root must be exactly 32 bytes.");
  return hkdfExtract(labelSalt(VAULT_PERSONAL_LABEL), concatBytes(connectionVaultRoot, vaultSudoKey));
}

/**
 * Deterministic material for the one-time migration of a pre-vault account.
 *
 * Two devices can run the phrase-gated migration concurrently. Random roots
 * would let both devices publish internally valid but mutually incompatible
 * capsules. The recovery capsule key and account id are stable, secret inputs,
 * so both devices instead derive the same roots. This is intentionally scoped
 * to legacy migration; new registrations continue to mint random roots.
 */
export function deriveLegacyVaultMaterial(
  recoveryCapsuleKey: Uint8Array,
  accountId: string
): { connectionVaultRoot: Uint8Array; vaultSudoKey: Uint8Array } {
  if (recoveryCapsuleKey.length !== 32) throw new Error("recovery capsule key must be exactly 32 bytes.");
  const accountIdBytes = base64urlToBytes(accountId);
  if (accountIdBytes.length !== 16) throw new Error("account_id must decode to exactly 16 bytes.");
  const migrationPrk = hkdfExtract(
    labelSalt(VAULT_MIGRATION_LABEL),
    concatBytes(recoveryCapsuleKey, accountIdBytes)
  );
  try {
    return {
      connectionVaultRoot: hkdfExpand(migrationPrk, VAULT_MIGRATION_ROOT_INFO, 32),
      vaultSudoKey: hkdfExpand(migrationPrk, VAULT_MIGRATION_SUDO_INFO, 32)
    };
  } finally {
    wipe(migrationPrk, accountIdBytes);
  }
}

/** Per-record encryption key (§CV6): the info string, a 0x00 separator, then
 *  the RAW 16 identifier bytes — spec-fixed layout, see the vectors test. */
export function deriveRecordKey(prk: Uint8Array, connectionId: string): Uint8Array {
  const idBytes = decodeConnectionId(connectionId);
  return hkdfExpand(prk, concatBytes(utf8ToBytes(VAULT_RECORD_KEY_INFO), new Uint8Array([0x00]), idBytes), 32);
}

/** Random 128-bit connection identifier (§CV7): opaque, never derived from
 *  anything meaningful, stable for the record's lifetime. */
export function newConnectionId(): string {
  return bytesToBase64url(randomBytes(16));
}

export function decodeConnectionId(connectionId: string): Uint8Array {
  const bytes = base64urlToBytes(connectionId);
  if (bytes.length !== 16) throw new Error("connection_id must decode to exactly 16 bytes (§CV7).");
  return bytes;
}

export function connectionDTag(connectionId: string): string {
  decodeConnectionId(connectionId); // shape check before it becomes an address
  return `${D_TAG_CONNECTION_PREFIX}${connectionId}`;
}

export function connectionIdFromDTag(dTag: string): string | null {
  if (!dTag.startsWith(D_TAG_CONNECTION_PREFIX)) return null;
  const id = dTag.slice(D_TAG_CONNECTION_PREFIX.length);
  try {
    decodeConnectionId(id);
    return id;
  } catch {
    return null;
  }
}
