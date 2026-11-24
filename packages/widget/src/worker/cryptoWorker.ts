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
import { getPublicKeyHex, base64urlToBytes, wipe, generatePrivateKey, randomBytes, bytesToHex, getConversationKey } from "@bitlogin/core/crypto";
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
import { saveCachedSession, loadCachedSession, clearCachedSession, cachedSessionState, clearSessionSlot, keptSlot } from "./sessionCache.js";
import { describe as describeKept, forget as forgetKept, keep as keepKept, loadKept, saveKept } from "./keptAccounts.js";
import { LOCK_LIMITS, openLockWithDevice, openLockWithPin, readLock, removeLock, removeLockDevice, setLockDevice, setLockPin, type OpenResult } from "./lock.js";
import { openAppHandoff, sealHandoff, SIGNER_ONLY_ACTIONS, type HandoffApp, type SealedHandoff } from "./handoff.js";
import { inFamily, readFamily } from "../embedded/family.js";
import { isLocalAddress, isSignInAddress, mayDecryptFrom, mayEncryptTo, MESSAGE_KINDS, prepareForApp, readPeersFor } from "../embedded/permissions.js";
import { createSignGate, HELD_MOST, signClass } from "../embedded/policy.js";
import { openSave, SAVE_LIMITS, saveAddress, sealSave } from "../embedded/saves.js";
import { SCORE_LIMITS, scoreForWorld } from "../embedded/scores.js";
import { ACHIEVEMENT_LIMITS, achievementForWorld } from "../embedded/achievements.js";
import { buildMessageRelays, MESSAGE_WORLD_LIMITS, openWrap, REACH_WORLD_LIMITS, sealMessage, UNWRAP_WORLD_LIMITS } from "../embedded/messages.js";
import { believedList, cleanMore, FOLLOW_LIMITS, followForWorld, FOLLOWS_KIND, readFollowList } from "../embedded/follows.js";
import { buildRoomPass, newestProfile, type Profile } from "../embedded/profile.js";
import { CASHU_MINT_KIND, MINT_RECOMMENDATION_KIND, rankMints } from "../ecash/mints.js";
import { keepReceipts, loadReceipts, peekReceipts } from "./receiptStore.js";
import { loadPaySettings, savePaySettings } from "./paySettings.js";
import { quickRelays } from "./quickRelays.js";
import { isListSubject, listD, ownerListTemplate, resolveOwnerList, type ListScope } from "../embedded/guests.js";
import { lightningAddressOfProfile } from "../pay/lightning.js";
import { cleanCoordinate, sellerOf, UNLOCK_SERVICES } from "../pay/listing.js";
import { blossomAuth, loadDrive, peekDrive, rankServers, saveDrive, SERVER_LIST_KIND, serversIn, type DriveSave } from "./driveStore.js";
import { cleanServer, DRIVE_LIMITS } from "../drive/tree.js";
import { loadEcash, peekEcash, rollEcash, setEcashMints, type EcashRoll } from "./ecashStore.js";
import { deleteSignerGrant, grantedAt, grantSite, loadSignerGrant, saveSignerGrant } from "./signerGrant.js";
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
import { LaneQueue } from "./serialQueue.js";
import { RelayKeeper } from "./relayKeeper.js";
import type { VaultConnectionSummary, WorkerNotification } from "./protocol.js";
import type {
  WorkerRequest,
  WorldSavePayload,
  WorldFindPayload,
  WorldOpenPayload,
  WorldFollowPayload,
  WorldScorePayload,
  WorldAchievePayload,
  WorldSealPayload,
  WorldUnwrapPayload,
  WorldReachPayload,
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
  AccountPayload,
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
  /** For a signer-only session serving a world: what the user let it do beyond a note and a reaction, by name. */
  more: readonly string[];
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
  family: null,
  more: []
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
/** How long the wallet's opening waits for the account's relay list to be read again, where the session has one. */
const RELAY_LIST_WAIT_MS = 1500;
const requestQueue = new LaneQueue();
/**
 * Each store's own line (docs/panel-speed-2026-11-23.md): its reads and writes run one at a time, in order, and
 * beside the other stores'. Each touches only its own records, in this browser and on relays, and reads the session
 * without changing it. Everything else runs alone, as every action did before: signing in and out, the lock and
 * switching accounts wait for every line, and hold every line until they are done.
 */
const LANE: Record<string, string> = {
  ecashLoad: "ecash", ecashSetMints: "ecash", ecashRoll: "ecash",
  // Asks relays which mints people recommend, and writes nothing: a line of its own, so it holds up no wallet work.
  ecashMints: "mints",
  driveLoad: "drive", driveSave: "drive", blossomServers: "drive", blossomSetServers: "drive", blossomAuth: "drive",
  receiptsLoad: "receipts", receiptsKeep: "receipts",
  paySettingsLoad: "paySettings", paySettingsSave: "paySettings",
  // Reads the account's profile and relay list, and keeps them only if the session is still the one that asked.
  loadProfile: "profile", profileContent: "profile"
};

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
    // Locked with nothing in the active slot too, where other accounts are kept: theirs are sealed under it.
    locked: !lockKey && ((await cachedSessionState(store)) === "locked" || (await loadKept(store)).length > 0),
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

/**
 * A world: a site that declared nothing, in a session that arrived by a hand-off for it. What it keeps for its
 * visitor (saves) is asked of this, and of nothing else: an application is held to the set the user read.
 */
function requireWorld(): { signer: NostrSigner; everydayPrivateKey: Uint8Array; site: string } {
  const unlocked = requireUnlocked();
  if (!session.signerOnly || session.app || !session.site) throw new Error("refused");
  return { ...unlocked, site: session.site };
}

/**
 * One world's own counts, apart from notes and passes: each world has its own, whether it was allowed by itself or
 * as one of a family (a save is kept by the world's exact address). Kept where loading the page again can't lose
 * them; where nothing can be kept, a grant ends with the page too, so the count in memory is enough.
 */
const WORLD_COUNTS = "bitlogin:world-counts:v1:";
/** The time of the newest follow list of an account that this signer has signed, been handed or found: by public key. */
const FOLLOWS_SEEN = "bitlogin:follows-seen:v1:";
const worldCounts = new Map<string, number[]>();
async function takeWorldCount(what: string, site: string, limits: { burst: number; perMs: number; hourly: number }, /** False for a count too busy to write down each time: it starts again with the page, and is generous either way. */ kept = true): Promise<boolean> {
  const key = `${WORLD_COUNTS}${what}:${site}`;
  let already = worldCounts.get(key);
  if (!already) {
    try {
      const before: unknown = kept ? JSON.parse((await store.get(key)) ?? "[]") : [];
      already = Array.isArray(before) ? before.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-limits.hourly) : [];
    } catch {
      already = [];
    }
  }
  const gate = createSignGate(limits, already);
  // A count of when, not a secret: the time is what is counted.
  const nowMs = Date.now();
  const ok = gate.take(nowMs);
  worldCounts.set(key, gate.times());
  if (ok && kept) await store.set(key, JSON.stringify(gate.times())).catch(() => {});
  return ok;
}

