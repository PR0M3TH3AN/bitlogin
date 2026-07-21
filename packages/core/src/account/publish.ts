/** Publish-then-verify-readback helper enforcing §15.6's registration success bar. */
import { RelayPool, countAcknowledgements } from "../nostr/pool.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";
import type { NostrEvent } from "../nostr/event.js";

export interface PublishVerificationResult {
  acknowledgedCount: number;
  readbackVerifiedCount: number;
  success: boolean;
}

export async function publishAndVerify(
  pool: RelayPool,
  event: NostrEvent,
  options: { dTag: string; minAcks?: number; minReadbacks?: number; timeoutMs?: number }
): Promise<PublishVerificationResult> {
  const minAcks = options.minAcks ?? 2;
  const minReadbacks = options.minReadbacks ?? 2;

  const publishOutcomes = await pool.publishAll(event, options.timeoutMs);
  const acknowledgedCount = countAcknowledgements(publishOutcomes);

  const quorum = await pool.queryQuorum(
    { kinds: [KIND_APP_DATA], authors: [event.pubkey], "#d": [options.dTag], limit: 5 },
    options.timeoutMs
  );
  const readbackVerifiedCount = quorum.outcomes.filter((o) => o.events.some((e) => e.id === event.id)).length;

  return {
    acknowledgedCount,
    readbackVerifiedCount,
    success: acknowledgedCount >= minAcks && readbackVerifiedCount >= minReadbacks
  };
}
