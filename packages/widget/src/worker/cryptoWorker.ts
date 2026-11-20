/**
 * Dedicated crypto Web Worker (§11.10, §22.4). All Argon2id/HKDF/scalar
 * derivation, private key custody, signing, and NIP-44 encryption happen
 * here. The main thread (UI, custom element, window.nostr shim) only ever
 * sees public keys, signed events, ciphertext, and warning strings.
 */
import {
  registerAccount,
  loginWithPassword,
  recoverWithPhrase,
  previewPhraseRebuild,
  rebuildAccountFromPhrase,
  completeRecoveryWithNewCredentials,
  changePassword as changePasswordFlow,
  publishInitialProfile,
  buildRecoveryExport,
  rebroadcastCapsules,
  checkReplicaHealth,
  importAccount,
  decodeEverydayPrivateKey,
  NostrSigner,
  type RecoveredIdentity
} from "@bitlogin/core/account";
import {
  countAcknowledgements,
  RelayPool,
  BUILTIN_VAULT_RELAYS,
  BUILTIN_DISCOVERY_RELAYS,
  loadCachedBootstrapList,
  refreshBootstrapList,
  relaySetsFor,
  type RelaySets,
  encodeNsec,
  encodeNpub,
  Nip46Client,
  parseBunkerUri,
  verifyNostrEvent,
  buildNostrconnectUri,
  listenForNostrconnect,
  type NostrEvent
} from "@bitlogin/core/nostr";
import { getPublicKeyHex, base64urlToBytes, wipe, generatePrivateKey, randomBytes, bytesToHex } from "@bitlogin/core/crypto";
import {
  VaultSession,
  parseNwcUri,
  toNwcUri,
  sameNwcCredential,
  validateNwcCredential,
  type DecryptedConnectionRecord,
  type NwcCredential
} from "@bitlogin/core/vault";
import { IndexedDbKeyValueStore } from "../storage/indexedDbStore.js";
import { saveCachedSession, loadCachedSession, clearCachedSession, cachedSessionState } from "./sessionCache.js";
import { LOCK_LIMITS, openLockWithDevice, openLockWithPin, readLock, removeLock, removeLockDevice, setLockDevice, setLockPin, type OpenResult } from "./lock.js";
import { openAppHandoff, sealHandoff, SIGNER_ONLY_ACTIONS, type HandoffApp, type SealedHandoff } from "./handoff.js";
import { inFamily, readFamily } from "../embedded/family.js";
import { mayDecryptFrom, mayEncryptTo, MESSAGE_KINDS, prepareForApp, readPeerFor } from "../embedded/permissions.js";
import { signClass } from "../embedded/policy.js";
import { buildRoomPass, newestProfile, type Profile } from "../embedded/profile.js";
import { deleteSignerGrant, grantedAt, loadSignerGrant, saveSignerGrant } from "./signerGrant.js";
import {
  checkDue,
  checkLearned,
  cleanRelays,
  isTakenBack,
  mergeTakenBack,
  newestTakeBackEvent,
  NOTHING_TAKEN_BACK,
  readTakenBack,
  RELAY_LIST_KIND,
  TAKE_BACK_D,
  TAKE_BACK_KIND,
  takeBack,
  writeRelaysFrom,
  writeTakenBack,
  type TakenBack
} from "../embedded/takeBack.js";
import { savePublicSession, clearPublicSession } from "../publicSession.js";
import { SerialQueue } from "./serialQueue.js";
import type { VaultConnectionSummary } from "./protocol.js";
import type {
  WorkerRequest,
  WorkerResponse,
  ConfigurePayload,
  RegisterPayload,
  LoginPayload,
  RecoverPayload,
  CompleteRecoveryPayload,
  PhraseRebuildPayload,
  RecoverResult,
  ChangePasswordPayload,
  PublishProfilePayload,
  SignEventPayload,
  Nip44EncryptPayload,
  Nip44DecryptPayload,
  Nip04EncryptPayload,
  Nip04DecryptPayload,
  PreviewImportKeyPayload,
  Nip46ConnectPayload,
  Nip46NostrconnectStartPayload,
  HandoffExportPayload,
  AppCryptPayload,
  AppDecryptEventPayload,
  LoadProfilePayload,
  LockDevicePayload,
  LockOpenPayload,
  LockPinPayload,
  LockStatusResult,
  RestoreSessionResult,
  RoomPassPayload,
  SignerKeepPayload,
  TakeBackPayload,
  SignerSitePayload,
  SignerTouchPayload
} from "./protocol.js";

interface SessionState {
  signer: NostrSigner | null;
  everydayPrivateKey: Uint8Array | null;
  accountId: string | null;
  recoveryPublicKey: string | null;
  activeCredentialEvent: NostrEvent | null;
  activeRecoveryEvent: NostrEvent | null;
  pendingRecovery: RecoveredIdentity | null;
  /** The capsule's hint that the recovery phrase alone rebuilds this identity
   *  (spec §12.1). False for imported, rotated, pre-v0.7 and unknown. */
  everydayKeyDerived: boolean;
  /** Connection Vault root (§CV5.2), or null when the account predates the
   *  vault OR the restored cache predates the field — vaultKnown tells the
   *  two apart. The SUDO key is deliberately NOT session state: personal-tier
   *  records are out of scope for the widget until a sudo ceremony exists,
   *  and the key is wiped the moment a login result delivers it. */
  connectionVaultRoot: Uint8Array | null;
  vaultKnown: boolean;
  vault: VaultSession | null;
  /** True for a session that arrived by a signer hand-off (docs/sign-in-window.md):
   *  the everyday key and nothing else, held in memory, never cached. Such a
   *  session can sign and can say who it is. It can do nothing else. */
  signerOnly: boolean;
  /** For a signer-only session: what an application was approved for (§SW9), from inside the sealed hand-off or
   *  the grant kept from one. Null for a site that declared nothing. Everything such a session is asked is held
   *  to this here, in the worker, whatever the page that asks says. */
  app: HandoffApp | null;
  /** For a signer-only session: the site it serves, from inside the sealed hand-off or the grant kept from one.
   *  Null where an older hand-off named none: then no room pass is made (§SW16). */
  site: string | null;
  /** The person's own signed profile (kind 0), fetched and checked here. In a full session it is what
   *  `loadProfile` found; in a signer-only one it is what the hand-off or the grant carried. */
  profile: Profile | null;
  /** For a signer-only session: whether it may be kept for its site across page loads (§SW11). True for one
   *  taken up from a kept grant. False for a site allowed for one visit: nothing of it is ever written down. */
  remember: boolean;
  /** For a signer-only session: when its site was allowed, in seconds (docs/take-back.md). Null where unknown. */
  grantAt: number | null;
  /** The user's own write relays (NIP-65). In a full session, what `loadProfile` found; in a signer-only one,
   *  what the hand-off or the grant carried. Where a signer looks for their take-back record. */
  relays: string[];
  /** For a signer-only session: the family of sites its grant is kept for (docs/site-family.md), where the user
   *  allowed every site under one domain. Null for a grant kept for its site alone. `site` is still the exact
   *  site it serves: a room pass names that, never the family. */
  family: string | null;
}

const session: SessionState = {
  signer: null,
  everydayPrivateKey: null,
  accountId: null,
  recoveryPublicKey: null,
  activeCredentialEvent: null,
  activeRecoveryEvent: null,
  pendingRecovery: null,
  everydayKeyDerived: false,
  connectionVaultRoot: null,
  vaultKnown: false,
  vault: null,
  signerOnly: false,
  app: null,
  site: null,
  profile: null,
  remember: false,
  grantAt: null,
  relays: [],
  family: null
};

/** The throwaway key a hand-off is to be sealed to, between handoffBegin and
 *  handoffAccept. One at a time, used once. */
let pendingHandoff: Uint8Array | null = null;


let vaultRelayUrls: string[] = [...BUILTIN_VAULT_RELAYS];
let discoveryRelayUrls: string[] = [...BUILTIN_DISCOVERY_RELAYS];

const store = new IndexedDbKeyValueStore();

let hostVaultRelays = false;
let hostDiscoveryRelays = false;

function applyRelaySets(sets: RelaySets): void {
  if (!hostVaultRelays) vaultRelayUrls = sets.vaultRelays;
  if (!hostDiscoveryRelays) discoveryRelayUrls = sets.discoveryRelays;
}
const requestQueue = new SerialQueue();

// ---- The optional lock (lock.ts, spec §21.5) ----

