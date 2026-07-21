import { describe, expect, it } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { randomAccountId } from "../crypto/random.js";
import { bytesToBase64url } from "../crypto/encoding.js";
import { signNostrEvent } from "../nostr/event.js";
import { KIND_APP_DATA, D_TAG_RECOVERY_CAPSULE, SCHEMA_RECOVERY_V1, SCHEMA_CREDENTIAL_V1 } from "../nostr/kinds.js";
import { buildRecoveryCapsuleEvent, decryptRecoveryCapsuleEvent } from "./recoveryCapsule.js";
import { buildCredentialCapsuleEvent, buildCredentialTombstoneEvent, decryptCredentialCapsuleEvent } from "./credentialCapsule.js";
import { CapsuleValidationError, checkRecoveryChainConsistency } from "./validation.js";
import { PROTOCOL_CAPSULE_ENCRYPTION, PROTOCOL_PASSWORD_KDF, PROTOCOL_RECOVERY_DERIVATION } from "./types.js";
import type { RecoveryPayload, CredentialPayload } from "./types.js";

function makeEverydayIdentity() {
  const sk = generatePrivateKey();
  return { sk, pub: getPublicKeyHex(sk) };
}

describe("Recovery capsule round trip (§14, §12.3)", () => {
  it("builds, signs, decrypts, and validates a recovery capsule", async () => {
    const recoveryKey = generatePrivateKey();
    const recoveryPub = getPublicKeyHex(recoveryKey);
    const capsuleKey = new Uint8Array(32).fill(9);
    const everyday = makeEverydayIdentity();
    const accountId = bytesToBase64url(randomAccountId());

    const payload: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: accountId,
      recovery_generation: 0,
      previous_recovery_event_id: null,
      operational_private_key: bytesToBase64url(everyday.sk),
      operational_public_key: everyday.pub,
      recovery_public_key: recoveryPub,
      created_at: 1700000000,
      vault_relay_hints: ["wss://relay-one.example"],
      protocol: { capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION, recovery_derivation: PROTOCOL_RECOVERY_DERIVATION }
    };

    const event = await buildRecoveryCapsuleEvent({ recoveryPrivateKey: recoveryKey, capsuleKey, payload });
    expect(event.kind).toBe(KIND_APP_DATA);
    expect(event.tags).toContainEqual(["d", D_TAG_RECOVERY_CAPSULE]);
    expect(event.pubkey).toBe(recoveryPub);

    const decrypted = await decryptRecoveryCapsuleEvent(event, capsuleKey);
    expect(decrypted.operational_public_key).toBe(everyday.pub);
    expect(decrypted.account_id).toBe(accountId);
  });

  it("rejects decryption with the wrong key", async () => {
    const recoveryKey = generatePrivateKey();
    const capsuleKey = new Uint8Array(32).fill(1);
    const wrongKey = new Uint8Array(32).fill(2);
    const everyday = makeEverydayIdentity();
    const payload: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: bytesToBase64url(randomAccountId()),
      recovery_generation: 0,
      previous_recovery_event_id: null,
      operational_private_key: bytesToBase64url(everyday.sk),
      operational_public_key: everyday.pub,
      recovery_public_key: getPublicKeyHex(recoveryKey),
      created_at: 1700000000,
      vault_relay_hints: [],
      protocol: { capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION, recovery_derivation: PROTOCOL_RECOVERY_DERIVATION }
    };
    const event = await buildRecoveryCapsuleEvent({ recoveryPrivateKey: recoveryKey, capsuleKey, payload });
    await expect(decryptRecoveryCapsuleEvent(event, wrongKey)).rejects.toThrow();
  });

  it("detects a broken previous_recovery_event_id hash chain (§12.4.9)", () => {
    const result = checkRecoveryChainConsistency([
      { eventId: "a".repeat(64), recoveryGeneration: 0, previousRecoveryEventId: null },
      { eventId: "b".repeat(64), recoveryGeneration: 1, previousRecoveryEventId: "ffff".repeat(16) } // wrong link
    ]);
    expect(result.consistent).toBe(false);
  });

  it("accepts a valid hash chain", () => {
    const result = checkRecoveryChainConsistency([
      { eventId: "a".repeat(64), recoveryGeneration: 0, previousRecoveryEventId: null },
      { eventId: "b".repeat(64), recoveryGeneration: 1, previousRecoveryEventId: "a".repeat(64) }
    ]);
    expect(result.consistent).toBe(true);
  });
});

