/**
 * A single relay WebSocket connection: NIP-01 EVENT/REQ/CLOSE, NIP-42 AUTH,
 * and NIP-11 relay information document fetches (§11.8, §16.1, §17.3, §19.2).
 */
import { signNostrEvent, verifyNostrEvent, type NostrEvent } from "./event.js";
import { KIND_AUTH } from "./kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { randomBytes } from "../crypto/random.js";
import { bytesToHex } from "../crypto/encoding.js";
import { isAllowedRelayUrl } from "./relayUrl.js";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#d"?: string[];
  "#e"?: string[];
  [key: string]: string[] | number[] | number | undefined;
}

export interface Nip11Info {
  name?: string;
  max_content_length?: number;
  max_message_length?: number;
  [key: string]: unknown;
}

export interface PublishResult {
  ok: boolean;
  message: string;
}

type WebSocketLike = InstanceType<typeof WebSocket>;

function webSocketCtor(): typeof WebSocket {
  const ctor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!ctor)
    throw new Error(
      "No global WebSocket implementation is available in this environment.",
    );
  return ctor;
}

export interface RelayConnectionOptions {
  /** If provided, the connection answers NIP-42 AUTH challenges by signing with this identity. */
  authPrivateKey?: Uint8Array;
  connectTimeoutMs?: number;
}

/** Hard ceiling on events buffered per query, regardless of the requested
 *  limit -- the local backstop against an adversarial relay spraying events
 *  before EOSE. Far above any legitimate BitLogin query (capsules and lists
 *  are single-digit result sets). */
const MAX_BUFFERED_EVENTS = 1000;

export class RelayConnection {
  readonly url: string;
  private ws: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private subs = new Map<
    string,
    {
      events: NostrEvent[];
      /** Ids already buffered, for replay dedup (buffered queries only). */
      seenIds: Set<string>;
      filter: NostrFilter;
      onEose: () => void;
      /** Present on live subscriptions (subscribeLive): each verified,
       *  filter-matching event is delivered here instead of buffered. */
      onEvent?: (event: NostrEvent) => void;
    }
  >();
  private pendingPublishes = new Map<string, (result: PublishResult) => void>();
  private readonly authPrivateKey?: Uint8Array;
  private readonly connectTimeoutMs: number;
  private authenticated = false;

  constructor(url: string, options: RelayConnectionOptions = {}) {
    if (!isAllowedRelayUrl(url)) {
      throw new Error(
        "Relay URL must use secure WebSockets, except for an explicit loopback development endpoint.",
      );
    }
    this.url = url;
    this.authPrivateKey = options.authPrivateKey;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 8000;
  }