/** The lock key, while the user has unlocked. Null when the lock is off, and when it is on and locked. */
let lockKey: Uint8Array | null = null;
/** When this worker was last asked to do something, in milliseconds: an unlocked session unused for long enough locks itself. */
let lastUsed = Date.now();
/** Asking these is not using the session, and none of them is refused for being idle. */
const NOT_USE = new Set(["configure", "lockStatus", "lockOpen", "restoreSession", "getSessionStatus", "logout"]);

// ---- Taking a site back (docs/take-back.md) ----

/** This browser's own copy of the last take-back record it wrote, by account. Not a secret: a list of addresses. */
const LOCAL_TAKEN_BACK = "bitlogin:taken-back:v1:";

async function loadLocalTakenBack(pubkey: string): Promise<TakenBack> {
  try {
    const raw = await store.get(LOCAL_TAKEN_BACK + pubkey);
    return (raw ? readTakenBack(JSON.parse(raw)) : null) ?? NOTHING_TAKEN_BACK;
  } catch {
    return NOTHING_TAKEN_BACK;
  }
}

/** A take-back record's content, opened with the key that sealed it to itself. Null for anything else. */
function openTakenBack(signer: NostrSigner, content: string): TakenBack | null {
  try {
    return readTakenBack(JSON.parse(signer.nip44Decrypt(signer.getPublicKey(), content)));
  } catch {
    return null;
  }
}

/** Lock: the keys go from memory. What is cached stays, sealed, for the next unlock. */
function lockNow(): void {
  clearSession();
  if (lockKey) wipe(lockKey);
  lockKey = null;
}

async function lockStatus(): Promise<LockStatusResult> {
  const record = await readLock(store);
  if (!record) return { on: false, locked: false, device: false, triesLeft: 0 };
  return {
    on: true,
    locked: !lockKey && (await cachedSessionState(store)) === "locked",
    device: !!record.device,
    ...(record.device ? { credentialId: record.device.credentialId } : {}),
    triesLeft: Math.max(0, LOCK_LIMITS.tries - record.tries)
  };
}

function requireUnlocked(): { signer: NostrSigner; everydayPrivateKey: Uint8Array } {
  if (!session.signer || !session.everydayPrivateKey) {
    throw new Error("No identity is unlocked in this session.");
  }
  return { signer: session.signer, everydayPrivateKey: session.everydayPrivateKey };
}

function requireApp(): HandoffApp {
  if (!session.signerOnly || !session.app) throw new Error("refused");
  return session.app;
}

function clearSession(): void {
  session.signer?.destroy();
  if (session.everydayPrivateKey) session.everydayPrivateKey.fill(0);
  session.signer = null;
  session.everydayPrivateKey = null;
  session.accountId = null;
  session.recoveryPublicKey = null;
  session.activeCredentialEvent = null;
  session.activeRecoveryEvent = null;
  session.everydayKeyDerived = false;
  session.vault?.destroy();
  session.vault = null;
  if (session.connectionVaultRoot) session.connectionVaultRoot.fill(0);
  session.connectionVaultRoot = null;
  session.vaultKnown = false;
  session.signerOnly = false;
  session.app = null;
  session.site = null;
  session.profile = null;
  session.remember = false;
  session.grantAt = null;
  session.relays = [];
  session.family = null;
  if (session.pendingRecovery) {
    session.pendingRecovery.recoveryPrivateKey.fill(0);
    session.pendingRecovery.everydayPrivateKey.fill(0);
    session.pendingRecovery = null;
  }
}

/** Shared by phrase recovery and rebuild-from-phrase (spec §17.4, §17.6): holds
 *  the recovered identity until completeRecovery sets new login credentials. */
function adoptRecoveredIdentity(recovered: RecoveredIdentity): RecoverResult {
  clearSession();
  session.pendingRecovery = recovered;
  session.signer = new NostrSigner(recovered.everydayPrivateKey);
  session.everydayPrivateKey = recovered.everydayPrivateKey;
  session.accountId = recovered.accountId;
  session.recoveryPublicKey = recovered.recoveryPublicKey;
  session.activeRecoveryEvent = recovered.currentRecoveryEvent;
  session.everydayKeyDerived = recovered.everydayKeyDerived;
  // §CV13.2 — the roots ride the recovery capsule; the sudo copy is not retained.
  adoptVaultMaterial(
    recovered.currentRecoveryPayload.connection_vault_root
      ? base64urlToBytes(recovered.currentRecoveryPayload.connection_vault_root)
      : undefined
  );
  return {
    everydayPublicKey: recovered.everydayPublicKey,
    accountId: recovered.accountId,
    generalRelays: recovered.generalRelays,
    dmRelays: recovered.dmRelays,
    chainWarning: recovered.chainWarning,
    everydayKeyDerived: recovered.everydayKeyDerived
  };
}

/** Adopts vault material from a login/register/recovery result: keeps the
 *  root, WIPES the sudo key immediately (see SessionState comment). */
function adoptVaultMaterial(root: Uint8Array | undefined, sudoKey?: Uint8Array): void {
  session.connectionVaultRoot = root ?? null;
  session.vaultKnown = true;
  session.vault = null;
  if (sudoKey) wipe(sudoKey);
}

// Caches the current session (§21) so a later page load can restore it via
// "restoreSession" instead of asking for the login name + password again.
// Best-effort and silent on any missing field -- every call site here runs
// right after setting all five, so this only ever no-ops if IndexedDB itself
// is unavailable (saveCachedSession's own concern, not this one's).
async function persistSession(): Promise<void> {
  if (
    !session.everydayPrivateKey ||
    !session.accountId ||
    !session.recoveryPublicKey ||
    !session.activeCredentialEvent ||
    !session.activeRecoveryEvent
  ) {
    return;
  }
  // A sign-in made while the lock was on and locked is the way past a forgotten PIN: it turns the lock off.
  // Nothing is lost by that, and nothing is gained by anyone who could not sign in.
  const lock = await readLock(store);
  if (lock && !lockKey) await removeLock(store);
  await saveCachedSession(store, {
    everydayPrivateKey: session.everydayPrivateKey,
    accountId: session.accountId,
    recoveryPublicKey: session.recoveryPublicKey,
    activeCredentialEvent: session.activeCredentialEvent,
    activeRecoveryEvent: session.activeRecoveryEvent,
    ...(session.connectionVaultRoot ? { connectionVaultRoot: session.connectionVaultRoot } : {}),
    ...(session.vaultKnown ? { vaultEnabled: session.connectionVaultRoot !== null } : {}),
    everydayKeyDerived: session.everydayKeyDerived
  }, lock && lockKey ? lockKey : null);
  await persistPublicSession();
}

/** Take up the cached session, with the lock key where the lock is on. */
async function restoreFromCache(): Promise<RestoreSessionResult> {
  const cached = await loadCachedSession(store, lockKey);
  if (!cached) return { restored: false };
  clearSession();
  session.signer = new NostrSigner(cached.everydayPrivateKey);
  session.everydayPrivateKey = cached.everydayPrivateKey;
  session.accountId = cached.accountId;
  session.recoveryPublicKey = cached.recoveryPublicKey;
  session.activeCredentialEvent = cached.activeCredentialEvent;
  session.activeRecoveryEvent = cached.activeRecoveryEvent;
  session.everydayKeyDerived = cached.everydayKeyDerived ?? false;
  session.connectionVaultRoot = cached.connectionVaultRoot ?? null;
  // vaultKnown only when the cache recorded a definitive answer; an old
  // cache entry leaves it false so requireVault says "sign in again"
  // rather than falsely claiming the account has no vault.
  session.vaultKnown = cached.vaultEnabled !== undefined;
  // Self-heal: a session cached before the public-record feature has an
  // encrypted entry but no cleartext one. Writing it here means the very
  // next lightweight read sees the identity, no re-login required.
  await persistPublicSession();
  return {
    restored: true,
    everydayPublicKey: session.signer.getPublicKey(),
    accountId: cached.accountId,
    everydayKeyDerived: session.everydayKeyDerived
  };
}

// Writes the cleartext public-only identity (publicSession.ts) beside the
// encrypted record so a read-only page can show "signed in as …" without
// loading this worker. Public data only -- never key material. Kept in lockstep
// with persistSession()/logout so it can't outlive the real session.
async function persistPublicSession(): Promise<void> {
  if (!session.signer) return;
  const pubkey = session.signer.getPublicKey();
  await savePublicSession(store, { pubkey, npub: encodeNpub(pubkey) });
}

