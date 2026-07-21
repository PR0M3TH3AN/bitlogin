/** Registration flow (§15). Recovery capsule is built and published before the credential capsule. */
import { randomEntropy128, randomAccountId } from "../crypto/random.js";
import { bytesToBase64url } from "../crypto/encoding.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { entropyToRecoveryPhrase, recoveryPhraseToSeed } from "../crypto/bip39.js";
import { derivePasswordKeys, deriveRecoveryKeys, normalizeLoginName } from "./normalize.js";
import { RelayPool } from "../nostr/pool.js";
import { D_TAG_PASSWORD_CAPSULE, D_TAG_RECOVERY_CAPSULE, SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import { buildCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import { buildRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import { PROTOCOL_CAPSULE_ENCRYPTION, PROTOCOL_PASSWORD_KDF, PROTOCOL_RECOVERY_DERIVATION } from "../capsules/types.js";
import type { CredentialPayload, RecoveryPayload } from "../capsules/types.js";
import { publishAndVerify, type PublishVerificationResult } from "./publish.js";
import { RegistrationFailedError } from "./errors.js";
import type { NostrEvent } from "../nostr/event.js";

export interface RegisterAccountParams {
  loginName: string;
  /** A client-generated credential (§9.2); manual passwords are prohibited in the alpha (§9.3). */
  password: string;
  vaultRelayUrls: string[];
  minAcknowledgements?: number;
  timeoutMs?: number;
  /** Testing hook; defaults to the current time. */
  now?: number;
}

export interface RegisterAccountResult {
  normalizedLoginName: string;
  recoveryPhrase: string;
  everydayPrivateKey: Uint8Array;
  everydayPublicKey: string;
  recoveryPublicKey: string;
  locatorPublicKey: string;
  accountId: string;
  credentialEvent: NostrEvent;
  recoveryEvent: NostrEvent;
  credentialPublish: PublishVerificationResult;
  recoveryPublish: PublishVerificationResult;
}

export async function registerAccount(params: RegisterAccountParams): Promise<RegisterAccountResult> {
  const normalizedLoginName = normalizeLoginName(params.loginName);
  const now = params.now ?? Math.floor(Date.now() / 1000);

  // §15.2 — recovery generation happens first so its signed event can be embedded below.
  const recoveryPhrase = entropyToRecoveryPhrase(randomEntropy128());
  const bip39Seed = await recoveryPhraseToSeed(recoveryPhrase);
  const { recoveryPrivateKey, capsuleKey: recoveryCapsuleKey } = deriveRecoveryKeys(bip39Seed);
  const recoveryPublicKey = getPublicKeyHex(recoveryPrivateKey);

  // §15.3 — everyday identity
  const everydayPrivateKey = generatePrivateKey();
  const everydayPublicKey = getPublicKeyHex(everydayPrivateKey);
  const accountId = bytesToBase64url(randomAccountId());

  // §15.4 — recovery capsule first, previous_recovery_event_id null (registration is generation 0)
  const recoveryPayload: RecoveryPayload = {
    schema: SCHEMA_RECOVERY_V1,
    account_id: accountId,
    recovery_generation: 0,
    previous_recovery_event_id: null,
    operational_private_key: bytesToBase64url(everydayPrivateKey),
    operational_public_key: everydayPublicKey,
    recovery_public_key: recoveryPublicKey,
    created_at: now,
    vault_relay_hints: params.vaultRelayUrls,
    protocol: { capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION, recovery_derivation: PROTOCOL_RECOVERY_DERIVATION }
  };
  const recoveryEvent = await buildRecoveryCapsuleEvent({
    recoveryPrivateKey,
    capsuleKey: recoveryCapsuleKey,
    payload: recoveryPayload
  });

  // §15.5 — password path, embedding the signed recovery event for keyless rebroadcast repair
  const { locatorPrivateKey, capsuleKey: credentialCapsuleKey } = await derivePasswordKeys(params.password, normalizedLoginName);
  const locatorPublicKey = getPublicKeyHex(locatorPrivateKey);
  const credentialPayload: CredentialPayload = {
    schema: SCHEMA_CREDENTIAL_V1,
    account_id: accountId,
    generation: 0,
    operational_private_key: bytesToBase64url(everydayPrivateKey),
    operational_public_key: everydayPublicKey,
    recovery_public_key: recoveryPublicKey,
    recovery_capsule_event: recoveryEvent,
    created_at: now,
    vault_relay_hints: params.vaultRelayUrls,
    protocol: {
      password_kdf: PROTOCOL_PASSWORD_KDF,
      capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
      recovery_derivation: PROTOCOL_RECOVERY_DERIVATION
    }
  };
  const credentialEvent = await buildCredentialCapsuleEvent({
    locatorPrivateKey,
    capsuleKey: credentialCapsuleKey,
    payload: credentialPayload
  });

  // §15.6 — publication; §23.4 connection hygiene: separate pools per identity, never shared with everyday-identity ops.
  const recoveryPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: recoveryPrivateKey });
  const recoveryPublish = await publishAndVerify(recoveryPool, recoveryEvent, {
    dTag: D_TAG_RECOVERY_CAPSULE,
    minAcks: params.minAcknowledgements,
    timeoutMs: params.timeoutMs
  });
  recoveryPool.closeAll();

  const credentialPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: locatorPrivateKey });
  const credentialPublish = await publishAndVerify(credentialPool, credentialEvent, {
    dTag: D_TAG_PASSWORD_CAPSULE,
    minAcks: params.minAcknowledgements,
    timeoutMs: params.timeoutMs
  });
  credentialPool.closeAll();

  if (!recoveryPublish.success || !credentialPublish.success) {
    throw new RegistrationFailedError(
      "Registration did not reach the required relay acknowledgement and readback quorum. Please retry, or add more vault relays."
    );
  }

  return {
    normalizedLoginName,
    recoveryPhrase,
    everydayPrivateKey,
    everydayPublicKey,
    recoveryPublicKey,
    locatorPublicKey,
    accountId,
    credentialEvent,
    recoveryEvent,
    credentialPublish,
    recoveryPublish
  };
}
