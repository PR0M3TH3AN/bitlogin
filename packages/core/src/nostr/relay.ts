/**
 * A single relay WebSocket connection: NIP-01 EVENT/REQ/CLOSE, NIP-42 AUTH,
 * and NIP-11 relay information document fetches (§11.8, §16.1, §17.3, §19.2).
 */
import { computeEventId, signNostrEvent, verifyNostrEvent, type NostrEvent } from "./event.js";
import { KIND_AUTH } from "./kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";

export interface NostrFilter {
  ids?: string[];
  authors?: string[];
  kinds?: number[];
  since?: number;
  until?: number;
  limit?: number;
  "#d"?: string[];
  "#e"?: string[];
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
  if (!ctor) throw new Error("No global WebSocket implementation is available in this environment.");
  return ctor;
}

export interface RelayConnectionOptions {
  /** If provided, the connection answers NIP-42 AUTH challenges by signing with this identity. */
  authPrivateKey?: Uint8Array;
  connectTimeoutMs?: number;
}

export class RelayConnection {
  readonly url: string;
  private ws: WebSocketLike | null = null;
  private connectPromise: Promise<void> | null = null;
  private subs = new Map<string, { events: NostrEvent[]; onEose: () => void }>();
  private pendingPublishes = new Map<string, (result: PublishResult) => void>();
  private readonly authPrivateKey?: Uint8Array;
  private readonly connectTimeoutMs: number;
  private authenticated = false;

  constructor(url: string, options: RelayConnectionOptions = {}) {
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
      const [subId, event] = rest as [string, NostrEvent];
      const sub = this.subs.get(subId);
      if (sub && verifyNostrEvent(event)) sub.events.push(event);
      return;
    }
    if (type === "EOSE") {
      const [subId] = rest as [string];
      this.subs.get(subId)?.onEose();
      return;
    }
    if (type === "OK") {
      const [eventId, ok, message] = rest as [string, boolean, string];
      const resolver = this.pendingPublishes.get(eventId);
      resolver?.({ ok, message: message ?? "" });
      this.pendingPublishes.delete(eventId);
      return;
    }
    if (type === "AUTH") {
      const [challenge] = rest as [string];
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
          ["challenge", challenge]
        ],
        content: ""
      },
      this.authPrivateKey
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

  async queryOnce(filter: NostrFilter, timeoutMs = 8000): Promise<NostrEvent[]> {
    await this.connect();
    const subId = computeEventId({
      pubkey: "0".repeat(64),
      created_at: Date.now(),
      kind: 0,
      tags: [],
      content: JSON.stringify(filter) + Math.random()
    }).slice(0, 16);

    return new Promise<NostrEvent[]>((resolve) => {
      const events: NostrEvent[] = [];
      const finish = () => {
        clearTimeout(timer);
        this.subs.delete(subId);
        this.send(["CLOSE", subId]);
        resolve(events);
      };
      const timer = setTimeout(finish, timeoutMs);
      this.subs.set(subId, { events, onEose: finish });
      this.send(["REQ", subId, filter]);
    });
  }
}

function toHttpUrl(relayUrl: string): string {
  return relayUrl.replace(/^ws/u, "http");
}

/** Fetches and validates a relay's NIP-11 document, used to check size limits before selecting a vault relay (§11.8, §19.2). */
export async function fetchRelayInfo(relayUrl: string, timeoutMs = 5000): Promise<Nip11Info | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(toHttpUrl(relayUrl), {
      headers: { Accept: "application/nostr+json" },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) return null;
    return (await response.json()) as Nip11Info;
  } catch {
    return null;
  }
}

/** Checks that a relay's advertised NIP-11 limits can carry the largest BitLogin capsule event (§11.8). */
export function relaySupportsCapsuleSize(info: Nip11Info | null, requiredBytes: number): boolean {
  if (!info) return true; // no NIP-11 document: cannot rule it out, caller may still choose to accept
  const contentOk = info.max_content_length === undefined || info.max_content_length >= requiredBytes;
  const messageOk = info.max_message_length === undefined || info.max_message_length >= requiredBytes;
  return contentOk && messageOk;
}
