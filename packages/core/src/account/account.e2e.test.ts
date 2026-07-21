import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { generatePassphrase } from "./passphrase.js";
import { registerAccount, importAccount, decodeEverydayPrivateKey } from "./create.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { encodeNsec, encodeNpub } from "../nostr/nip19.js";
import { bytesToHex } from "../crypto/encoding.js";
import { loginWithPassword } from "./login.js";
import { recoverWithPhrase, completeRecoveryWithNewCredentials } from "./recover.js";
import { changePassword } from "./changePassword.js";
import { repairReplicas } from "./repair.js";
import { InMemoryKeyValueStore } from "../storage/interface.js";
import { raiseHighWaterMark } from "./highWaterMark.js";
import { RelayPool } from "../nostr/pool.js";
import { AccountNotFoundError, RollbackDetectedError } from "./errors.js";
import { derivePasswordKeys, normalizeLoginName } from "./normalize.js";
import { buildCredentialCapsuleEvent, decryptCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import { RelayConnection } from "../nostr/relay.js";
import { readCredentialCapsule } from "./capsuleReader.js";
import { buildRecoveryExport, parseRecoveryExport } from "./exportImport.js";

const ARGON2_TIMEOUT = 20000;

describe("BitLogin Phase 0 end-to-end scenarios (§32)", () => {
  let relays: MockRelay[] = [];
  let vaultRelayUrls: string[] = [];

  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    vaultRelayUrls = relays.map((r) => r.url);
  });

  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it(
    "create -> publish -> clean-device password login produces the identical everyday pubkey",
    async () => {
      const loginName = "adam";
      const password = generatePassphrase().secret;

      const registration = await registerAccount({ loginName, password, vaultRelayUrls });
      expect(registration.credentialPublish.success).toBe(true);
      expect(registration.recoveryPublish.success).toBe(true);

      // Simulate a brand-new device/browser: no local state at all besides login name + password.
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls });
      expect(login.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(login.accountId).toBe(registration.accountId);
      expect(login.generation).toBe(0);
      expect(login.rollbackWarning).toBeUndefined();
    },
    ARGON2_TIMEOUT
  );

  it(
    "import an existing nsec -> clean-device login and phrase recovery both reproduce the imported npub (§SF10)",
    async () => {
      // A pre-existing Nostr identity the user already controls.
      const existingKey = generatePrivateKey();
      const existingPubkey = getPublicKeyHex(existingKey);
      const nsec = encodeNsec(existingKey);
      const npub = encodeNpub(existingPubkey);

      const loginName = "importer";
      const password = generatePassphrase().secret;

      // decodeEverydayPrivateKey accepts both nsec and 64-char hex forms.
      const existingKeyHex = bytesToHex(existingKey);
      expect(getPublicKeyHex(decodeEverydayPrivateKey(nsec))).toBe(existingPubkey);
      expect(getPublicKeyHex(decodeEverydayPrivateKey(existingKeyHex))).toBe(existingPubkey);

      const registration = await importAccount({ nsecOrHex: nsec, loginName, password, vaultRelayUrls });
      expect(registration.imported).toBe(true);
      expect(registration.everydayPublicKey).toBe(existingPubkey);

      // Clean-device password login yields the imported identity, unchanged.
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls });
      expect(login.everydayPublicKey).toBe(existingPubkey);
      expect(encodeNpub(login.everydayPublicKey)).toBe(npub);

      // The freshly generated BitLogin phrase recovers the SAME imported identity.
      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: vaultRelayUrls
      });
      expect(recovered.everydayPublicKey).toBe(existingPubkey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "login and password change both surface the embedded recovery capsule event (recovery export must work without a fresh phrase-recovery)",
    async () => {
      const loginName = "exportbug";
      const oldPassword = generatePassphrase().secret;
      const newPassword = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password: oldPassword, vaultRelayUrls });

      // A clean-device login (no prior registration/recovery in this "session") must still
      // return the embedded recovery event -- this is what a recovery-export button needs.
      const login = await loginWithPassword({ loginName, password: oldPassword, vaultRelayUrls });
      expect(login.recoveryCapsuleEvent.id).toBe(registration.recoveryEvent.id);

      // After a password rotation, the (unchanged) recovery capsule event must still be
      // surfaced -- previously this was silently dropped, breaking "download export" after
      // a rotation even across a logout/login.
      const changed = await changePassword({ loginName, oldPassword, newPassword, vaultRelayUrls });
      expect(changed.recoveryCapsuleEvent.id).toBe(registration.recoveryEvent.id);
      expect(changed.recoveryPublicKey).toBe(registration.recoveryPublicKey);

      const loginAfterRotation = await loginWithPassword({ loginName, password: newPassword, vaultRelayUrls });
      expect(loginAfterRotation.recoveryCapsuleEvent.id).toBe(registration.recoveryEvent.id);
    },
    ARGON2_TIMEOUT * 2
  );

  it("rejects malformed keys on import (§SF10)", () => {
    expect(() => decodeEverydayPrivateKey("not-a-key")).toThrow();
    expect(() => decodeEverydayPrivateKey("nsec1invalid")).toThrow();
    expect(() => decodeEverydayPrivateKey("00".repeat(32))).toThrow(); // zero scalar is invalid
    expect(() => decodeEverydayPrivateKey("ab".repeat(20))).toThrow(); // wrong length hex
  });

  it(
    "wrong password on a real account is indistinguishable from a nonexistent account (§16.3)",
    async () => {
      const loginName = "adam2";
      const password = generatePassphrase().secret;
      await registerAccount({ loginName, password, vaultRelayUrls });

      await expect(loginWithPassword({ loginName, password: generatePassphrase().secret, vaultRelayUrls })).rejects.toThrow(
        "Account not found or credentials incorrect."
      );
      await expect(loginWithPassword({ loginName: "nobody-has-this-name", password, vaultRelayUrls })).rejects.toThrow(
        "Account not found or credentials incorrect."
      );
    },
    ARGON2_TIMEOUT
  );

  it(
    "recover -> establish new credentials -> clean-device login with the new password works, same everyday identity",
    async () => {
      const loginName = "recoverme";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password, vaultRelayUrls });

      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: vaultRelayUrls
      });
      expect(recovered.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(recovered.accountId).toBe(registration.accountId);
      expect(recovered.chainWarning).toBeUndefined();

      const newLoginName = "recoverme2";
      const newPassword = generatePassphrase().secret;
      const completion = await completeRecoveryWithNewCredentials({
        recovered,
        newLoginName,
        newPassword,
        vaultRelayUrls
      });
      expect(completion.credentialPublish.success).toBe(true);
      expect(completion.recoveryPublish.success).toBe(true);

      // Old credentials must no longer resolve to a fresh login path in the same way (new locator address);
      // the important invariant is that the NEW credentials work from a clean device.
      const cleanDeviceLogin = await loginWithPassword({ loginName: newLoginName, password: newPassword, vaultRelayUrls });
      expect(cleanDeviceLogin.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(cleanDeviceLogin.generation).toBe(0);

      // The refreshed recovery capsule replaced the original; recovering again with the same phrase
      // must see the new generation and a consistent (non-broken) chain back to the original.
      const recoveredAgain = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: vaultRelayUrls
      });
      expect(recoveredAgain.currentRecoveryPayload.recovery_generation).toBe(1);
      expect(recoveredAgain.currentRecoveryPayload.previous_recovery_event_id).toBe(registration.recoveryEvent.id);
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "recovery export file lets recovery succeed even when every configured relay is unreachable (§19.5)",
    async () => {
      const loginName = "offlinerecover";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password, vaultRelayUrls });

      // Build (and round-trip through JSON, as the downloaded file would be) the recovery
      // export exactly as the widget does right after registration.
      const exportFile = buildRecoveryExport({
        recoveryPublicKeyHex: registration.recoveryPublicKey,
        vaultRelayUrls,
        recoveryCapsuleEvents: [registration.recoveryEvent],
        relayListEvents: []
      });
      const parsedExportFile = parseRecoveryExport(JSON.parse(JSON.stringify(exportFile)));

      // Simulate every configured relay being unreachable (not just empty -- an actual closed
      // port, so the quorum read genuinely fails rather than vacuously succeeding on zero relays).
      const unreachableRelayUrls = ["ws://127.0.0.1:1"];

      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls: unreachableRelayUrls,
        discoveryRelayUrls: unreachableRelayUrls,
        offlineRecoveryCapsuleEvents: parsedExportFile.recovery_capsule_events
      });
      expect(recovered.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(recovered.accountId).toBe(registration.accountId);

      // Without the offline file, the same unreachable relays must fail outright.
      await expect(
        recoverWithPhrase({
          phrase: registration.recoveryPhrase,
          vaultRelayUrls: unreachableRelayUrls,
          discoveryRelayUrls: unreachableRelayUrls
        })
      ).rejects.toThrow(AccountNotFoundError);
    },
    ARGON2_TIMEOUT
  );

  it(
    "known-password change tombstones the old locator and a stale replay of the old capsule does not win",
    async () => {
      const loginName = "changeme";
      const oldPassword = generatePassphrase().secret;
      const newPassword = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password: oldPassword, vaultRelayUrls });

      const changed = await changePassword({ loginName, oldPassword, newPassword, vaultRelayUrls });
      expect(changed.newCredentialPublish.success).toBe(true);
      expect(changed.tombstoneAcknowledgedCount).toBeGreaterThanOrEqual(2);
      expect(changed.deletionAcknowledgedCount).toBeGreaterThanOrEqual(2);
      expect(changed.newGeneration).toBe(1);

      // New password logs in to the same everyday identity.
      const login = await loginWithPassword({ loginName, password: newPassword, vaultRelayUrls });
      expect(login.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(login.generation).toBe(1);

      // Old password's locator address is now tombstoned (empty content) -- old password no longer logs in.
      await expect(loginWithPassword({ loginName, password: oldPassword, vaultRelayUrls })).rejects.toThrow(AccountNotFoundError);
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "relay loss -> replica repair restores both capsules, including keyless recovery-event rebroadcast",
    async () => {
      const loginName = "repairme";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password, vaultRelayUrls });

      // Simulate total data loss on one relay (§19.4, §29.3).
      relays[2]!.wipeAllData();

      const pool = new RelayPool(vaultRelayUrls);
      const repair = await repairReplicas(pool, registration.credentialEvent, registration.recoveryEvent);
      pool.closeAll();
      expect(repair.credentialAcknowledgedCount).toBe(3);
      expect(repair.recoveryAcknowledgedCount).toBe(3);

      // The repaired relay can now serve a clean-device login on its own.
      const soleRelayLogin = await loginWithPassword({ loginName, password, vaultRelayUrls: [relays[2]!.url] });
      expect(soleRelayLogin.everydayPublicKey).toBe(registration.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "a device that has seen a higher generation refuses a lower one by default, unless explicitly acknowledged (§16.2 step 6)",
    async () => {
      const loginName = "rollback";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password, vaultRelayUrls });

      const store = new InMemoryKeyValueStore();
      // Simulate this device having previously observed a higher generation for this account.
      await raiseHighWaterMark(store, registration.everydayPublicKey, { generation: 5 });

      // Fails closed by default -- the client cannot tell "old, replayed credential" apart
      // from "relay is merely lagging," so it must not silently grant a session either way.
      await expect(loginWithPassword({ loginName, password, vaultRelayUrls, store })).rejects.toThrow(RollbackDetectedError);

      // An explicit override still allows the (still-warned) login through.
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls, store, acknowledgeRollback: true });
      expect(login.generation).toBe(0);
      expect(login.rollbackWarning).toBeDefined();
    },
    ARGON2_TIMEOUT
  );

  it(
    "old password rotated away on another device still fails closed even when a holdout relay never received the tombstone (§16.2 step 6, §18.1)",
    async () => {
      const loginName = "holdout";
      const oldPassword = generatePassphrase().secret;
      const newPassword = generatePassphrase().secret;
      await registerAccount({ loginName, password: oldPassword, vaultRelayUrls });

      // Rotate using only two of the three relays -- the third (relays[2]) never receives the
      // new capsule NOR the tombstone/deletion request, so it keeps serving the original,
      // "revoked" capsule indefinitely (a relay is never obligated to honor a deletion request).
      const rotatingRelays = [relays[0]!.url, relays[1]!.url];
      await changePassword({ loginName, oldPassword, newPassword, vaultRelayUrls: rotatingRelays });

      // Simulate one continuously-used device/browser: it logs in with the new password (across
      // all relays, including the holdout) and so locally records having seen the new generation.
      const store = new InMemoryKeyValueStore();
      const afterRotationLogin = await loginWithPassword({ loginName, password: newPassword, vaultRelayUrls, store });
      expect(afterRotationLogin.generation).toBe(1);

      // The same device is now asked to log in with the OLD password, querying ONLY the
      // holdout relay that still has the pre-rotation capsule. Before the fix, this granted a
      // full session (with only a non-blocking warning) because the old password's locator
      // address still decrypts successfully there. It must now fail closed instead.
      await expect(
        loginWithPassword({ loginName, password: oldPassword, vaultRelayUrls: [relays[2]!.url], store })
      ).rejects.toThrow(RollbackDetectedError);

      // The explicit escape hatch still exists for a human who is confident this is relay lag.
      const acknowledged = await loginWithPassword({
        loginName,
        password: oldPassword,
        vaultRelayUrls: [relays[2]!.url],
        store,
        acknowledgeRollback: true
      });
      expect(acknowledged.generation).toBe(0);
      expect(acknowledged.rollbackWarning).toBeDefined();
    },
    ARGON2_TIMEOUT * 2
  );

  it(
    "relays disagreeing about the latest capsule for the same address are detected (§16.2 step 8)",
    async () => {
      const loginName = "disagree";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({ loginName, password, vaultRelayUrls });

      // One relay receives a newer, independently re-signed generation that never reached the
      // other two -- simulating a relay that is ahead while its peers are ahead of *it* in a
      // split-brain sense; either way, "latest per relay" no longer agrees across the pool.
      const normalizedLoginName = normalizeLoginName(loginName);
      const { locatorPrivateKey, capsuleKey } = await derivePasswordKeys(password, normalizedLoginName);
      const decrypted = await decryptCredentialCapsuleEvent(registration.credentialEvent, capsuleKey);
      const conflictingEvent = await buildCredentialCapsuleEvent({
        locatorPrivateKey,
        capsuleKey,
        payload: { ...decrypted, generation: decrypted.generation + 1, created_at: registration.credentialEvent.created_at + 100 }
      });

      const holdoutConnection = new RelayConnection(relays[2]!.url);
      await holdoutConnection.publish(conflictingEvent);
      holdoutConnection.close();

      const pool = new RelayPool(vaultRelayUrls);
      const result = await readCredentialCapsule(pool, registration.locatorPublicKey, capsuleKey);
      pool.closeAll();
      expect(result.relayDisagreement).toBe(true);
    },
    ARGON2_TIMEOUT
  );
});
