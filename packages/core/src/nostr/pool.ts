/** Multi-relay coordination: quorum reads and best-effort broadcast publishing (§16.1, §16.2, §17.3, §19.3). */
import { RelayConnection, type NostrFilter, type PublishResult } from "./relay.js";
import type { NostrEvent } from "./event.js";

export interface RelayQueryOutcome {
  relayUrl: string;
  events: NostrEvent[];
  responded: boolean;
  error?: string;
}

export interface QuorumQueryResult {
  outcomes: RelayQueryOutcome[];
  /** True when at least ceil(N/2) of the N configured relays responded (§16.2 step 1). */
  quorumMet: boolean;
  respondedCount: number;
  totalCount: number;
}

export interface RelayPublishOutcome {
  relayUrl: string;
  result: PublishResult;
}

export class RelayPool {
  private readonly connections: Map<string, RelayConnection> = new Map();

  constructor(relayUrls: string[], options: { authPrivateKey?: Uint8Array; connectTimeoutMs?: number } = {}) {
    for (const url of new Set(relayUrls)) {
      this.connections.set(url, new RelayConnection(url, options));
    }
  }

  get relayUrls(): string[] {
    return [...this.connections.keys()];
  }

  /** Queries every configured relay and waits for a quorum of responses (or all timeouts) before returning (§16.2). */
  async queryQuorum(filter: NostrFilter, timeoutMs = 8000): Promise<QuorumQueryResult> {
    const entries = [...this.connections.entries()];
    const outcomes = await Promise.all(
      entries.map(async ([relayUrl, conn]): Promise<RelayQueryOutcome> => {
        try {
          const events = await conn.queryOnce(filter, timeoutMs);
          return { relayUrl, events, responded: true };
        } catch (err) {
          return { relayUrl, events: [], responded: false, error: (err as Error).message };
        }
      })
    );
    const respondedCount = outcomes.filter((o) => o.responded).length;
    const totalCount = outcomes.length;
    return {
      outcomes,
      quorumMet: respondedCount >= Math.ceil(totalCount / 2),
      respondedCount,
      totalCount
    };
  }

  /** Publishes an event to every configured relay, best-effort (§15.6, §24.4). */
  async publishAll(event: NostrEvent, timeoutMs = 8000): Promise<RelayPublishOutcome[]> {
    const entries = [...this.connections.entries()];
    return Promise.all(
      entries.map(async ([relayUrl, conn]): Promise<RelayPublishOutcome> => {
        try {
          const result = await conn.publish(event, timeoutMs);
          return { relayUrl, result };
        } catch (err) {
          return { relayUrl, result: { ok: false, message: (err as Error).message } };
        }
      })
    );
  }

  /**
   * Sent to every relay, as `publishAll`; but finished once every relay has answered, or `graceMs` after `enough` of
   * them have taken it. A relay that connects and never answers then costs the grace, not the whole timeout. With
   * fewer than `enough` taking it, the whole timeout is waited, so nothing is called taken out of impatience. A relay
   * not waited for is reported as not having taken it.
   */
  publishEnough(event: NostrEvent, timeoutMs = 8000, enough = 2, graceMs = 1500): Promise<RelayPublishOutcome[]> {
    const entries = [...this.connections.entries()];
    return new Promise((resolve) => {
      const got = new Map<string, RelayPublishOutcome>();
      let took = 0;
      let grace: ReturnType<typeof setTimeout> | null = null;
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        if (grace) clearTimeout(grace);
        resolve(entries.map(([relayUrl]) => got.get(relayUrl) ?? { relayUrl, result: { ok: false, message: "Not waited for." } }));
      };
      if (entries.length === 0) return finish();
      for (const [relayUrl, conn] of entries) {
        conn
          .publish(event, timeoutMs)
          .then(
            (result) => ({ relayUrl, result }),
            (err: unknown) => ({ relayUrl, result: { ok: false, message: (err as Error).message } })
          )
          .then((outcome) => {
            if (over) return;
            got.set(relayUrl, outcome);
            if (outcome.result.ok) took++;
            if (got.size === entries.length) return finish();
            if (took >= Math.min(enough, entries.length) && !grace) grace = setTimeout(finish, graceMs);
          });
      }
    });
  }

  closeAll(): void {
    for (const conn of this.connections.values()) conn.close();
  }
}

export function countAcknowledgements(outcomes: RelayPublishOutcome[]): number {
  return outcomes.filter((o) => o.result.ok).length;
}
