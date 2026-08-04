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
  completeRecoveryWithNewCredentials,
  changePassword as changePasswordFlow,
  publishInitialProfile,
  buildRecoveryExport,
  repairReplicas,
  importAccount,
  decodeEverydayPrivateKey,
  NostrSigner,
  type RecoveredIdentity
} from "@bitlogin/core/account";
import {
  RelayPool,
  BUILTIN_VAULT_RELAYS,
  BUILTIN_DISCOVERY_RELAYS,
  encodeNsec,
  encodeNpub,
  Nip46Client,
  parseBunkerUri,
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
import { saveCachedSession, loadCachedSession, clearCachedSession } from "./sessionCache.js";
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
  ChangePasswordPayload,
  PublishProfilePayload,
  SignEventPayload,
  Nip44EncryptPayload,
  Nip44DecryptPayload,
  Nip04EncryptPayload,
  Nip04DecryptPayload,
  PreviewImportKeyPayload,
  Nip46ConnectPayload,
  Nip46NostrconnectStartPayload
} from "./protocol.js";

interface SessionState {
  signer: NostrSigner | null;
  everydayPrivateKey: Uint8Array | null;
  accountId: string | null;
  recoveryPublicKey: string | null;
  activeCredentialEvent: NostrEvent | null;
  activeRecoveryEvent: NostrEvent | null;
  pendingRecovery: RecoveredIdentity | null;
  /** Connection Vault root (§CV5.2), or null when the account predates the
   *  vault OR the restored cache predates the field — vaultKnown tells the
   *  two apart. The SUDO key is deliberately NOT session state: personal-tier
   *  records are out of scope for the widget until a sudo ceremony exists,
   *  and the key is wiped the moment a login result delivers it. */
  connectionVaultRoot: Uint8Array | null;
  vaultKnown: boolean;
  vault: VaultSession | null;
}

const session: SessionState = {
  signer: null,
  everydayPrivateKey: null,
  accountId: null,
  recoveryPublicKey: null,
  activeCredentialEvent: null,
  activeRecoveryEvent: null,
  pendingRecovery: null,
  connectionVaultRoot: null,
  vaultKnown: false,
  vault: null
};

let vaultRelayUrls: string[] = [...BUILTIN_VAULT_RELAYS];
let discoveryRelayUrls: string[] = [...BUILTIN_DISCOVERY_RELAYS];

const store = new IndexedDbKeyValueStore();
const requestQueue = new SerialQueue();

