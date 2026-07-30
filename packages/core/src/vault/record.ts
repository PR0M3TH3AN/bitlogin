/**
 * Connection record events (connection-vault.md §8, §9, §11).
 *
 * Each connection is one NIP-78 addressable event signed by the DERIVED
 * vault identity, its content an encrypted envelope built with the same
 * JCS + fixed-bucket padding + AES-256-GCM pipeline as the capsules. The
 * padding buckets are the capsule buckets (1024/2048/4096) — resolved open
 * decision §CV16.2: every profile fixture fits 1024 with room, and a shared
 * bucket set means an NWC record and an S3 record are indistinguishable by
 * size on a relay.
 *
 * Tier is invisible from the outside: the two tiers use different keys but
 * identical envelopes, d-tag shapes, and buckets, so decryption is
 * trial-based (connectable key first, then personal when a sudo window is
 * open). Two AES attempts are microseconds; a distinguishable ciphertext
 * would leak which records are "the sensitive ones" to every relay.
 */
import { signNostrEvent, verifyNostrEvent, findTagValue, type NostrEvent } from "../nostr/event.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { utf8ToBytes } from "../crypto/encoding.js";
import { encryptEnvelope, decryptEnvelope } from "../capsules/serialization.js";
import type { EncryptedEnvelope } from "../capsules/types.js";
import { nextCreatedAt } from "../account/timestamp.js";
import {
  connectionDTag,
  connectionIdFromDTag,
  deriveRecordKey,
  deriveVaultSigningKey
} from "./derivation.js";
import { SCHEMA_CONNECTION_V1, type ConnectionRecord, type ConnectionTier } from "./types.js";

const MAX_LABEL_LENGTH = 120;
const STATES = new Set(["active", "suspended", "deleted"]);
const TIERS = new Set(["connectable", "personal"]);

export class ConnectionRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionRecordError";
  }
}

/** §CV8.2 associated data — binds the ciphertext to its address. */
export function connectionRecordAad(vaultPubkeyHex: string, dTag: string): Uint8Array {
  return utf8ToBytes(`bitlogin|connection-record|v1|${vaultPubkeyHex}|30078|${dTag}`);
}

export function validateConnectionRecord(record: unknown): asserts record is ConnectionRecord {
  const r = record as Partial<ConnectionRecord> | null;
  const fail = (message: string) => {
    throw new ConnectionRecordError(message);
  };
  if (!r || typeof r !== "object") fail("Connection record must be an object.");
  if (r!.schema !== SCHEMA_CONNECTION_V1) fail(`Unsupported connection record schema (§CV8.3).`);
  if (typeof r!.connection_id !== "string") fail("connection_id must be a string (§CV7).");
  if (typeof r!.connection_type !== "string" || r!.connection_type.length === 0) {
    fail("connection_type must be a non-empty string (§CV8.3).");
  }
  if (!TIERS.has(r!.tier as string)) fail("tier must be connectable or personal.");
  if (!STATES.has(r!.state as string)) fail("state must be active, suspended, or deleted (§CV8.3).");
  if (typeof r!.label !== "string" || r!.label.length > MAX_LABEL_LENGTH) {
    fail(`label must be a string of at most ${MAX_LABEL_LENGTH} characters.`);
  }
  if (!Number.isInteger(r!.created_at) || !Number.isInteger(r!.updated_at)) {
    fail("created_at and updated_at must be integers (§CV8.3).");
  }
  const credential = r!.credential as { schema?: unknown } | undefined;
  if (!credential || typeof credential !== "object" || typeof credential.schema !== "string") {
    fail("credential must be an object naming its profile schema (§CV8.3).");
  }
  const binding = r!.application_binding as { origin?: unknown; app_pubkey?: unknown } | undefined;
  if (
    !binding ||
    typeof binding !== "object" ||
    (binding.origin !== null && typeof binding.origin !== "string") ||
    (binding.app_pubkey !== null && typeof binding.app_pubkey !== "string")
  ) {
    fail("application_binding must carry origin and app_pubkey (string or null).");
  }
  if (r!.notes !== null && typeof r!.notes !== "string") fail("notes must be a string or null.");
}

