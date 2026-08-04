/**
 * NIP-46 remote-signer ("bunker") client (docs/login-methods.md §LM5).
 *
 * The user's key lives in their signer (Amber, nsec.app, an nsecBunker …); this
 * client holds only an ephemeral keypair and a connection secret, and requests
 * signatures over relays as kind-24133 events whose content is NIP-44-encrypted
 * between the client key and the remote signer's key. Memory-only by design:
 * nothing here persists anything, and closing the client ends the session.
 *
 * Two ways to establish a session:
 *  - `bunker://` (parseBunkerUri): the user pastes a URI naming the signer's
 *    pubkey, relays, and an optional secret; the client calls `connect`.
 *  - nostrconnect (buildNostrconnectUri + listenForNostrconnect): the client
 *    displays a URI/QR naming ITS pubkey, relays, and a fresh secret; the
 *    signer initiates and proves itself by echoing the secret.
 *
 * Transport encryption is NIP-44 only, per the current NIP-46 spec; legacy
 * NIP-04-only bunkers are not supported.
 */
import { RelayConnection } from "./relay.js";
import {
  signNostrEvent,
  verifyNostrEvent,
  type NostrEvent,
  type NostrTag
} from "./event.js";
import { KIND_NOSTR_CONNECT } from "./kinds.js";
import { getConversationKey, nip44Encrypt, nip44Decrypt } from "../crypto/nip44.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { randomBytes } from "../crypto/random.js";
import { bytesToHex } from "../crypto/encoding.js";
import { wipe } from "../crypto/memory.js";

const HEX64 = /^[0-9a-f]{64}$/u;

/** Ceiling on relays taken from a bunker:// URI (BL-21). */
const MAX_BUNKER_RELAYS = 8;

export interface BunkerPointer {
  signerPubkey: string;
  relayUrls: string[];
  secret?: string;
}

export class BunkerUriParseError extends Error {
  override name = "BunkerUriParseError";
}

export class Nip46RequestTimeoutError extends Error {
  override name = "Nip46RequestTimeoutError";
  constructor(method: string, timeoutMs: number) {
    super(
      `The remote signer did not answer ${method} within ${Math.round(timeoutMs / 1000)}s. It may be offline, or waiting for your approval on another device -- check your signer and try again.`
    );
  }
}

/** The signer answered, and the answer was a refusal or failure. */
export class Nip46ErrorResponse extends Error {
  override name = "Nip46ErrorResponse";
}

/**
 * Validates a signer-supplied auth_url before it may be shown as a link.
 * Only https (or http to loopback, for local development signers) survives;
 * anything else -- javascript:, data:, blob:, custom schemes, unparseable
 * strings -- returns null and is never surfaced.
 */
export function sanitizeAuthUrl(candidate: string): string | null {
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return null;
  }
  const isLoopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopback)) {
    return url.toString();
  }
  return null;
}

export function parseBunkerUri(uri: string): BunkerPointer {
  let url: URL;
  try {
    url = new URL(uri.trim());
  } catch {
    throw new BunkerUriParseError("That doesn't look like a valid URI.");
  }
  if (url.protocol !== "bunker:") {
    throw new BunkerUriParseError("A remote-signer URI must start with bunker://");
  }
  // Non-special schemes parse inconsistently across engines: the pubkey may
  // land in host or in pathname ("//<hex>"). Accept both.
  const signerPubkey = (url.host || url.pathname.replace(/^\/+/u, "")).toLowerCase();
  if (!HEX64.test(signerPubkey)) {
    throw new BunkerUriParseError("The bunker URI does not name a valid signer public key.");
  }
  // Deduplicate and CAP: the URI is untrusted input, and each relay becomes
  // a live WebSocket -- a crafted 5,000-relay URI must not become 5,000
  // sockets (BL-21). Nobody legitimate needs more than a handful.
  const relayUrls = [
    ...new Set(
      url.searchParams
        .getAll("relay")
        .map((value) => value.trim())
        .filter(Boolean)
    )
  ].slice(0, MAX_BUNKER_RELAYS);
  if (relayUrls.length === 0) {
    throw new BunkerUriParseError(
      "The bunker URI names no relays -- without at least one relay= parameter there is no way to reach the signer."
    );
  }
  const secret = url.searchParams.get("secret") ?? undefined;
  return { signerPubkey, relayUrls, secret: secret || undefined };
}

