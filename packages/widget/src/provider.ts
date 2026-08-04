/** window.nostr — a NIP-07-compatible provider backed by the crypto worker (§26.2, §26.4). */
import type { NostrEvent, NostrTag } from "@bitlogin/core/nostr";
import type { WorkerClient } from "./worker/workerClient.js";

export interface UnsignedEventForSigning {
  kind: number;
  tags?: NostrTag[];
  content: string;
  created_at?: number;
}

export interface Nip07Provider {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEventForSigning): Promise<NostrEvent>;
  getRelays(): Promise<Record<string, { read: boolean; write: boolean }>>;
  nip44: {
    encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
    decrypt(peerPublicKey: string, payload: string): Promise<string>;
  };
  /** Legacy relative to nip44 above, but present on every real NIP-07 extension -- kept for
   * drop-in parity with sites (or their older DM code paths) that still expect it. */
  nip04: {
    encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
    decrypt(peerPublicKey: string, payload: string): Promise<string>;
  };
  /**
   * Identifies this provider as BitLogin's, distinct from a browser extension (Alby, nos2x,
   * …) that may also implement window.nostr. Only one provider can occupy window.nostr at a
   * time — this lets a host site that supports multiple signing methods tell which one is
   * actually active, e.g. `window.nostr?._bitlogin === true`. Prefer `window.bitlogin` (see
   * index.ts) for this check where available; it survives another provider later overwriting
   * window.nostr, which this flag on the object itself cannot.
   */
  readonly _bitlogin: true;
}

/** The signing surface a <bitlogin-auth> element exposes; the routed provider
 *  below delegates to it so window.nostr always follows the ACTIVE signer. */
export interface ElementSignerApi {
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEventForSigning): Promise<NostrEvent>;
  nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPublicKey: string, payload: string): Promise<string>;
  nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPublicKey: string, payload: string): Promise<string>;
}

/**
 * A window.nostr provider that routes through the element rather than binding
 * the worker directly. The element dispatches each call to whichever signer
 * backs the current session -- the crypto worker for a BitLogin account, the
 * worker-held NIP-46 client for a remote-signer session (§LM3, §LM5) -- so a
 * host page reading window.nostr gets the right backend without caring which
 * method the user picked. (NIP-07 sessions never claim the slot at all; the
 * extension that IS the backend already owns it, §LM4.)
 */
export function createElementRoutedProvider(
  element: ElementSignerApi,
  configuredRelays: () => string[]
): Nip07Provider {
  return {
    getPublicKey: () => element.getPublicKey(),
    signEvent: (event) => element.signEvent(event),
    async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
      const out: Record<string, { read: boolean; write: boolean }> = {};
      for (const url of configuredRelays()) out[url] = { read: true, write: true };
      return out;
    },
    nip44: {
      encrypt: (peerPublicKey, plaintext) => element.nip44Encrypt(peerPublicKey, plaintext),
      decrypt: (peerPublicKey, payload) => element.nip44Decrypt(peerPublicKey, payload)
    },
    nip04: {
      encrypt: (peerPublicKey, plaintext) => element.nip04Encrypt(peerPublicKey, plaintext),
      decrypt: (peerPublicKey, payload) => element.nip04Decrypt(peerPublicKey, payload)
    },
    _bitlogin: true
  };
}

const NOT_UNLOCKED_MESSAGE =
  "BitLogin: no identity is unlocked yet. Add <bitlogin-auth> to the page and let the user sign in, or call it programmatically before invoking window.nostr.";

function wrapUnlockError<T>(promise: Promise<T>): Promise<T> {
  return promise.catch((err: Error) => {
    if (err.message.includes("No identity is unlocked")) throw new Error(NOT_UNLOCKED_MESSAGE);
    throw err;
  });
}

export function createNip07Provider(workerClient: WorkerClient, configuredRelays: () => string[]): Nip07Provider {
  return {
    async getPublicKey(): Promise<string> {
      const { publicKey } = await wrapUnlockError(workerClient.getPublicKey());
      return publicKey;
    },
    async signEvent(event: UnsignedEventForSigning): Promise<NostrEvent> {
      return wrapUnlockError(workerClient.signEvent(event));
    },
    async getRelays(): Promise<Record<string, { read: boolean; write: boolean }>> {
      const out: Record<string, { read: boolean; write: boolean }> = {};
      for (const url of configuredRelays()) out[url] = { read: true, write: true };
      return out;
    },
    nip44: {
      async encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
        const { ciphertext } = await wrapUnlockError(workerClient.nip44Encrypt({ peerPublicKey, plaintext }));
        return ciphertext;
      },
      async decrypt(peerPublicKey: string, payload: string): Promise<string> {
        const { plaintext } = await wrapUnlockError(workerClient.nip44Decrypt({ peerPublicKey, payload }));
        return plaintext;
      }
    },
    nip04: {
      async encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
        const { ciphertext } = await wrapUnlockError(workerClient.nip04Encrypt({ peerPublicKey, plaintext }));
        return ciphertext;
      },
      async decrypt(peerPublicKey: string, payload: string): Promise<string> {
        const { plaintext } = await wrapUnlockError(workerClient.nip04Decrypt({ peerPublicKey, payload }));
        return plaintext;
      }
    },
    _bitlogin: true
  };
}
