/**
 * Connection Vault protocol round trips against mock relays.
 *
 * The scenarios mirror vault-ux.md: a new account gets the vault for free, a
 * legacy account migrates with the phrase, records survive a clean-device
 * login AND a phrase recovery, a password change never strands them, and a
 * stale replica cannot resurrect an old credential.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { registerAccount } from "../account/create.js";
import { loginWithPassword } from "../account/login.js";
import { changePassword } from "../account/changePassword.js";
import {
  recoverWithPhrase,
  completeRecoveryWithNewCredentials,
} from "../account/recover.js";
import { enableConnectionVault } from "../account/enableVault.js";
import {
  derivePasswordKeys,
  deriveRecoveryKeys,
  normalizeLoginName,
} from "../account/normalize.js";
import { recoveryPhraseToSeed } from "../crypto/bip39.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { RelayPool } from "../nostr/pool.js";
import {
  D_TAG_PASSWORD_CAPSULE,
  D_TAG_RECOVERY_CAPSULE,
  SCHEMA_CREDENTIAL_V1,
  SCHEMA_RECOVERY_V1,
} from "../nostr/kinds.js";
import {
  buildCredentialCapsuleEvent,
  decryptCredentialCapsuleEvent,
} from "../capsules/credentialCapsule.js";
import { buildRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import {
  PROTOCOL_CAPSULE_ENCRYPTION,
  PROTOCOL_PASSWORD_KDF,
  PROTOCOL_RECOVERY_DERIVATION,
  type CredentialPayload,
  type RecoveryPayload,
} from "../capsules/types.js";
import { publishAndVerify } from "../account/publish.js";
import { InMemoryKeyValueStore } from "../storage/interface.js";
import { VaultSession } from "./session.js";
import { parseNwcUri } from "./nwc.js";
import { buildConnectionRecordEvent } from "./record.js";
import {
  publishConnectionRecord,
  fetchConnectionRecordEvents,
} from "./sync.js";
import { deriveVaultPrk } from "./derivation.js";

const NWC_URI = `nostr+walletconnect://${"ab".repeat(32)}?relay=wss%3A%2F%2Frelay.example&secret=${"cd".repeat(32)}`;

describe("Connection Vault end-to-end", () => {
  let relays: MockRelay[] = [];
  let vaultRelayUrls: string[] = [];

  beforeEach(async () => {
    relays = await Promise.all([
      MockRelay.start(),
      MockRelay.start(),
      MockRelay.start(),
    ]);
    vaultRelayUrls = relays.map((r) => r.url);
  });

  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it("registration mints the roots; records survive a clean-device login; sign-in restores the wallet", async () => {
    const loginName = "vault-user";
    const password = "correct horse battery staple 9";
    const registration = await registerAccount({
      loginName,
      password,
      vaultRelayUrls,
    });
    expect(registration.connectionVaultRoot.length).toBe(32);
    expect(registration.vaultSudoKey.length).toBe(32);
    const registrationKeys = await derivePasswordKeys(
      password,
      normalizeLoginName(loginName),
    );
    const registrationCredential = await decryptCredentialCapsuleEvent(
      registration.credentialEvent,
      registrationKeys.capsuleKey,
    );
    expect(registrationCredential.connection_vault_root).toBeDefined();
    expect(registrationCredential.vault_sudo_key).toBeUndefined();

    // Device A: store one NWC connection, bound to Satisfied's origin.
    const sessionA = new VaultSession(registration.connectionVaultRoot);
    const storeA = new InMemoryKeyValueStore();
    const { record, event } = await sessionA.createConnection({
      connection_type: "nwc",
      tier: "connectable",
      label: "Satisfied spending wallet",
      credential: parseNwcUri(NWC_URI),
      application_binding: {
        origin: "https://imsatisfied.app",
        app_pubkey: null,
      },
    });
    const publish = await sessionA.publish({
      event,
      connectionId: record.connection_id,
      relayUrls: vaultRelayUrls,
      store: storeA,
    });
    expect(publish.success).toBe(true);

    // Device B, clean: password login restores the roots, then the wallet.
    const login = await loginWithPassword({
      loginName,
      password,
      vaultRelayUrls,
    });
    expect(login.connectionVaultRoot).toBeDefined();
    expect(Buffer.from(login.connectionVaultRoot!)).toEqual(
      Buffer.from(registration.connectionVaultRoot),
    );

    const sessionB = new VaultSession(login.connectionVaultRoot!);
    const listed = await sessionB.listConnections({
      relayUrls: vaultRelayUrls,
      store: new InMemoryKeyValueStore(),
    });
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0]!.record.label).toBe(
      "Satisfied spending wallet",
    );
    expect(listed.connections[0]!.record.application_binding.origin).toBe(
      "https://imsatisfied.app",
    );
    expect(
      (listed.connections[0]!.record.credential as { secret: string }).secret,
    ).toBe("cd".repeat(32));
  });

  it("password change carries the roots; phrase recovery restores them on a clean device", async () => {
    const loginName = "vault-rotator";
    const oldPassword = "old password entirely 77";
    const newPassword = "new password entirely 88";
    const registration = await registerAccount({
      loginName,
      password: oldPassword,
      vaultRelayUrls,
    });

    const rotation = await changePassword({
      loginName,
      oldPassword,
      newPassword,
      vaultRelayUrls,
    });
    const rotatedKeys = await derivePasswordKeys(
      newPassword,
      normalizeLoginName(loginName),
    );
    const rotatedCredential = await decryptCredentialCapsuleEvent(
      rotation.newCredentialEvent,
      rotatedKeys.capsuleKey,
    );
    expect(rotatedCredential.vault_sudo_key).toBeUndefined();
    const login = await loginWithPassword({
      loginName,
      password: newPassword,
      vaultRelayUrls,
    });
    expect(Buffer.from(login.connectionVaultRoot!)).toEqual(
      Buffer.from(registration.connectionVaultRoot),
    );
    expect(login.vaultSudoKey).toBeUndefined();

    // House-fire scenario: phrase only, new login credentials.
    const recovered = await recoverWithPhrase({
      phrase: registration.recoveryPhrase,
      vaultRelayUrls,
      discoveryRelayUrls: vaultRelayUrls,
    });
    expect(
      recovered.currentRecoveryPayload.connection_vault_root,
    ).toBeDefined();
    await completeRecoveryWithNewCredentials({
      recovered,
      newLoginName: "vault-rotator-reborn",
      newPassword: "phoenix password 12",
      vaultRelayUrls,
    });
    const reborn = await loginWithPassword({
      loginName: "vault-rotator-reborn",
      password: "phoenix password 12",
      vaultRelayUrls,
    });
    expect(Buffer.from(reborn.connectionVaultRoot!)).toEqual(
      Buffer.from(registration.connectionVaultRoot),
    );
  });

  it("a legacy account (no roots) migrates via the phrase ceremony, idempotently", async () => {
    const loginName = "legacy-account";
    const password = "pre vault password 55";
    const registration = await registerAccount({
      loginName,
      password,
      vaultRelayUrls,
    });

    // Simulate a pre-vault account: republish both capsules WITHOUT the vault
    // fields at higher generations, exactly what an old client would write.
    const normalized = normalizeLoginName(loginName);
    const passwordKeys = await derivePasswordKeys(password, normalized);
    const seed = await recoveryPhraseToSeed(registration.recoveryPhrase);
    const recoveryKeys = deriveRecoveryKeys(seed);
    const operationalPrivB64 = Buffer.from(
      registration.everydayPrivateKey,
    ).toString("base64url");
    const strippedRecovery: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: registration.accountId,
      recovery_generation: 1,
      previous_recovery_event_id: registration.recoveryEvent.id,
      operational_private_key: operationalPrivB64,
      operational_public_key: registration.everydayPublicKey,
      recovery_public_key: registration.recoveryPublicKey,
      created_at: registration.recoveryEvent.created_at + 1,
      vault_relay_hints: vaultRelayUrls,
      protocol: {
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION,
      },
    };
    const strippedRecoveryEvent = await buildRecoveryCapsuleEvent({
      recoveryPrivateKey: recoveryKeys.recoveryPrivateKey,
      capsuleKey: recoveryKeys.capsuleKey,
      payload: strippedRecovery,
    });
    const recoveryPool = new RelayPool(vaultRelayUrls, {
      authPrivateKey: recoveryKeys.recoveryPrivateKey,
    });
    expect(
      (
        await publishAndVerify(recoveryPool, strippedRecoveryEvent, {
          dTag: D_TAG_RECOVERY_CAPSULE,
        })
      ).success,
    ).toBe(true);
    recoveryPool.closeAll();

    const strippedCredential: CredentialPayload = {
      schema: SCHEMA_CREDENTIAL_V1,
      account_id: registration.accountId,
      generation: 1,
      operational_private_key: operationalPrivB64,
      operational_public_key: registration.everydayPublicKey,
      recovery_public_key: registration.recoveryPublicKey,
      recovery_capsule_event: strippedRecoveryEvent,
      created_at: registration.credentialEvent.created_at + 1,
      vault_relay_hints: vaultRelayUrls,
      protocol: {
        password_kdf: PROTOCOL_PASSWORD_KDF,
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION,
      },
    };
    const strippedCredentialEvent = await buildCredentialCapsuleEvent({
      locatorPrivateKey: passwordKeys.locatorPrivateKey,
      capsuleKey: passwordKeys.capsuleKey,
      payload: strippedCredential,
    });
    const credentialPool = new RelayPool(vaultRelayUrls, {
      authPrivateKey: passwordKeys.locatorPrivateKey,
    });
    expect(
      (
        await publishAndVerify(credentialPool, strippedCredentialEvent, {
          dTag: D_TAG_PASSWORD_CAPSULE,
        })
      ).success,
    ).toBe(true);
    credentialPool.closeAll();

    const legacyLogin = await loginWithPassword({
      loginName,
      password,
      vaultRelayUrls,
    });
    expect(legacyLogin.connectionVaultRoot).toBeUndefined();

    // Wrong phrase must not graft a vault onto this account.
    const stranger = await registerAccount({
      loginName: "someone-else",
      password: "another password 33",
      vaultRelayUrls,
    });
    await expect(
      enableConnectionVault({
        loginName,
        password,
        phrase: stranger.recoveryPhrase,
        vaultRelayUrls,
      }),
    ).rejects.toThrow(/does not belong to this account/);

    // The ceremony proper.
    const enabled = await enableConnectionVault({
      loginName,
      password,
      phrase: registration.recoveryPhrase,
      vaultRelayUrls,
    });
    expect(enabled.alreadyEnabled).toBe(false);
    const after = await loginWithPassword({
      loginName,
      password,
      vaultRelayUrls,
    });
    expect(Buffer.from(after.connectionVaultRoot!)).toEqual(
      Buffer.from(enabled.connectionVaultRoot),
    );

    // Idempotent: a second run reuses the roots and writes nothing.
    const again = await enableConnectionVault({
      loginName,
      password,
      phrase: registration.recoveryPhrase,
      vaultRelayUrls,
    });
    expect(again.alreadyEnabled).toBe(true);
    expect(Buffer.from(again.connectionVaultRoot)).toEqual(
      Buffer.from(enabled.connectionVaultRoot),
    );
  });

  it("a stale replica cannot silently resurrect an old record (§CV9)", async () => {
    const registration = await registerAccount({
      loginName: "rollback-user",
      password: "rollback password 44",
      vaultRelayUrls,
    });
    const session = new VaultSession(registration.connectionVaultRoot);
    const store = new InMemoryKeyValueStore();

    const { record, event: v1 } = await session.createConnection({
      connection_type: "nwc",
      tier: "connectable",
      label: "wallet v1",
      credential: parseNwcUri(NWC_URI),
    });
    expect(
      (
        await session.publish({
          event: v1,
          connectionId: record.connection_id,
          relayUrls: vaultRelayUrls,
          store,
        })
      ).success,
    ).toBe(true);

    // The update reaches only relay 0 — relays 1 and 2 keep the stale v1.
    const current = await session.decryptEvent(v1);
    const { event: v2 } = await session.updateConnection(current!, {
      label: "wallet v2",
    });
    expect(
      (
        await session.publish({
          event: v2,
          connectionId: record.connection_id,
          relayUrls: [vaultRelayUrls[0]!],
          store,
          minAcknowledgements: 1,
        })
      ).success,
    ).toBe(true);

    // Reading ONLY the stale relays: the record is withheld and warned about,
    // not served at its old contents.
    const stale = await session.fetchEvents({
      relayUrls: [vaultRelayUrls[1]!, vaultRelayUrls[2]!],
      store,
    });
    expect(stale.rollbackWarnings).toEqual([record.connection_id]);
    expect(stale.events.size).toBe(0);

    // Reading everything: the newest version wins.
    const all = await session.fetchEvents({ relayUrls: vaultRelayUrls, store });
    expect(all.rollbackWarnings).toEqual([]);
    const decrypted = await session.decryptEvent(
      all.events.get(record.connection_id)!,
    );
    expect(decrypted!.record.label).toBe("wallet v2");
  });

  it("chooses the canonical lower-id sibling at equal timestamps in either relay arrival order", async () => {
    const root = new Uint8Array(32).fill(23);
    const vaultPrk = deriveVaultPrk(root);
    const session = new VaultSession(root);
    const { record } = await session.createConnection({
      connection_type: "nwc",
      tier: "connectable",
      label: "base",
      credential: parseNwcUri(NWC_URI),
      now: 1_800_000_000,
    });
    const eventA = await buildConnectionRecordEvent({
      vaultPrk,
      recordPrk: vaultPrk,
      record: { ...record, label: "sibling A" },
      now: 1_800_000_100,
    });
    const eventB = await buildConnectionRecordEvent({
      vaultPrk,
      recordPrk: vaultPrk,
      record: { ...record, label: "sibling B" },
      now: 1_800_000_100,
    });
    const [lower, higher] = [eventA, eventB].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    for (const order of [
      [higher, lower, higher],
      [lower, higher, lower],
    ]) {
      relays.forEach((relay, index) => {
        relay.unsolicitedQueryEvents = [order[index]!];
      });
      const fetched = await fetchConnectionRecordEvents({
        vaultPrk,
        relayUrls: vaultRelayUrls,
        store: new InMemoryKeyValueStore(),
      });
      expect(fetched.events.get(record.connection_id)?.id).toBe(lower!.id);
      expect(fetched.rollbackWarnings).toEqual([]);
    }
  });
});
