/**
 * Replica repair (§24.4). Rebroadcasting the embedded signed recovery event
 * requires no key material and must not involve re-signing — relay-side
 * NIP-01 replacement (only accept a newer `created_at`) makes it always safe
 * to republish a known-good event indiscriminately, so no relay is ever
 * clobbered with a stale copy.
 */
import { RelayPool, countAcknowledgements } from "../nostr/pool.js";
import { findTagValue, type NostrEvent } from "../nostr/event.js";

/**
 * The relays a credential capsule may be re-sent to (2026-11-25): those that answered and hold nothing at its
 * address, or this same event. A relay holding another event there may hold another account registered under the
 * same login name and password, where this one was written without it (it wasn't reachable then); re-sending this,
 * newer, would replace that account's capsule. And a relay that didn't answer may be such a relay.
 */
export async function relaysToRepair(relayUrls: string[], event: NostrEvent, timeoutMs?: number): Promise<{ ok: string[]; heldBack: Map<string, string> }> {
  const d = findTagValue(event, "d") ?? "";
  const pool = new RelayPool(relayUrls);
  try {
    const quorum = await pool.queryQuorum({ kinds: [event.kind], authors: [event.pubkey], "#d": [d], limit: 5 }, timeoutMs);
    const ok: string[] = [];
    const heldBack = new Map<string, string>();
    for (const outcome of quorum.outcomes) {
      const here = outcome.events.filter((e) => e.kind === event.kind && e.pubkey === event.pubkey && findTagValue(e, "d") === d);
      if (!outcome.responded) heldBack.set(outcome.relayUrl, "held back: it didn't answer what it holds at this address");
      else if (here.some((e) => e.id !== event.id)) heldBack.set(outcome.relayUrl, "held back: it holds another record at this address");
      else ok.push(outcome.relayUrl);
    }
    return { ok, heldBack };
  } finally {
    pool.closeAll();
  }
}

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
  // The credential capsule only where it can't replace another record (relaysToRepair); the recovery capsule, whose
  // address is this account's alone, everywhere.
  const targets = await relaysToRepair(pool.relayUrls, credentialEvent, timeoutMs);
  const credentialPool = new RelayPool(targets.ok);
  const [credentialOutcomes, recoveryOutcomes] = await Promise.all([
    targets.ok.length ? credentialPool.publishAll(credentialEvent, timeoutMs).finally(() => credentialPool.closeAll()) : Promise.resolve([]),
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
    to: string[] = relayUrls,
  ): Promise<Map<string, RelayPublishReply>> => {
    if (to.length === 0) return new Map();
    const pool = new RelayPool(to);
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
  // The credential capsule only where it can't replace another record (relaysToRepair).
  const targets = await relaysToRepair(relayUrls, params.credentialEvent, params.timeoutMs);
  const [credentialSent, recovery] = await Promise.all([
    publish(params.credentialEvent, targets.ok),
    publish(params.recoveryEvent),
  ]);
  const credential = new Map(credentialSent);
  for (const [relayUrl, why] of targets.heldBack) credential.set(relayUrl, { ok: false, message: why });
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