function requireApp(): HandoffApp {
  if (!session.signerOnly || !session.app) throw new Error("refused");
  return session.app;
}

function clearSession(): void {
  // The kept relay connections go with the session (relayKeeper.ts): at sign-out, the lock, or another account.
  relayKeeper.closeAll();
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
  session.more = [];
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
  if (lock && !lockKey) {
    await removeLock(store);
    // The other accounts kept here were sealed under that lock, and its key is gone with it. They are signed
    // in to again the ordinary way.
    await forgetEveryKeptAccount();
  }
  const data = {
    everydayPrivateKey: session.everydayPrivateKey,
    accountId: session.accountId,
    recoveryPublicKey: session.recoveryPublicKey,
    activeCredentialEvent: session.activeCredentialEvent,
    activeRecoveryEvent: session.activeRecoveryEvent,
    ...(session.connectionVaultRoot ? { connectionVaultRoot: session.connectionVaultRoot } : {}),
    ...(session.vaultKnown ? { vaultEnabled: session.connectionVaultRoot !== null } : {}),
    everydayKeyDerived: session.everydayKeyDerived
  };
  const sealWith = lock && lockKey ? lockKey : null;
  await saveCachedSession(store, data, sealWith);
  // And in a slot of its own, so that signing in as another account does not sign this one out of the device
  // (docs/account-switching.md). The list of them holds nothing secret.
  const me = getPublicKeyHex(session.everydayPrivateKey);
  await saveCachedSession(store, data, sealWith, keptSlot(me));
  const kept = keepKept(await loadKept(store), me, Date.now() / 1000);
  for (const gone of kept.dropped) await clearSessionSlot(store, keptSlot(gone));
  await saveKept(store, kept.list);
  await persistPublicSession();
}

/** Every kept account but the list itself is a slot: remove them all, and the list. */
async function forgetEveryKeptAccount(): Promise<void> {
  for (const account of await loadKept(store)) await clearSessionSlot(store, keptSlot(account.pubkey));
  await saveKept(store, []);
}

/**
 * The lock's key is about to change (turned on, or off): every kept account but the one signed in is sealed
 * again under the new one. One that can't be read with the old key is forgotten: it could never be opened.
 */
async function resealKeptAccounts(oldKey: Uint8Array | null, newKey: Uint8Array | null): Promise<void> {
  const me = session.everydayPrivateKey ? getPublicKeyHex(session.everydayPrivateKey) : "";
  let list = await loadKept(store);
  for (const account of list) {
    if (account.pubkey === me) continue;
    const data = await loadCachedSession(store, oldKey, keptSlot(account.pubkey));
    if (data) {
      await saveCachedSession(store, data, newKey, keptSlot(account.pubkey));
      data.everydayPrivateKey.fill(0);
      data.connectionVaultRoot?.fill(0);
    } else {
      await clearSessionSlot(store, keptSlot(account.pubkey));
      list = forgetKept(list, account.pubkey);
    }
  }
  await saveKept(store, list);
}

