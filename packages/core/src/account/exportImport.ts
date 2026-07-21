/**
 * Encrypted recovery export (§19.5) — the file that lets recovery succeed
 * even if every relay has lost the capsules, given the file plus the phrase.
 * It must never contain the recovery phrase or any phrase-derived key.
 */
import { verifyNostrEvent, type NostrEvent } from "../nostr/event.js";
import { SCHEMA_RECOVERY_EXPORT_V3 } from "../nostr/kinds.js";

export interface RecoveryExportFile {
  schema: typeof SCHEMA_RECOVERY_EXPORT_V3;
  recovery_public_key: string;
  vault_relays: string[];
  recovery_capsule_events: NostrEvent[];
  relay_list_events: NostrEvent[];
  created_at: number;
}

export interface BuildRecoveryExportParams {
  recoveryPublicKeyHex: string;
  vaultRelayUrls: string[];
  /** The latest signed recovery capsule event(s) this device knows about (§19.5). */
  recoveryCapsuleEvents: NostrEvent[];
  /** The user's latest signed kind-10002/10050 (and optionally kind-0) events (§19.6). */
  relayListEvents: NostrEvent[];
  now?: number;
}

export function buildRecoveryExport(params: BuildRecoveryExportParams): RecoveryExportFile {
  return {
    schema: SCHEMA_RECOVERY_EXPORT_V3,
    recovery_public_key: params.recoveryPublicKeyHex,
    vault_relays: params.vaultRelayUrls,
    recovery_capsule_events: params.recoveryCapsuleEvents,
    relay_list_events: params.relayListEvents,
    created_at: params.now ?? Math.floor(Date.now() / 1000)
  };
}

export class RecoveryExportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryExportParseError";
  }
}

export function parseRecoveryExport(json: unknown): RecoveryExportFile {
  if (typeof json !== "object" || json === null) {
    throw new RecoveryExportParseError("Recovery export must be a JSON object.");
  }
  const candidate = json as Partial<RecoveryExportFile>;
  if (candidate.schema !== SCHEMA_RECOVERY_EXPORT_V3) {
    throw new RecoveryExportParseError(`Unsupported recovery export schema: ${String(candidate.schema)}`);
  }
  if (typeof candidate.recovery_public_key !== "string" || !/^[0-9a-f]{64}$/u.test(candidate.recovery_public_key)) {
    throw new RecoveryExportParseError("recovery_public_key must be lowercase 64-char hex.");
  }
  if (!Array.isArray(candidate.vault_relays)) throw new RecoveryExportParseError("vault_relays must be an array.");
  if (!Array.isArray(candidate.recovery_capsule_events) || candidate.recovery_capsule_events.length === 0) {
    throw new RecoveryExportParseError("recovery_capsule_events must be a non-empty array.");
  }
  for (const event of candidate.recovery_capsule_events) {
    if (!verifyNostrEvent(event)) throw new RecoveryExportParseError("An embedded recovery_capsule_event has an invalid id or signature.");
  }
  if (!Array.isArray(candidate.relay_list_events)) throw new RecoveryExportParseError("relay_list_events must be an array.");
  for (const event of candidate.relay_list_events) {
    if (!verifyNostrEvent(event)) throw new RecoveryExportParseError("An embedded relay_list_event has an invalid id or signature.");
  }
  if (typeof candidate.created_at !== "number") throw new RecoveryExportParseError("created_at must be a number.");
  return candidate as RecoveryExportFile;
}