/** The URI a signer app scans (or receives via paste) in the nostrconnect flow.
 *  Names the CLIENT's pubkey, the relays to answer on, and a fresh secret the
 *  signer must echo back to prove it scanned this exact code. */
export function buildNostrconnectUri(options: {
  clientPubkey: string;
  relayUrls: string[];
  secret: string;
  name?: string;
  perms?: string[];
}): string {
  if (!HEX64.test(options.clientPubkey)) throw new Error("Client public key must be 64 hex characters.");
  if (options.relayUrls.length === 0) throw new Error("At least one relay is required.");
  if (!options.secret) throw new Error("A nostrconnect secret is required.");
  const params = new URLSearchParams();
  for (const relay of options.relayUrls) params.append("relay", relay);
  params.set("secret", options.secret);
  if (options.name) params.set("name", options.name);
  if (options.perms?.length) params.set("perms", options.perms.join(","));
  return `nostrconnect://${options.clientPubkey}?${params.toString()}`;
}

interface PendingRequest {
  resolve: (result: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  authUrlSeen: boolean;
}

export interface Nip46ClientOptions {
  clientSecretKey: Uint8Array;
  pointer: BunkerPointer;
  /** Called (once per request) when the signer asks for interactive approval
   *  at a URL before it will answer -- surface it to the user and keep waiting. */
  onAuthUrl?: (url: string) => void;
  requestTimeoutMs?: number;
}

/** Deadline generous enough for a human to approve a prompt on another device,
 *  but finite -- no silent hangs (§LM3). */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export class Nip46Client {
  private readonly clientSecretKey: Uint8Array;
  private readonly clientPubkey: string;
  private readonly pointer: BunkerPointer;
  private readonly conversationKey: Uint8Array;
  private readonly conns: RelayConnection[];
  private readonly onAuthUrl?: (url: string) => void;
  private readonly requestTimeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private subs: Array<{ close: () => void }> = [];
  private startPromise: Promise<void> | null = null;
  private userPubkeyKnown: string | null = null;
  private closed = false;

  constructor(options: Nip46ClientOptions) {
    this.clientSecretKey = options.clientSecretKey;
    this.clientPubkey = getPublicKeyHex(options.clientSecretKey);
    this.pointer = options.pointer;
    this.conversationKey = getConversationKey(options.clientSecretKey, options.pointer.signerPubkey);
    this.onAuthUrl = options.onAuthUrl;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.conns = options.pointer.relayUrls.map(
      (url) => new RelayConnection(url, { authPrivateKey: options.clientSecretKey })
    );
  }

  /** The user pubkey this session signs for, once get_public_key has answered. */
  get userPublicKey(): string | null {
    return this.userPubkeyKnown;
  }

  private async start(): Promise<void> {
    if (this.closed) throw new Error("This signer connection is closed.");
    if (!this.startPromise) {
      this.startPromise = (async () => {
        const filter = {
          kinds: [KIND_NOSTR_CONNECT],
          authors: [this.pointer.signerPubkey],
          "#p": [this.clientPubkey]
        };
        const results = await Promise.allSettled(
          this.conns.map((conn) => conn.subscribeLive(filter, (event) => this.handleResponse(event)))
        );
        this.subs = results
          .filter((r): r is PromiseFulfilledResult<{ close: () => void }> => r.status === "fulfilled")
          .map((r) => r.value);
        if (this.subs.length === 0) {
          this.startPromise = null;
          throw new Error("Could not reach any of the signer's relays.");
        }
      })();
    }
    return this.startPromise;
  }

  private handleResponse(event: NostrEvent): void {
    // The subscription filter already constrains author and #p; re-check the
    // author anyway -- relays are untrusted (§16.1) and this is the identity
    // the whole session's security rests on.
    if (event.pubkey !== this.pointer.signerPubkey) return;
    let payload: { id?: unknown; result?: unknown; error?: unknown };
    try {
      payload = JSON.parse(nip44Decrypt(this.conversationKey, event.content)) as typeof payload;
    } catch {
      return;
    }
    if (typeof payload.id !== "string") return;
    const request = this.pending.get(payload.id);
    if (!request) return; // answered already by a faster relay, or stale
    if (payload.result === "auth_url") {
      // Interim, not an answer: the signer wants interactive approval at the
      // URL (carried in `error`, per NIP-46). The URL is REMOTE-SIGNER
      // CONTROLLED input that UIs render as a clickable link, so only a
      // validated https URL is ever surfaced (sanitizeAuthUrl) -- a hostile
      // signer must not be able to hand the page a javascript:/data: href.
      // An invalid URL is dropped without consuming the one surfacing slot,
      // so a subsequent well-formed auth_url can still arrive.
      if (!request.authUrlSeen && typeof payload.error === "string" && payload.error) {
        const authUrl = sanitizeAuthUrl(payload.error);
        if (authUrl) {
          request.authUrlSeen = true;
          this.onAuthUrl?.(authUrl);
        }
      }
      return;
    }
    this.pending.delete(payload.id);
    clearTimeout(request.timer);
    if (typeof payload.error === "string" && payload.error) {
      request.reject(new Nip46ErrorResponse(payload.error));
      return;
    }
    if (typeof payload.result !== "string") {
      request.reject(new Error("The signer returned a malformed response."));
      return;
    }
    request.resolve(payload.result);
  }

  private async rpc(method: string, params: string[]): Promise<string> {
    await this.start();
    const id = bytesToHex(randomBytes(8));
    const content = nip44Encrypt(this.conversationKey, JSON.stringify({ id, method, params }));
    const tags: NostrTag[] = [["p", this.pointer.signerPubkey]];
    const event = signNostrEvent(
      {
        pubkey: this.clientPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_NOSTR_CONNECT,
        tags,
        content
      },
      this.clientSecretKey
    );

    const wait = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Nip46RequestTimeoutError(method, this.requestTimeoutMs));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, authUrlSeen: false });
    });
    // Swallow the local rejection path used below; callers await `wait` only
    // when at least one relay accepted the request.
    wait.catch(() => {});

    const publishes = await Promise.allSettled(this.conns.map((conn) => conn.publish(event)));
    const accepted = publishes.some((p) => p.status === "fulfilled" && p.value.ok);
    if (!accepted) {
      const request = this.pending.get(id);
      if (request) {
        this.pending.delete(id);
        clearTimeout(request.timer);
      }
      throw new Error("No relay accepted the request to the signer.");
    }
    return wait;
  }

  /** bunker:// flow: announce ourselves; any non-error answer is acceptance. */
  async connect(): Promise<void> {
    await this.rpc("connect", [this.pointer.signerPubkey, this.pointer.secret ?? ""]);
  }

  async getUserPublicKey(): Promise<string> {
    const result = (await this.rpc("get_public_key", [])).trim().toLowerCase();
    if (!HEX64.test(result)) throw new Error("The signer returned an invalid public key.");
    this.userPubkeyKnown = result;
    return result;
  }

  async signEvent(unsigned: {
    kind: number;
    content: string;
    tags: string[][];
    created_at: number;
  }): Promise<NostrEvent> {
    const toSign = this.userPubkeyKnown ? { ...unsigned, pubkey: this.userPubkeyKnown } : unsigned;
    const result = await this.rpc("sign_event", [JSON.stringify(toSign)]);
    let event: unknown;
    try {
      event = JSON.parse(result);
    } catch {
      throw new Error("The signer returned a malformed signed event.");
    }
    if (!verifyNostrEvent(event)) {
      throw new Error("The signer returned an event that does not verify.");
    }
    if (this.userPubkeyKnown && event.pubkey !== this.userPubkeyKnown) {
      throw new Error("The signer returned an event signed by a different identity.");
    }
    // Signature and identity are necessary but not sufficient: the signer
    // could sign a DIFFERENT event than the one requested. Enforce field
    // equality so callers get exactly what they asked to have signed.
    if (
      event.kind !== unsigned.kind ||
      event.content !== unsigned.content ||
      event.created_at !== unsigned.created_at ||
      JSON.stringify(event.tags) !== JSON.stringify(unsigned.tags)
    ) {
      throw new Error("The signer returned a different event than the one requested.");
    }
    return event;
  }

  async nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return this.rpc("nip44_encrypt", [peerPublicKey, plaintext]);
  }

  async nip44Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return this.rpc("nip44_decrypt", [peerPublicKey, payload]);
  }

  async nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return this.rpc("nip04_encrypt", [peerPublicKey, plaintext]);
  }

  async nip04Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return this.rpc("nip04_decrypt", [peerPublicKey, payload]);
  }

  /**
   * Courtesy logout per current NIP-46 -- explicitly not a security boundary
   * (the signer revokes authorization on its own side); best-effort, bounded,
   * and never allowed to block or fail teardown. Call before close().
   */
  async logout(timeoutMs = 2000): Promise<void> {
    if (this.closed) return;
    try {
      const id = bytesToHex(randomBytes(8));
      const content = nip44Encrypt(
        this.conversationKey,
        JSON.stringify({ id, method: "logout", params: [] })
      );
      const event = signNostrEvent(
        {
          pubkey: this.clientPubkey,
          created_at: Math.floor(Date.now() / 1000),
          kind: KIND_NOSTR_CONNECT,
          tags: [["p", this.pointer.signerPubkey]],
          content
        },
        this.clientSecretKey
      );
      await Promise.race([
        Promise.allSettled(this.conns.map((conn) => conn.publish(event))),
        new Promise((resolve) => setTimeout(resolve, timeoutMs))
      ]);
    } catch {
      // Courtesy only.
    }
  }

  close(): void {
    this.closed = true;
    for (const sub of this.subs) sub.close();
    this.subs = [];
    for (const conn of this.conns) conn.close();
    for (const [, request] of this.pending) {
      clearTimeout(request.timer);
      request.reject(new Error("The signer connection was closed."));
    }
    this.pending.clear();
    // Shortest-practical-lifetime handling (§11.10): the ephemeral client
    // key and the conversation key derived from it die with the session.
    wipe(this.clientSecretKey);
    wipe(this.conversationKey);
  }
}

