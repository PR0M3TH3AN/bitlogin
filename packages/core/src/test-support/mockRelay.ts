/**
 * Minimal in-process Nostr relay for tests (EVENT/REQ/CLOSE/OK, NIP-01
 * addressable/replaceable replacement semantics). This sandbox has no route
 * to public relays, so protocol-level round trips (create -> login on a
 * "clean device" -> recover) are exercised against this mock instead.
 * Not shipped in the published package.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { verifyNostrEvent, findTagValue, type NostrEvent } from "../nostr/event.js";

function storageKey(event: NostrEvent): string {
  if (event.kind >= 30000 && event.kind < 40000) {
    return `${event.kind}:${event.pubkey}:${findTagValue(event, "d") ?? ""}`;
  }
  if (event.kind === 0 || event.kind === 3 || (event.kind >= 10000 && event.kind < 20000)) {
    return `${event.kind}:${event.pubkey}`;
  }
  return `id:${event.id}`;
}

function isIndexedKind(kind: number): boolean {
  return (kind >= 30000 && kind < 40000) || kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000);
}

export class MockRelay {
  readonly port: number;
  readonly url: string;
  private wss: WebSocketServer;
  private events = new Map<string, NostrEvent>();
  private plainEvents: NostrEvent[] = [];
  public requireAuthForKinds: Set<number> = new Set();

  private constructor(wss: WebSocketServer, port: number) {
    this.wss = wss;
    this.port = port;
    this.url = `ws://127.0.0.1:${port}`;
    this.wss.on("connection", (socket) => this.handleConnection(socket));
  }

  static async start(): Promise<MockRelay> {
    return new Promise((resolve) => {
      const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
      wss.on("listening", () => {
        const address = wss.address();
        const port = typeof address === "object" && address ? address.port : 0;
        resolve(new MockRelay(wss, port));
      });
    });
  }

  private handleConnection(socket: WebSocket): void {
    socket.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!Array.isArray(msg)) return;
      const [type, ...rest] = msg as [string, ...unknown[]];

      if (type === "EVENT") {
        const [event] = rest as [NostrEvent];
        if (!verifyNostrEvent(event)) {
          socket.send(JSON.stringify(["OK", event.id, false, "invalid: bad signature or id"]));
          return;
        }
        if (this.requireAuthForKinds.has(event.kind)) {
          socket.send(JSON.stringify(["OK", event.id, false, "auth-required: publish requires NIP-42 AUTH"]));
          return;
        }
        this.store(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        return;
      }
      if (type === "REQ") {
        const [subId, ...filters] = rest as [string, Record<string, unknown>];
        const matches = this.query(filters[0] ?? {});
        for (const event of matches) socket.send(JSON.stringify(["EVENT", subId, event]));
        socket.send(JSON.stringify(["EOSE", subId]));
        return;
      }
      if (type === "CLOSE") {
        return;
      }
    });
  }

  private store(event: NostrEvent): void {
    if (!isIndexedKind(event.kind)) {
      this.plainEvents.push(event);
      return;
    }
    const key = storageKey(event);
    const existing = this.events.get(key);
    if (!existing) {
      this.events.set(key, event);
      return;
    }
    if (event.created_at > existing.created_at) {
      this.events.set(key, event);
    } else if (event.created_at === existing.created_at && event.id < existing.id) {
      this.events.set(key, event);
    }
    // else: existing event wins, replacement discarded (NIP-01 replacement rule)
  }

  private query(filter: Record<string, unknown>): NostrEvent[] {
    const all = [...this.events.values(), ...this.plainEvents];
    const kinds = filter.kinds as number[] | undefined;
    const authors = filter.authors as string[] | undefined;
    const dTags = filter["#d"] as string[] | undefined;
    const ids = filter.ids as string[] | undefined;
    const limit = filter.limit as number | undefined;

    let results = all.filter((event) => {
      if (kinds && !kinds.includes(event.kind)) return false;
      if (authors && !authors.includes(event.pubkey)) return false;
      if (ids && !ids.includes(event.id)) return false;
      if (dTags && !dTags.includes(findTagValue(event, "d") ?? "")) return false;
      return true;
    });
    results = results.sort((a, b) => b.created_at - a.created_at);
    if (limit !== undefined) results = results.slice(0, limit);
    return results;
  }

  /** Simulates total data loss for this relay (§19.4, §29.3 test scenarios). */
  wipeAllData(): void {
    this.events.clear();
    this.plainEvents = [];
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
