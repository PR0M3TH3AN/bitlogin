/** Required post-decryption validation (§12.4). Failure of any check aborts login. */
import { isValidScalar, getPublicKeyHex } from "../crypto/secp256k1.js";
import { base64urlToBytes } from "../crypto/encoding.js";
import { verifyNostrEvent } from "../nostr/event.js";
import { SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import type { CredentialPayload, RecoveryPayload } from "./types.js";

export class CapsuleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsuleValidationError";
  }
}

const ALLOWED_RELAY_SCHEMES = new Set(["wss:", "ws:"]);
const MAX_GENERATION = 1_000_000;
const HEX64 = /^[0-9a-f]{64}$/u;

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new CapsuleValidationError(message);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && HEX64.test(value);
}

export function validateRelayUrls(urls: unknown): void {
  assert(Array.isArray(urls), "vault_relay_hints must be an array (§12.4.7).");
  for (const url of urls) {
    assert(typeof url === "string", "Each relay hint must be a string (§12.4.7).");
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CapsuleValidationError(`Invalid relay URL: ${String(url)} (§12.4.7)`);
    }
    assert(ALLOWED_RELAY_SCHEMES.has(parsed.protocol), `Relay URL uses a disallowed scheme: ${url} (§12.4.7)`);
  }
}

export function validateAccountId(accountId: unknown): void {
  assert(typeof accountId === "string", "account_id must be a string (§12.4.2).");
  let bytes: Uint8Array;
  try {
    bytes = base64urlToBytes(accountId);
  } catch {
    throw new CapsuleValidationError("account_id is not valid base64url (§12.4.2).");
  }
  assert(bytes.length === 16, "account_id must decode to exactly 128 bits (§12.4.2).");
}

export function validateOperationalKeyPair(privateKeyB64: unknown, publicKeyHex: unknown): void {
  assert(typeof privateKeyB64 === "string", "operational_private_key must be a string (§12.4.3).");
  const priv = base64urlToBytes(privateKeyB64);
  assert(priv.length === 32, "operational_private_key must be exactly 32 bytes (§12.4.3).");
  assert(isValidScalar(priv), "operational_private_key is not a valid secp256k1 scalar (§12.4.3).");
  assert(isHex64(publicKeyHex), "operational_public_key must be lowercase 64-char hex (§12.4.4).");
  const derived = getPublicKeyHex(priv);
  assert(derived === publicKeyHex, "operational_public_key does not match the derived public key (§12.4.4).");
}

/**
 * Connection Vault fields (connection-vault.md §5.2): optional, but they
 * appear together or not at all — a capsule carrying only one of the two
 * roots is a corrupt or tampered migration and must not grant a session, or
 * personal-tier records would silently become unrecoverable.
 */
export function validateVaultFields(payload: {
  connection_vault_root?: unknown;
  vault_sudo_key?: unknown;
}): void {
  const root = payload.connection_vault_root;
  const sudo = payload.vault_sudo_key;
  if (root === undefined && sudo === undefined) return;
  assert(root !== undefined && sudo !== undefined, "connection_vault_root and vault_sudo_key must appear together (§CV5.2).");
  for (const [field, value] of [
    ["connection_vault_root", root],
    ["vault_sudo_key", sudo]
  ] as const) {
    assert(typeof value === "string", `${field} must be a string (§CV5.2).`);
    let bytes: Uint8Array;
    try {
      bytes = base64urlToBytes(value);
    } catch {
      throw new CapsuleValidationError(`${field} is not valid base64url (§CV5.2).`);
    }
    assert(bytes.length === 32, `${field} must decode to exactly 32 bytes (§CV5.2).`);
  }
}

function assertGenerationInBounds(value: unknown, field: string): void {
  assert(
    Number.isInteger(value) && (value as number) >= 0 && (value as number) <= MAX_GENERATION,
    `${field} is out of supported bounds (§12.4.8).`
  );
}

/** §12.4 checks 1-7 for the credential capsule, plus 5-6 (embedded recovery event). */
export function validateCredentialPayload(payload: CredentialPayload): void {
  assert(
    (payload as { schema?: unknown }).schema === SCHEMA_CREDENTIAL_V1,
    `Unsupported or unknown schema: ${String((payload as { schema?: unknown }).schema)} (§12.4.1)`
  );
  validateAccountId(payload.account_id);
  assertGenerationInBounds(payload.generation, "generation");
  validateOperationalKeyPair(payload.operational_private_key, payload.operational_public_key);
  assert(isHex64(payload.recovery_public_key), "recovery_public_key must be lowercase 64-char hex (§12.4.5).");
  validateRelayUrls(payload.vault_relay_hints);
  validateVaultFields(payload);

  const embedded = payload.recovery_capsule_event;
  assert(!!embedded && typeof embedded === "object", "recovery_capsule_event must be present (§12.4.6).");
  assert(verifyNostrEvent(embedded), "Embedded recovery_capsule_event has an invalid event id or signature (§12.4.6).");
  assert(
    embedded.pubkey === payload.recovery_public_key,
    "Embedded recovery_capsule_event author does not match recovery_public_key (§12.4.5)."
  );
}

/** §12.4 checks 1-4, 7-8 for the recovery capsule (chain consistency, check 9, is verified across candidates by the caller). */
export function validateRecoveryPayload(payload: RecoveryPayload): void {
  assert(
    (payload as { schema?: unknown }).schema === SCHEMA_RECOVERY_V1,
    `Unsupported or unknown schema: ${String((payload as { schema?: unknown }).schema)} (§12.4.1)`
  );
  validateAccountId(payload.account_id);
  assertGenerationInBounds(payload.recovery_generation, "recovery_generation");
  assert(
    payload.previous_recovery_event_id === null || isHex64(payload.previous_recovery_event_id),
    "previous_recovery_event_id must be null or lowercase 64-char hex (§12.3)."
  );
  validateOperationalKeyPair(payload.operational_private_key, payload.operational_public_key);
  assert(isHex64(payload.recovery_public_key), "recovery_public_key must be lowercase 64-char hex.");
  validateRelayUrls(payload.vault_relay_hints);
  validateVaultFields(payload);
}

/** §12.4.9 — detects a broken previous_recovery_event_id hash chain when multiple generations are visible. */
export function checkRecoveryChainConsistency(
  generations: Array<{ eventId: string; recoveryGeneration: number; previousRecoveryEventId: string | null }>
): { consistent: boolean; warning?: string } {
  const byGeneration = new Map(generations.map((g) => [g.recoveryGeneration, g]));
  const sorted = [...generations].sort((a, b) => a.recoveryGeneration - b.recoveryGeneration);
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!;
    const prior = byGeneration.get(current.recoveryGeneration - 1);
    if (current.previousRecoveryEventId === null) {
      return { consistent: false, warning: `Generation ${current.recoveryGeneration} has a null previous-event link but is not the first generation.` };
    }
    if (prior && current.previousRecoveryEventId !== prior.eventId) {
      return {
        consistent: false,
        warning: `Recovery generation chain is broken between generation ${prior.recoveryGeneration} and ${current.recoveryGeneration}: possible replay or relay misbehavior.`
      };
    }
  }
  return { consistent: true };
}
