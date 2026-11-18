/**
 * Replica health check (§24.4). Asks every vault relay, one by one, whether it
 * still holds the exact capsule events this session knows about.
 *
 * Relays promise nothing about retention (§19.4). If every relay drops both
 * capsules, neither the password nor the recovery phrase can find the account
 * again, so a logged-in client needs a way to see that coming while it still
 * holds the signed events and can rebroadcast them (`repairReplicas`).
 *
 * Needs no key material: both capsules are public, encrypted events, and the
 * check only compares what a relay returns against events already in hand.
 */
import { RelayPool } from "../nostr/pool.js";
import {
  verifyNostrEvent,
  findTagValue,
  type NostrEvent,
} from "../nostr/event.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";

/**
 * What one relay holds at one capsule address.
 *
 * - `current`: the relay returned the exact event this session holds, and its
 *   id and signature verify.
 * - `newer` / `older`: the relay holds a different valid event at the address.
 *   `newer` usually means the capsule was replaced from another device and
 *   this session is out of date.
 * - `missing`: the relay answered and holds nothing valid at the address.
 * - `unreachable`: the relay did not answer in time, or refused the query.
 */
export type ReplicaStatus =
  "current" | "newer" | "older" | "missing" | "unreachable";

export interface RelayReplicaHealth {
  relayUrl: string;
  credential: ReplicaStatus;
  recovery: ReplicaStatus;
  /** Set when either query failed; the relay's own words, for diagnostics. */
  error?: string;
}

export interface ReplicaHealthResult {
  relays: RelayReplicaHealth[];
  totalCount: number;
  /** Relays that answered both queries. */
  reachableCount: number;
  /** Relays holding the exact, verified credential capsule this session holds. */
  credentialCurrentCount: number;
  /** Relays holding the exact, verified recovery capsule this session holds. */
  recoveryCurrentCount: number;
  checkedAt: number;
}

export interface CheckReplicaHealthParams {
  relayUrls: string[];
  credentialEvent: NostrEvent;
  recoveryEvent: NostrEvent;
  timeoutMs?: number;
  now?: number;
}

function capsuleAddress(event: NostrEvent): { pubkey: string; dTag: string } {
  const dTag = findTagValue(event, "d");
  if (
    event.kind !== KIND_APP_DATA ||
    dTag === undefined ||
    !verifyNostrEvent(event)
  ) {
    throw new Error("This session's capsule event is not a valid capsule.");
  }
  return { pubkey: event.pubkey, dTag };
}

/**
 * A relay's response is a claim, not an answer (see capsuleReader): only
 * events that are at the requested address and verify count for anything.
 */
function classify(
  returned: NostrEvent[],
  expected: NostrEvent,
  address: { pubkey: string; dTag: string },
): ReplicaStatus {
  const atAddress = returned.filter(
    (event) =>
      event.pubkey === address.pubkey &&
      event.kind === KIND_APP_DATA &&
      findTagValue(event, "d") === address.dTag &&
      verifyNostrEvent(event),
  );
  if (atAddress.some((event) => event.id === expected.id)) return "current";
  if (atAddress.length === 0) return "missing";
  const newest = Math.max(...atAddress.map((event) => event.created_at));
  return newest >= expected.created_at ? "newer" : "older";
}

async function checkOneCapsule(
  relayUrls: string[],
  expected: NostrEvent,
  timeoutMs: number | undefined,
): Promise<Map<string, { status: ReplicaStatus; error?: string }>> {
  const address = capsuleAddress(expected);
  const pool = new RelayPool(relayUrls);
  try {
    const quorum = await pool.queryQuorum(
      {
        kinds: [KIND_APP_DATA],
        authors: [address.pubkey],
        "#d": [address.dTag],
        limit: 5,
      },
      timeoutMs,
    );
    return new Map(
      quorum.outcomes.map((outcome) => [
        outcome.relayUrl,
        outcome.responded
          ? { status: classify(outcome.events, expected, address) }
          : { status: "unreachable" as const, error: outcome.error },
      ]),
    );
  } finally {
    pool.closeAll();
  }
}

export async function checkReplicaHealth(
  params: CheckReplicaHealthParams,
): Promise<ReplicaHealthResult> {
  const relayUrls = [...new Set(params.relayUrls)];
  // One pool per capsule: the two addresses are unlinkable on the wire unless
  // a client asks for both over the same connection.
  const [credential, recovery] = await Promise.all([
    checkOneCapsule(relayUrls, params.credentialEvent, params.timeoutMs),
    checkOneCapsule(relayUrls, params.recoveryEvent, params.timeoutMs),
  ]);

  const relays = relayUrls.map((relayUrl): RelayReplicaHealth => {
    const c = credential.get(relayUrl) ?? { status: "unreachable" as const };
    const r = recovery.get(relayUrl) ?? { status: "unreachable" as const };
    const error = c.error ?? r.error;
    return {
      relayUrl,
      credential: c.status,
      recovery: r.status,
      ...(error ? { error } : {}),
    };
  });

  return {
    relays,
    totalCount: relays.length,
    reachableCount: relays.filter(
      (r) => r.credential !== "unreachable" && r.recovery !== "unreachable",
    ).length,
    credentialCurrentCount: relays.filter((r) => r.credential === "current")
      .length,
    recoveryCurrentCount: relays.filter((r) => r.recovery === "current").length,
    checkedAt: params.now ?? Math.floor(Date.now() / 1000),
  };
}