/**
 * nostrconnect flow: after the URI from buildNostrconnectUri is shown to the
 * signer (QR or paste), wait for ANY signer to send a kind-24133 event to the
 * client pubkey whose decrypted payload echoes the secret. The echo is the
 * proof of possession -- an attacker who saw the client pubkey on a relay but
 * not the URI cannot produce it. Resolves the signer's pubkey; hand it to
 * Nip46Client as a BunkerPointer (same clientSecretKey) to run the session.
 */
export async function listenForNostrconnect(options: {
  clientSecretKey: Uint8Array;
  relayUrls: string[];
  secret: string;
  timeoutMs?: number;
  /** Cancels the listen (superseded attempt, user backed out, disconnect):
   *  connections close and the promise rejects promptly instead of running
   *  out its full window (BL-22). */
  signal?: AbortSignal;
}): Promise<{ signerPubkey: string }> {
  const clientPubkey = getPublicKeyHex(options.clientSecretKey);
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const conns = options.relayUrls.map(
    (url) => new RelayConnection(url, { authPrivateKey: options.clientSecretKey })
  );
  const closeAll = () => {
    for (const conn of conns) conn.close();
  };

  return new Promise<{ signerPubkey: string }>((resolve, reject) => {
    let settled = false;
    const onAbort = () => settle(new Error("The signer-connection attempt was cancelled."));
    const settle = (outcome: { signerPubkey: string } | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      closeAll();
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    };
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            `No signer connected within ${Math.round(timeoutMs / 1000)}s. Scan or paste the connection code in your signer app, then try again.`
          )
        ),
      timeoutMs
    );
    if (options.signal?.aborted) {
      onAbort();
      return;
    }
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const filter = { kinds: [KIND_NOSTR_CONNECT], "#p": [clientPubkey] };
    const onEvent = (event: NostrEvent) => {
      // The sender is unknown until the secret verifies, so the conversation
      // key is derived per candidate event -- and wiped per candidate, not
      // left to garbage collection (§11.10, BL-22).
      let payload: { result?: unknown };
      let conversationKey: Uint8Array | null = null;
      try {
        conversationKey = getConversationKey(options.clientSecretKey, event.pubkey);
        payload = JSON.parse(nip44Decrypt(conversationKey, event.content)) as typeof payload;
      } catch {
        return;
      } finally {
        if (conversationKey) wipe(conversationKey);
      }
      if (payload.result === options.secret) settle({ signerPubkey: event.pubkey });
    };

    void Promise.allSettled(conns.map((conn) => conn.subscribeLive(filter, onEvent))).then(
      (results) => {
        if (!results.some((r) => r.status === "fulfilled")) {
          settle(new Error("Could not reach any relay to listen for the signer."));
        }
      }
    );
  });
}
