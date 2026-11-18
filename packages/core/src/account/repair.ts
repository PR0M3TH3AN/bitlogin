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

/** What one relay said when a capsule was re-sent to it. `message` is the
 *  relay's own text (or the connection error) and is untrusted. */
export interface RelayPublishReply {
  ok: boolean;
  message: string;
}

export interface RebroadcastResult extends RepairReplicasResult {
  /** One entry per relay, in the order given, so a caller can show why a
   *  relay refused a capsule instead of only how many did. */
  relays: Array<{
    relayUrl: string;
    credential: RelayPublishReply;
    recovery: RelayPublishReply;
  }>;
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
}): Promise<RebroadcastResult> {
  const relayUrls = [...new Set(params.relayUrls)];
  const publish = async (
    event: NostrEvent,
  ): Promise<Map<string, RelayPublishReply>> => {
    const pool = new RelayPool(relayUrls);
    try {
      const outcomes = await pool.publishAll(event, params.timeoutMs);
      return new Map(
        outcomes.map((o) => [
          o.relayUrl,
          { ok: o.result.ok, message: o.result.message ?? "" },
        ]),
      );
    } finally {
      pool.closeAll();
    }
  };
  const [credential, recovery] = await Promise.all([
    publish(params.credentialEvent),
    publish(params.recoveryEvent),
  ]);
  const noReply: RelayPublishReply = { ok: false, message: "no reply" };
  const relays = relayUrls.map((relayUrl) => ({
    relayUrl,
    credential: credential.get(relayUrl) ?? noReply,
    recovery: recovery.get(relayUrl) ?? noReply,
  }));
  return {
    credentialAcknowledgedCount: relays.filter((r) => r.credential.ok).length,
    recoveryAcknowledgedCount: relays.filter((r) => r.recovery.ok).length,
    relaysTried: relays.length,
    relays,
  };
}