function requireUnlocked(): { signer: NostrSigner; everydayPrivateKey: Uint8Array } {
  if (!session.signer || !session.everydayPrivateKey) {
    throw new Error("No identity is unlocked in this session.");
  }
  return { signer: session.signer, everydayPrivateKey: session.everydayPrivateKey };
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
  session.vault?.destroy();
  session.vault = null;
  if (session.connectionVaultRoot) session.connectionVaultRoot.fill(0);
  session.connectionVaultRoot = null;
  session.vaultKnown = false;
  if (session.pendingRecovery) {
    session.pendingRecovery.recoveryPrivateKey.fill(0);
    session.pendingRecovery.everydayPrivateKey.fill(0);
    session.pendingRecovery = null;
  }
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
  await saveCachedSession(store, {
    everydayPrivateKey: session.everydayPrivateKey,
    accountId: session.accountId,
    recoveryPublicKey: session.recoveryPublicKey,
    activeCredentialEvent: session.activeCredentialEvent,
    activeRecoveryEvent: session.activeRecoveryEvent,
    ...(session.connectionVaultRoot ? { connectionVaultRoot: session.connectionVaultRoot } : {}),
    ...(session.vaultKnown ? { vaultEnabled: session.connectionVaultRoot !== null } : {})
  });
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

/** Retires a previous session with the courtesy protocol logout (current
 *  NIP-46 defines it as exactly that -- not a security boundary), then
 *  closes it, which wipes its keys. */
function retireNip46Client(client: Nip46Client): void {
  void client
    .logout()
    .catch(() => {})
    .finally(() => client.close());
}

function adoptNip46Client(client: Nip46Client, userPubkey: string): void {
  if (nip46) retireNip46Client(nip46.client);
  nip46 = { client, userPubkey };
}

async function handle(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
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
      const { signerPubkey } = await listenForNostrconnect({
        clientSecretKey: pending.clientSecretKey,
        relayUrls: pending.relayUrls,
        secret: pending.secret,
        timeoutMs: 180_000,
        signal: pending.abort.signal
      });
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
      if (p.vaultRelayUrls?.length) vaultRelayUrls = p.vaultRelayUrls;
      if (p.discoveryRelayUrls?.length) discoveryRelayUrls = p.discoveryRelayUrls;
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
      adoptVaultMaterial(result.connectionVaultRoot, result.vaultSudoKey);
      await persistSession();
      return {
        recoveryPhrase: result.recoveryPhrase,
        everydayPublicKey: result.everydayPublicKey,
        recoveryPublicKey: result.recoveryPublicKey,
        accountId: result.accountId,
        imported: result.imported,
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
      adoptVaultMaterial(result.connectionVaultRoot, result.vaultSudoKey);
      await persistSession();
      return {
        everydayPublicKey: result.everydayPublicKey,
        accountId: result.accountId,
        generation: result.generation,
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
      clearSession();
      session.pendingRecovery = recovered;
      session.signer = new NostrSigner(recovered.everydayPrivateKey);
      session.everydayPrivateKey = recovered.everydayPrivateKey;
      session.accountId = recovered.accountId;
      session.recoveryPublicKey = recovered.recoveryPublicKey;
      session.activeRecoveryEvent = recovered.currentRecoveryEvent;
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
        chainWarning: recovered.chainWarning
      };
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
      const pool = new RelayPool(vaultRelayUrls);
      const result = await repairReplicas(pool, session.activeCredentialEvent, session.activeRecoveryEvent);
      pool.closeAll();
      return result;
    }

    case "getSessionStatus": {
      return { unlocked: !!session.signer, everydayPublicKey: session.signer?.getPublicKey() };
    }

    // Called once, right after "configure", before the widget renders its welcome
    // screen -- restores whatever persistSession() last cached for this origin, so
    // a page reload doesn't ask for the login name + password again. A missing or
    // corrupt cache is not an error: it just means the widget falls through to its
    // normal welcome screen, exactly like it always has.
    case "restoreSession": {
      const cached = await loadCachedSession(store);
      if (!cached) return { restored: false };
      clearSession();
      session.signer = new NostrSigner(cached.everydayPrivateKey);
      session.everydayPrivateKey = cached.everydayPrivateKey;
      session.accountId = cached.accountId;
      session.recoveryPublicKey = cached.recoveryPublicKey;
      session.activeCredentialEvent = cached.activeCredentialEvent;
      session.activeRecoveryEvent = cached.activeRecoveryEvent;
      session.connectionVaultRoot = cached.connectionVaultRoot ?? null;
      // vaultKnown only when the cache recorded a definitive answer; an old
      // cache entry leaves it false so requireVault says "sign in again"
      // rather than falsely claiming the account has no vault.
      session.vaultKnown = cached.vaultEnabled !== undefined;
      return { restored: true, everydayPublicKey: session.signer.getPublicKey(), accountId: cached.accountId };
    }

    case "logout": {
      clearSession();
      await clearCachedSession(store);
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
  "configure", "register", "previewImportKey", "login", "recover", "completeRecovery",
  "changePassword", "publishProfileAndRelayLists", "getPublicKey", "signEvent",
  "nip44Encrypt", "nip44Decrypt", "nip04Encrypt", "nip04Decrypt", "exportIdentity",
  "buildRecoveryExport", "repairReplicas", "getSessionStatus", "restoreSession", "logout",
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
