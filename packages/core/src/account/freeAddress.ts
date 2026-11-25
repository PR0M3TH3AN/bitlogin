/**
 * Whether a login name and password's address is free, before a registration, a password change or a recovery
 * writes a credential capsule there (2026-11-25). Publishing over an existing account's capsule would destroy it.
 *
 * A record found anywhere is decisive: the address is taken. Otherwise "free" needs:
 * - at least a quorum of the relays (half, rounded up) to have answered to the end with nothing there;
 * - no relay that connected and didn't finish: such a relay is asked once more, given a few seconds; if it still
 *   hasn't finished, the address couldn't be checked. It may be the one that holds an existing account.
 * A relay that never connected (refused, unreachable, closed before the question) wasn't asked, and says nothing.
 *
 * The new capsule is then written only to the relays that answered "nothing here": none that might hold an
 * existing account is written over. (Replica repair is held to the same rule: repair.ts.)
 */
import type { CapsuleReadResult } from "./capsuleReader.js";

/** How long a relay that connected and didn't finish is given when it is asked once more. */
export const SLOW_RELAY_WAIT_MS = 5000;

export type FreeCheck<T> =
  | { state: "free"; writeUrls: string[] }
  | { state: "taken"; result: CapsuleReadResult<T>; answeredUrls: string[] }
  | { state: "unchecked"; why: "slow" | "too-few"; answered: number; of: number };

export async function checkAddressFree<T>(params: {
  urls: string[];
  /** Read the address from these relays, within this time. */
  read: (urls: string[], timeoutMs?: number) => Promise<CapsuleReadResult<T>>;
  timeoutMs?: number;
  slowWaitMs?: number;
}): Promise<FreeCheck<T>> {
  const urls = [...new Set(params.urls)];
  const first = await params.read(urls, params.timeoutMs);
  const answered = first.relays.filter((r) => r.state === "answered").map((r) => r.relayUrl);
  if (first.candidates.length > 0) return { state: "taken", result: first, answeredUrls: answered };
  const slow = first.relays.filter((r) => r.state === "slow").map((r) => r.relayUrl);
  if (slow.length > 0) {
    const again = await params.read(slow, params.slowWaitMs ?? SLOW_RELAY_WAIT_MS);
    if (again.candidates.length > 0) return { state: "taken", result: again, answeredUrls: [...answered, ...again.relays.filter((r) => r.state === "answered").map((r) => r.relayUrl)] };
    // Connected before: still not finished, or gone now. Either may be the one that holds an account.
    if (again.relays.some((r) => r.state !== "answered")) return { state: "unchecked", why: "slow", answered: answered.length, of: urls.length };
    answered.push(...slow);
  }
  if (answered.length < Math.ceil(urls.length / 2)) return { state: "unchecked", why: "too-few", answered: answered.length, of: urls.length };
  return { state: "free", writeUrls: answered };
}

/** What a person is told when an address couldn't be checked. Nothing was written. */
export const UNCHECKED_WORDS = {
  slow: "a vault relay that connected didn't finish answering, and it may hold an account",
  "too-few": "too few vault relays answered"
} as const;
