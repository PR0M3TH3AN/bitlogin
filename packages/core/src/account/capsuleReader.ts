/**
 * Shared quorum-read + decrypt-newest-to-oldest + rollback/disagreement
 * detection logic (§16.1, §16.2, §17.3, §17.4, §12.4.9), used by login,
 * recovery, and password-change (which must read the capsule it replaces).
 */
import { RelayPool } from "../nostr/pool.js";
import { verifyNostrEvent, type NostrEvent } from "../nostr/event.js";
import { KIND_APP_DATA, D_TAG_PASSWORD_CAPSULE, D_TAG_RECOVERY_CAPSULE } from "../nostr/kinds.js";
import { decryptCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import { decryptRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import { checkRecoveryChainConsistency } from "../capsules/validation.js";
import type { CredentialPayload, RecoveryPayload } from "../capsules/types.js";

export interface Candidate<TPayload> {
  event: NostrEvent;
  payload: TPayload | null;
  error?: string;
}

export interface CapsuleReadResult<TPayload> {
  quorumMet: boolean;
  respondedCount: number;
  totalCount: number;
  candidates: Array<Candidate<TPayload>>;
  /** Highest-created_at candidate that decrypted and validated successfully, if any. */
  best: Candidate<TPayload> | null;
  /** True when responsive relays disagree about which event is newest for this address (§16.2 step 8). */
  relayDisagreement: boolean;
}

function dedupeAndSort(events: NostrEvent[]): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (verifyNostrEvent(event)) byId.set(event.id, event);
  }
  return [...byId.values()].sort((a, b) => b.created_at - a.created_at);
}

async function readAddressableCapsule<TPayload>(
  pool: RelayPool,
  authorPubkeyHex: string,
  dTag: string,
  decrypt: (event: NostrEvent) => Promise<TPayload>,
  timeoutMs: number
): Promise<CapsuleReadResult<TPayload>> {
  const quorum = await pool.queryQuorum(
    { kinds: [KIND_APP_DATA], authors: [authorPubkeyHex], "#d": [dTag], limit: 5 },
    timeoutMs
  );

  const allEvents = quorum.outcomes.flatMap((o) => o.events);
  const sortedEvents = dedupeAndSort(allEvents);

  const candidates: Array<Candidate<TPayload>> = [];
  for (const event of sortedEvents) {
    try {
      const payload = await decrypt(event);
      candidates.push({ event, payload });
    } catch (err) {
      candidates.push({ event, payload: null, error: (err as Error).message });
    }
  }
  const best = candidates.find((c) => c.payload !== null) ?? null;

  const latestIdPerRelay = quorum.outcomes
    .filter((o) => o.responded && o.events.length > 0)
    .map((o) => o.events.slice().sort((a, b) => b.created_at - a.created_at)[0]!.id);
  const relayDisagreement = new Set(latestIdPerRelay).size > 1;

  return {
    quorumMet: quorum.quorumMet,
    respondedCount: quorum.respondedCount,
    totalCount: quorum.totalCount,
    candidates,
    best,
    relayDisagreement
  };
}

export async function readCredentialCapsule(
  pool: RelayPool,
  locatorPublicKeyHex: string,
  capsuleKey: Uint8Array,
  timeoutMs = 8000
): Promise<CapsuleReadResult<CredentialPayload>> {
  return readAddressableCapsule(
    pool,
    locatorPublicKeyHex,
    D_TAG_PASSWORD_CAPSULE,
    (event) => decryptCredentialCapsuleEvent(event, capsuleKey),
    timeoutMs
  );
}

export async function readRecoveryCapsule(
  pool: RelayPool,
  recoveryPublicKeyHex: string,
  capsuleKey: Uint8Array,
  timeoutMs = 8000
): Promise<CapsuleReadResult<RecoveryPayload>> {
  return readAddressableCapsule(
    pool,
    recoveryPublicKeyHex,
    D_TAG_RECOVERY_CAPSULE,
    (event) => decryptRecoveryCapsuleEvent(event, capsuleKey),
    timeoutMs
  );
}

/** §12.4.9 — checks the previous_recovery_event_id chain across every recovery-capsule candidate this client can see. */
export function checkRecoveryChainAcrossCandidates(candidates: Array<Candidate<RecoveryPayload>>): { consistent: boolean; warning?: string } {
  const valid = candidates.filter((c): c is Candidate<RecoveryPayload> & { payload: RecoveryPayload } => c.payload !== null);
  if (valid.length < 2) return { consistent: true };
  return checkRecoveryChainConsistency(
    valid.map((c) => ({
      eventId: c.event.id,
      recoveryGeneration: c.payload.recovery_generation,
      previousRecoveryEventId: c.payload.previous_recovery_event_id
    }))
  );
}