/**
 * The origin this worker actually runs in, derived rather than accepted.
 *
 * Every vault call used to take `origin` from the message payload, which made
 * the per-origin binding -- the vault's ENTIRE authorization model -- advisory:
 * a caller could claim any origin, bind another site's wallet to itself, or
 * plant a wallet under a victim origin. The worker is same-origin with its
 * page and can simply look. A dedicated worker's self.location.origin is the
 * origin of the script's URL, which is the embedding page's origin.
 */
function selfOrigin(): string {
  try {
    return new URL(self.location.href).origin;
  } catch {
    return "";
  }
}

function requireVault(): VaultSession {
  if (!session.signer) throw new Error("No identity is unlocked in this session.");
  if (!session.connectionVaultRoot) {
    throw new Error(
      session.vaultKnown
        ? "This account predates the Connection Vault. Enable it from your BitLogin account manager (recovery phrase required)."
        : "Sign in again to use wallet connections on this device."
    );
  }
  session.vault ??= new VaultSession(session.connectionVaultRoot.slice());
  return session.vault;
}

function summarize(decrypted: DecryptedConnectionRecord): VaultConnectionSummary {
  const { record } = decrypted;
  const summary: VaultConnectionSummary = {
    connectionId: record.connection_id,
    connectionType: record.connection_type,
    label: record.label,
    state: record.state,
    origin: record.application_binding.origin,
    createdAt: record.created_at,
    updatedAt: record.updated_at
  };
  if (record.connection_type === "nwc" && record.state !== "deleted") {
    const credential = record.credential as unknown as NwcCredential;
    summary.walletPubkey = credential.wallet_pubkey;
    summary.relayCount = credential.relays?.length;
  }
  return summary;
}

/** Fetch + decrypt the live (non-deleted) connections. */
async function listLiveConnections(): Promise<{
  vault: VaultSession;
  connections: DecryptedConnectionRecord[];
  rollbackWarnings: string[];
  unreadable: string[];
  truncated: boolean;
  quorumMet: boolean;
}> {
  const vault = requireVault();
  const listed = await vault.listConnections({ relayUrls: vaultRelayUrls, store });
  return {
    vault,
    connections: listed.connections.filter((c) => c.record.state !== "deleted"),
    rollbackWarnings: listed.rollbackWarnings,
    unreadable: listed.unreadable,
    truncated: listed.truncated,
    quorumMet: listed.quorumMet
  };
}

async function findConnection(connectionId: string): Promise<{
  vault: VaultSession;
  connection: DecryptedConnectionRecord;
}> {
  const { vault, connections } = await listLiveConnections();
  const connection = connections.find((c) => c.record.connection_id === connectionId);
  if (!connection) throw new Error("That connection no longer exists.");
  return { vault, connection };
}

// ---- NIP-46 remote-signer session (§LM5) ----
// Deliberately separate from `session`: a remote-signer session has no account,
// no vault, and nothing persisted. The ephemeral client key never leaves this
// worker (§LM5.4); close() ends everything.
let nip46: { client: Nip46Client; userPubkey: string } | null = null;
let nostrconnectPending: {
  clientSecretKey: Uint8Array;
  relayUrls: string[];
  secret: string;
  abort: AbortController;
} | null = null;

function postAuthUrlNotification(url: string): void {
  (self as unknown as Worker).postMessage({ notify: "nip46-auth-url", url });
}

function requireNip46(): { client: Nip46Client; userPubkey: string } {
  if (!nip46) throw new Error("No remote signer is connected.");
  return nip46;
}

/** Ends a superseded or abandoned nostrconnect attempt for real (BL-22):
 *  the active listener is cancelled and the pending ephemeral key wiped --
 *  never merely dereferenced. NOT used when the key's ownership transfers
 *  into an adopted Nip46Client. */
function discardNostrconnectPending(): void {
  if (!nostrconnectPending) return;
  nostrconnectPending.abort.abort();
  wipe(nostrconnectPending.clientSecretKey);
  nostrconnectPending = null;
}

/** Retires a session with local revocation FIRST (BL-26): the logout event
 *  is pre-signed while the key exists, then close() immediately rejects
 *  every pending request and wipes keys -- nothing can resolve after logout
 *  begins -- and only then is the courtesy event delivered, asynchronously
 *  and bounded. Current NIP-46 defines logout as a courtesy, never a
 *  security boundary, so its delivery is allowed to fail silently. */
function retireNip46Client(client: Nip46Client): void {
  const farewell = client.buildLogoutEvent();
  client.close();
  if (farewell) void client.publishCourtesy(farewell);
}

function adoptNip46Client(client: Nip46Client, userPubkey: string): void {
  if (nip46) retireNip46Client(nip46.client);
  nip46 = { client, userPubkey };
}