  async connect(): Promise<void> {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<void>((resolve, reject) => {
      const Ctor = webSocketCtor();
      const socket = new Ctor(this.url);
      this.ws = socket;
      const timer = setTimeout(() => {
        reject(new Error(`Timed out connecting to relay ${this.url}`));
      }, this.connectTimeoutMs);

      socket.addEventListener("open", () => {
        clearTimeout(timer);
        // Re-issue REQ for every subscription that predates this (re)connection.
        // A socket that dropped and reopened lost its server-side subscriptions;
        // without this, a live subscription (subscribeLive) would appear open
        // client-side while the relay no longer delivers anything to it.
        for (const [subId, sub] of this.subs) {
          socket.send(JSON.stringify(["REQ", subId, sub.filter]));
        }
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error(`WebSocket error connecting to relay ${this.url}`));
      });
      socket.addEventListener("close", () => {
        this.connectPromise = null;
      });
      socket.addEventListener("message", (ev: MessageEvent) => {
        this.handleMessage(String(ev.data));
      });
    });
    return this.connectPromise;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
    this.connectPromise = null;
    this.subs.clear();
    this.pendingPublishes.clear();
  }

  private send(payload: unknown): void {
    if (!this.ws) throw new Error("Not connected to relay.");
    this.ws.send(JSON.stringify(payload));
  }

  private handleMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || typeof msg[0] !== "string") return;
    const [type, ...rest] = msg as [string, ...unknown[]];

    if (type === "EVENT") {
      const [subId, event] = rest;
      if (typeof subId !== "string") return;
      const sub = this.subs.get(subId);
      // Relays are untrusted and are not entitled to define the result set.
      // Verify both the event and the full requested NIP-01 filter centrally;
      // callers may still re-check security-sensitive identity constraints.
      if (
        sub &&
        verifyNostrEvent(event) &&
        matchesNostrFilter(event, sub.filter)
      ) {
        if (sub.onEvent) {
          sub.onEvent(event);
        } else {
          // Relays are untrusted: enforce the requested limit and a global
          // ceiling LOCALLY, and drop replayed duplicates, so an adversarial
          // relay cannot amplify memory/CPU by spraying copies before EOSE.
          if (sub.seenIds.has(event.id)) return;
          const cap = Math.min(sub.filter.limit ?? MAX_BUFFERED_EVENTS, MAX_BUFFERED_EVENTS);
          if (sub.events.length >= cap) return;
          sub.seenIds.add(event.id);
          sub.events.push(event);
        }
      }
      return;
    }
    if (type === "EOSE") {
      const [subId] = rest as [string];
      if (typeof subId !== "string") return;
      this.subs.get(subId)?.onEose();
      return;
    }
    if (type === "OK") {
      const [eventId, ok, message] = rest as [string, boolean, string];
      if (
        typeof eventId !== "string" ||
        typeof ok !== "boolean" ||
        (message !== undefined && typeof message !== "string")
      ) {
        return;
      }
      const resolver = this.pendingPublishes.get(eventId);
      resolver?.({ ok, message: message ?? "" });
      this.pendingPublishes.delete(eventId);
      return;
    }
    if (type === "AUTH") {
      const [challenge] = rest as [string];
      if (typeof challenge !== "string") return;
      void this.respondToAuthChallenge(challenge);
      return;
    }
  }

  private async respondToAuthChallenge(challenge: string): Promise<void> {
    if (!this.authPrivateKey) return;
    const pubkey = getPublicKeyHex(this.authPrivateKey);
    const event = signNostrEvent(
      {
        pubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_AUTH,
        tags: [
          ["relay", this.url],
          ["challenge", challenge],
        ],
        content: "",
      },
      this.authPrivateKey,
    );
    this.authenticated = true;
    this.send(["AUTH", event]);
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async publish(event: NostrEvent, timeoutMs = 8000): Promise<PublishResult> {
    await this.connect();
    return new Promise<PublishResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPublishes.delete(event.id);
        resolve({ ok: false, message: "timeout: no OK received from relay" });
      }, timeoutMs);
      this.pendingPublishes.set(event.id, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      this.send(["EVENT", event]);
    });
  }

  /**
   * Opens a subscription that stays live past EOSE: every verified,
   * filter-matching event is delivered to `onEvent` as it arrives, until the
   * returned handle is closed. Survives socket drops -- connect() re-issues
   * REQ for all open subscriptions on reopen -- though events published while
   * the socket was down are only seen if the relay replays them on the new REQ.
   */
  async subscribeLive(
    filter: NostrFilter,
    onEvent: (event: NostrEvent) => void,
  ): Promise<{ close: () => void }> {
    await this.connect();
    const subId = bytesToHex(randomBytes(8));
    this.subs.set(subId, { events: [], seenIds: new Set(), filter, onEose: () => {}, onEvent });
    this.send(["REQ", subId, filter]);
    return {
      close: () => {
        if (!this.subs.delete(subId)) return;
        try {
          this.send(["CLOSE", subId]);
        } catch {
          // Socket already gone; the relay-side subscription died with it.
        }
      },
    };
  }

  async queryOnce(
    filter: NostrFilter,
    timeoutMs = 8000,
  ): Promise<NostrEvent[]> {
    await this.connect();
    // Subscription ids are public wire identifiers scoped to one socket, not
    // secrets — collision is the only failure mode. Drawn from the CSPRNG
    // regardless, so `Math.random` stays banned package-wide (.semgrep.yml)
    // with no standing exception to reason about at review time.
    const subId = bytesToHex(randomBytes(8));

    return new Promise<NostrEvent[]>((resolve, reject) => {
      const events: NostrEvent[] = [];
      const settle = (fail?: Error) => {
        clearTimeout(timer);
        this.subs.delete(subId);
        try {
          this.send(["CLOSE", subId]);
        } catch {
          // The socket died mid-query. The relay-side subscription died with
          // it; what matters is settling the promise below REGARDLESS -- an
          // unreliable relay must not strand a query (and with it everything
          // queued behind the worker's serial queue) until reload.
        }
        if (fail) reject(fail);
        else resolve(events);
      };
      // A relay that opened a socket and then said NOTHING for the whole
      // window has not answered, and must not be counted toward quorum:
      // quorumMet was measuring reachability, not participation, which made
      // every "not enough relays answered" guard -- login, recovery,
      // rotation, and the registration collision check -- near-vacuous
      // against a set of connectable-but-silent relays. Only EOSE is an
      // answer; the timeout is a failure.
      const timer = setTimeout(
        () =>
          settle(
            new Error(
              "relay did not answer the subscription before the timeout",
            ),
          ),
        timeoutMs,
      );
      this.subs.set(subId, { events, seenIds: new Set(), filter, onEose: () => settle() });
      this.send(["REQ", subId, filter]);
    });
  }
}

/** Applies every NIP-01 subscription filter dimension supported by the client. */
export function matchesNostrFilter(
  event: NostrEvent,
  filter: NostrFilter,
): boolean {
  if (filter.ids && !filter.ids.some((prefix) => event.id.startsWith(prefix)))
    return false;
  if (
    filter.authors &&
    !filter.authors.some((prefix) => event.pubkey.startsWith(prefix))
  )
    return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since)
    return false;
  if (filter.until !== undefined && event.created_at > filter.until)
    return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#") || !Array.isArray(values)) continue;
    const tagName = key.slice(1);
    const tagValues = values as unknown[];
    if (
      !event.tags.some(
        (tag) =>
          tag[0] === tagName &&
          tagValues.some((value) => value === (tag[1] ?? "")),
      )
    )
      return false;
  }
  return true;
}

function toHttpUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws/u, "http");
}

/** Fetches and validates a relay's NIP-11 document, used to check size limits before selecting a vault relay (§11.8, §19.2). */
export async function fetchRelayInfo(
  relayUrl: string,
  timeoutMs = 5000,
): Promise<Nip11Info | null> {
  if (!isAllowedRelayUrl(relayUrl)) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(toHttpUrl(relayUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as Nip11Info;
  } catch {
    return null;
  }
}

/** Checks that a relay's advertised NIP-11 limits can carry the largest BitLogin capsule event (§11.8). */
export function relaySupportsCapsuleSize(
  info: Nip11Info | null,
  requiredBytes: number,
): boolean {
  if (!info) return true; // no NIP-11 document: cannot rule it out, caller may still choose to accept
  const contentOk =
    info.max_content_length === undefined ||
    info.max_content_length >= requiredBytes;
  const messageOk =
    info.max_message_length === undefined ||
    info.max_message_length >= requiredBytes;
  return contentOk && messageOk;
}
