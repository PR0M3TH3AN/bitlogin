/**
 * The worker's relay connections, kept open between actions, and a short memory of relays that failed
 * (docs/panel-speed-2026-11-23.md, round three).
 *
 * Each action used to open a new connection to every relay and close it after. Kept, a read after the first goes out
 * at once, without a connection to make, and the browser is not asked for a new connection each time (it throttles
 * those while others are pending or have failed).
 *
 * A relay that refused, never finished connecting, or connected and never answered is remembered for a few minutes.
 * In that time it is asked nothing and sent records without being waited for: it has the copy when it comes back,
 * and nothing waits on it. It is remembered only for what it really did, when it was tried; and where every relay is
 * remembered, every relay is asked anyway (RelayPool). So a careful read that skipped one still waited for every relay
 * that hadn't just failed.
 *
 * Everything is closed when the session goes: at sign-out, at the lock, on switching accounts, and when the panel's
 * worker is let go.
 */
import { RelayConnection } from "@bitlogin/core/nostr";

/** How long a relay that failed is left out of what is waited for. Short: a relay that was down is soon asked again. */
export const REMEMBER_FAILED_MS = 3 * 60_000;

export class RelayKeeper {
  private readonly connections = new Map<string, RelayConnection>();
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly connectTimeoutMs: number,
    private readonly now: () => number = Date.now,
    private readonly open: (url: string, connectTimeoutMs: number) => RelayConnection = (url, ms) => new RelayConnection(url, { connectTimeoutMs: ms })
  ) {}

  /** The kept connection to a relay, opened the first time it is wanted. */
  connectionFor = (url: string): RelayConnection => {
    let conn = this.connections.get(url);
    if (!conn) {
      conn = this.open(url, this.connectTimeoutMs);
      this.connections.set(url, conn);
    }
    return conn;
  };

  /** Whether this relay failed within the memory's time. */
  notWaitedFor = (url: string): boolean => {
    const at = this.failedAt.get(url);
    if (at === undefined) return false;
    if (this.now() - at < REMEMBER_FAILED_MS) return true;
    this.failedAt.delete(url);
    return false;
  };

  /**
   * What a relay did when it was tried. A failure is remembered, and its connection dropped, so the next try after the
   * memory's time starts afresh. An answer clears what was remembered.
   */
  heard = (url: string, answered: boolean): void => {
    if (answered) {
      this.failedAt.delete(url);
      return;
    }
    this.failedAt.set(url, this.now());
    this.connections.get(url)?.close();
    this.connections.delete(url);
  };

  /** The session is gone: every connection is closed, and nothing is remembered. */
  closeAll(): void {
    for (const conn of this.connections.values()) conn.close();
    this.connections.clear();
    this.failedAt.clear();
  }
}