describe("Credential capsule round trip (§13, §12.1, §12.2)", () => {
  it("builds, signs, decrypts, and validates a credential capsule embedding the signed recovery event", async () => {
    const locatorKey = generatePrivateKey();
    const recoveryKey = generatePrivateKey();
    const capsuleKey = new Uint8Array(32).fill(3);
    const recoveryCapsuleKey = new Uint8Array(32).fill(4);
    const everyday = makeEverydayIdentity();
    const accountId = bytesToBase64url(randomAccountId());

    const recoveryPayload: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: accountId,
      recovery_generation: 0,
      previous_recovery_event_id: null,
      operational_private_key: bytesToBase64url(everyday.sk),
      operational_public_key: everyday.pub,
      recovery_public_key: getPublicKeyHex(recoveryKey),
      created_at: 1700000000,
      vault_relay_hints: [],
      protocol: { capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION, recovery_derivation: PROTOCOL_RECOVERY_DERIVATION }
    };
    const recoveryEvent = await buildRecoveryCapsuleEvent({ recoveryPrivateKey: recoveryKey, capsuleKey: recoveryCapsuleKey, payload: recoveryPayload });

    const credentialPayload: CredentialPayload = {
      schema: SCHEMA_CREDENTIAL_V1,
      account_id: accountId,
      generation: 0,
      operational_private_key: bytesToBase64url(everyday.sk),
      operational_public_key: everyday.pub,
      recovery_public_key: getPublicKeyHex(recoveryKey),
      recovery_capsule_event: recoveryEvent,
      created_at: 1700000001,
      vault_relay_hints: ["wss://relay-one.example", "wss://relay-two.example"],
      protocol: {
        password_kdf: PROTOCOL_PASSWORD_KDF,
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION
      }
    };

    const event = await buildCredentialCapsuleEvent({ locatorPrivateKey: locatorKey, capsuleKey, payload: credentialPayload });
    const decrypted = await decryptCredentialCapsuleEvent(event, capsuleKey);
    expect(decrypted.operational_public_key).toBe(everyday.pub);
    expect(decrypted.recovery_capsule_event.id).toBe(recoveryEvent.id);
  });

  it("rejects a credential payload whose embedded recovery event author does not match recovery_public_key", async () => {
    const locatorKey = generatePrivateKey();
    const recoveryKeyA = generatePrivateKey();
    const recoveryKeyB = generatePrivateKey();
    const capsuleKey = new Uint8Array(32).fill(5);
    const everyday = makeEverydayIdentity();
    const accountId = bytesToBase64url(randomAccountId());

    // Recovery event signed by A, but payload claims recovery_public_key B.
    const foreignRecoveryEvent = signNostrEvent(
      { pubkey: getPublicKeyHex(recoveryKeyA), created_at: 1, kind: KIND_APP_DATA, tags: [["d", D_TAG_RECOVERY_CAPSULE]], content: "{}" },
      recoveryKeyA
    );

    const credentialPayload: CredentialPayload = {
      schema: SCHEMA_CREDENTIAL_V1,
      account_id: accountId,
      generation: 0,
      operational_private_key: bytesToBase64url(everyday.sk),
      operational_public_key: everyday.pub,
      recovery_public_key: getPublicKeyHex(recoveryKeyB),
      recovery_capsule_event: foreignRecoveryEvent,
      created_at: 1700000001,
      vault_relay_hints: [],
      protocol: {
        password_kdf: PROTOCOL_PASSWORD_KDF,
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION
      }
    };

    const event = await buildCredentialCapsuleEvent({ locatorPrivateKey: locatorKey, capsuleKey, payload: credentialPayload });
    await expect(decryptCredentialCapsuleEvent(event, capsuleKey)).rejects.toThrow(CapsuleValidationError);
  });

  it("produces a signed tombstone with empty content for the old locator (§18.1)", () => {
    const oldLocatorKey = generatePrivateKey();
    const event = buildCredentialTombstoneEvent({ oldLocatorPrivateKey: oldLocatorKey, createdAt: 1700000002 });
    expect(event.content).toBe("");
    expect(event.pubkey).toBe(getPublicKeyHex(oldLocatorKey));
  });
});
