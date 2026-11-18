/**
 * Turns a replica health check (§24.4) into what the account panel says about
 * it. Pure, so the wording and the thresholds are testable without a DOM.
 */
import type { RebroadcastResult, ReplicaHealthResult, ReplicaStatus } from "@bitlogin/core/account";

export type ReplicaHealthLevel =
  /** Every vault relay holds both capsules. */
  | "healthy"
  /** Enough copies to sign in and recover, but some relays lack one. */
  | "degraded"
  /** Fewer than two relays hold one of the capsules. */
  | "at-risk"
  /** No relay that answered holds one of the capsules. */
  | "lost"
  /** Relays hold a newer sign-in capsule than this device does. */
  | "stale"
  /** No relay answered, so nothing can be said either way. */
  | "unknown";

export interface ReplicaHealthSummary {
  level: ReplicaHealthLevel;
  headline: string;
  detail: string;
  /** False when re-sending this device's copies cannot improve anything. */
  repairUseful: boolean;
}

/** Registration's own durability bar (§15.6): two relays per capsule. */
const MIN_SAFE_COPIES = 2;

export function summarizeReplicaHealth(result: ReplicaHealthResult): ReplicaHealthSummary {
  const { totalCount, reachableCount, credentialCurrentCount, recoveryCurrentCount } = result;
  const counts = `Sign-in copy on ${credentialCurrentCount} of ${totalCount} relays, recovery copy on ${recoveryCurrentCount} of ${totalCount}.`;

  if (reachableCount === 0 && credentialCurrentCount === 0 && recoveryCurrentCount === 0) {
    return {
      level: "unknown",
      headline: "Couldn't reach any relay",
      detail: "None of the relays answered, so this says nothing about your account. Check your connection and try again.",
      repairUseful: false
    };
  }

  if (credentialCurrentCount === 0 && result.relays.some((relay) => relay.credential === "newer")) {
    return {
      level: "stale",
      headline: "This device is out of date",
      detail:
        "Relays hold a newer sign-in copy than this device does, which usually means the password was changed somewhere else. Log out and sign in again with your current password.",
      repairUseful: false
    };
  }

  const weakest = Math.min(credentialCurrentCount, recoveryCurrentCount);
  if (weakest === 0) {
    return {
      level: "lost",
      headline: "Relays have dropped your account",
      detail: `${counts} Until this is fixed, ${
        credentialCurrentCount === 0 && recoveryCurrentCount === 0
          ? "neither your password nor your recovery phrase"
          : credentialCurrentCount === 0
            ? "your password"
            : "your recovery phrase"
      } can find it from a new device. This device still has it: re-send it now, and keep your private key saved.`,
      repairUseful: true
    };
  }
  if (weakest < MIN_SAFE_COPIES) {
    return {
      level: "at-risk",
      headline: "Your account is down to one relay",
      detail: `${counts} Re-send it to the others before that one drops it too.`,
      repairUseful: true
    };
  }
  if (weakest < totalCount) {
    return {
      level: "degraded",
      headline: "Stored, but not everywhere",
      detail: `${counts} Re-send it to fill in the relays that lack a copy.`,
      repairUseful: true
    };
  }
  return {
    level: "healthy",
    headline: "Stored on every relay",
    detail: `${counts} Each copy was checked against the one this device holds.`,
    repairUseful: false
  };
}

export function replicaStatusLabel(status: ReplicaStatus): string {
  switch (status) {
    case "current":
      return "stored";
    case "newer":
      return "newer copy";
    case "older":
      return "old copy";
    case "missing":
      return "missing";
    case "unreachable":
      return "no answer";
  }
}

const RELAY_TEXT_MAX = 140;

/**
 * A relay's own words, made safe to put on screen as plain text. It is
 * untrusted input: control characters and runs of whitespace are flattened
 * and the length is capped, so a relay cannot reshape the panel or bury it.
 * The caller still HTML-escapes the result.
 */
export function cleanRelayText(text: string): string {
  const flat = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/gu, " ").replace(/\s+/gu, " ").trim();
  return flat.length > RELAY_TEXT_MAX ? `${flat.slice(0, RELAY_TEXT_MAX - 1)}…` : flat;
}

type RelayHealth = ReplicaHealthResult["relays"][number];
type RelayRepair = RebroadcastResult["relays"][number];

/**
 * Why one relay is not holding a capsule, in that relay's own words where it
 * gave any. `repair` is the relay's reply to the most recent re-send, if one
 * was made; `health` is what the check after it found.
 */
export function relayProblemNotes(health: RelayHealth, repair?: RelayRepair): string[] {
  const notes: string[] = [];
  const capsules = [
    ["sign-in", health.credential, repair?.credential],
    ["recovery", health.recovery, repair?.recovery]
  ] as const;
  for (const [label, status, reply] of capsules) {
    // A relay that could not be reached refused nothing: that is the
    // "No answer" case below, said once rather than once per capsule.
    if (status === "current" || status === "unreachable") continue;
    if (reply && !reply.ok) {
      const said = cleanRelayText(reply.message);
      notes.push(`Refused the ${label} copy${said ? `: ${said}` : " without giving a reason"}`);
    } else if (reply?.ok && status === "missing") {
      notes.push(`Said it accepted the ${label} copy, but does not return it`);
    }
  }
  if (notes.length === 0 && health.error && (health.credential === "unreachable" || health.recovery === "unreachable")) {
    notes.push(`No answer: ${cleanRelayText(health.error)}`);
  }
  // The same refusal for both capsules reads better once.
  return [...new Set(notes)];
}

/** Private-key backup file offered at registration and from Export identity. */
export function buildKeyBackupText(params: { npub: string; nsec: string; createdAt: Date }): string {
  return [
    "BitLogin private key backup",
    `Saved: ${params.createdAt.toISOString()}`,
    "",
    `Public key (npub): ${params.npub}`,
    `Private key (nsec): ${params.nsec}`,
    "",
    "Anyone with the private key controls this identity. Keep this file offline",
    "or in a password manager, and never send it to anyone.",
    "",
    "This key is the identity itself. If relays ever drop your BitLogin account,",
    "your recovery phrase alone cannot bring it back, but this key can: choose",
    '"Import a Nostr key" under "More sign-in options", or use it in any Nostr app.',
    ""
  ].join("\n");
}
