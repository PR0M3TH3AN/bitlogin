/**
 * Replica repair (§24.4). Rebroadcasting the embedded signed recovery event
 * requires no key material and must not involve re-signing — relay-side
 * NIP-01 replacement (only accept a newer `created_at`) makes it always safe
 * to republish a known-good event indiscriminately, so no relay is ever
 * clobbered with a stale copy.
 */
import { RelayPool, countAcknowledgements } from "../nostr/pool.js";
import type { NostrEvent } from "../nostr/event.js";

export interface RepairReplicasResult {
  credentialAcknowledgedCount: number;
  recoveryAcknowledgedCount: number;
  relaysTried: number;
}

export async function repairReplicas(
  pool: RelayPool,
  credentialEvent: NostrEvent,
  recoveryEvent: NostrEvent,
  timeoutMs?: number
): Promise<RepairReplicasResult> {
  const [credentialOutcomes, recoveryOutcomes] = await Promise.all([
    pool.publishAll(credentialEvent, timeoutMs),
    pool.publishAll(recoveryEvent, timeoutMs)
  ]);
  return {
    credentialAcknowledgedCount: countAcknowledgements(credentialOutcomes),
    recoveryAcknowledgedCount: countAcknowledgements(recoveryOutcomes),
    relaysTried: pool.relayUrls.length
  };
}
