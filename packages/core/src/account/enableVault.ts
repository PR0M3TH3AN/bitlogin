/**
 * Existing-account Connection Vault migration (connection-vault.md §5.3).
 *
 * Adding the vault roots requires the RECOVERY PHRASE, not just the password:
 * a password-only write could update the credential capsule while leaving the
 * phrase-recovery path without the roots, and the first phrase recovery after
 * that would silently lose every connection. The ceremony writes the
 * refreshed recovery capsule FIRST (same ordering as registration §15.4), so
 * every intermediate failure state is recoverable:
 *
 * - recovery write fails  -> nothing changed, retry freely.
 * - recovery ok, credential write fails -> the roots exist on the phrase
 *   path; retrying repairs the credential capsule using the SAME roots (the
 *   flow reuses roots found in either capsule rather than minting twice).
 *
 * New accounts never come here — registration mints the roots for free.
 */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { base64urlToBytes, bytesToBase64url } from "../crypto/encoding.js";
import { randomBytes } from "../crypto/random.js";
import { isValidRecoveryPhrase, recoveryPhraseToSeed } from "../crypto/bip39.js";
import { derivePasswordKeys, deriveRecoveryKeys, normalizeLoginName } from "./normalize.js";
import { nextCreatedAt } from "./timestamp.js";
import { RelayPool } from "../nostr/pool.js";
import { D_TAG_PASSWORD_CAPSULE, D_TAG_RECOVERY_CAPSULE, SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import { readCredentialCapsule, readRecoveryCapsule } from "./capsuleReader.js";
import { buildCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import { buildRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import {
  PROTOCOL_CAPSULE_ENCRYPTION,
  PROTOCOL_PASSWORD_KDF,
  PROTOCOL_RECOVERY_DERIVATION,
  type CredentialPayload,
  type RecoveryPayload
} from "../capsules/types.js";
import { publishAndVerify } from "./publish.js";
import { AccountNotFoundError, RecoveryFailedError, RegistrationFailedError } from "./errors.js";
import type { PublishVerificationResult } from "./publish.js";

export interface EnableConnectionVaultParams {
  loginName: string;
  password: string;
  /** The account's recovery phrase — required, see the module comment. */
  phrase: string;
  vaultRelayUrls: string[];
  minAcknowledgements?: number;
  timeoutMs?: number;
  now?: number;
}

export interface EnableConnectionVaultResult {
  /** True when the account already carried the roots and nothing was written. */
  alreadyEnabled: boolean;
  connectionVaultRoot: Uint8Array;
  vaultSudoKey: Uint8Array;
  recoveryPublish?: PublishVerificationResult;
  credentialPublish?: PublishVerificationResult;
}

export async function enableConnectionVault(
  params: EnableConnectionVaultParams
): Promise<EnableConnectionVaultResult> {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const normalizedLoginName = normalizeLoginName(params.loginName);
  if (!isValidRecoveryPhrase(params.phrase)) {
    throw new RecoveryFailedError("This does not look like a valid 12-word BitLogin recovery phrase.");
  }

  // Password path: the current credential capsule.
  const passwordKeys = await derivePasswordKeys(params.password, normalizedLoginName);
  const locatorPublicKey = getPublicKeyHex(passwordKeys.locatorPrivateKey);
  const credentialPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: passwordKeys.locatorPrivateKey });
  let credentialRead;
  try {
    credentialRead = await readCredentialCapsule(credentialPool, locatorPublicKey, passwordKeys.capsuleKey, params.timeoutMs);
  } finally {
    credentialPool.closeAll();
  }
  if (!credentialRead.quorumMet) throw new AccountNotFoundError("quorum-not-met");
  if (!credentialRead.best) {
    throw new AccountNotFoundError(credentialRead.candidates.length > 0 ? "no-valid-candidate" : "no-matching-event");
  }
  const credentialPayload = credentialRead.best.payload!;
  const credentialEvent = credentialRead.best.event;

  // Phrase path: the current recovery capsule, which must belong to the SAME
  // account — a phrase for some other account must not be grafted onto this one.
  const bip39Seed = await recoveryPhraseToSeed(params.phrase);
  const recoveryKeys = deriveRecoveryKeys(bip39Seed);
  const recoveryPublicKey = getPublicKeyHex(recoveryKeys.recoveryPrivateKey);
  if (recoveryPublicKey !== credentialPayload.recovery_public_key) {
    throw new RecoveryFailedError("This recovery phrase does not belong to this account.");
  }
  const recoveryPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: recoveryKeys.recoveryPrivateKey });
  let recoveryRead;
  try {
    recoveryRead = await readRecoveryCapsule(recoveryPool, recoveryPublicKey, recoveryKeys.capsuleKey, params.timeoutMs);
  } finally {
    recoveryPool.closeAll();
  }
  // QUORUM IS LOAD-BEARING HERE, not decoration. The mint decision below is
  // "did I see a root?", so a single stale or hostile relay answering with a
  // pre-vault generation makes this flow mint a SECOND root and permanently
  // orphan every existing connectable record -- the spendable NWC strings.
  // The credential read above already enforces quorum; this one must too.
  if (!recoveryRead.quorumMet) throw new AccountNotFoundError("quorum-not-met");
  if (!recoveryRead.best) throw new AccountNotFoundError("no-valid-candidate");
  const recoveryPayload = recoveryRead.best.payload!;
  if (recoveryPayload.account_id !== credentialPayload.account_id) {
    throw new RecoveryFailedError("This recovery phrase does not belong to this account.");
  }

  // Idempotency and partial-failure repair: reuse roots wherever they already
  // exist. Minting twice is the one unforgivable outcome — it would strand
  // whichever records were encrypted under the first mint.
  const existingRoot = credentialPayload.connection_vault_root ?? recoveryPayload.connection_vault_root;
  const existingSudo = credentialPayload.vault_sudo_key ?? recoveryPayload.vault_sudo_key;
  if (
    credentialPayload.connection_vault_root !== undefined &&
    recoveryPayload.connection_vault_root !== undefined
  ) {
    return {
      alreadyEnabled: true,
      connectionVaultRoot: base64urlToBytes(credentialPayload.connection_vault_root),
      vaultSudoKey: base64urlToBytes(credentialPayload.vault_sudo_key!)
    };
  }
  const connectionVaultRoot = existingRoot !== undefined ? base64urlToBytes(existingRoot) : randomBytes(32);
  const vaultSudoKey = existingSudo !== undefined ? base64urlToBytes(existingSudo) : randomBytes(32);
  const rootB64 = bytesToBase64url(connectionVaultRoot);
  const sudoB64 = bytesToBase64url(vaultSudoKey);

  // Recovery capsule first (§15.4 ordering; module comment explains why).
  const refreshedRecoveryPayload: RecoveryPayload = {
    schema: SCHEMA_RECOVERY_V1,
    account_id: recoveryPayload.account_id,
    recovery_generation: recoveryPayload.recovery_generation + 1,
    previous_recovery_event_id: recoveryRead.best.event.id,
    operational_private_key: recoveryPayload.operational_private_key,
    operational_public_key: recoveryPayload.operational_public_key,
    recovery_public_key: recoveryPayload.recovery_public_key,
    connection_vault_root: rootB64,
    vault_sudo_key: sudoB64,
    created_at: nextCreatedAt(recoveryRead.best.event.created_at, now),
    vault_relay_hints: params.vaultRelayUrls,
    protocol: { capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION, recovery_derivation: PROTOCOL_RECOVERY_DERIVATION }
  };
  const refreshedRecoveryEvent = await buildRecoveryCapsuleEvent({
    recoveryPrivateKey: recoveryKeys.recoveryPrivateKey,
    capsuleKey: recoveryKeys.capsuleKey,
    payload: refreshedRecoveryPayload
  });
  const recoveryPublishPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: recoveryKeys.recoveryPrivateKey });
  const recoveryPublish = await publishAndVerify(recoveryPublishPool, refreshedRecoveryEvent, {
    dTag: D_TAG_RECOVERY_CAPSULE,
    minAcks: params.minAcknowledgements,
    timeoutMs: params.timeoutMs
  });
  recoveryPublishPool.closeAll();
  if (!recoveryPublish.success) {
    throw new RegistrationFailedError(
      "Enabling the vault did not reach the relay quorum while refreshing the recovery capsule. Nothing was changed; please retry."
    );
  }

  const newCredentialPayload: CredentialPayload = {
    schema: SCHEMA_CREDENTIAL_V1,
    account_id: credentialPayload.account_id,
    generation: credentialPayload.generation + 1,
    operational_private_key: credentialPayload.operational_private_key,
    operational_public_key: credentialPayload.operational_public_key,
    recovery_public_key: credentialPayload.recovery_public_key,
    recovery_capsule_event: refreshedRecoveryEvent,
    connection_vault_root: rootB64,
    vault_sudo_key: sudoB64,
    created_at: nextCreatedAt(credentialEvent.created_at, now),
    vault_relay_hints: params.vaultRelayUrls,
    protocol: {
      password_kdf: PROTOCOL_PASSWORD_KDF,
      capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
      recovery_derivation: PROTOCOL_RECOVERY_DERIVATION
    }
  };
  const newCredentialEvent = await buildCredentialCapsuleEvent({
    locatorPrivateKey: passwordKeys.locatorPrivateKey,
    capsuleKey: passwordKeys.capsuleKey,
    payload: newCredentialPayload
  });
  const credentialPublishPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: passwordKeys.locatorPrivateKey });
  const credentialPublish = await publishAndVerify(credentialPublishPool, newCredentialEvent, {
    dTag: D_TAG_PASSWORD_CAPSULE,
    minAcks: params.minAcknowledgements,
    timeoutMs: params.timeoutMs
  });
  credentialPublishPool.closeAll();
  if (!credentialPublish.success) {
    throw new RegistrationFailedError(
      "The recovery capsule now carries the vault roots, but the credential capsule update did not reach quorum. " +
        "Retry enableConnectionVault: it will reuse the same roots and only repair the credential capsule."
    );
  }

  return { alreadyEnabled: false, connectionVaultRoot, vaultSudoKey, recoveryPublish, credentialPublish };
}
