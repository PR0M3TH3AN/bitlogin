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

/**
 * The same repair with one connection set per capsule, for callers that run
 * it routinely (after every sign-in) rather than once at a user's request.
 * The credential and recovery addresses are unlinkable on the wire unless a
 * client publishes both over the same connection, so this does not.
 */
export async function rebroadcastCapsules(params: {
  relayUrls: string[];
  credentialEvent: NostrEvent;
  recoveryEvent: NostrEvent;
  timeoutMs?: number;
}): Promise<RepairReplicasResult> {
  const publish = async (event: NostrEvent): Promise<number> => {
    const pool = new RelayPool(params.relayUrls);
    try {
      return countAcknowledgements(
        await pool.publishAll(event, params.timeoutMs),
      );
    } finally {
      pool.closeAll();
    }
  };
  const [credentialAcknowledgedCount, recoveryAcknowledgedCount] =
    await Promise.all([
      publish(params.credentialEvent),
      publish(params.recoveryEvent),
    ]);
  return {
    credentialAcknowledgedCount,
    recoveryAcknowledgedCount,
    relaysTried: new Set(params.relayUrls).size,
  };
}
