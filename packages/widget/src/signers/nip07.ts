/** NIP-07 delegation: sign in with a signer extension already in the browser (§LM4).
 *
 * No key custody, no stored secrets, no relay traffic -- the extension's provider is the
 * backend and this signer is a passthrough with three additions: capability probing,
 * deadlines on every call, and normalization of the unsigned event. A NIP-07 session
 * persists nothing and the widget leaves window.nostr alone -- the extension already
 * owns that slot, and fighting it (claimSigner) is reserved for BitLogin-account
 * sessions where the user explicitly chose BitLogin as their signer.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import type { UnsignedEventForSigning } from "../provider.js";
import {
  SignerTimeoutError,
  SignerUnsupportedError,
  type Signer,
  type SignerCapabilities
} from "./types.js";

interface EncryptDecrypt {
  encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  decrypt(peerPublicKey: string, payload: string): Promise<string>;
}

/** The subset of window.nostr this signer relies on. getPublicKey and signEvent are the
 * only calls NIP-07 actually mandates; everything else is probed (§LM4). */
export interface ForeignNip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: {
    kind: number;
    tags: string[][];
    content: string;
    created_at: number;
  }): Promise<NostrEvent>;
  getRelays?(): Promise<Record<string, { read: boolean; write: boolean }>>;
  nip44?: Partial<EncryptDecrypt>;
  nip04?: Partial<EncryptDecrypt>;
}

/**
 * Returns the window.nostr occupant if -- and only if -- it is someone else's NIP-07
 * provider: a browser extension (Alby, nos2x, …), not this widget's own provider nor
 * another <bitlogin-auth> instance's (both marked `_bitlogin`). The snapshot is taken
 * when called; the caller holds the returned reference so a later change of occupant
 * (including our own claimSigner) can never swap backends mid-session.
 *
 * `host` exists for tests; real callers use the default.
 */
export function detectForeignNip07Provider(
  host: { nostr?: unknown } = window as unknown as { nostr?: unknown }
): ForeignNip07Provider | null {
  const candidate = host.nostr as
    | { _bitlogin?: unknown; getPublicKey?: unknown; signEvent?: unknown }
    | undefined
    | null;
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate._bitlogin === true) return null;
  if (typeof candidate.getPublicKey !== "function" || typeof candidate.signEvent !== "function") return null;
  return candidate as unknown as ForeignNip07Provider;
}

/** Generous because these calls are interactive -- most extensions pop an approval
 * prompt the user has to find and click -- but finite, per §LM3's no-silent-hangs rule. */
const DEFAULT_TIMEOUT_MS = 120_000;

function withDeadline<T>(promise: Promise<T>, call: string, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SignerTimeoutError(call, timeoutMs)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class Nip07Signer implements Signer {
  readonly method = "nip07" as const;
  readonly capabilities: SignerCapabilities;
  private provider: ForeignNip07Provider;
  private timeoutMs: number;

  constructor(provider: ForeignNip07Provider, options: { timeoutMs?: number } = {}) {
    this.provider = provider;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.capabilities = {
      nip44:
        typeof provider.nip44?.encrypt === "function" && typeof provider.nip44?.decrypt === "function",
      nip04:
        typeof provider.nip04?.encrypt === "function" && typeof provider.nip04?.decrypt === "function",
      getRelays: typeof provider.getRelays === "function"
    };
  }

  /** Identity this extension reported; later signEvent results must come
   *  from it -- a multi-profile extension switching accounts mid-session
   *  must surface as an error, not as silently mixed authorship. */
  private knownPublicKey: string | null = null;

  async getPublicKey(): Promise<string> {
    const raw = await withDeadline(this.provider.getPublicKey(), "getPublicKey", this.timeoutMs);
    const publicKey = typeof raw === "string" ? raw.toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(publicKey)) {
      throw new Error("The extension returned an invalid public key (expected 64 hex characters).");
    }
    this.knownPublicKey = publicKey;
    return publicKey;
  }

  async signEvent(event: UnsignedEventForSigning): Promise<NostrEvent> {
    // NIP-07 leaves it to the caller to complete the unsigned event; some extensions
    // reject when created_at or tags are absent, so fill both here rather than making
    // every caller remember to.
    const normalized = {
      kind: event.kind,
      content: event.content,
      tags: (event.tags ?? []) as string[][],
      created_at: event.created_at ?? Math.floor(Date.now() / 1000)
    };
    const signed = await withDeadline(this.provider.signEvent(normalized), "signEvent", this.timeoutMs);
    // The extension is an external signer: verify what came back before any
    // caller treats it as the event they asked for. NIP-07's contract is
    // "the supplied event plus id/pubkey/sig" -- enforce exactly that.
    if (!verifyNostrEvent(signed)) {
      throw new Error("The extension returned an event that does not verify.");
    }
    if (this.knownPublicKey && signed.pubkey !== this.knownPublicKey) {
      throw new Error("The extension signed with a different identity than this session's.");
    }
    if (
      signed.kind !== normalized.kind ||
      signed.content !== normalized.content ||
      signed.created_at !== normalized.created_at ||
      JSON.stringify(signed.tags) !== JSON.stringify(normalized.tags)
    ) {
      throw new Error("The extension returned a different event than the one requested.");
    }
    return signed;
  }

  async nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    if (!this.capabilities.nip44) throw new SignerUnsupportedError("nip44.encrypt", this.method);
    return withDeadline(this.provider.nip44!.encrypt!(peerPublicKey, plaintext), "nip44.encrypt", this.timeoutMs);
  }

  async nip44Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    if (!this.capabilities.nip44) throw new SignerUnsupportedError("nip44.decrypt", this.method);
    return withDeadline(this.provider.nip44!.decrypt!(peerPublicKey, payload), "nip44.decrypt", this.timeoutMs);
  }

  async nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    if (!this.capabilities.nip04) throw new SignerUnsupportedError("nip04.encrypt", this.method);
    return withDeadline(this.provider.nip04!.encrypt!(peerPublicKey, plaintext), "nip04.encrypt", this.timeoutMs);
  }

  async nip04Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    if (!this.capabilities.nip04) throw new SignerUnsupportedError("nip04.decrypt", this.method);
    return withDeadline(this.provider.nip04!.decrypt!(peerPublicKey, payload), "nip04.decrypt", this.timeoutMs);
  }
}