/** Take up the cached session, with the lock key where the lock is on: the active one, or a kept account's. */
async function restoreFromCache(slot?: string): Promise<RestoreSessionResult> {
  const cached = await loadCachedSession(store, lockKey, slot);
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

/** Where a site's signer keeps the receipts it was handed, by site. */
const HELD_RECEIPTS = "bitlogin:held:v1:";

/**
 * How long a relay may take to accept a connection before it counts as not answering (docs/panel-speed-2026-11-23.md).
 * Without it a relay that accepts and then says nothing (relay.nostr.band, measured 2026-11-23) held every question
 * for eight seconds before that question's own timer even started. Three covers the slowest relay seen to answer
 * (2.7 s). A question still waits for every relay that connects, so what is written after a read is built on all
 * that answered.
 */
const READ_CONNECT_MS = 3000;
/**
 * And how long a relay that did connect may take to answer one question, on its own limit: a relay that connects and
 * then says nothing is cut off here, not left to each question's longer timer. Relays that answer were measured to
 * answer within a third of a second of connecting.
 */
const READ_ANSWER_MS = 2500;
/** The worker's relay connections, kept between actions, and the relays that failed a moment ago (relayKeeper.ts). */
const relayKeeper = new RelayKeeper(READ_CONNECT_MS);
const readPool = (urls: string[]): RelayPool => {
  const pool = new RelayPool(urls, {
    connectTimeoutMs: READ_CONNECT_MS,
    connectionFor: relayKeeper.connectionFor,
    notWaitedFor: relayKeeper.notWaitedFor,
    heard: relayKeeper.heard
  });
  const ask = pool.queryQuorum.bind(pool);
  pool.queryQuorum = (filter, timeoutMs = READ_ANSWER_MS) => ask(filter, Math.min(timeoutMs, READ_ANSWER_MS));
  return pool;
};
/**
 * How long, after two relays have taken a store's record, the rest are still given (docs/panel-speed-2026-11-23.md).
 * The stores count a record as kept once two have, as before. Every relay that is answering takes it within this; a
 * relay that connects and never answers cost each record its whole six seconds, one after another, and sats paid for
 * took eighteen to show.
 */
const SEND_GRACE_MS = 1500;
/** A careful read, and records sent until two relays have taken them and the rest have had their moment. */
const storePool = (urls: string[]): RelayPool => {
  const pool = readPool(urls);
  pool.publishAll = (event, timeoutMs) => pool.publishEnough(event, timeoutMs, 2, SEND_GRACE_MS);
  return pool;
};

/** Relays for the paying screens: asked together, and not waited on to the last one (quickRelays.ts). */
const quick = (urls: readonly string[]) => quickRelays(urls, (url) => readPool([url]));

/** Paying and buying are done on BitLogin's own pages, and nowhere a copy of the widget is hosted. */
function requireSignInAddress(): void {
  if (!isSignInAddress(selfOrigin())) throw new Error("That is done at BitLogin's own address.");
}

/**
 * The site a wallet connection is for. This page's own origin, always, except in one place: at one of BitLogin's
 * own sign-in addresses the page may name the site, because there the page is BitLogin's panel or window
 * answering for a world, and the person is shown that world's address before anything is shared (§SW20). In a
 * vendored copy at an application's address a named site is refused, so a host can never adopt, or be handed, a
 * wallet the user connected to another site.
 */
function walletSite(named: unknown): string {
  if (named === undefined) return selfOrigin();
  const site = grantSite(named);
  if (!site || !isSignInAddress(selfOrigin())) throw new Error("A wallet connection is for this site only.");
  return site;
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

async function handle(action: string, payload: unknown, id = ""): Promise<unknown> {
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
      await resealKeptAccounts(lockKey, fresh);
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
      await resealKeptAccounts(lockKey, null);
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
        // Nobody is signed in, and other accounts are kept under this lock: it is open, for one to be chosen.
        if ((await cachedSessionState(store)) === "none" && (await loadKept(store)).length > 0) return { ok: true, left: LOCK_LIMITS.tries, removed: false, restored: false };
        // The lock opened and there was nothing behind it that could be read: there is no lock to keep.
        await removeLock(store);
        lockNow();
        result = { ok: false, left: 0, removed: true };
      }
      if (result.removed) {
        lockNow();
        await forgetEveryKeptAccount();
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
          ...(p.more !== undefined ? { more: p.more } : {}),
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
            ...(!session.app && !session.family && session.more.length ? { more: cleanMore(session.more) } : {}),
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
      // More than a note and a reaction is the site's own grant's to say, never a family's.
      session.more = family ? [] : (grant.more ?? []);
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
        ...(session.more.length ? { more: cleanMore(session.more) } : {}),
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
      await store.delete(HELD_RECEIPTS + site).catch(() => {});
      // Its counts go with it: nothing is left here that says the site was ever used.
      for (const what of ["save", "follow", "seal", "unwrap", "reach", "score", "achieve"]) {
        worldCounts.delete(`${WORLD_COUNTS}${what}:${site}`);
        await store.delete(`${WORLD_COUNTS}${what}:${site}`).catch(() => {});
      }
      return {};
    }

    // The receipts BitLogin's own page handed a site's signer (docs/paying.md): the person's, for that site's own
    // listings. Kept beside the site's grant, so a page loaded again still knows what its visitor holds (owner,
    // 2026-11-21). They are signed notes and no secret; each is checked again where it is used. A signer-only
    // session only, and only for the site its hand-off was sealed for.
    case "signerHold":
    case "signerHeld": {
      const { signer } = requireUnlocked();
      if (!session.signerOnly) throw new Error("Only a site's signer holds receipts for it.");
      const site = grantSite((payload as { site?: unknown }).site);
      if (!site) throw new Error("That is not a site.");
      if ((session.app && session.app.site !== site) || (session.site && session.site !== site)) throw new Error("That is another site's.");
      const me = signer.getPublicKey();
      if (action === "signerHold") {
        const offered = (payload as { receipts?: unknown }).receipts;
        const receipts = (Array.isArray(offered) ? offered.slice(0, HELD_MOST) : []).filter((event): event is NostrEvent => !!event && typeof event === "object" && (event as NostrEvent).kind === 30078 && typeof (event as NostrEvent).content === "string" && (event as NostrEvent).content.length <= 8000 && verifyNostrEvent(event as NostrEvent));
        await store.set(HELD_RECEIPTS + site, JSON.stringify({ pubkey: me, receipts }));
        return {};
      }
      try {
        const kept = JSON.parse((await store.get(HELD_RECEIPTS + site)) ?? "null") as { pubkey?: unknown; receipts?: unknown } | null;
        return { receipts: kept?.pubkey === me && Array.isArray(kept.receipts) ? (kept.receipts as NostrEvent[]).slice(0, HELD_MOST) : [] };
      } catch {
        return { receipts: [] };
      }
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
      session.more = opened.more;
      return {
        everydayPublicKey: session.signer.getPublicKey(),
        ...(opened.app ? { app: opened.app } : {}),
        ...(opened.site ? { site: opened.site } : {}),
        ...(opened.profile ? { profile: opened.profile } : {}),
        ...(opened.remember ? { remember: true } : {}),
        ...(opened.family ? { family: opened.family } : {}),
        ...(opened.more.length ? { more: opened.more } : {})
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
      const pool = readPool(relayUrls);
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
        // What the chooser calls this account: as its own profile has it, when last read.
        if (session.profile && !session.signerOnly) await saveKept(store, describeKept(await loadKept(store), me, session.profile));
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
      const finder = readPool([...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8));
      let mine: string[];
      try {
        mine = writeRelaysFrom((await finder.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)).outcomes.flatMap((o) => o.events), me);
      } finally {
        finder.closeAll();
      }
      // Their own write relays, and BitLogin's, which every signer knows without being told.
      const relayUrls = [...new Set([...mine, ...vaultRelayUrls])].slice(0, 16);
      const pool = readPool(relayUrls);
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
      const pool = readPool(relayUrls);
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

    // ---- What a world keeps for its visitor (NSWP-12; embedded/saves.ts). The world is never taken from what is
    // asked: it is the site this session serves, as the browser gave it to the signer's page.

    case "worldSave": {
      const { signer, everydayPrivateKey, site } = requireWorld();
      const p = payload as WorldSavePayload;
      const conversationKey = getConversationKey(everydayPrivateKey, signer.getPublicKey());
      try {
        const save = sealSave({ conversationKey, world: site, slot: p.slot, data: p.data, nowSeconds: Date.now() / 1000 });
        if (!save || !(await takeWorldCount("save", site, SAVE_LIMITS))) throw new Error("refused");
        return signer.signEvent(save);
      } finally {
        wipe(conversationKey);
      }
    }

    case "worldFind": {
      const { signer, everydayPrivateKey, site } = requireWorld();
      const conversationKey = getConversationKey(everydayPrivateKey, signer.getPublicKey());
      try {
        const d = saveAddress(conversationKey, site, (payload as WorldFindPayload).slot);
        if (!d) throw new Error("refused");
        return { d };
      } finally {
        wipe(conversationKey);
      }
    }

    case "worldOpen": {
      const { signer, everydayPrivateKey, site } = requireWorld();
      const event = (payload as WorldOpenPayload).event;
      if (!verifyNostrEvent(event)) throw new Error("refused");
      const conversationKey = getConversationKey(everydayPrivateKey, signer.getPublicKey());
      try {
        const opened = openSave(event, { conversationKey, pubkey: signer.getPublicKey(), world: site });
        if (!opened) throw new Error("refused");
        return opened;
      } finally {
        wipe(conversationKey);
      }
    }

    // ---- Following from inside a world (NSWP-14; embedded/follows.ts). Only for a world the user let do this, by
    // name, in the window. The world hands over their newest follow list and one change; what is signed is that
    // list with that change and nothing else. A follow list replaces the last, so before a world's word is
    // believed this worker looks at the user's own relays itself: a world that is behind, or that says there is
    // no list where one merely couldn't be reached, is refused.
    case "worldFollow": {
      const { signer, site } = requireWorld();
      if (!session.more.includes("follows")) throw new Error("refused");
      const p = payload as WorldFollowPayload;
      const me = signer.getPublicKey();
      const list = p.list === null ? null : readFollowList(p.list, me);
      if (p.list !== null && !list) throw new Error("refused");
      const seenKey = FOLLOWS_SEEN + me;
      let seen = 0;
      try {
        const kept = Number(await store.get(seenKey));
        if (Number.isSafeInteger(kept) && kept > 0) seen = kept;
      } catch {
        /* nothing kept: only what is handed over and what relays say is known */
      }
      // Asked of where they write, and of the usual relays. A world's own choice of relays is not asked.
      const relayUrls = [...new Set([...cleanRelays(session.relays), ...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8);
      let answered = 0;
      let newestAt = 0;
      if (relayUrls.length) {
        const pool = readPool(relayUrls);
        try {
          const lists = await pool.queryQuorum({ kinds: [FOLLOWS_KIND], authors: [me], limit: 2 }, 3500);
          answered = lists.respondedCount;
          for (const found of lists.outcomes.flatMap((o) => o.events)) {
            if (found.created_at > newestAt && readFollowList(found, me)) newestAt = found.created_at;
          }
        } catch {
          /* no relay could be asked: as if none answered */
        } finally {
          pool.closeAll();
        }
      }
      // The page was closed, or the site signed out of, while relays were answering.
      if (session.signer !== signer || !session.more.includes("follows")) throw new Error("refused");
      seen = Math.max(seen, newestAt);
      if (seen) await store.set(seenKey, String(seen)).catch(() => {});
      if (!believedList(list, { answered, newestAt })) throw new Error("refused");
      const next = followForWorld({ list, ...(p.add !== undefined ? { add: p.add } : {}), ...(p.remove !== undefined ? { remove: p.remove } : {}), pubkey: me, nowSeconds: Date.now() / 1000, seen });
      if (!next || !(await takeWorldCount("follow", site, FOLLOW_LIMITS))) throw new Error("refused");
      // No mark of the site on it: a follow list that named the world it was last changed in would say where its
      // owner had been.
      const signed = signer.signEvent(next);
      await store.set(seenKey, String(Math.max(seen, signed.created_at))).catch(() => {});
      return signed;
    }

    // ---- A score on one of a world's boards (NSWP-15; embedded/scores.ts). For any world its visitor allowed: it
    // is less than a note. The world names its coordinate, a board and a number; the note and the mark that says
    // which site asked are this worker's own.
    case "worldScore": {
      const { signer, site } = requireWorld();
      const p = payload as WorldScorePayload;
      const score = scoreForWorld({ world: p.world, board: p.board, score: p.score, title: p.title, format: p.format, origin: site, nowSeconds: Date.now() / 1000 });
      if (!score || !(await takeWorldCount("score", site, SCORE_LIMITS))) throw new Error("refused");
      return signer.signEvent(score);
    }

    // ---- An achievement held in a world (NSWP-16; embedded/achievements.ts). As a score: for any world its visitor
    // allowed, built here from three plain fields, and marked with the site this session serves.
    case "worldAchieve": {
      const { signer, site } = requireWorld();
      const p = payload as WorldAchievePayload;
      const held = achievementForWorld({ world: p.world, id: p.achievement, title: p.title, origin: site, nowSeconds: Date.now() / 1000 });
      if (!held || !(await takeWorldCount("achieve", site, ACHIEVEMENT_LIMITS))) throw new Error("refused");
      return signer.signEvent(held);
    }

    // ---- Private messages from inside a world (NSWP-14; embedded/messages.ts). Only for a world the user let do
    // this, by name, in the window. The world names a reader and the words, or hands over a wrap; it is never given
    // a key, and nothing else is encrypted or decrypted for it.

    case "worldSeal": {
      const { signer, site } = requireWorld();
      if (!session.more.includes("messages")) throw new Error("refused");
      const p = payload as WorldSealPayload;
      const sealed = sealMessage(signer, { to: p.to, text: p.text, nowSeconds: Date.now() / 1000 });
      if (!sealed || !(await takeWorldCount("seal", site, MESSAGE_WORLD_LIMITS))) throw new Error("refused");
      return sealed;
    }

    case "worldUnwrap": {
      const { signer, site } = requireWorld();
      if (!session.more.includes("messages")) throw new Error("refused");
      if (!(await takeWorldCount("unwrap", site, UNWRAP_WORLD_LIMITS, false))) throw new Error("refused");
      const message = openWrap(signer, (payload as WorldUnwrapPayload).event);
      if (!message) throw new Error("refused");
      return { message };
    }

    case "worldReach": {
      const { signer, site } = requireWorld();
      if (!session.more.includes("messages")) throw new Error("refused");
      const list = buildMessageRelays((payload as WorldReachPayload).relays, Date.now() / 1000);
      if (!list || !(await takeWorldCount("reach", site, REACH_WORLD_LIMITS))) throw new Error("refused");
      // No mark of the site on it: where messages reach someone should not say where they have been.
      return signer.signEvent(list);
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
      const peers = readPeersFor(app.permissions, signer.getPublicKey(), event);
      // Kind 4 is the older scheme, and says so in its content.
      const older = event.kind === 4 || /\?iv=[A-Za-z0-9+/=]+$/u.test(event.content);
      // Against the key the event names, and then, for one the user signed themselves, their own: a note saved
      // for them alone is sealed to their own key whatever tags it carries.
      for (const peer of peers) {
        try {
          return { text: older ? signer.nip04Decrypt(peer, event.content) : signer.nip44Decrypt(peer, event.content) };
        } catch {
          // Not sealed to that key: the next is tried, and with none left it is refused.
        }
      }
      throw new Error("refused");
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

    // Log out: this account is forgotten on this device. Other accounts kept here stay, and so does the lock
    // they are sealed under; with none left, everything goes as it always did.
    case "logout": {
      const me = session.everydayPrivateKey && !session.signerOnly ? getPublicKeyHex(session.everydayPrivateKey) : "";
      const others = forgetKept(await loadKept(store), me);
      if (me) await clearSessionSlot(store, keptSlot(me));
      if (others.length > 0 && me) {
        await saveKept(store, others);
        clearSession();
        await clearSessionSlot(store);
        await clearPublicSession(store);
        return {};
      }
      lockNow();
      await removeLock(store);
      await forgetEveryKeptAccount();
      await clearCachedSession(store);
      await clearPublicSession(store);
      return {};
    }

    // ---- Several accounts on one device (docs/account-switching.md) ----

    // Who is kept here, and which of them is signed in. Public keys and what their own profiles call them.
    case "accountsList": {
      const active = session.everydayPrivateKey && !session.signerOnly ? getPublicKeyHex(session.everydayPrivateKey) : "";
      return { accounts: (await loadKept(store)).map((account) => ({ ...account, active: account.pubkey === active })) };
    }

    // Switch to a kept account: its own slot is opened, on this device, with no password and no relay. With the
    // lock on and locked, it says so, and nothing changes.
    case "accountsSwitch": {
      if (session.signerOnly) throw new Error("A signer-only session cannot switch accounts.");
      const pubkey = String((payload as AccountPayload).pubkey ?? "");
      const list = await loadKept(store);
      if (!list.some((account) => account.pubkey === pubkey)) return { restored: false };
      if (!lockKey && (await cachedSessionState(store, keptSlot(pubkey))) === "locked") return { restored: false, locked: true };
      const restored = await restoreFromCache(keptSlot(pubkey));
      if (!restored.restored || restored.everydayPublicKey !== pubkey) {
        // Unreadable, or not the account it was filed as: it is forgotten, and signed in to again the ordinary way.
        clearSession();
        await clearSessionSlot(store, keptSlot(pubkey));
        await saveKept(store, forgetKept(list, pubkey));
        await clearSessionSlot(store);
        await clearPublicSession(store);
        return { restored: false };
      }
      await persistSession();
      return restored;
    }

    // Make room to sign in as another account: nobody is signed in, and everyone kept stays kept.
    case "accountsAdd": {
      if (session.signerOnly) throw new Error("A signer-only session cannot add accounts.");
      clearSession();
      await clearSessionSlot(store);
      await clearPublicSession(store);
      return {};
    }

    // Forget one kept account that is not the one signed in. (For that one: log out.)
    case "accountsRemove": {
      const pubkey = String((payload as AccountPayload).pubkey ?? "");
      const active = session.everydayPrivateKey && !session.signerOnly ? getPublicKeyHex(session.everydayPrivateKey) : "";
      if (pubkey === active) throw new Error("Log out to remove the account that is signed in.");
      await clearSessionSlot(store, keptSlot(pubkey));
      await saveKept(store, forgetKept(await loadKept(store), pubkey));
      return {};
    }

    // ---- Connection Vault (connection-vault.md §12, reveal mode) ----

    // ---- An ecash wallet kept with the account (docs/ecash.md). A full session only: none of these is on the list a
    // handed-over session may ask, so no embedded signer, and so no site, can read a token.
    // ---- A person's files (docs/files.md). A full session only: none of these is on the list a handed-over
    // session may ask, so no embedded signer, and so no site, can read the index or have a permission note signed.
    case "blossomAuth": {
      const { signer } = requireUnlocked();
      return { token: blossomAuth(signer, payload as { verb: unknown; server: unknown; sha256?: unknown }) };
    }
    case "driveLoad":
    case "driveSave":
    case "blossomServers":
    case "blossomSetServers": {
      const { signer } = requireUnlocked();
      const me = signer.getPublicKey();
      const finderUrls = [...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8);
      let mine: string[] = session.relays;
      if (mine.length === 0 && finderUrls.length) {
        const finder = readPool(finderUrls);
        try {
          mine = writeRelaysFrom((await finder.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)).outcomes.flatMap((o) => o.events), me);
          // Kept for this session, as loadProfile keeps it: the next read needn't look it up again.
          if (mine.length) session.relays = mine;
        } catch {
          mine = [];
        } finally {
          finder.closeAll();
        }
      }
      const pool = storePool([...new Set([...mine, ...vaultRelayUrls, ...(action.startsWith("blossom") ? discoveryRelayUrls : [])])].slice(0, 16));
      try {
        const deps = { signer, store, relays: pool };
        if (action === "driveLoad") return await loadDrive(deps);
        if (action === "driveSave") return await saveDrive(deps, payload as DriveSave);
        const ownList = async (): Promise<string[]> => {
          const found = await pool.queryQuorum({ kinds: [SERVER_LIST_KIND], authors: [me], limit: 2 }, 4000);
          // Silence is not "no servers": a list written from it would replace the real one.
          if (found.respondedCount === 0) throw new Error("No relay answered for your server list.");
          const newest = found.outcomes.flatMap((o) => o.events).filter((event) => event.kind === SERVER_LIST_KIND && event.pubkey === me && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
          return newest ? serversIn(newest) : [];
        };
        if (action === "blossomSetServers") {
          const servers = [...new Set(((payload as { servers?: unknown }).servers as unknown[] | undefined ?? []).map(cleanServer).filter(Boolean))].slice(0, DRIVE_LIMITS.servers);
          if (servers.length === 0) throw new Error("Name at least one file server, by its https address.");
          // The standard, public list (BUD-03): it is how other apps find a person's files when a link breaks.
          const event = signer.signEvent({ kind: SERVER_LIST_KIND, created_at: Math.floor(Date.now() / 1000), tags: servers.map((server) => ["server", server]), content: "" });
          if (countAcknowledgements(await pool.publishAll(event, 6000)) < Math.min(2, pool.relayUrls.length)) throw new Error("No relay took your server list. Try again when you are online.");
          return { mine: servers };
        }
        // The servers people use are for the screen where a server is chosen, and only asked for there. They are only
        // shown, never written from, so they are asked quickly: not waiting on the slowest relay.
        if ((payload as { ranked?: unknown }).ranked !== true) return { mine: await ownList(), ranked: [] };
        const shown = quick(pool.relayUrls);
        const [own, lists, follows] = await Promise.all([
          ownList(),
          shown.queryQuorum({ kinds: [SERVER_LIST_KIND], limit: 500 }, 5000),
          shown.queryQuorum({ kinds: [FOLLOWS_KIND], authors: [me], limit: 2 }, 4000)
        ]).finally(() => shown.closeAll());
        const followList = follows.outcomes.flatMap((o) => o.events).filter((event) => event.pubkey === me && event.kind === FOLLOWS_KIND && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
        const followed = new Set((followList?.tags ?? []).filter((tag) => tag[0] === "p" && typeof tag[1] === "string").map((tag) => tag[1]!));
        const byId = new Map(lists.outcomes.flatMap((o) => o.events).filter((event) => event.pubkey !== me && verifyNostrEvent(event)).map((event) => [event.id, event]));
        return { mine: own, ranked: rankServers([...byId.values()], followed) };
      } finally {
        pool.closeAll();
      }
    }

    // ---- Paying, and buying (docs/paying.md). A full session at one of BitLogin's own sign-in addresses only: none
    // of these is on the list a handed-over session may ask, so no embedded signer, and so no site, can have a
    // buyer's permission note signed or read what a person bought.

    // Whom a tip is for: the name and the lightning address in that person's own signed profile. Read-only.
    case "payProfile": {
      requireUnlocked();
      requireSignInAddress();
      const who = (payload as { pubkey?: unknown }).pubkey;
      if (typeof who !== "string" || !/^[0-9a-f]{64}$/u.test(who)) throw new Error("That is not an account.");
      const relayUrls = [...new Set([...session.relays, ...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 10);
      if (relayUrls.length === 0) return { name: "", address: "", answered: false };
      const pool = quick(relayUrls);
      try {
        const found = await pool.queryQuorum({ kinds: [0], authors: [who], limit: 2 }, 3500);
        const events = found.outcomes.flatMap((o) => o.events);
        const newest = events.filter((event) => event.kind === 0 && event.pubkey === who && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
        return { name: newestProfile(events, who)?.name ?? "", address: newest ? lightningAddressOfProfile(newest.content, { local: isLocalAddress(selfOrigin()) }) : "", answered: found.respondedCount > 0 };
      } finally {
        pool.closeAll();
      }
    }

    // A listing, by its coordinate, from the relays its service names and the account's own. The page checks it.
    case "payListing": {
      requireUnlocked();
      requireSignInAddress();
      const p = payload as { coordinate?: unknown; relays?: unknown };
      const coordinate = cleanCoordinate(p.coordinate);
      if (!coordinate) throw new Error("That is not a listing.");
      const local = isLocalAddress(selfOrigin());
      const named = (Array.isArray(p.relays) ? p.relays : []).filter((url): url is string => typeof url === "string" && url.length <= 200 && (/^wss:\/\//u.test(url) || (local && /^ws:\/\/(localhost|127\.0\.0\.1)[:/]/u.test(url)))).slice(0, 6);
      const relayUrls = [...new Set([...named, ...session.relays, ...discoveryRelayUrls])].slice(0, 12);
      if (relayUrls.length === 0) return { event: null, answered: false };
      const pool = quick(relayUrls);
      try {
        const found = await pool.queryQuorum({ kinds: [30078], authors: [sellerOf(coordinate)], "#d": [coordinate.slice(71)], limit: 4 }, 5000);
        const newest = found.outcomes.flatMap((o) => o.events).filter((event) => event.kind === 30078 && event.pubkey === sellerOf(coordinate) && event.tags.some((tag) => tag[0] === "d" && tag[1] === coordinate.slice(71)) && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
        return { event: newest ?? null, answered: found.respondedCount > 0 };
      } finally {
        pool.closeAll();
      }
    }

    // A buyer's permission note (NIP-98) for one request to a selling service BitLogin knows: this address, this
    // method, this body, once. Kind 27235 is signed here and nowhere else, and never for a site.
    case "unlockAuth": {
      const { signer } = requireUnlocked();
      requireSignInAddress();
      const p = payload as { url?: unknown; method?: unknown; payload?: unknown };
      let url: URL;
      try {
        url = new URL(String(p.url));
      } catch {
        throw new Error("That is not an address.");
      }
      const known = UNLOCK_SERVICES.some((service) => service.endpoint === url.origin) || (isLocalAddress(selfOrigin()) && isLocalAddress(url.origin));
      if (typeof p.url !== "string" || p.url.length > 1000 || url.toString() !== p.url || url.username || url.password || !known) throw new Error("That is not a service BitLogin buys from.");
      if (p.method !== "GET" && p.method !== "POST") throw new Error("That is not something a selling service is asked.");
      const body = typeof p.payload === "string" && /^[0-9a-f]{64}$/u.test(p.payload) ? p.payload : "";
      if (p.method === "POST" && !body) throw new Error("A permission note names what is sent with it.");
      const event = signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), tags: [["u", p.url], ["method", p.method], ["bitunlock:nonce", crypto.randomUUID()], ...(body ? [["payload", body]] : [])], content: "" });
      const bytes = new TextEncoder().encode(JSON.stringify(event));
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return { token: `Nostr ${btoa(binary)}` };
    }

    // ---- A world owner's lists (embedded/guests.ts). A full session at one of BitLogin's own sign-in addresses
    // only: the page asks the owner every time, and these build nothing a world wrote but the people. Kind 30078 stays
    // on the never list for every site's `sign` and `propose`.

    // The newest of this account's own lists for a world, as relays hold it: so a world can't hand over an old one.
    case "guestListFind": {
      const { signer } = requireUnlocked();
      requireSignInAddress();
      const p = payload as { subject?: unknown; scope?: unknown };
      if (!isListSubject(p.subject) || (p.scope !== "user-allow" && p.scope !== "user-deny")) throw new Error("That is not a world's list.");
      const me = signer.getPublicKey();
      // A careful read, not a quick one: the list found here decides whether the world's is the newest, and a new one is
      // written on it. Every relay that connects within the limit is waited for.
      const pool = readPool([...new Set([...session.relays, ...vaultRelayUrls, ...discoveryRelayUrls])].slice(0, 12));
      try {
        const found = await pool.queryQuorum({ kinds: [30078], authors: [me], "#d": [listD(p.scope, p.subject)], limit: 4 }, 5000);
        const events = found.outcomes.flatMap((o) => o.events);
        // The one that stands, by the readers' own rule. One that doesn't read is no list to change.
        const d = listD(p.scope as ListScope, p.subject as string);
        const standing = resolveOwnerList(events, { scope: p.scope as ListScope, subject: p.subject as string, root: [me] });
        const mine = events.filter((e) => e.pubkey === me && e.kind === 30078 && e.tags.some((t) => t[0] === "d" && t[1] === d) && e.created_at <= Date.now() / 1000 + 600).sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
        return { event: standing.ok ? (mine[0] ?? null) : null, answered: found.respondedCount > 0 };
      } finally {
        pool.closeAll();
      }
    }

    // Sign this account's list for a world: built here from the world, which list, and who is on it. Nothing else.
    case "guestListSign": {
      const { signer } = requireUnlocked();
      requireSignInAddress();
      const p = payload as { subject?: unknown; scope?: unknown; people?: unknown; replaces?: unknown };
      const notBefore = typeof p.replaces === "number" && Number.isSafeInteger(p.replaces) && p.replaces <= Date.now() / 1000 + 600 ? p.replaces : undefined;
      const template = p.scope === "user-allow" || p.scope === "user-deny" ? ownerListTemplate({ scope: p.scope, subject: String(p.subject), people: Array.isArray(p.people) ? (p.people as string[]) : [], createdAt: Math.floor(Date.now() / 1000), ...(notBefore !== undefined ? { notBefore } : {}) }) : null;
      if (!template || !isListSubject(p.subject)) throw new Error("That is not a list this account can keep.");
      return { event: signer.signEvent(template) };
    }

    // The receipts kept with the account: in this browser first, then on its relays, each sealed to its own key.
    case "paySettingsLoad":
    case "paySettingsSave":
    case "receiptsLoad":
    case "receiptsKeep": {
      const { signer } = requireUnlocked();
      requireSignInAddress();
      const me = signer.getPublicKey();
      const finderUrls = [...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8);
      let mine: string[] = session.relays;
      if (mine.length === 0 && finderUrls.length) {
        const finder = quick(finderUrls);
        try {
          mine = writeRelaysFrom((await finder.queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)).outcomes.flatMap((o) => o.events), me);
          // Kept for this session, as loadProfile keeps it: the next read needn't look it up again.
          if (mine.length) session.relays = mine;
        } catch {
          mine = [];
        } finally {
          finder.closeAll();
        }
      }
      // The settings are written whole from what is read here, so they are read carefully: every relay that connects
      // within the limit is waited for. A receipt record is never changed once written (one record a receipt, the same
      // words each time), so sending it again can't overwrite anything newer: those may be read quickly.
      const relayUrlsHere = [...new Set([...mine, ...vaultRelayUrls])].slice(0, 16);
      const pool = action === "receiptsLoad" || action === "receiptsKeep" ? quick(relayUrlsHere) : storePool(relayUrlsHere);
      try {
        const deps = { signer, store, relays: pool };
        if (action === "paySettingsLoad") return await loadPaySettings(deps);
        if (action === "paySettingsSave") return await savePaySettings(deps, payload);
        return action === "receiptsLoad" ? await loadReceipts(deps) : await keepReceipts(deps, (payload as { receipts?: unknown }).receipts);
      } finally {
        pool.closeAll();
      }
    }

    // The words of their newest profile note, to show what a proposed one would change. Read-only, and theirs.
    case "profileContent": {
      const { signer } = requireUnlocked();
      const me = signer.getPublicKey();
      const relayUrls = [...new Set([...session.relays, ...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 10);
      if (relayUrls.length === 0) return { content: null, answered: false };
      const pool = readPool(relayUrls);
      try {
        const found = await pool.queryQuorum({ kinds: [0], authors: [me], limit: 2 }, 3500);
        const newest = found.outcomes.flatMap((o) => o.events).filter((event) => event.kind === 0 && event.pubkey === me && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
        return { content: newest ? newest.content : null, answered: found.respondedCount > 0 };
      } finally {
        pool.closeAll();
      }
    }

    // The mints people recommend (NIP-87): read from relays, counted one voice per account, the user's own follows
    // first. It reads public notes and the user's follow list, and writes nothing.
    case "ecashMints": {
      const { signer } = requireUnlocked();
      const me = signer.getPublicKey();
      const relayUrls = [...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8);
      if (relayUrls.length === 0) return { mints: [] };
      // Only shown, never written from: asked quickly, not waiting on the slowest relay.
      const pool = quick(relayUrls);
      try {
        const [recommended, lists] = await Promise.all([
          pool.queryQuorum({ kinds: [MINT_RECOMMENDATION_KIND], "#k": [CASHU_MINT_KIND], limit: 500 }, 5000),
          pool.queryQuorum({ kinds: [FOLLOWS_KIND], authors: [me], limit: 2 }, 4000)
        ]);
        const newest = lists.outcomes.flatMap((o) => o.events).filter((event) => event.pubkey === me && event.kind === FOLLOWS_KIND && verifyNostrEvent(event)).sort((a, b) => b.created_at - a.created_at)[0];
        const follows = new Set((newest?.tags ?? []).filter((tag) => tag[0] === "p" && typeof tag[1] === "string").map((tag) => tag[1]!));
        const byId = new Map(recommended.outcomes.flatMap((o) => o.events).filter((event) => verifyNostrEvent(event)).map((event) => [event.id, event]));
        return { mints: rankMints([...byId.values()], follows) };
      } finally {
        pool.closeAll();
      }
    }

    // The browser's own copies, asked of no relay and writing nothing: shown at once, marked as being checked, while
    // the careful read above runs behind them (docs/panel-speed-2026-11-23.md). A full session only, as the loads are.
    case "ecashPeek":
    case "drivePeek":
    case "receiptsPeek": {
      const { signer } = requireUnlocked();
      if (action === "receiptsPeek") requireSignInAddress();
      const deps = { signer, store };
      return action === "ecashPeek" ? await peekEcash(deps) : action === "drivePeek" ? await peekDrive(deps) : await peekReceipts(deps);
    }

    case "ecashLoad":
    case "ecashSetMints":
    case "ecashRoll": {
      const { signer } = requireUnlocked();
      const me = signer.getPublicKey();
      // Their own write relays, and BitLogin's: the same place a take-back is kept. The list is read again each time
      // (2026-11-24): one changed in another app since sign-in, to relays that take wallet records, is used at the
      // next opening, with no sign-out. Where the session already has a list, that read is waited for only briefly,
      // and finishes behind, for the next time.
      const finder = readPool([...new Set([...discoveryRelayUrls, ...vaultRelayUrls])].slice(0, 8));
      const fresh = finder
        .queryQuorum({ kinds: [RELAY_LIST_KIND], authors: [me], limit: 2 }, 4000)
        .then((found) => writeRelaysFrom(found.outcomes.flatMap((o) => o.events), me))
        .catch(() => [] as string[])
        .then((list) => {
          // Kept for this session, as loadProfile keeps it, unless the session changed meanwhile.
          if (list.length && session.signer === signer) session.relays = list;
          return list;
        })
        .finally(() => finder.closeAll());
      let mine: string[] = session.relays;
      if (mine.length === 0) mine = await fresh;
      else {
        const read = await Promise.race([fresh, new Promise<string[]>((done) => setTimeout(() => done([]), RELAY_LIST_WAIT_MS))]);
        if (read.length) mine = read;
      }
      const relayUrls = [...new Set([...mine, ...vaultRelayUrls])].slice(0, 16);
      const pool = storePool(relayUrls);
      try {
        const deps = { signer, store, relays: pool };
        if (action === "ecashLoad") return await loadEcash(deps);
        if (action === "ecashSetMints") return await setEcashMints({ ...deps, newKey: () => bytesToHex(generatePrivateKey()) }, (payload as { mints?: unknown }).mints);
        // The page is told once the new proofs are sealed here, for that call alone: "Added" is true from then on.
        return await rollEcash(deps, payload as EcashRoll, () => (self as unknown as Worker).postMessage({ notify: "ecash-sealed", id } satisfies WorkerNotification));
      } finally {
        pool.closeAll();
      }
    }

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
      const p = payload as { uri: string; label: string; site?: unknown };
      const origin = walletSite(p.site);
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
      const origin = walletSite((payload as { site?: unknown }).site);
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
      const p = payload as { connectionId: string; site?: unknown };
      const forSite = walletSite(p.site);
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
      if (boundOrigin !== null && boundOrigin !== forSite) {
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
  "signerKeep", "signerRestore", "signerTouch", "signerForget", "signerHold", "signerHeld",
  "appEncrypt", "appDecrypt", "appDecryptEvent", "loadProfile", "roomPass", "worldSave", "worldFind", "worldOpen", "worldFollow", "worldScore", "worldAchieve", "worldSeal", "worldUnwrap", "worldReach",
  "takeBack", "signerCheck", "accountsList", "accountsSwitch", "accountsAdd", "accountsRemove",
  "lockStatus", "lockEnable", "lockSetDevice", "lockRemoveDevice", "lockDisable", "lockNow", "lockOpen",
  "ecashLoad", "ecashSetMints", "ecashRoll", "ecashMints", "profileContent",
  "ecashPeek", "drivePeek", "receiptsPeek", "payProfile", "payListing", "unlockAuth", "guestListFind", "guestListSign", "receiptsLoad", "receiptsKeep", "paySettingsLoad", "paySettingsSave",
  "driveLoad", "driveSave", "blossomAuth", "blossomServers", "blossomSetServers",
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
    // The peeks too: they read the browser's own sealed copy and change nothing, and they are what is on screen while
    // the queue is busy asking relays (docs/panel-speed-2026-11-23.md).
    action.startsWith("nip46") || action === "ecashPeek" || action === "drivePeek" || action === "receiptsPeek"
      ? (operation: () => Promise<unknown>) => operation()
      : (operation: () => Promise<unknown>) => requestQueue.run(LANE[action] ?? null, operation);
  run(() => handle(action, payload, id)).then(
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
