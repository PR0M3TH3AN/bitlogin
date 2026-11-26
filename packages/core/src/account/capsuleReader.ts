/**
 * Shared quorum-read + decrypt-newest-to-oldest + rollback/disagreement
 * detection logic (§16.1, §16.2, §17.3, §17.4, §12.4.9), used by login,
 * recovery, and password-change (which must read the capsule it replaces).
 */
import { RelaysSlowError } from "./errors.js";
import { RelayPool } from "../nostr/pool.js";
import { verifyNostrEvent, findTagValue, type NostrEvent } from "../nostr/event.js";
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
  /**
   * What each relay did (2026-11-25): answered to the end; connected and didn't finish ("slow"); or never connected,
   * so was never asked ("not-asked"). Only a relay that answered can say an address is empty.
   */
  relays: Array<{ relayUrl: string; state: RelayAnswer; held: number }>;
}

export type RelayAnswer = "answered" | "slow" | "not-asked";
/** A relay's failure, read as never connected (so never asked) or as connected and not finished. */
export function relayAnswer(outcome: { responded: boolean; error?: string }): RelayAnswer {
  if (outcome.responded) return "answered";
  if (/connecting to relay|Not connected to relay|Not waited for/u.test(outcome.error ?? "")) return "not-asked";
  return "slow";
}

/**
 * Keeps only events that are actually AT the address we asked for.
 *
 * A relay's response is a claim, not an answer: nothing stops it returning a
 * validly-signed event by some other author, of some other kind, or under a
 * different `d` tag. Signature verification alone accepted all of those.
 * `best` was never at risk (the AEAD binds the ciphertext to the event's own
 * pubkey, so a foreign event cannot decrypt) -- but `candidates.length` is
 * load-bearing in the registration, rotation, and recovery collision guards,
 * so ONE junk event from ONE relay was enough to block all three, for every
 * login name and password the user tried, at zero cost.
 */
function dedupeAndSort(
  events: NostrEvent[],
  authorPubkeyHex: string,
  dTag: string
): NostrEvent[] {
  const byId = new Map<string, NostrEvent>();
  for (const event of events) {
    if (event.pubkey !== authorPubkeyHex) continue;
    if (event.kind !== KIND_APP_DATA) continue;
    if (findTagValue(event, "d") !== dTag) continue;
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
  const sortedEvents = dedupeAndSort(allEvents, authorPubkeyHex, dTag);

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
    .map((outcome) => ({
      responded: outcome.responded,
      events: dedupeAndSort(outcome.events, authorPubkeyHex, dTag)
    }))
    .filter((outcome) => outcome.responded && outcome.events.length > 0)
    .map((outcome) => outcome.events[0]!.id);
  const relayDisagreement = new Set(latestIdPerRelay).size > 1;

  return {
    quorumMet: quorum.quorumMet,
    respondedCount: quorum.respondedCount,
    totalCount: quorum.totalCount,
    candidates,
    best,
    relayDisagreement,
    relays: quorum.outcomes.map((outcome) => ({ relayUrl: outcome.relayUrl, state: relayAnswer(outcome), held: dedupeAndSort(outcome.events, authorPubkeyHex, dTag).length }))
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

/** How long a relay that connected and didn't finish is given when a sign-in or recovery asks it once more. */
export const SLOW_ANSWER_WAIT_MS = 5000;

/**
 * Read an address as sign-in and recovery must (2026-11-26, the record-not-found fault), held to the free check's
 * rule the other way round: a relay that connected and didn't finish is asked once more, and where nothing decrypts,
 * "no account" is said only where every listed relay was reached and answered empty. Otherwise `RelaysSlowError`:
 * "slow" where a relay that connected still hasn't finished, "unreached" where some couldn't be reached at all. A
 * false "no account" at sign-in sends someone to make a new account, or to rebuild one: the harm this stops.
 */
export async function readAccountCarefully<T>(
  read: (urls: string[], timeoutMs?: number) => Promise<CapsuleReadResult<T>>,
  urls: readonly string[],
  timeoutMs?: number,
  slowWaitMs = SLOW_ANSWER_WAIT_MS
): Promise<CapsuleReadResult<T>> {
  const list = [...new Set(urls)];
  const first = await read(list, timeoutMs);
  if (first.best || first.candidates.length > 0) return first;
  const slow = first.relays.filter((r) => r.state === "slow").map((r) => r.relayUrl);
  let result = first;
  let stillSlow = 0;
  if (slow.length > 0) {
    const again = await read(slow, slowWaitMs);
    if (again.best || again.candidates.length > 0) {
      return { ...again, quorumMet: true, respondedCount: first.respondedCount + again.respondedCount, totalCount: first.totalCount, relays: [...first.relays.filter((r) => r.state !== "slow"), ...again.relays] };
    }
    stillSlow = again.relays.filter((r) => r.state !== "answered").length;
    result = { ...first, respondedCount: first.respondedCount + again.respondedCount, relays: [...first.relays.filter((r) => r.state !== "slow"), ...again.relays] };
  }
  if (stillSlow > 0) throw new RelaysSlowError("slow");
  const unreached = result.relays.filter((r) => r.state !== "answered").length;
  if (unreached > 0) throw new RelaysSlowError("unreached", unreached);
  return { ...result, quorumMet: true };
}