async function handle(action: string, payload: unknown): Promise<unknown> {
  if (session.signerOnly && !SIGNER_ONLY_ACTIONS.has(action)) {
    throw new Error("This session can only sign. Sign in at your own BitLogin page for anything else.");
  }
  // With the lock on, a session nobody has used for a while locks itself before anything more is done with it.
  if (lockKey && action !== "configure" && Date.now() - lastUsed > LOCK_LIMITS.idleSec * 1000) lockNow();
  if (!NOT_USE.has(action)) lastUsed = Date.now();
  switch (action) {
    // ---- The optional lock (lock.ts) ----

    case "lockStatus":
      return lockStatus();

    // Turn it on, or change the PIN. Only with a full session unlocked: the key that is sealed is the one in hand.
    case "lockEnable": {
      requireUnlocked();
      if ((await readLock(store)) && !lockKey) throw new Error("Unlock first.");
      const fresh = await setLockPin(store, (payload as LockPinPayload).pin, lockKey ?? undefined);
      if (lockKey) wipe(lockKey);
      lockKey = fresh;
      await persistSession();
      return lockStatus();
    }

    case "lockSetDevice": {
      requireUnlocked();
      if (!lockKey) throw new Error("Turn the lock on first.");
      const p = payload as LockDevicePayload;
      const prf = base64urlToBytes(String(p.prfOutput));
      try {
        await setLockDevice(store, lockKey, String(p.credentialId), prf);
      } finally {
        wipe(prf);
      }
      return lockStatus();
    }

    case "lockRemoveDevice": {
      requireUnlocked();
      if (!lockKey) throw new Error("Turn the lock on first.");
      await removeLockDevice(store);
      return lockStatus();
    }

    case "lockDisable": {
      requireUnlocked();
      if ((await readLock(store)) && !lockKey) throw new Error("Unlock first.");
      await removeLock(store);
      if (lockKey) wipe(lockKey);
      lockKey = null;
      await persistSession();
      return lockStatus();
    }

    case "lockNow": {
      if (!lockKey) throw new Error("The lock is not on.");
      lockNow();
      return lockStatus();
    }

    // Open it, with the PIN or with the device. A wrong try is counted; one too many removes the lock and the
    // cached session with it, and the user signs in again the ordinary way.
    case "lockOpen": {
      const p = payload as LockOpenPayload;
      let result: OpenResult;
      if (typeof p.prfOutput === "string") {
        const prf = base64urlToBytes(p.prfOutput);
        try {
          result = await openLockWithDevice(store, prf);
        } finally {
          wipe(prf);
        }
      } else {
        result = await openLockWithPin(store, p.pin);
      }
      if (result.ok) {
        if (lockKey) wipe(lockKey);
        lockKey = result.lockKey;
        lastUsed = Date.now();
        const restored = await restoreFromCache();
        if (restored.restored) return { ok: true, left: LOCK_LIMITS.tries, removed: false, ...restored };
        // The lock opened and there was nothing behind it that could be read: there is no lock to keep.
        await removeLock(store);
        lockNow();
        result = { ok: false, left: 0, removed: true };
      }
      if (result.removed) {
        lockNow();
        await clearCachedSession(store);
        await clearPublicSession(store);
      }
      return { ok: false, left: result.left, removed: result.removed, restored: false };
    }

    // ---- Signer hand-off (docs/sign-in-window.md) ----

    // The receiving side, first: a throwaway key for the hand-off to be sealed to.
    case "handoffBegin": {
      if (pendingHandoff) wipe(pendingHandoff);
      pendingHandoff = generatePrivateKey();
      return { recipientPublicKey: getPublicKeyHex(pendingHandoff) };
    }

    // The sending side: this worker has the session, and seals the everyday
    // key (only that) to the receiving worker's throwaway key.
    case "handoffExport": {
      const { everydayPrivateKey } = requireUnlocked();
      const sender = generatePrivateKey();
      const p = payload as HandoffExportPayload;
      try {
        // The profile is this worker's own finding (loadProfile), never a page's word.
        return sealHandoff(everydayPrivateKey, p.recipientPublicKey, sender, p.app, {
          ...(p.site !== undefined ? { site: p.site } : {}),
          // Only a site that declared nothing is told who they are. An application is held to what it asked,
          // though the window may have read the profile to show the user which account this is.
          ...(session.profile && !p.app ? { profile: session.profile } : {}),
          ...(p.remember === true ? { remember: true } : {}),
          ...(p.family !== undefined ? { family: p.family } : {}),
          // With the lock on, nothing is kept for any site: a key at rest in a site's storage would be a key
          // the lock does not cover. Every site is allowed for the visit, and asks at the sign-in address again.
          ...(lockKey ? { visitOnly: true } : {}),
          // When it was allowed, by this worker's clock, and where the user writes: what a signer needs to
          // find out later whether the site was taken back (docs/take-back.md).
          at: Date.now() / 1000,
          relays: session.relays
        });
      } finally {
        wipe(sender);
      }
    }

    // The receiving side, last: open it with the throwaway key, which is
    // then gone. What results is a signer-only session, in memory. It is
    // never written to the session cache or the public record.
    // ---- What the embedded signer remembers for a site (signerGrant.ts) ----

    // Keep this hand-off for the site that asked, so the user is not asked again on its next page load. Only a
    // session that arrived by a hand-off is ever kept this way: a full session is never written as a grant.
    case "signerKeep": {
      const { everydayPrivateKey } = requireUnlocked();
      if (!session.signerOnly) throw new Error("Only a signer-only session can be remembered for a site.");
      const p = payload as SignerKeepPayload;
      const now = Date.now() / 1000;
      // Allowed for this visit only: nothing is kept, whatever the page asks.
      if (!session.remember) return { kept: false };
      // An application's grant is for the site its hand-off was sealed for, and no other.
      if ((session.app && session.app.site !== p.site) || (session.site && session.site !== p.site)) throw new Error("This hand-off was for another site.");
      // Allowed for every site of a family: kept once, under the family, and this site's own grant (an older
      // choice) is forgotten, so what the user chose last is what applies.
      if (session.family) {
        if (!inFamily(p.site, session.family)) throw new Error("This hand-off was for another site.");
        await deleteSignerGrant(store, p.site);
      }
      return {
        kept: await saveSignerGrant(
          store,
          {
            site: session.family ?? p.site,
            everydayPrivateKey,
            until: p.until,
            ...(p.name ? { name: p.name } : {}),
            ...(session.profile ? { profile: session.profile } : {}),
            at: session.grantAt ?? Math.floor(now),
            ...(session.relays.length ? { relays: session.relays } : {}),
            signed: [],
            ...(session.app ? { permissions: session.app.permissions, signedSensitive: [] } : {})
          },
          now
        )
      };
    }

    // The site's page was loaded again: what was kept for that site, if it is still in date, becomes a
    // signer-only session. It touches nothing a full session uses.
    case "signerRestore": {
      const p = payload as SignerSitePayload;
      // The site's own grant first. Where it has none, the family's, for a site in that family: the embedded
      // signer names the family, from the site's address, by the Public Suffix List (docs/site-family.md).
      const ownGrant = await loadSignerGrant(store, p.site, Date.now() / 1000);
      const family = !ownGrant && p.family !== undefined && readFamily(p.family) && inFamily(p.site, p.family) ? p.family : null;
      const grant = ownGrant ?? (family ? await loadSignerGrant(store, family, Date.now() / 1000) : null);
      if (!grant || (family && grant.site !== family)) return { restored: false };
      clearSession();
      session.signer = new NostrSigner(grant.everydayPrivateKey);
      session.everydayPrivateKey = grant.everydayPrivateKey;
      session.signerOnly = true;
      session.app = grant.permissions ? { site: grant.site, permissions: grant.permissions } : null;
      // The site it serves is the one asking, whichever grant it was kept under.
      session.site = family ? p.site : grant.site;
      session.family = family;
      session.profile = grant.profile ?? null;
      session.remember = true;
      session.grantAt = grantedAt(grant);
      session.relays = grant.relays ?? [];
      return {
        restored: true,
        everydayPublicKey: session.signer.getPublicKey(),
        until: grant.until,
        ...(grant.name ? { name: grant.name } : {}),
        ...(grant.profile ? { profile: grant.profile } : {}),
        signed: grant.signed,
        ...(grant.signedPass ? { signedPass: grant.signedPass } : {}),
        check: checkDue(Date.now() / 1000, grantedAt(grant), grant.checkedAt ?? 0),
        ...(family ? { family } : {}),
        ...(grant.permissions ? { permissions: grant.permissions, signedSensitive: grant.signedSensitive ?? [] } : {})
      };
    }

    // Count a signature against the site, where reloading the page can't lose the count.
    case "signerTouch": {
      const { everydayPrivateKey } = requireUnlocked();
      if (!session.signerOnly) throw new Error("Only a signer-only session is counted for a site.");
      const p = payload as SignerTouchPayload;
      const now = Date.now() / 1000;
      // A family's counts are the family's: every site of it shares one (docs/site-family.md SF5).
      const kept = await loadSignerGrant(store, session.family && inFamily(p.site, session.family) ? session.family : p.site, now);
      // Only a grant that is there, and is this session's, is rewritten.
      if (kept && getPublicKeyHex(kept.everydayPrivateKey) === getPublicKeyHex(everydayPrivateKey)) {
        await saveSignerGrant(
          store,
          { ...kept, signed: Array.isArray(p.signed) ? p.signed : [], ...(Array.isArray(p.signedPass) ? { signedPass: p.signedPass } : {}), ...(kept.permissions ? { signedSensitive: Array.isArray(p.signedSensitive) ? p.signedSensitive : [] } : {}) },
          now
        );
      }
      return {};
    }

    // Signing out of a site that was allowed as one of a family signs out of the family: otherwise its next page
    // load would take the family's grant up again, and the sign-out would not have happened (SF6).
    case "signerForget": {
      const site = (payload as SignerSitePayload).site;
      await deleteSignerGrant(store, site);
      if (session.family && inFamily(site, session.family)) await deleteSignerGrant(store, session.family);
      return {};
    }

    case "handoffAccept": {
      if (!pendingHandoff) throw new Error("No hand-off was begun here.");
      const mine = pendingHandoff;
      pendingHandoff = null;
      let opened: ReturnType<typeof openAppHandoff>;
      try {
        opened = openAppHandoff(payload as SealedHandoff, mine);
      } finally {
        wipe(mine);
      }
      clearSession();
      session.signer = new NostrSigner(opened.key);
      session.everydayPrivateKey = opened.key;
      session.signerOnly = true;
      session.app = opened.app;
      session.site = opened.site;
      session.profile = opened.profile;
      session.remember = opened.remember;
      session.grantAt = opened.at;
      session.relays = opened.relays;
      session.family = opened.family;
      return {
        everydayPublicKey: session.signer.getPublicKey(),
        ...(opened.app ? { app: opened.app } : {}),
        ...(opened.site ? { site: opened.site } : {}),
        ...(opened.profile ? { profile: opened.profile } : {}),
        ...(opened.remember ? { remember: true } : {}),
        ...(opened.family ? { family: opened.family } : {})
      };
    }

    // ---- Who someone is, to a world they allowed (§SW16).

    // A full session, at the sign-in address: the person's own profile, asked of relays and believed only as
    // far as its signature goes. It is sealed into the next hand-off. A session that arrived by a hand-off
    // never asks a relay anything: this action is not on its list.
    case "loadProfile": {
      const { signer } = requireUnlocked();
      const me = signer.getPublicKey();
      const wantProfile = (payload as LoadProfilePayload).profile !== false;
      const relayUrls = [...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8);
      if (relayUrls.length === 0) return {};
      const pool = new RelayPool(relayUrls);
      try {
        // Their profile (only for a site that is to be told who they are), and their relay list (NIP-65), which
        // every hand-off carries: it is where a signer later looks for their take-back record.
        const [profiles, lists] = await Promise.all([
          wantProfile ? pool.queryQuorum({ kinds: [0], authors: [me], limit: 2 }, 4000) : Promise.resolve(null),
          pool.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)
        ]);
        // Still the same session: a sign-out while relays were answering must not leave any of it behind.
        if (session.signer !== signer) return {};
        session.profile = profiles ? newestProfile(profiles.outcomes.flatMap((outcome) => outcome.events), me) : null;
        session.relays = writeRelaysFrom(lists.outcomes.flatMap((outcome) => outcome.events), me);
      } finally {
        pool.closeAll();
      }
      return { ...(session.profile ? { profile: session.profile } : {}), relays: session.relays };
    }

    // ---- Taking a site back (docs/take-back.md) ----

    // At the sign-in address, with a full session: publish the record that says a site, or every site, is taken
    // back as of now. It carries everything an earlier record said, from the relays and from this browser's own
    // copy, so a record built here can never give a site back.
    case "takeBack": {
      const { signer } = requireUnlocked();
      const p = payload as TakeBackPayload;
      const me = signer.getPublicKey();
      const now = Date.now() / 1000;
      const what = p.all === true ? ({ all: true } as const) : { site: String(p.site ?? "") };
      const finder = new RelayPool([...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8));
      let mine: string[];
      try {
        mine = writeRelaysFrom((await finder.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)).outcomes.flatMap((o) => o.events), me);
      } finally {
        finder.closeAll();
      }
      // Their own write relays, and BitLogin's, which every signer knows without being told.
      const relayUrls = [...new Set([...mine, ...vaultRelayUrls])].slice(0, 16);
      const pool = new RelayPool(relayUrls);
      try {
        const found = await pool.queryQuorum({ kinds: [TAKE_BACK_KIND], authors: [me], "#d": [TAKE_BACK_D], limit: 2 }, 5000);
        // With no relay answering, an earlier record made on another device could not be carried forward.
        if (found.respondedCount === 0) return { ok: false, accepted: 0, of: relayUrls.length };
        const newest = newestTakeBackEvent(found.outcomes.flatMap((o) => o.events), me, now);
        const onRelays = newest ? openTakenBack(signer, newest.content) : null;
        const local = await loadLocalTakenBack(me);
        const next = takeBack(mergeTakenBack(onRelays ?? NOTHING_TAKEN_BACK, local, now), what, now);
        const event = signer.signEvent({
          kind: TAKE_BACK_KIND,
          // Later than the one it replaces, whatever the two clocks say.
          created_at: Math.max(Math.floor(now), (newest?.created_at ?? 0) + 1),
          tags: [["d", TAKE_BACK_D]],
          content: signer.nip44Encrypt(me, writeTakenBack(next))
        });
        const accepted = countAcknowledgements(await pool.publishAll(event, 6000));
        const ok = accepted >= Math.min(2, relayUrls.length);
        // Kept here only once it is out: this browser's copy is what the next record is built on.
        if (ok) await store.set(LOCAL_TAKEN_BACK + me, writeTakenBack(next)).catch(() => {});
        return { ok, accepted, of: relayUrls.length };
      } finally {
        pool.closeAll();
      }
    }

    // In the embedded signer, for a kept grant: ask the user's relays whether this site was taken back. Asked at
    // most once a day. It can end the grant or leave it be, and nothing else.
    case "signerCheck": {
      const { signer } = requireUnlocked();
      if (!session.signerOnly || !session.site) return { state: "ok" };
      // What is checked is what the grant is kept under: the site, or its family.
      const site = session.family ?? session.site;
      const now = Date.now() / 1000;
      const grant = await loadSignerGrant(store, site, now);
      // Allowed for one visit: held in memory, ends with the page, and is not checked.
      if (!grant) return { state: "ok" };
      const me = signer.getPublicKey();
      const at = grantedAt(grant);
      const due = checkDue(now, at, grant.checkedAt ?? 0);
      if (due === "fresh") return { state: "ok" };
      const relayUrls = [...new Set([...cleanRelays(grant.relays), ...vaultRelayUrls])].slice(0, 12);
      const pool = new RelayPool(relayUrls);
      let records: Awaited<ReturnType<RelayPool["queryQuorum"]>>;
      let lists: Awaited<ReturnType<RelayPool["queryQuorum"]>>;
      try {
        [records, lists] = await Promise.all([
          pool.queryQuorum({ kinds: [TAKE_BACK_KIND], authors: [me], "#d": [TAKE_BACK_D], limit: 2 }, 5000),
          pool.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 5000)
        ]);
      } finally {
        pool.closeAll();
      }
      // The page was closed, or the site signed out of, while relays were answering.
      if (session.signer !== signer) return { state: "ok" };
      // The newest valid record across every relay that answered: never the first to arrive.
      const newest = newestTakeBackEvent(records.outcomes.flatMap((o) => o.events), me, now);
      const record = newest ? openTakenBack(signer, newest.content) : null;
      // Whatever else is true of this round, a record that ends the grant ends it.
      if (record && isTakenBack(record, site, at)) {
        await deleteSignerGrant(store, site);
        clearSession();
        return { state: "ended" };
      }
      // Otherwise the round counts as a check only if it could have found one (takeBack.ts, checkLearned).
      const learned = checkLearned({
        asked: relayUrls.length,
        answered: records.respondedCount,
        seenAt: grant.seenAt ?? 0,
        newestAt: newest ? newest.created_at : null,
        readable: record !== null
      });
      // Nothing was learned. A grant too long unchecked is locked until something is.
      if (!learned) return { state: due === "overdue" ? "stale" : "ok" };
      // They may have changed where they write since: the next check follows their list as it is now.
      const theirs = writeRelaysFrom(lists.outcomes.flatMap((o) => o.events), me);
      await saveSignerGrant(
        store,
        {
          ...grant,
          checkedAt: Math.floor(now),
          seenAt: Math.max(grant.seenAt ?? 0, record && newest ? newest.created_at : 0),
          ...(theirs.length ? { relays: theirs } : {})
        },
        now
      );
      if (theirs.length) session.relays = theirs;
      return { state: "ok" };
    }

    // A room pass (NSWP kind 27300) for the site this session serves, and for no other. The site, the time, how
    // long it lasts and the profile are all this worker's own: what is asked for is a session public key. Not
    // for an application: an application is held to the set the user read, and a pass is not in one.
    case "roomPass": {
      const { signer } = requireUnlocked();
      if (!session.signerOnly || session.app || !session.site) throw new Error("refused");
      const pass = buildRoomPass({
        session: (payload as RoomPassPayload).session,
        site: session.site,
        identity: signer.getPublicKey(),
        nowSeconds: Date.now() / 1000,
        profile: session.profile
      });
      if (!pass) throw new Error("refused");
      return signer.signEvent(pass);
    }

    // ---- What an approved application may ask beyond signing (§SW9.5). Refused without a permission set.

    case "appEncrypt": {
      const { signer } = requireUnlocked();
      const app = requireApp();
      const p = payload as AppCryptPayload;
      const me = signer.getPublicKey();
      // To the user's own key, to a key they were shown, or (where they approved sending messages) to whoever
      // a message is for.
      const sendsMessages = app.permissions.sign.some((kind) => MESSAGE_KINDS.includes(kind));
      if (!mayEncryptTo(app.permissions, me, p.peerPublicKey) && !(sendsMessages && /^[0-9a-f]{64}$/u.test(String(p.peerPublicKey)))) {
        throw new Error("refused");
      }
      if (typeof p.text !== "string" || p.text.length > 100_000) throw new Error("refused");
      return { text: p.scheme === "nip04" ? signer.nip04Encrypt(p.peerPublicKey, p.text) : signer.nip44Encrypt(p.peerPublicKey, p.text) };
    }

    case "appDecrypt": {
      const { signer } = requireUnlocked();
      const app = requireApp();
      const p = payload as AppCryptPayload;
      // Only against a key the user was shown. Never the user's own: that would read everything they ever
      // encrypted to themselves, whatever kind it was kept in.
      if (!mayDecryptFrom(app.permissions, p.peerPublicKey) || typeof p.text !== "string") throw new Error("refused");
      return { text: p.scheme === "nip04" ? signer.nip04Decrypt(p.peerPublicKey, p.text) : signer.nip44Decrypt(p.peerPublicKey, p.text) };
    }

    case "appDecryptEvent": {
      const { signer } = requireUnlocked();
      const app = requireApp();
      const event: unknown = (payload as AppDecryptEventPayload).event;
      // Reading is tied to an event that really is what it says: signed, of a kind the user approved reading.
      if (!verifyNostrEvent(event)) throw new Error("refused");
      const peer = readPeerFor(app.permissions, signer.getPublicKey(), event);
      if (!peer) throw new Error("refused");
      // Kind 4 is the older scheme, and says so in its content.
      const text = event.kind === 4 || /\?iv=[A-Za-z0-9+/=]+$/u.test(event.content) ? signer.nip04Decrypt(peer, event.content) : signer.nip44Decrypt(peer, event.content);
      return { text };
    }

    case "nip46Connect": {
      const p = payload as Nip46ConnectPayload;
      const pointer = parseBunkerUri(p.uri);
      const client = new Nip46Client({
        clientSecretKey: generatePrivateKey(),
        pointer,
        onAuthUrl: postAuthUrlNotification
      });
      try {
        await client.connect();
        const userPubkey = await client.getUserPublicKey();
        adoptNip46Client(client, userPubkey);
        // The paste leg won; a QR listener still waiting is superseded.
        discardNostrconnectPending();
        return { userPubkey };
      } catch (err) {
        client.close();
        throw err;
      }
    }

    case "nip46NostrconnectStart": {
      const p = payload as Nip46NostrconnectStartPayload;
      // Two relays, not the whole list: every relay URL inflates the QR by a
      // version step or two, and a dense code with tiny modules is measurably
      // harder for a phone camera to lock onto. NIP-46 needs one shared
      // relay; the second is the redundancy.
      const relayUrls = vaultRelayUrls.slice(0, 2);
      // A fresh attempt supersedes any prior one: cancel its listener and
      // wipe its key rather than orphaning them (BL-22).
      discardNostrconnectPending();
      const clientSecretKey = generatePrivateKey();
      // The secret is the proof-of-scan: whoever echoes it back becomes this
      // session's signer, so it gets real entropy, not a friendly string.
      const secret = bytesToHex(randomBytes(16));
      nostrconnectPending = { clientSecretKey, relayUrls, secret, abort: new AbortController() };
      const uri = buildNostrconnectUri({
        clientPubkey: getPublicKeyHex(clientSecretKey),
        relayUrls,
        secret,
        name: p.appName?.trim() || "BitLogin",
        perms: ["sign_event", "nip44_encrypt", "nip44_decrypt", "nip04_encrypt", "nip04_decrypt"]
      });
      return { uri };
    }

    case "nip46NostrconnectAwait": {
      const pending = nostrconnectPending;
      if (!pending) throw new Error("No signer-connection attempt is in progress.");
      let signerPubkey: string;
      try {
        ({ signerPubkey } = await listenForNostrconnect({
          clientSecretKey: pending.clientSecretKey,
          relayUrls: pending.relayUrls,
          secret: pending.secret,
          timeoutMs: 180_000,
          signal: pending.abort.signal
        }));
      } catch (err) {
        // Natural failure (timeout, unreachable relays) must not orphan the
        // ephemeral key in worker memory (BL-27) -- but only if this attempt
        // still owns the pending slot; a superseding attempt already
        // discarded it.
        if (nostrconnectPending === pending) discardNostrconnectPending();
        throw err;
      }
      if (nostrconnectPending !== pending) throw new Error("This signer-connection attempt was superseded.");
      // Ownership of the ephemeral key transfers into the client below --
      // dereference only; discardNostrconnectPending would wipe it.
      nostrconnectPending = null;
      const client = new Nip46Client({
        clientSecretKey: pending.clientSecretKey,
        pointer: { signerPubkey, relayUrls: pending.relayUrls },
        onAuthUrl: postAuthUrlNotification
      });
      try {
        // The signer initiated (it echoed the secret), so no connect RPC is
        // needed -- go straight to asking whose key it signs for.
        const userPubkey = await client.getUserPublicKey();
        adoptNip46Client(client, userPubkey);
        return { userPubkey };
      } catch (err) {
        client.close();
        throw err;
      }
    }

    case "nip46SignEvent": {
      const p = payload as SignEventPayload;
      return requireNip46().client.signEvent({
        kind: p.kind,
        content: p.content,
        tags: (p.tags ?? []) as string[][],
        created_at: p.created_at ?? Math.floor(Date.now() / 1000)
      });
    }

    case "nip46Nip44Encrypt": {
      const p = payload as Nip44EncryptPayload;
      return { ciphertext: await requireNip46().client.nip44Encrypt(p.peerPublicKey, p.plaintext) };
    }

    case "nip46Nip44Decrypt": {
      const p = payload as Nip44DecryptPayload;
      return { plaintext: await requireNip46().client.nip44Decrypt(p.peerPublicKey, p.payload) };
    }

    case "nip46Nip04Encrypt": {
      const p = payload as Nip04EncryptPayload;
      return { ciphertext: await requireNip46().client.nip04Encrypt(p.peerPublicKey, p.plaintext) };
    }

    case "nip46Nip04Decrypt": {
      const p = payload as Nip04DecryptPayload;
      return { plaintext: await requireNip46().client.nip04Decrypt(p.peerPublicKey, p.payload) };
    }

    case "nip46Disconnect": {
      const active = nip46;
      nip46 = null;
      discardNostrconnectPending();
      if (active) retireNip46Client(active.client);
      return {};
    }

    case "configure": {
      const p = payload as ConfigurePayload;
      // A host that names its own relays has taken that decision on itself:
      // the signed relay list (spec §19.1) only ever extends the BUILT-IN
      // lists, and never touches a list the host supplied.
      hostVaultRelays = Boolean(p.vaultRelayUrls?.length);
      hostDiscoveryRelays = Boolean(p.discoveryRelayUrls?.length);
      if (p.vaultRelayUrls?.length) vaultRelayUrls = p.vaultRelayUrls;
      if (p.discoveryRelayUrls?.length) discoveryRelayUrls = p.discoveryRelayUrls;
      // The list this device already accepted applies at once; looking for a
      // newer one happens in the background and must never delay sign-in.
      applyRelaySets(relaySetsFor(await loadCachedBootstrapList(store)));
      if (!hostVaultRelays || !hostDiscoveryRelays) {
        void refreshBootstrapList(store).then(applyRelaySets, () => undefined);
      }
      return {};
    }

    case "register": {
      const p = payload as RegisterPayload;
      const result = p.importKey
        ? await importAccount({ nsecOrHex: p.importKey, loginName: p.loginName, password: p.password, vaultRelayUrls })
        : await registerAccount({ loginName: p.loginName, password: p.password, vaultRelayUrls });
      clearSession();
      session.signer = new NostrSigner(result.everydayPrivateKey);
      session.everydayPrivateKey = result.everydayPrivateKey;
      session.accountId = result.accountId;
      session.recoveryPublicKey = result.recoveryPublicKey;
      session.activeCredentialEvent = result.credentialEvent;
      session.activeRecoveryEvent = result.recoveryEvent;
      session.everydayKeyDerived = result.everydayKeyDerived;
      adoptVaultMaterial(result.connectionVaultRoot, result.vaultSudoKey);
      await persistSession();
      return {
        recoveryPhrase: result.recoveryPhrase,
        everydayPublicKey: result.everydayPublicKey,
        recoveryPublicKey: result.recoveryPublicKey,
        accountId: result.accountId,
        imported: result.imported,
        everydayKeyDerived: result.everydayKeyDerived,
        credentialEventId: result.credentialEvent.id,
        recoveryEventId: result.recoveryEvent.id
      };
    }

    case "previewImportKey": {
      // Validates and previews the npub WITHOUT publishing anything, so the user can
      // confirm they pasted the right key before committing to registration (§SF10).
      const p = payload as PreviewImportKeyPayload;
      const key = decodeEverydayPrivateKey(p.nsecOrHex);
      const everydayPublicKey = getPublicKeyHex(key);
      const preview = { everydayPublicKey, npub: encodeNpub(everydayPublicKey) };
      key.fill(0); // §11.10 — the previewed key is not retained
      return preview;
    }

    case "login": {
      const p = payload as LoginPayload;
      const result = await loginWithPassword({
        loginName: p.loginName,
        password: p.password,
        vaultRelayUrls,
        store,
        acknowledgeRollback: p.acknowledgeRollback
      });
      clearSession();
      session.signer = new NostrSigner(result.everydayPrivateKey);
      session.everydayPrivateKey = result.everydayPrivateKey;
      session.accountId = result.accountId;
      session.recoveryPublicKey = result.recoveryPublicKey;
      session.activeCredentialEvent = result.credentialEvent;
      session.activeRecoveryEvent = result.recoveryCapsuleEvent;
      session.everydayKeyDerived = result.everydayKeyDerived;
      adoptVaultMaterial(result.connectionVaultRoot, result.vaultSudoKey);
      await persistSession();
      // Replica repair after sign-in (spec §24.4): top up any relay that has
      // dropped a capsule, so relays losing the account one at a time never
      // add up to losing it everywhere. Not awaited, and never an error the
      // user sees. Skipped when this sign-in looked stale in any way: a
      // capsule the relays disagree about, or one older than this device has
      // seen, must not be spread further.
      if (!result.rollbackWarning && !result.relayDisagreementWarning) {
        void rebroadcastCapsules({
          relayUrls: vaultRelayUrls,
          credentialEvent: result.credentialEvent,
          recoveryEvent: result.recoveryCapsuleEvent
        }).catch(() => undefined);
      }
      return {
        everydayPublicKey: result.everydayPublicKey,
        accountId: result.accountId,
        generation: result.generation,
        everydayKeyDerived: result.everydayKeyDerived,
        rollbackWarning: result.rollbackWarning,
        relayDisagreementWarning: result.relayDisagreementWarning
      };
    }

    case "recover": {
      const p = payload as RecoverPayload;
      const recovered = await recoverWithPhrase({
        phrase: p.phrase,
        vaultRelayUrls,
        discoveryRelayUrls,
        offlineRecoveryCapsuleEvents: p.offlineExportFile?.recovery_capsule_events
      });
      return adoptRecoveredIdentity(recovered);
    }

    case "previewPhraseRebuild": {
      // Publishes nothing and unlocks nothing: the user has to confirm the
      // identity shown before rebuildFromPhrase runs (spec §17.6 step 3).
      const p = payload as PhraseRebuildPayload;
      const preview = await previewPhraseRebuild({ phrase: p.phrase, vaultRelayUrls, discoveryRelayUrls });
      return { ...preview, npub: encodeNpub(preview.everydayPublicKey) };
    }

    case "rebuildFromPhrase": {
      const p = payload as PhraseRebuildPayload;
      const rebuilt = await rebuildAccountFromPhrase({ phrase: p.phrase, vaultRelayUrls, discoveryRelayUrls });
      return adoptRecoveredIdentity(rebuilt);
    }

    case "completeRecovery": {
      const p = payload as CompleteRecoveryPayload;
      if (!session.pendingRecovery) throw new Error("No recovery is in progress in this session.");
      const result = await completeRecoveryWithNewCredentials({
        recovered: session.pendingRecovery,
        newLoginName: p.newLoginName,
        newPassword: p.newPassword,
        vaultRelayUrls,
        store
      });
      session.activeCredentialEvent = result.credentialEvent;
      session.activeRecoveryEvent = result.refreshedRecoveryEvent;
      // The recovery phrase's signing key must not linger beyond the operations that need it (§7.1, §11.10).
      session.pendingRecovery.recoveryPrivateKey.fill(0);
      session.pendingRecovery = null;
      await persistSession();
      return {
        locatorPublicKey: result.locatorPublicKey,
        credentialEventId: result.credentialEvent.id,
        refreshedRecoveryEventId: result.refreshedRecoveryEvent.id
      };
    }

    case "changePassword": {
      const p = payload as ChangePasswordPayload;
      const result = await changePasswordFlow({
        loginName: p.loginName,
        oldPassword: p.oldPassword,
        newPassword: p.newPassword,
        vaultRelayUrls,
        store,
        acknowledgeRollback: p.acknowledgeRollback
      });
      // Keep the session's capsule references current so a recovery export or replica
      // repair requested right after rotation (without an intervening re-login) still
      // finds the NEW credential capsule and the (unchanged) recovery capsule.
      session.activeCredentialEvent = result.newCredentialEvent;
      session.recoveryPublicKey = result.recoveryPublicKey;
      session.activeRecoveryEvent = result.recoveryCapsuleEvent;
      await persistSession();
      return {
        newLocatorPublicKey: result.newLocatorPublicKey,
        newGeneration: result.newGeneration,
        tombstoneAcknowledgedCount: result.tombstoneAcknowledgedCount,
        deletionAcknowledgedCount: result.deletionAcknowledgedCount
      };
    }

    case "publishProfileAndRelayLists": {
      const p = payload as PublishProfilePayload;
      const { everydayPrivateKey } = requireUnlocked();
      return publishInitialProfile({
        everydayPrivateKey,
        name: p.name,
        about: p.about,
        picture: p.picture,
        generalRelays: p.generalRelays,
        dmRelays: p.dmRelays,
        discoveryRelays: discoveryRelayUrls
      });
    }

    case "getPublicKey": {
      const { signer } = requireUnlocked();
      return { publicKey: signer.getPublicKey() };
    }

    case "signEvent": {
      const { signer } = requireUnlocked();
      const p = payload as SignEventPayload;
      if (session.signerOnly) {
        // The floor under the embedded signer's page (§SW5, §SW9.8): a session that arrived by a hand-off
        // signs only what its site may have signed, decided again here whatever that page prepared. For an
        // application that is its permission set, applied in full. For a site that declared nothing it is the
        // kind alone, a note or a reaction: this worker is never told which site a plain hand-off was for, so
        // the rest of that site's rules stay with the page.
        if (session.app) {
          const allowed = prepareForApp(session.app.permissions, p, session.app.site, Date.now() / 1000);
          if (!allowed) throw new Error("refused");
          return signer.signEvent(allowed);
        }
        if (signClass(p.kind) !== "ordinary") throw new Error("refused");
      }
      return signer.signEvent({ kind: p.kind, tags: p.tags, content: p.content, created_at: p.created_at });
    }

    case "nip44Encrypt": {
      const { signer } = requireUnlocked();
      const p = payload as Nip44EncryptPayload;
      return { ciphertext: signer.nip44Encrypt(p.peerPublicKey, p.plaintext) };
    }

    case "nip44Decrypt": {
      const { signer } = requireUnlocked();
      const p = payload as Nip44DecryptPayload;
      return { plaintext: signer.nip44Decrypt(p.peerPublicKey, p.payload) };
    }

    case "nip04Encrypt": {
      const { signer } = requireUnlocked();
      const p = payload as Nip04EncryptPayload;
      return { ciphertext: signer.nip04Encrypt(p.peerPublicKey, p.plaintext) };
    }

    case "nip04Decrypt": {
      const { signer } = requireUnlocked();
      const p = payload as Nip04DecryptPayload;
      return { plaintext: signer.nip04Decrypt(p.peerPublicKey, p.payload) };
    }

    case "exportIdentity": {
      const { everydayPrivateKey, signer } = requireUnlocked();
      return { nsec: encodeNsec(everydayPrivateKey), npub: encodeNpub(signer.getPublicKey()) };
    }

    case "buildRecoveryExport": {
      const { signer } = requireUnlocked();
      if (!session.recoveryPublicKey || !session.activeRecoveryEvent) {
        throw new Error("No recovery capsule is known in this session yet.");
      }
      void signer;
      return buildRecoveryExport({
        recoveryPublicKeyHex: session.recoveryPublicKey,
        vaultRelayUrls,
        recoveryCapsuleEvents: [session.activeRecoveryEvent],
        relayListEvents: []
      });
    }

    case "repairReplicas": {
      if (!session.activeCredentialEvent || !session.activeRecoveryEvent) {
        throw new Error("No active capsule events are known in this session yet.");
      }
      return rebroadcastCapsules({
        relayUrls: vaultRelayUrls,
        credentialEvent: session.activeCredentialEvent,
        recoveryEvent: session.activeRecoveryEvent
      });
    }

    case "checkReplicaHealth": {
      if (!session.activeCredentialEvent || !session.activeRecoveryEvent) {
        throw new Error("No active capsule events are known in this session yet.");
      }
      return checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: session.activeCredentialEvent,
        recoveryEvent: session.activeRecoveryEvent
      });
    }

    case "getSessionStatus": {
      return { unlocked: !!session.signer, everydayPublicKey: session.signer?.getPublicKey(), signerOnly: session.signerOnly };
    }

    // Called once, right after "configure", before the widget renders its welcome
    // screen -- restores whatever persistSession() last cached for this origin, so
    // a page reload doesn't ask for the login name + password again. A missing or
    // corrupt cache is not an error: it just means the widget falls through to its
    // normal welcome screen, exactly like it always has.
    case "restoreSession": {
      // Sealed under the lock, and not unlocked: not "no session". The caller asks for the PIN or the device.
      if (!lockKey && (await cachedSessionState(store)) === "locked") return { restored: false, locked: true };
      return restoreFromCache();
    }

    case "logout": {
      lockNow();
      await removeLock(store);
      await clearCachedSession(store);
      await clearPublicSession(store);
      return {};
    }

    // ---- Connection Vault (connection-vault.md §12, reveal mode) ----

    case "vaultStatus": {
      if (!session.signer) return { enabled: false };
      if (session.connectionVaultRoot) {
        return { enabled: true, vaultPublicKey: requireVault().vaultPublicKey };
      }
      return { enabled: false, reason: session.vaultKnown ? "no-vault" : "stale-cache" };
    }

    case "vaultList": {
      const { connections, rollbackWarnings, unreadable, truncated, quorumMet } = await listLiveConnections();
      return { connections: connections.map(summarize), rollbackWarnings, unreadable, truncated, quorumMet };
    }

    case "vaultSaveNwc": {
      const p = payload as { uri: string; label: string };
      const origin = selfOrigin();
      const vault = requireVault();
      const credential = parseNwcUri(p.uri);
      const label = p.label.trim().slice(0, 120) || "Wallet connection";
      const { record, event } = await vault.createConnection({
        connection_type: "nwc",
        tier: "connectable",
        label,
        credential: credential as unknown as { schema: string } & Record<string, unknown>,
        application_binding: { origin, app_pubkey: null }
      });
      const publish = await vault.publish({
        event,
        connectionId: record.connection_id,
        relayUrls: vaultRelayUrls,
        store
      });
      if (!publish.success) {
        // Nothing was stored anywhere durable -- say so instead of letting the
        // user believe a connection exists that no device can ever restore.
        throw new Error("The connection could not be saved to enough relays. Please try again.");
      }
      const decrypted = await vault.decryptEvent(event);
      return summarize(decrypted!);
    }

    case "vaultFindForOrigin": {
      const origin = selfOrigin();
      const { connections } = await listLiveConnections();
      const match = connections.find(
        (c) =>
          c.record.connection_type === "nwc" &&
          c.record.state === "active" &&
          c.record.application_binding.origin === origin
      );
      return { connection: match ? summarize(match) : null };
    }

    case "vaultRevealNwc": {
      const p = payload as { connectionId: string };
      const { connection } = await findConnection(p.connectionId);
      if (connection.record.connection_type !== "nwc" || connection.record.state !== "active") {
        throw new Error("That connection is not an active wallet connection.");
      }
      // THE authorization check. Reveal mode concedes that the requesting
      // origin receives the credential IT was granted (connection-vault.md
      // §12.3) -- it concedes nothing about OTHER origins' grants. Without
      // this, any caller that can name a connection id (they appear in the
      // management UI's markup) could pull a wallet the user connected to a
      // different site entirely.
      const boundOrigin = connection.record.application_binding.origin;
      if (boundOrigin !== null && boundOrigin !== selfOrigin()) {
        throw new Error("That connection belongs to a different site.");
      }
      const credential = connection.record.credential as unknown as NwcCredential;
      validateNwcCredential(credential);
      return { uri: toNwcUri(credential) };
    }

    case "vaultSetBinding": {
      // Two transitions only, and the difference is the whole feature:
      // origin === null is UNBIND (the dashboard's "Revoke app access"), and
      // anything else binds to THIS origin -- never a caller-named one, or a
      // host could adopt a wallet the user bound to another site.
      //
      // The bare identifier `origin` sat here and silently resolved to the
      // WORKER GLOBAL self.origin, so revoke rebound the record to the
      // calling page instead of clearing it -- the exact adoption this guard
      // exists to prevent, wearing the label of the button that prevents it.
      // It typechecked because the DOM lib declares that global.
      const p = payload as { connectionId: string; origin: string | null };
      const { vault, connection } = await findConnection(p.connectionId);
      const nextOrigin = p.origin === null ? null : selfOrigin();
      const { record, event } = await vault.updateConnection(connection, {
        application_binding: { origin: nextOrigin, app_pubkey: null }
      });
      const publish = await vault.publish({
        event,
        connectionId: record.connection_id,
        relayUrls: vaultRelayUrls,
        store
      });
      if (!publish.success) throw new Error("The change could not reach enough relays. Please try again.");
      const decrypted = await vault.decryptEvent(event);
      return summarize(decrypted!);
    }

    case "vaultDelete": {
      const p = payload as { connectionId: string };
      const { vault, connection } = await findConnection(p.connectionId);
      const { record, event } = await vault.deleteConnection(connection);
      const publish = await vault.publish({
        event,
        connectionId: record.connection_id,
        relayUrls: vaultRelayUrls,
        store
      });
      if (!publish.success) throw new Error("The deletion could not reach enough relays. Please try again.");
      // §CV11 step 3: best-effort NIP-09 request for the replaced event id.
      try {
        const deletion = vault.buildDeletionRequest(connection.event.id);
        const pool = new RelayPool(vaultRelayUrls);
        await pool.publishAll(deletion);
        pool.closeAll();
      } catch {
        // The tombstone is the durable part; a failed NIP-09 broadcast is not.
      }
      return {};
    }

    case "vaultOfferCheck": {
      // READ-ONLY on purpose. This used to publish an origin rebinding to
      // relays -- a real, durable mutation of the user's account -- from a
      // plain host API call, before any consent screen existed. Deduping is
      // a question, not a write. If the caller wants the binding refreshed,
      // that happens through the consented save path.
      const p = payload as { uri: string };
      const origin = selfOrigin();
      const credential = parseNwcUri(p.uri);
      const { connections } = await listLiveConnections();
      const existing = connections.find(
        (c) =>
          c.record.connection_type === "nwc" &&
          sameNwcCredential(c.record.credential as unknown as NwcCredential, credential)
      );
      if (!existing) return { duplicate: false };
      // Only report it as already-saved when it is already THIS origin's.
      // A wallet stored under another origin is not this caller's to claim
      // silently; treating it as new sends the user through consent, which
      // is the only place a cross-origin binding may legitimately change.
      if (existing.record.application_binding.origin !== origin) return { duplicate: false };
      return { duplicate: true, connection: summarize(existing) };
    }

    default:
      throw new Error(`Unknown worker action: ${action}`);
  }
}

