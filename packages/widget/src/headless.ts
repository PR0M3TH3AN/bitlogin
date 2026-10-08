/**
 * Headless BitLogin signer — session restore + signing with NO custom element
 * and no DOM.
 *
 * The `<bitlogin-auth>` widget owns the interactive surface (create / recover /
 * password entry). This is the other half: a host that already has a session
 * established on this origin — set up once, via the widget — and wants to sign
 * programmatically without mounting anything. A background job, a framework that
 * renders its own account UI, a headless test. It spins up the same crypto Web
 * Worker the widget uses, restores the cached session, and exposes
 * getPublicKey / signEvent / nip44 — no `window.nostr`, no element, no styles.
 *
 * It deliberately cannot LOG IN (that needs the password UI): `restore()`
 * returns null when no session is cached, at which point the host should mount
 * `<bitlogin-auth>` once so the user can sign in. After that, this signer works
 * across reloads from the cached session.
 *
 * Deploy `cryptoWorker.js` and the shared chunks alongside the headless build,
 * exactly as for `bitlogin.js` — the worker is where the keys live.
 */
import { WorkerClient } from "./worker/workerClient.js";
import type { SignEventPayload } from "./worker/protocol.js";
import type { NostrEvent } from "@bitlogin/core/nostr";
import { identityFields, type IdentityFields } from "./identity.js";

export interface HeadlessSignerOptions {
  /** Relays for the Connection Vault (only needed for wallet features). */
  vaultRelays?: string[];
  /** Relays for account discovery (only needed for interactive login, which
   *  this signer doesn't do — safe to omit). */
  discoveryRelays?: string[];
}

export interface HeadlessSigner {
  /** Restore the cached session for this origin. Returns the identity, or null
   *  if nothing is cached (mount `<bitlogin-auth>` so the user can sign in).
   *  Idempotent. */
  restore(): Promise<IdentityFields | null>;
  /** Whether a session is unlocked and ready to sign. */
  isUnlocked(): Promise<boolean>;
  /** The signed-in public key (hex). Rejects if no session is unlocked. */
  getPublicKey(): Promise<string>;
  signEvent(event: SignEventPayload): Promise<NostrEvent>;
  nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPublicKey: string, payload: string): Promise<string>;
  /** Clear the cached session for this origin. */
  logout(): Promise<void>;
  /** Tear down the crypto worker. The signer is unusable afterward; create a
   *  new one to sign again. */
  destroy(): void;
}

const NO_SESSION =
  "BitLogin: no session is unlocked. Call restore() first, or have the user sign in once via <bitlogin-auth>.";

/**
 * Create a headless signer and configure its worker. Call `restore()` next to
 * pick up an existing session.
 */
export async function createHeadlessSigner(options: HeadlessSignerOptions = {}): Promise<HeadlessSigner> {
  const client = new WorkerClient();
  await client.configure({
    vaultRelayUrls: options.vaultRelays ?? [],
    discoveryRelayUrls: options.discoveryRelays ?? []
  });

  let pubkey: string | null = null;

  const requirePubkey = async (): Promise<string> => {
    if (pubkey) return pubkey;
    const status = await client.getSessionStatus();
    if (!status.unlocked || !status.everydayPublicKey) throw new Error(NO_SESSION);
    pubkey = status.everydayPublicKey;
    return pubkey;
  };

  return {
    async restore() {
      const res = await client.restoreSession();
      pubkey = res.restored && res.everydayPublicKey ? res.everydayPublicKey : null;
      return pubkey ? identityFields(pubkey) : null;
    },
    async isUnlocked() {
      if (pubkey) return true;
      const status = await client.getSessionStatus();
      if (status.unlocked && status.everydayPublicKey) pubkey = status.everydayPublicKey;
      return Boolean(status.unlocked);
    },
    getPublicKey() {
      return requirePubkey();
    },
    async signEvent(event) {
      await requirePubkey();
      return client.signEvent(event);
    },
    async nip44Encrypt(peerPublicKey, plaintext) {
      await requirePubkey();
      return (await client.nip44Encrypt({ peerPublicKey, plaintext })).ciphertext;
    },
    async nip44Decrypt(peerPublicKey, payload) {
      await requirePubkey();
      return (await client.nip44Decrypt({ peerPublicKey, payload })).plaintext;
    },
    async logout() {
      await client.logout();
      pubkey = null;
    },
    destroy() {
      client.terminate("BitLogin headless signer was destroyed.");
      pubkey = null;
    }
  };
}