/**
 * Encrypts and signs one record as its addressable event. `previousCreatedAt`
 * feeds the monotonic replacement rule (§CV9) — pass the replaced event's
 * created_at on every update or a same-second edit will silently lose.
 */
export async function buildConnectionRecordEvent(params: {
  vaultPrk: Uint8Array;
  /** The prk whose keys encrypt THIS record: vaultPrk for connectable, personalPrk for personal. */
  recordPrk: Uint8Array;
  record: ConnectionRecord;
  previousCreatedAt?: number | null;
  now?: number;
}): Promise<NostrEvent> {
  validateConnectionRecord(params.record);
  const signingKey = deriveVaultSigningKey(params.vaultPrk);
  const vaultPubkey = getPublicKeyHex(signingKey);
  const dTag = connectionDTag(params.record.connection_id);
  const recordKey = deriveRecordKey(params.recordPrk, params.record.connection_id);
  const envelope = await encryptEnvelope(params.record, recordKey, connectionRecordAad(vaultPubkey, dTag));
  return signNostrEvent(
    {
      pubkey: vaultPubkey,
      created_at: nextCreatedAt(params.previousCreatedAt, params.now),
      kind: KIND_APP_DATA,
      tags: [["d", dTag]],
      content: JSON.stringify(envelope)
    },
    signingKey
  );
}

export interface DecryptedConnectionRecord {
  record: ConnectionRecord;
  tier: ConnectionTier;
  event: NostrEvent;
}

/**
 * Trial-decrypts one event: the connectable key always, the personal key
 * only when a sudo window has supplied `personalPrk`. Returns null for
 * events that decrypt with neither — which, outside a sudo window, is the
 * EXPECTED result for every personal-tier record, not an error.
 */
export async function decryptConnectionRecordEvent(
  event: NostrEvent,
  vaultPrk: Uint8Array,
  personalPrk?: Uint8Array
): Promise<DecryptedConnectionRecord | null> {
  if (!verifyNostrEvent(event)) {
    throw new ConnectionRecordError("Connection record event has an invalid id or signature.");
  }
  const expectedPubkey = getPublicKeyHex(deriveVaultSigningKey(vaultPrk));
  if (event.pubkey !== expectedPubkey) {
    throw new ConnectionRecordError("Connection record event is not signed by this vault's identity.");
  }
  const dTag = findTagValue(event, "d") ?? "";
  const connectionId = connectionIdFromDTag(dTag);
  if (connectionId === null) {
    throw new ConnectionRecordError("Connection record event has a malformed d tag.");
  }
  const envelope = JSON.parse(event.content) as EncryptedEnvelope;
  const aad = connectionRecordAad(event.pubkey, dTag);

  const attempts: Array<{ prk: Uint8Array; tier: ConnectionTier }> = [
    { prk: vaultPrk, tier: "connectable" },
    ...(personalPrk ? [{ prk: personalPrk, tier: "personal" as const }] : [])
  ];
  for (const attempt of attempts) {
    let record: ConnectionRecord;
    try {
      record = await decryptEnvelope<ConnectionRecord>(envelope, deriveRecordKey(attempt.prk, connectionId), aad);
    } catch {
      continue; // wrong tier for this key; try the next
    }
    validateConnectionRecord(record);
    if (record.connection_id !== connectionId) {
      // The d tag and the ciphertext must agree, or one record could be
      // smuggled into another record's replaceable slot.
      throw new ConnectionRecordError("Connection record id does not match its d tag.");
    }
    if (record.tier !== attempt.tier) {
      throw new ConnectionRecordError("Connection record tier does not match the key that decrypted it.");
    }
    return { record, tier: attempt.tier, event };
  }
  return null;
}

/**
 * §CV11 tombstone: the record replaced with state "deleted" and its
 * credential wiped to the bare profile schema. Encrypted like any record —
 * a relay must not learn that a deletion happened, only that a replacement did.
 */
export function tombstoneRecord(record: ConnectionRecord, now: number): ConnectionRecord {
  return {
    ...record,
    state: "deleted",
    credential: { schema: record.credential.schema },
    notes: null,
    updated_at: now
  };
}
