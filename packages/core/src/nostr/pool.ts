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

export interface RelayPoolOptions {
  authPrivateKey?: Uint8Array;
  connectTimeoutMs?: number;
  /**
   * Connections kept by the caller, open between pools (the worker's: docs/panel-speed-2026-11-23.md). `closeAll`
   * then leaves them open: they are the caller's to close.
   */
  connectionFor?: (url: string) => RelayConnection;
  /**
   * Relays that failed a moment ago: asked nothing, and sent records without being waited for. Where every relay is
   * one, all are asked anyway, so a pool never asks nobody.
   */
  notWaitedFor?: (url: string) => boolean;
  /** Told, for each relay asked or sent to, whether it answered (EOSE, or OK either way) or failed. */
  heard?: (url: string, answered: boolean) => void;
}

const NOT_WAITED = "Not waited for: it didn't answer a moment ago.";

export class RelayPool {
  private readonly connections: Map<string, RelayConnection> = new Map();
  private readonly kept: boolean;
  private readonly notWaitedFor: (url: string) => boolean;
  private readonly heard: (url: string, answered: boolean) => void;

  constructor(relayUrls: string[], options: RelayPoolOptions = {}) {
    this.kept = Boolean(options.connectionFor);
    this.notWaitedFor = options.notWaitedFor ?? (() => false);
    this.heard = options.heard ?? (() => {});
    for (const url of new Set(relayUrls)) {
      this.connections.set(url, options.connectionFor ? options.connectionFor(url) : new RelayConnection(url, options));
    }
  }

  /** The relays waited for this time, and the ones not: those that failed a moment ago, unless that is every one. */
  private split(): { waited: [string, RelayConnection][]; skipped: [string, RelayConnection][] } {
    const entries = [...this.connections.entries()];
    const skipped = entries.filter(([url]) => this.notWaitedFor(url));
    if (skipped.length === entries.length) return { waited: entries, skipped: [] };
    return { waited: entries.filter(([url]) => !this.notWaitedFor(url)), skipped };
  }

  /** A record sent to a relay not waited for: it has the copy when it comes back, and nothing waits on it. */
  private sendUnwaited(skipped: [string, RelayConnection][], event: NostrEvent, timeoutMs: number): RelayPublishOutcome[] {
    for (const [relayUrl, conn] of skipped) {
      void conn.publish(event, timeoutMs).then(
        (result) => this.heard(relayUrl, true),
        () => this.heard(relayUrl, false)
      );
    }
    return skipped.map(([relayUrl]) => ({ relayUrl, result: { ok: false, message: NOT_WAITED } }));
  }

  get relayUrls(): string[] {
    return [...this.connections.keys()];
  }

  /** Queries every configured relay and waits for a quorum of responses (or all timeouts) before returning (§16.2). */
  async queryQuorum(filter: NostrFilter, timeoutMs = 8000): Promise<QuorumQueryResult> {
    const { waited, skipped } = this.split();
    const asked = await Promise.all(
      waited.map(async ([relayUrl, conn]): Promise<RelayQueryOutcome> => {
        try {
          const events = await conn.queryOnce(filter, timeoutMs);
          this.heard(relayUrl, true);
          return { relayUrl, events, responded: true };
        } catch (err) {
          this.heard(relayUrl, false);
          return { relayUrl, events: [], responded: false, error: (err as Error).message };
        }
      })
    );
    const outcomes = [...asked, ...skipped.map(([relayUrl]): RelayQueryOutcome => ({ relayUrl, events: [], responded: false, error: NOT_WAITED }))];
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
    const { waited, skipped } = this.split();
    const unwaited = this.sendUnwaited(skipped, event, timeoutMs);
    const sent = await Promise.all(
      waited.map(async ([relayUrl, conn]): Promise<RelayPublishOutcome> => {
        try {
          const result = await conn.publish(event, timeoutMs);
          this.heard(relayUrl, !result.message.startsWith("timeout"));
          return { relayUrl, result };
        } catch (err) {
          this.heard(relayUrl, false);
          return { relayUrl, result: { ok: false, message: (err as Error).message } };
        }
      })
    );
    return [...sent, ...unwaited];
  }

  /**
   * Sent to every relay, as `publishAll`; but finished once every relay has answered, or `graceMs` after `enough` of
   * them have taken it. A relay that connects and never answers then costs the grace, not the whole timeout. With
   * fewer than `enough` taking it, the whole timeout is waited, so nothing is called taken out of impatience. A relay
   * not waited for is reported as not having taken it.
   */
  publishEnough(event: NostrEvent, timeoutMs = 8000, enough = 2, graceMs = 1500): Promise<RelayPublishOutcome[]> {
    const { waited: entries, skipped } = this.split();
    const unwaited = this.sendUnwaited(skipped, event, timeoutMs);
    return new Promise((resolve) => {
      const got = new Map<string, RelayPublishOutcome>();
      let took = 0;
      let grace: ReturnType<typeof setTimeout> | null = null;
      let over = false;
      const finish = () => {
        if (over) return;
        over = true;
        if (grace) clearTimeout(grace);
        resolve([...entries.map(([relayUrl]) => got.get(relayUrl) ?? { relayUrl, result: { ok: false, message: "Not waited for." } }), ...unwaited]);
      };
      if (entries.length === 0) return finish();
      for (const [relayUrl, conn] of entries) {
        conn
          .publish(event, timeoutMs)
          .then(
            (result) => (this.heard(relayUrl, !result.message.startsWith("timeout")), { relayUrl, result }),
            (err: unknown) => (this.heard(relayUrl, false), { relayUrl, result: { ok: false, message: (err as Error).message } })
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
    // Kept connections are the caller's: they stay open for the next pool.
    if (this.kept) return;
    for (const conn of this.connections.values()) conn.close();
  }
}

export function countAcknowledgements(outcomes: RelayPublishOutcome[]): number {
  return outcomes.filter((o) => o.result.ok).length;
}
