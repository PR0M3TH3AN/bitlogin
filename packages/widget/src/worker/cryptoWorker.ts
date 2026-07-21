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
import { RelayPool, BUILTIN_VAULT_RELAYS, BUILTIN_DISCOVERY_RELAYS, encodeNsec, encodeNpub, type NostrEvent } from "@bitlogin/core/nostr";
import { getPublicKeyHex } from "@bitlogin/core/crypto";
import { IndexedDbKeyValueStore } from "../storage/indexedDbStore.js";
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
  PreviewImportKeyPayload
} from "./protocol.js";

interface SessionState {
  signer: NostrSigner | null;
  everydayPrivateKey: Uint8Array | null;
  accountId: string | null;
  recoveryPublicKey: string | null;
  activeCredentialEvent: NostrEvent | null;
  activeRecoveryEvent: NostrEvent | null;
  pendingRecovery: RecoveredIdentity | null;
}

const session: SessionState = {
  signer: null,
  everydayPrivateKey: null,
  accountId: null,
  recoveryPublicKey: null,
  activeCredentialEvent: null,
  activeRecoveryEvent: null,
  pendingRecovery: null
};

let vaultRelayUrls: string[] = [...BUILTIN_VAULT_RELAYS];
let discoveryRelayUrls: string[] = [...BUILTIN_DISCOVERY_RELAYS];

const store = new IndexedDbKeyValueStore();

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
  if (session.pendingRecovery) {
    session.pendingRecovery.recoveryPrivateKey.fill(0);
    session.pendingRecovery.everydayPrivateKey.fill(0);
    session.pendingRecovery = null;
  }
}

async function handle(action: string, payload: unknown): Promise<unknown> {
  switch (action) {
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
        vaultRelayUrls
      });
      session.activeCredentialEvent = result.credentialEvent;
      session.activeRecoveryEvent = result.refreshedRecoveryEvent;
      // The recovery phrase's signing key must not linger beyond the operations that need it (§7.1, §11.10).
      session.pendingRecovery.recoveryPrivateKey.fill(0);
      session.pendingRecovery = null;
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

    case "logout": {
      clearSession();
      return {};
    }

    default:
      throw new Error(`Unknown worker action: ${action}`);
  }
}

self.addEventListener("message", (event: MessageEvent<WorkerRequest>) => {
  const { id, action, payload } = event.data;
  handle(action, payload).then(
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
