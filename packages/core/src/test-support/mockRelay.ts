/**
 * Minimal in-process Nostr relay for tests (EVENT/REQ/CLOSE/OK, NIP-01
 * addressable/replaceable replacement semantics). This sandbox has no route
 * to public relays, so protocol-level round trips (create -> login on a
 * "clean device" -> recover) are exercised against this mock instead.
 * Not shipped in the published package.
 */
import { WebSocketServer, type WebSocket } from "ws";
import { compareNip01ReplacementOrder, verifyNostrEvent, findTagValue, type NostrEvent } from "../nostr/event.js";
import { matchesNostrFilter, type NostrFilter } from "../nostr/relay.js";

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
  /** Open subscriptions per socket, for live post-EOSE delivery -- real relays
   *  push newly published events to every matching open REQ, and NIP-46 round
   *  trips depend on that. */
  private liveSubs = new Map<WebSocket, Map<string, NostrFilter>>();
  public requireAuthForKinds: Set<number> = new Set();
  /** Pubkeys whose publishes are refused. Models the partially-hostile relay
   *  that accepts some writes and drops others -- the case that makes write
   *  ORDERING a safety property rather than a style choice. */
  public refusePublishFrom: Set<string> = new Set();
  /** Frames injected before normal query results, even when they do not match
   *  the requested filter. Models a malicious or buggy relay. */
  public unsolicitedQueryEvents: unknown[] = [];
  /** When true, REQ subscriptions never receive EOSE -- models a relay that
   *  goes silent (or dies) mid-query, leaving the client's timeout as the
   *  only way out. */
  public suppressEose = false;
  /** Addressable-event d tags whose publishes are refused. Lets ordering tests
   *  reject recovery writes while still accepting credential writes (or vice
   *  versa), independently of the signing identity. */
  public refusePublishDTags: Set<string> = new Set();

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
          const eventId = typeof event === "object" && event !== null && "id" in event && typeof event.id === "string" ? event.id : "";
          socket.send(JSON.stringify(["OK", eventId, false, "invalid: bad signature, id, or shape"]));
          return;
        }
        if (this.requireAuthForKinds.has(event.kind)) {
          socket.send(JSON.stringify(["OK", event.id, false, "auth-required: publish requires NIP-42 AUTH"]));
          return;
        }
        const dTag = findTagValue(event, "d");
        if (this.refusePublishFrom.has(event.pubkey) || (dTag !== undefined && this.refusePublishDTags.has(dTag))) {
          socket.send(JSON.stringify(["OK", event.id, false, "blocked: refused by test relay"]));
          return;
        }
        this.store(event);
        socket.send(JSON.stringify(["OK", event.id, true, ""]));
        this.broadcast(event);
        return;
      }
      if (type === "REQ") {
        const [subId, ...filters] = rest as [string, Record<string, unknown>];
        const matches = this.query(filters[0] ?? {});
        for (const event of this.unsolicitedQueryEvents) socket.send(JSON.stringify(["EVENT", subId, event]));
        for (const event of matches) socket.send(JSON.stringify(["EVENT", subId, event]));
        if (!this.suppressEose) socket.send(JSON.stringify(["EOSE", subId]));
        let subsForSocket = this.liveSubs.get(socket);
        if (!subsForSocket) {
          subsForSocket = new Map();
          this.liveSubs.set(socket, subsForSocket);
        }
        subsForSocket.set(subId, (filters[0] ?? {}) as NostrFilter);
        return;
      }
      if (type === "CLOSE") {
        const [subId] = rest as [string];
        if (typeof subId === "string") this.liveSubs.get(socket)?.delete(subId);
        return;
      }
    });
    socket.on("close", () => {
      this.liveSubs.delete(socket);
    });
  }

  /** Pushes a just-published event to every open subscription it matches. */
  private broadcast(event: NostrEvent): void {
    for (const [socket, subs] of this.liveSubs) {
      for (const [subId, filter] of subs) {
        if (matchesNostrFilter(event, filter)) {
          socket.send(JSON.stringify(["EVENT", subId, event]));
        }
      }
    }
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
    if (compareNip01ReplacementOrder(event, existing) > 0) {
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
    // Terminate live sockets first: wss.close() only stops listening and its
    // callback waits for every client to leave -- a test closing the relay
    // mid-query (the BL-18 scenario) would otherwise hang here forever.
    for (const socket of this.wss.clients) socket.terminate();
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
