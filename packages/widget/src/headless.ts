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
import type { KeptAccountInfo, LockStatusResult, SignEventPayload } from "./worker/protocol.js";
import type { NostrEvent } from "@bitlogin/core/nostr";
import type { WorldMore } from "./embedded/follows.js";
import type { ReadMessage, WrittenMessage } from "./embedded/messages.js";

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
  /**
   * The accounts kept signed in on this device (docs/account-switching.md):
   * public keys, and what their own profiles call them. Nothing secret.
   */
  accounts(): Promise<KeptAccountInfo[]>;
  /**
   * Switch to one of them: no password, no relay. This signer then holds
   * its session. `locked` means the optional lock must be opened first
   * (`lockOpen`); null means it is no longer kept here.
   */
  switchAccount(pubkey: string): Promise<{ pubkey: string } | { locked: true } | null>;
  /** Make room to sign in as another account: nobody is signed in, and everyone kept stays kept. */
  addAccount(): Promise<void>;
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
    remember?: boolean,
    /** The user allowed every site of this family, `https://*.domain` (docs/site-family.md). Only with `remember`. */
    family?: string,
    /** What the user let this world do beyond a note and a reaction, by name ("follows"). Never with `app` or `family`. */
    more?: readonly string[]
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
  loadProfile(options?: { profile?: boolean }): Promise<Profile | null>;
  /**
   * At the sign-in address: take a site back, or every site
   * (docs/take-back.md). Publishes the record every embedded signer obeys.
   * `ok` false means nothing was taken back.
   */
  takeBack(what: { site: string } | { all: true }): Promise<{ ok: boolean; accepted: number; of: number }>;
  /**
   * In the embedded signer: ask the user's relays whether this site was
   * taken back, if it is time to. "ended" means the grant is gone.
   */
  checkTakenBack(site: string): Promise<"ok" | "ended" | "stale">;
  /**
   * In a session that arrived by a hand-off for a site that declared no
   * permissions: a room pass (NSWP kind 27300) for that site, naming the
   * given session key. Everything else in it is the worker's own.
   */
  roomPass(session: string): Promise<NostrEvent>;
  /**
   * In the same kind of session: what the world keeps for its visitor
   * (NSWP-12). A save for the site the session serves, signed; where that
   * site's save in a slot is kept; and a save opened, only if it is that
   * site's. Each is refused for anything else.
   */
  worldSave(slot: string, data: string): Promise<NostrEvent>;
  worldFind(slot: string): Promise<string>;
  worldOpen(event: unknown): Promise<{ slot: string; data: string; at: number }>;
  /**
   * In the same kind of session, for a world the user let change who they
   * follow (NSWP-14): their follow list with one person added or taken out,
   * signed. `list` is their newest as the world found it, or null.
   */
  worldFollow(list: unknown, change: { add?: string; remove?: string }): Promise<NostrEvent>;
  /** In the same kind of session: a score on one of a world's boards (NSWP-15), built whole in the worker and marked with the site the session serves. */
  worldScore(world: string, board: string, score: number): Promise<NostrEvent>;
  /**
   * In the same kind of session, for a world the user let send and read
   * their private messages (NSWP-14): a message written and sealed twice; a
   * wrap opened; and the list of where their messages reach them, signed.
   */
  worldSeal(to: string, text: string): Promise<{ message: WrittenMessage; seals: [NostrEvent, NostrEvent] }>;
  worldUnwrap(event: unknown): Promise<ReadMessage>;
  worldReach(relays: string[]): Promise<NostrEvent>;
  /**
   * Receiving side, last step: open the hand-off. This signer then holds a
   * signer-only session, in memory: it can sign and say who it is, and
   * nothing else, and nothing is cached.
   */
  acceptHandoff(
    sealed: { senderPublicKey: string; payload: string }
  ): Promise<{ pubkey: string; app?: { site: string; permissions: AppPermissions }; site?: string; profile?: Profile; remember?: boolean; family?: string; more?: WorldMore[] }>;
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
    site: string,
    /** The family the site is in (publicSuffix.ts): its grant is taken up where the site has none of its own. */
    family?: string
  ): Promise<{ pubkey: string; until: number; name?: string; profile?: Profile; signed: number[]; signedPass?: number[]; check?: "fresh" | "due" | "overdue"; family?: string; more?: WorldMore[]; permissions?: AppPermissions; signedSensitive?: number[] } | null>;
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
    async accounts() {
      return (await client.accountsList()).accounts;
    },
    async switchAccount(to) {
      const res = await client.accountsSwitch(to);
      if (res.locked) return { locked: true };
      pubkey = res.restored && res.everydayPublicKey ? res.everydayPublicKey : null;
      return pubkey ? { pubkey } : null;
    },
    async addAccount() {
      await client.accountsAdd();
      pubkey = null;
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
    async exportHandoff(recipientPublicKey, app, site, remember, family, more) {
      await requirePubkey();
      return client.handoffExport({ recipientPublicKey, ...(app ? { app } : {}), ...(site ? { site } : {}), ...(remember ? { remember: true } : {}), ...(family ? { family } : {}), ...(more?.length ? { more: [...more] } : {}) });
    },
    async lockStatus() {
      return client.lockStatus();
    },
    async lockOpen(with_) {
      const res = await client.lockOpen(with_);
      pubkey = res.ok && res.everydayPublicKey ? res.everydayPublicKey : null;
      return { ok: res.ok, left: res.left, removed: res.removed };
    },
    async loadProfile(options = {}) {
      await requirePubkey();
      return (await client.loadProfile(options)).profile ?? null;
    },
    async takeBack(what) {
      await requirePubkey();
      return client.takeBack(what);
    },
    async checkTakenBack(site) {
      return (await client.signerCheck({ site })).state;
    },
    async roomPass(sessionKey) {
      return client.roomPass({ session: sessionKey });
    },
    async worldSave(slot, data) {
      return client.worldSave({ slot, data });
    },
    async worldFind(slot) {
      return (await client.worldFind({ slot })).d;
    },
    async worldOpen(event) {
      return client.worldOpen({ event });
    },
    async worldFollow(list, change) {
      return client.worldFollow({ list, ...change });
    },
    async worldSeal(to, text) {
      return client.worldSeal({ to, text });
    },
    async worldUnwrap(event) {
      return (await client.worldUnwrap({ event })).message;
    },
    async worldReach(relays) {
      return client.worldReach({ relays });
    },
    async worldScore(world, board, score) {
      return client.worldScore({ world, board, score });
    },
    async acceptHandoff(sealed) {
      const res = await client.handoffAccept(sealed);
      pubkey = res.everydayPublicKey;
      return { pubkey, ...(res.app ? { app: res.app } : {}), ...(res.site ? { site: res.site } : {}), ...(res.profile ? { profile: res.profile } : {}), ...(res.remember ? { remember: true } : {}), ...(res.family ? { family: res.family } : {}), ...(res.more?.length ? { more: res.more } : {}) };
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
    async restoreSignerGrant(site, family) {
      const res = await client.signerRestore({ site, ...(family ? { family } : {}) });
      if (!res.restored || !res.everydayPublicKey || typeof res.until !== "number") return null;
      pubkey = res.everydayPublicKey;
      return {
        pubkey,
        until: res.until,
        ...(res.name ? { name: res.name } : {}),
        ...(res.profile ? { profile: res.profile } : {}),
        signed: res.signed ?? [],
        ...(res.signedPass ? { signedPass: res.signedPass } : {}),
        ...(res.check ? { check: res.check } : {}),
        ...(res.family ? { family: res.family } : {}),
        ...(res.more?.length ? { more: res.more } : {}),
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
