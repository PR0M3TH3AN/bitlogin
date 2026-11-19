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
import type { AppPermissions } from "./embedded/permissions.js";
import type { Profile } from "./embedded/profile.js";
import { WorkerClient } from "./worker/workerClient.js";
import type { LockStatusResult, SignEventPayload } from "./worker/protocol.js";
import type { NostrEvent } from "@bitlogin/core/nostr";

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
  restore(): Promise<{ pubkey: string } | null>;
  /** Whether a session is unlocked and ready to sign. */
  isUnlocked(): Promise<boolean>;
  /** The signed-in public key (hex). Rejects if no session is unlocked. */
  getPublicKey(): Promise<string>;
  signEvent(event: SignEventPayload): Promise<NostrEvent>;
  nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPublicKey: string, payload: string): Promise<string>;
  /**
   * Signer hand-off (docs/sign-in-window.md), receiving side, first step: a
   * throwaway public key for a window of this same origin to seal the
   * hand-off to. Use it once.
   */
  beginHandoff(): Promise<string>;
  /**
   * Sending side: seal this session's everyday key (and nothing else) to the
   * receiving worker's throwaway key. Rejects if no session is unlocked, or
   * if this session itself arrived by a hand-off. The caller must deliver the
   * result only to a frame of this origin.
   */
  exportHandoff(
    recipientPublicKey: string,
    app?: { site: string; permissions: unknown },
    /** The site the hand-off is for, as the signer reported it. Sealed with the key. */
    site?: string,
    /** The user left "remember" ticked in the window. Without it nothing is kept. */
    remember?: boolean
  ): Promise<{ senderPublicKey: string; payload: string }>;
  /** The optional lock (docs/sign-in-window.md §SW12): whether it is on, and whether it is locked now. */
  lockStatus(): Promise<LockStatusResult>;
  /**
   * Open the lock, with the PIN or with the device's PRF output (base64url).
   * On success this signer holds the session. A wrong try is counted; one
   * too many removes the lock and what was cached.
   */
  lockOpen(with_: { pin?: string; prfOutput?: string }): Promise<{ ok: boolean; left: number; removed: boolean }>;
  /**
   * At the sign-in address, before a hand-off: fetch this account's own
   * signed profile (kind 0) and check it. What is found is sealed into the
   * next hand-off by the worker. Resolves null when there is none, or no
   * relay answered. Refused in a session that arrived by a hand-off.
   */
  loadProfile(): Promise<Profile | null>;
  /**
   * In a session that arrived by a hand-off for a site that declared no
   * permissions: a room pass (NSWP kind 27300) for that site, naming the
   * given session key. Everything else in it is the worker's own.
   */
  roomPass(session: string): Promise<NostrEvent>;
  /**
   * Receiving side, last step: open the hand-off. This signer then holds a
   * signer-only session, in memory: it can sign and say who it is, and
   * nothing else, and nothing is cached.
   */
  acceptHandoff(
    sealed: { senderPublicKey: string; payload: string }
  ): Promise<{ pubkey: string; app?: { site: string; permissions: AppPermissions }; site?: string; profile?: Profile; remember?: boolean }>;
  /**
   * For a session an application was approved for (docs/sign-in-window.md
   * §SW9.5). Each rejects unless the session carries a permission set that
   * covers it: the worker decides, not the caller.
   */
  appEncrypt(peerPublicKey: string, text: string, scheme?: "nip44" | "nip04"): Promise<string>;
  /** Only against a key in the set's `peers`. */
  appDecrypt(peerPublicKey: string, text: string, scheme?: "nip44" | "nip04"): Promise<string>;
  /** The content of a whole signed event of a kind the set may read. */
  appDecryptEvent(event: unknown): Promise<string>;
  /** Whether the unlocked session arrived by a hand-off and can only sign. */
  isSignerOnly(): Promise<boolean>;
  /**
   * For the embedded signer (docs/sign-in-window.md §SW11): keep this
   * hand-off for one asking site, encrypted at rest, until `until`
   * (seconds; never past thirty days), so the user is not asked again on
   * that site's next page load. Only a signer-only session can be kept.
   * Resolves false where it could not be kept.
   */
  keepSignerGrant(grant: { site: string; until: number; name?: string }): Promise<boolean>;
  /**
   * Take up what was kept for a site, if it is still in date: this signer
   * then holds a signer-only session. Null when nothing is kept for it.
   */
  restoreSignerGrant(
    site: string
  ): Promise<{ pubkey: string; until: number; name?: string; profile?: Profile; signed: number[]; signedPass?: number[]; permissions?: AppPermissions; signedSensitive?: number[] } | null>;
  /** Record when the last signatures for a site were made, so reloading its page can't lose the count. */
  touchSignerGrant(site: string, signed: number[], signedSensitive?: number[], signedPass?: number[]): Promise<void>;
  /** Forget a site. */
  forgetSignerGrant(site: string): Promise<void>;
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
      return pubkey ? { pubkey } : null;
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
    async beginHandoff() {
      return (await client.handoffBegin()).recipientPublicKey;
    },
    async exportHandoff(recipientPublicKey, app, site, remember) {
      await requirePubkey();
      return client.handoffExport({ recipientPublicKey, ...(app ? { app } : {}), ...(site ? { site } : {}), ...(remember ? { remember: true } : {}) });
    },
    async lockStatus() {
      return client.lockStatus();
    },
    async lockOpen(with_) {
      const res = await client.lockOpen(with_);
      pubkey = res.ok && res.everydayPublicKey ? res.everydayPublicKey : null;
      return { ok: res.ok, left: res.left, removed: res.removed };
    },
    async loadProfile() {
      await requirePubkey();
      return (await client.loadProfile()).profile ?? null;
    },
    async roomPass(sessionKey) {
      return client.roomPass({ session: sessionKey });
    },
    async acceptHandoff(sealed) {
      const res = await client.handoffAccept(sealed);
      pubkey = res.everydayPublicKey;
      return { pubkey, ...(res.app ? { app: res.app } : {}), ...(res.site ? { site: res.site } : {}), ...(res.profile ? { profile: res.profile } : {}), ...(res.remember ? { remember: true } : {}) };
    },
    async appEncrypt(peerPublicKey, text, scheme = "nip44") {
      return (await client.appEncrypt({ peerPublicKey, text, scheme })).text;
    },
    async appDecrypt(peerPublicKey, text, scheme = "nip44") {
      return (await client.appDecrypt({ peerPublicKey, text, scheme })).text;
    },
    async appDecryptEvent(event) {
      return (await client.appDecryptEvent({ event })).text;
    },
    async isSignerOnly() {
      return Boolean((await client.getSessionStatus()).signerOnly);
    },
    async keepSignerGrant(grant) {
      return (await client.signerKeep(grant)).kept;
    },
    async restoreSignerGrant(site) {
      const res = await client.signerRestore({ site });
      if (!res.restored || !res.everydayPublicKey || typeof res.until !== "number") return null;
      pubkey = res.everydayPublicKey;
      return {
        pubkey,
        until: res.until,
        ...(res.name ? { name: res.name } : {}),
        ...(res.profile ? { profile: res.profile } : {}),
        signed: res.signed ?? [],
        ...(res.signedPass ? { signedPass: res.signedPass } : {}),
        ...(res.permissions ? { permissions: res.permissions, signedSensitive: res.signedSensitive ?? [] } : {})
      };
    },
    async touchSignerGrant(site, signed, signedSensitive, signedPass) {
      await client.signerTouch({ site, signed, ...(signedSensitive ? { signedSensitive } : {}), ...(signedPass ? { signedPass } : {}) });
    },
    async forgetSignerGrant(site) {
      await client.signerForget({ site });
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