const KNOWN_ACTIONS = new Set<string>([
  "configure", "register", "previewImportKey", "login", "recover", "previewPhraseRebuild",
  "rebuildFromPhrase", "completeRecovery",
  "changePassword", "publishProfileAndRelayLists", "getPublicKey", "signEvent",
  "nip44Encrypt", "nip44Decrypt", "nip04Encrypt", "nip04Decrypt", "exportIdentity",
  "buildRecoveryExport", "repairReplicas", "checkReplicaHealth", "getSessionStatus", "restoreSession", "logout",
  "handoffBegin", "handoffExport", "handoffAccept",
  "signerKeep", "signerRestore", "signerTouch", "signerForget",
  "appEncrypt", "appDecrypt", "appDecryptEvent", "loadProfile", "roomPass",
  "takeBack", "signerCheck",
  "lockStatus", "lockEnable", "lockSetDevice", "lockRemoveDevice", "lockDisable", "lockNow", "lockOpen",
  "vaultStatus", "vaultList", "vaultSaveNwc", "vaultFindForOrigin", "vaultRevealNwc",
  "vaultSetBinding", "vaultDelete", "vaultOfferCheck",
  "nip46Connect", "nip46NostrconnectStart", "nip46NostrconnectAwait", "nip46SignEvent",
  "nip46Nip44Encrypt", "nip46Nip44Decrypt", "nip46Nip04Encrypt", "nip46Nip04Decrypt",
  "nip46Disconnect"
]);

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  // Validate the envelope BEFORE destructuring. A malformed frame (or a
  // stray postMessage from anything else on the page) used to throw straight
  // out of this listener, which posts no response at all and leaves the
  // caller's promise pending forever.
  const frame = event.data as Partial<WorkerRequest> | null;
  if (!frame || typeof frame !== "object" || typeof frame.id !== "string") return;
  if (typeof frame.action !== "string" || !KNOWN_ACTIONS.has(frame.action)) {
    const response: WorkerResponse = {
      id: frame.id,
      ok: false,
      error: `Unknown worker action: ${String(frame.action)}`,
      errorName: "Error"
    };
    (self as unknown as Worker).postMessage(response);
    return;
  }
  const { id, action, payload } = event.data;
  // NIP-46 calls run OUTSIDE the serial queue: they touch none of the
  // account/vault state the queue exists to order, and a signer waiting
  // minutes for a human's approval must not block every other worker call
  // behind it (getSessionStatus, vault requests, even logout).
  const run =
    action.startsWith("nip46")
      ? (operation: () => Promise<unknown>) => operation()
      : (operation: () => Promise<unknown>) => requestQueue.run(operation);
  run(() => handle(action, payload)).then(
    (result) => {
      const response: WorkerResponse = { id, ok: true, result };
      (self as unknown as Worker).postMessage(response);
    },
    (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      const response: WorkerResponse = { id, ok: false, error: error.message, errorName: error.name };
      (self as unknown as Worker).postMessage(response);
    }
  );
});
