/**
 * Vault relay synchronization (connection-vault.md §9, §10, Phase C).
 *
 * Publishing reuses the capsule publish-and-verify quorum bar. Fetching
 * queries the derived vault identity's kind-30078 events and filters the
 * `bitlogin:connection:` prefix locally — relay filters match exact tag
 * values, and a per-id filter list would leak the vault's size and ids to
 * anyone watching query traffic (§CV10).
 *
 * Rollback detection is per record (§CV9): a KeyValueStore high-water mark
 * remembers the newest created_at ever accepted per connection, and a relay
 * serving something older is reported, never silently accepted — a stale
 * replica resurrecting a revoked credential is this design's nastiest
 * failure mode.
 */
import { RelayPool } from "../nostr/pool.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";
import { verifyNostrEvent, findTagValue, type NostrEvent } from "../nostr/event.js";
import { publishAndVerify, type PublishVerificationResult } from "../account/publish.js";
import type { KeyValueStore } from "../storage/interface.js";
import { deriveVaultSigningKey, connectionDTag, connectionIdFromDTag } from "./derivation.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";

function hwmKey(vaultPubkey: string, connectionId: string): string {
  return `bitlogin:vault-hwm:${vaultPubkey}:${connectionId}`;
}

export interface RecordHighWaterMark {
  createdAt: number;
  eventId: string;
}

export async function getRecordHighWaterMark(
  store: KeyValueStore,
  vaultPubkey: string,
  connectionId: string
): Promise<RecordHighWaterMark | null> {
  const raw = await store.get(hwmKey(vaultPubkey, connectionId));
  return raw ? (JSON.parse(raw) as RecordHighWaterMark) : null;
}

export async function raiseRecordHighWaterMark(
  store: KeyValueStore,
  vaultPubkey: string,
  connectionId: string,
  observed: RecordHighWaterMark
): Promise<void> {
  const current = await getRecordHighWaterMark(store, vaultPubkey, connectionId);
  if (current && current.createdAt > observed.createdAt) return;
  // Equal timestamps are NOT a no-op: two devices editing the same record in
  // the same second both compute nextCreatedAt(T) = T+1, so a benign edit can
  // land at the exact timestamp of a REVOCATION. Ties break on event id (the
  // addressable-event convention) so the mark advances deterministically
  // rather than depending on which write arrived first.
  if (current && current.createdAt === observed.createdAt && current.eventId <= observed.eventId) return;
  await store.set(hwmKey(vaultPubkey, connectionId), JSON.stringify(observed));
}

/** Publishes one record event to the vault relays with the §15.6 quorum bar,
 *  raising the local high-water mark only on success. */
export async function publishConnectionRecord(params: {
  vaultPrk: Uint8Array;
  event: NostrEvent;
  connectionId: string;
  relayUrls: string[];
  store: KeyValueStore;
  minAcknowledgements?: number;
  timeoutMs?: number;
}): Promise<PublishVerificationResult> {
  const signingKey = deriveVaultSigningKey(params.vaultPrk);
  const pool = new RelayPool(params.relayUrls, { authPrivateKey: signingKey });
  let result: PublishVerificationResult;
  try {
    result = await publishAndVerify(pool, params.event, {
      dTag: connectionDTag(params.connectionId),
      minAcks: params.minAcknowledgements,
      // The readback bar follows the ack bar: a caller publishing to fewer
      // relays (a targeted repair, a test) has already lowered its quorum.
      minReadbacks: params.minAcknowledgements,
      timeoutMs: params.timeoutMs
    });
  } finally {
    pool.closeAll();
  }
  if (result.success) {
    await raiseRecordHighWaterMark(params.store, params.event.pubkey, params.connectionId, {
      createdAt: params.event.created_at,
      eventId: params.event.id
    });
  }
  return result;
}

export interface FetchedConnectionEvents {
  /** Newest valid event per connection id, high-water marks already applied. */
  events: Map<string, NostrEvent>;
  /** Connection ids where every visible event is OLDER than this device has
   *  already accepted — stale replicas or replay, never auto-accepted (§CV9). */
  rollbackWarnings: string[];
  quorumMet: boolean;
  respondedCount: number;
  /** True when a relay returned the full page, so records may be missing. */
  truncated: boolean;
}

/** Ceiling on records fetched in one query. Hit means the relay, not the
 *  user, decided which connections exist -- so it is REPORTED, not silent. */
const FETCH_LIMIT = 500;

/** Fetches every connection record visible for this vault identity (§CV10). */
export async function fetchConnectionRecordEvents(params: {
  vaultPrk: Uint8Array;
  relayUrls: string[];
  store: KeyValueStore;
  timeoutMs?: number;
}): Promise<FetchedConnectionEvents> {
  const signingKey = deriveVaultSigningKey(params.vaultPrk);
  const vaultPubkey = getPublicKeyHex(signingKey);
  const pool = new RelayPool(params.relayUrls, { authPrivateKey: signingKey });
  let quorum;
  try {
    quorum = await pool.queryQuorum(
      { kinds: [KIND_APP_DATA], authors: [vaultPubkey], limit: FETCH_LIMIT },
      params.timeoutMs
    );
  } finally {
    pool.closeAll();
  }

  const truncated = quorum.outcomes.some((outcome) => outcome.events.length >= FETCH_LIMIT);
  const newestById = new Map<string, NostrEvent>();
  for (const event of quorum.outcomes.flatMap((o) => o.events)) {
    if (!verifyNostrEvent(event) || event.pubkey !== vaultPubkey) continue;
    const connectionId = connectionIdFromDTag(findTagValue(event, "d") ?? "");
    if (connectionId === null) continue;
    const current = newestById.get(connectionId);
    if (!current || event.created_at > current.created_at) newestById.set(connectionId, event);
  }

  const events = new Map<string, NostrEvent>();
  const rollbackWarnings: string[] = [];
  for (const [connectionId, event] of newestById) {
    const hwm = await getRecordHighWaterMark(params.store, vaultPubkey, connectionId);
    // Strict `<` alone let a same-second sibling of a revocation through
    // forever (the relay may keep both events at one address). An equal
    // timestamp is only acceptable from the SAME event, or a later-sorting
    // id under the same tie-break the mark itself uses.
    const stale =
      hwm !== null &&
      (event.created_at < hwm.createdAt ||
        (event.created_at === hwm.createdAt && event.id < hwm.eventId));
    if (stale) {
      rollbackWarnings.push(connectionId);
      continue;
    }
    events.set(connectionId, event);
    await raiseRecordHighWaterMark(params.store, vaultPubkey, connectionId, {
      createdAt: event.created_at,
      eventId: event.id
    });
  }

  return {
    events,
    rollbackWarnings,
    quorumMet: quorum.quorumMet,
    respondedCount: quorum.respondedCount,
    truncated
  };
}
