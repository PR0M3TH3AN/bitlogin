/**
 * Relays asked together, and not waited on to the last one (docs/paying.md
 * PY13). The account's own flows wait for every relay or the whole timeout,
 * because for them the newest record matters more than a second. Paying is
 * different: a person is looking at "Looking up", every record asked for here
 * is also kept in the browser, and one relay that never answers must not cost
 * the whole timeout on every question.
 *
 * So: a question is finished when every relay has answered; or, once two
 * have, a moment later. The same for sending. What a slow relay held and was
 * not waited for is found the next time, and what it did not take is sent
 * again then: the stores that use this already work that way.
 */
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";

interface OneRelay {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[]; responded?: boolean }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  closeAll(): void;
}

export interface QuickRelays {
  relayUrls: string[];
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  closeAll(): void;
}

/** How many answers are enough to stop waiting for the rest, and how long the rest are then given, in milliseconds. */
export const QUICK = { enough: 2, graceMs: 700 } as const;

export function quickRelays(urls: readonly string[], open: (url: string) => OneRelay, quick: { enough: number; graceMs: number } = QUICK): QuickRelays {
  const relays = urls.map((url) => open(url));
  /** Run one thing at every relay. Finished when all are, or a moment after `enough` of them counted as good. */
  const gather = <T>(each: (relay: OneRelay) => Promise<T>, good: (got: T) => boolean): Promise<T[]> =>
    new Promise((resolve) => {
      const got: T[] = [];
      let left = relays.length;
      let goodOnes = 0;
      let grace: ReturnType<typeof setTimeout> | null = null;
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        if (grace) clearTimeout(grace);
        resolve(got);
      };
      if (left === 0) return finish();
      for (const relay of relays) {
        void each(relay)
          .then((result) => {
            if (over) return;
            got.push(result);
            if (good(result)) goodOnes++;
          })
          .catch(() => {})
          .finally(() => {
            left--;
            if (left === 0) return finish();
            if (goodOnes >= Math.min(quick.enough, relays.length) && !grace) grace = setTimeout(finish, quick.graceMs);
          });
      }
    });
  return {
    relayUrls: [...urls],
    async queryQuorum(filter, timeoutMs) {
      const answers = await gather((relay) => relay.queryQuorum(filter, timeoutMs), (answer) => answer.respondedCount > 0);
      return { outcomes: answers.flatMap((answer) => answer.outcomes), respondedCount: answers.reduce((sum, answer) => sum + answer.respondedCount, 0) };
    },
    async publishAll(event, timeoutMs) {
      return (await gather((relay) => relay.publishAll(event, timeoutMs), (outcomes) => outcomes.some((outcome) => outcome.result.ok))).flat();
    },
    closeAll() {
      for (const relay of relays) relay.closeAll();
    }
  };
}
