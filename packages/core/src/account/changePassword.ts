/** Known-password change: mandatory tombstone + NIP-09 deletion of the old locator (§18.1). */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { derivePasswordKeys, normalizeLoginName } from "./normalize.js";
import { nextCreatedAt } from "./timestamp.js";
import { RelayPool, countAcknowledgements } from "../nostr/pool.js";
import { D_TAG_PASSWORD_CAPSULE, KIND_APP_DATA, SCHEMA_CREDENTIAL_V1 } from "../nostr/kinds.js";
import { readCredentialCapsule } from "./capsuleReader.js";
import { buildCredentialCapsuleEvent, buildCredentialTombstoneEvent } from "../capsules/credentialCapsule.js";
import { buildDeletionRequest } from "../nostr/nip09.js";
import { PROTOCOL_CAPSULE_ENCRYPTION, PROTOCOL_PASSWORD_KDF, PROTOCOL_RECOVERY_DERIVATION } from "../capsules/types.js";
import type { CredentialPayload } from "../capsules/types.js";
import { publishAndVerify, type PublishVerificationResult } from "./publish.js";
import { AccountNotFoundError, RegistrationFailedError, RollbackDetectedError } from "./errors.js";
import { getHighWaterMark, raiseHighWaterMark } from "./highWaterMark.js";
import { InMemoryKeyValueStore, type KeyValueStore } from "../storage/interface.js";
import type { NostrEvent } from "../nostr/event.js";

export interface ChangePasswordParams {
  loginName: string;
  oldPassword: string;
  newPassword: string;
  vaultRelayUrls: string[];
  store?: KeyValueStore;
  minAcknowledgements?: number;
  timeoutMs?: number;
  now?: number;
  /** See {@link RollbackDetectedError} and the equivalent option on `LoginParams` (§16.2 step 6). */
  acknowledgeRollback?: boolean;
}

export interface ChangePasswordResult {
  normalizedLoginName: string;
  oldLocatorPublicKey: string;
  newLocatorPublicKey: string;
  newGeneration: number;
  /** Carried forward unchanged from the old capsule (§14.1: rotation never touches the recovery capsule). */
  recoveryPublicKey: string;
  recoveryCapsuleEvent: NostrEvent;
  newCredentialEvent: NostrEvent;
  tombstoneEvent: NostrEvent;
  deletionRequestEvent: NostrEvent;
  newCredentialPublish: PublishVerificationResult;
  tombstoneAcknowledgedCount: number;
  deletionAcknowledgedCount: number;
}

export async function changePassword(params: ChangePasswordParams): Promise<ChangePasswordResult> {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const normalizedLoginName = normalizeLoginName(params.loginName);

  const oldKeys = await derivePasswordKeys(params.oldPassword, normalizedLoginName);
  const oldLocatorPublicKey = getPublicKeyHex(oldKeys.locatorPrivateKey);

  const readPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: oldKeys.locatorPrivateKey });
  let readResult;
  try {
    readResult = await readCredentialCapsule(readPool, oldLocatorPublicKey, oldKeys.capsuleKey, params.timeoutMs);
  } finally {
    readPool.closeAll();
  }
  if (!readResult.quorumMet) throw new AccountNotFoundError("quorum-not-met");
  if (!readResult.best) {
    throw new AccountNotFoundError(readResult.candidates.length > 0 ? "no-valid-candidate" : "no-matching-event");
  }
  const oldPayload = readResult.best.payload!;
  const oldEvent = readResult.best.event;

  // §16.2 step 6: the "old password" supplied here derives its own locator address, distinct
  // from any other password's -- if this device has already seen a newer generation than what
  // that address reports, the safe assumption is that this password itself is stale (already
  // rotated away elsewhere) and a relay is simply replaying its last-known capsule, not that
  // this is a legitimate in-progress rotation.
  const store = params.store ?? new InMemoryKeyValueStore();
  const hwm = await getHighWaterMark(store, oldPayload.operational_public_key);
  if (oldPayload.generation < hwm.generation && !params.acknowledgeRollback) {
    throw new RollbackDetectedError(hwm.generation, oldPayload.generation);
  }

  const newKeys = await derivePasswordKeys(params.newPassword, normalizedLoginName);
  const newLocatorPublicKey = getPublicKeyHex(newKeys.locatorPrivateKey);
  const newGeneration = oldPayload.generation + 1;

  const newPayload: CredentialPayload = {
    schema: SCHEMA_CREDENTIAL_V1,
    account_id: oldPayload.account_id,
    generation: newGeneration,
    operational_private_key: oldPayload.operational_private_key,
    operational_public_key: oldPayload.operational_public_key,
    recovery_public_key: oldPayload.recovery_public_key,
    recovery_capsule_event: oldPayload.recovery_capsule_event,
    created_at: now,
    vault_relay_hints: params.vaultRelayUrls,
    protocol: {
      password_kdf: PROTOCOL_PASSWORD_KDF,
      capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
      recovery_derivation: PROTOCOL_RECOVERY_DERIVATION
    }
  };
  const newCredentialEvent = await buildCredentialCapsuleEvent({
    locatorPrivateKey: newKeys.locatorPrivateKey,
    capsuleKey: newKeys.capsuleKey,
    payload: newPayload
  });

  const newPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: newKeys.locatorPrivateKey });
  const newCredentialPublish = await publishAndVerify(newPool, newCredentialEvent, {
    dTag: D_TAG_PASSWORD_CAPSULE,
    minAcks: params.minAcknowledgements,
    timeoutMs: params.timeoutMs
  });
  newPool.closeAll();

  // §18.1 steps 4-5: mandatory tombstone + NIP-09 deletion at the OLD locator address.
  const tombstoneEvent = buildCredentialTombstoneEvent({
    oldLocatorPrivateKey: oldKeys.locatorPrivateKey,
    createdAt: nextCreatedAt(oldEvent.created_at, now)
  });
  const deletionRequestEvent = buildDeletionRequest({
    privateKey: oldKeys.locatorPrivateKey,
    eventIdToDelete: oldEvent.id,
    deletedEventKind: KIND_APP_DATA,
    createdAt: now
  });

  const oldPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: oldKeys.locatorPrivateKey });
  const [tombstoneOutcomes, deletionOutcomes] = await Promise.all([
    oldPool.publishAll(tombstoneEvent, params.timeoutMs),
    oldPool.publishAll(deletionRequestEvent, params.timeoutMs)
  ]);
  oldPool.closeAll();

  if (!newCredentialPublish.success) {
    throw new RegistrationFailedError(
      "The new credential capsule did not reach the required relay acknowledgement and readback quorum. Please retry."
    );
  }

  await raiseHighWaterMark(store, oldPayload.operational_public_key, { generation: newGeneration });

  return {
    normalizedLoginName,
    oldLocatorPublicKey,
    newLocatorPublicKey,
    newGeneration,
    recoveryPublicKey: oldPayload.recovery_public_key,
    recoveryCapsuleEvent: oldPayload.recovery_capsule_event,
    newCredentialEvent,
    tombstoneEvent,
    deletionRequestEvent,
    newCredentialPublish,
    tombstoneAcknowledgedCount: countAcknowledgements(tombstoneOutcomes),
    deletionAcknowledgedCount: countAcknowledgements(deletionOutcomes)
  };
}
