/** Registration flow (§15). Recovery capsule is built and published before the credential capsule. */
import { randomEntropy128, randomAccountId } from "../crypto/random.js";
import { bytesToBase64url, hexToBytes } from "../crypto/encoding.js";
import { generatePrivateKey, getPublicKeyHex, isValidScalar } from "../crypto/secp256k1.js";
import { decodeNsec } from "../nostr/nip19.js";
import { entropyToRecoveryPhrase, recoveryPhraseToSeed } from "../crypto/bip39.js";
import { derivePasswordKeys, deriveRecoveryKeys, normalizeLoginName } from "./normalize.js";
import { RelayPool } from "../nostr/pool.js";
import { D_TAG_PASSWORD_CAPSULE, D_TAG_RECOVERY_CAPSULE, SCHEMA_CREDENTIAL_V1, SCHEMA_RECOVERY_V1 } from "../nostr/kinds.js";
import { buildCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import { buildRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import { PROTOCOL_CAPSULE_ENCRYPTION, PROTOCOL_PASSWORD_KDF, PROTOCOL_RECOVERY_DERIVATION } from "../capsules/types.js";
import type { CredentialPayload, RecoveryPayload } from "../capsules/types.js";
import { publishAndVerify, type PublishVerificationResult } from "./publish.js";
import { readCredentialCapsule } from "./capsuleReader.js";
import { RegistrationFailedError, AccountAlreadyExistsError } from "./errors.js";
import type { NostrEvent } from "../nostr/event.js";

export interface RegisterAccountParams {
  loginName: string;
  /** A client-generated credential (§9.2); manual passwords are prohibited in the alpha (§9.3). */
  password: string;
  vaultRelayUrls: string[];
  /**
   * Optional existing everyday identity to wrap instead of generating a fresh one (§28.1, §SF10).
   * The everyday key is never derived from any BitLogin secret (§7.2), so an imported key is
   * indistinguishable to the rest of the protocol — only the origin differs. Must be a valid
   * 32-byte secp256k1 scalar; the caller is responsible for decoding an `nsec` first.
   */
  everydayPrivateKey?: Uint8Array;
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
  /** True when the everyday identity was imported (§SF10) rather than freshly generated. */
  imported: boolean;
  credentialEvent: NostrEvent;
  recoveryEvent: NostrEvent;
  credentialPublish: PublishVerificationResult;
  recoveryPublish: PublishVerificationResult;
}

export async function registerAccount(params: RegisterAccountParams): Promise<RegisterAccountResult> {
  const normalizedLoginName = normalizeLoginName(params.loginName);
  const now = params.now ?? Math.floor(Date.now() / 1000);

  // §15.6 — the credential capsule address is fully determined by login name + password,
  // and is a NIP-33 replaceable event: publishing over one that already exists there would
  // silently destroy that other account's identity binding, with no way back short of its
  // own recovery phrase. Derive the locator early and check before generating anything else
  // for this attempt, so a collision fails fast without discarding a freshly generated
  // recovery phrase or everyday keypair.
  const { locatorPrivateKey, capsuleKey: credentialCapsuleKey } = await derivePasswordKeys(params.password, normalizedLoginName);
  const locatorPublicKey = getPublicKeyHex(locatorPrivateKey);
  const checkPool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: locatorPrivateKey });
  let existingCapsule;
  try {
    existingCapsule = await readCredentialCapsule(checkPool, locatorPublicKey, credentialCapsuleKey, params.timeoutMs);
  } finally {
    checkPool.closeAll();
  }
  if (!existingCapsule.quorumMet) {
    throw new RegistrationFailedError(
      "Couldn't verify this login name and password aren't already registered. Please retry, or add more vault relays."
    );
  }
  // Any validly signed event at this address (decryptable by us or not) required
  // knowing this exact locator private key to publish -- which requires this exact
  // login name + password -- so its mere presence means an account already exists here.
  if (existingCapsule.candidates.length > 0) {
    throw new AccountAlreadyExistsError();
  }

  // §15.2 — recovery generation happens first so its signed event can be embedded below.
  const recoveryPhrase = entropyToRecoveryPhrase(randomEntropy128());
  const bip39Seed = await recoveryPhraseToSeed(recoveryPhrase);
  const { recoveryPrivateKey, capsuleKey: recoveryCapsuleKey } = deriveRecoveryKeys(bip39Seed);
  const recoveryPublicKey = getPublicKeyHex(recoveryPrivateKey);

  // §15.3 — everyday identity: generated fresh, or an imported existing key (§28.1, §SF10).
  const imported = params.everydayPrivateKey !== undefined;
  if (imported && !isValidScalar(params.everydayPrivateKey!)) {
    throw new RegistrationFailedError("The provided key is not a valid secp256k1 private key.");
  }
  const everydayPrivateKey = imported ? params.everydayPrivateKey! : generatePrivateKey();
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
  // (locatorPrivateKey/credentialCapsuleKey/locatorPublicKey were already derived above for the
  // existing-account check).
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
    imported,
    credentialEvent,
    recoveryEvent,
    credentialPublish,
    recoveryPublish
  };
}

/**
 * Convenience wrapper for importing an existing Nostr identity (§28.1, §SF10).
 * Accepts an `nsec` (bech32) or 64-char lowercase-hex private key, decodes it,
 * and registers a new BitLogin account (fresh recovery phrase + password)
 * around that key. Everything downstream is identical to a generated account —
 * only the everyday key's origin differs.
 *
 * Honest limitation (§SF10): BitLogin secures its own storage of the key, but
 * copies that already exist elsewhere (extensions, other signers, clipboard
 * history, backups) remain live attack surface outside its reach. If the key
 * may already be compromised, rotate to a fresh identity instead of importing.
 */
export async function importAccount(
  params: Omit<RegisterAccountParams, "everydayPrivateKey"> & { nsecOrHex: string }
): Promise<RegisterAccountResult> {
  const { nsecOrHex, ...rest } = params;
  const everydayPrivateKey = decodeEverydayPrivateKey(nsecOrHex);
  return registerAccount({ ...rest, everydayPrivateKey });
}

/** Decodes an `nsec` or 64-char hex string to a validated 32-byte scalar (§SF10). */
export function decodeEverydayPrivateKey(nsecOrHex: string): Uint8Array {
  const trimmed = nsecOrHex.trim();
  let key: Uint8Array;
  if (trimmed.startsWith("nsec1")) {
    key = decodeNsec(trimmed);
  } else if (/^[0-9a-fA-F]{64}$/u.test(trimmed)) {
    key = hexToBytes(trimmed.toLowerCase());
  } else {
    throw new RegistrationFailedError("Enter a valid nsec (nsec1…) or a 64-character hex private key.");
  }
  if (!isValidScalar(key)) {
    throw new RegistrationFailedError("The provided key is not a valid secp256k1 private key.");
  }
  return key;
}
