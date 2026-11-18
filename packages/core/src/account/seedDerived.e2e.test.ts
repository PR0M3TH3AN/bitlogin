import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { generatePassphrase } from "./passphrase.js";
import { registerAccount } from "./create.js";
import { loginWithPassword } from "./login.js";
import {
  recoverWithPhrase,
  completeRecoveryWithNewCredentials,
  previewPhraseRebuild,
  rebuildAccountFromPhrase,
} from "./recover.js";
import { changePassword } from "./changePassword.js";
import { publishInitialProfile } from "./profileEvents.js";
import { deriveEverydayPrivateKey, deriveRecoveryKeys } from "./normalize.js";
import { AccountNotFoundError, RecoveryFailedError } from "./errors.js";
import { recoveryPhraseToSeed } from "../crypto/bip39.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { decryptRecoveryCapsuleEvent } from "../capsules/recoveryCapsule.js";
import {
  MAX_VAULT_RELAY_HINTS,
  PROTOCOL_EVERYDAY_DERIVATION,
  vaultRelayHints,
} from "../capsules/types.js";
import { BUILTIN_VAULT_RELAYS, maxRemoteAdditions } from "../nostr/bootstrap.js";

const ARGON2_TIMEOUT = 20000;

describe("seed-derived everyday identity (§11.6) and rebuild from phrase (§17.6)", () => {
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

  async function derivedPublicKey(phrase: string): Promise<string> {
    return getPublicKeyHex(
      deriveEverydayPrivateKey(await recoveryPhraseToSeed(phrase)),
    );
  }

  it(
    "a generated account's identity is the one its phrase derives, and its capsules say so",
    async () => {
      const loginName = "derived";
      const password = generatePassphrase().secret;
      const registration = await registerAccount({
        loginName,
        password,
        vaultRelayUrls,
      });
      expect(registration.imported).toBe(false);
      expect(registration.everydayKeyDerived).toBe(true);
      expect(registration.everydayPublicKey).toBe(
        await derivedPublicKey(registration.recoveryPhrase),
      );

      const login = await loginWithPassword({
        loginName,
        password,
        vaultRelayUrls,
      });
      expect(login.everydayKeyDerived).toBe(true);

      const { capsuleKey } = deriveRecoveryKeys(
        await recoveryPhraseToSeed(registration.recoveryPhrase),
      );
      const recoveryPayload = await decryptRecoveryCapsuleEvent(
        registration.recoveryEvent,
        capsuleKey,
      );
      expect(recoveryPayload.protocol.everyday_derivation).toBe(
        PROTOCOL_EVERYDAY_DERIVATION,
      );

      // Rotation rewrites the credential capsule and must not lose the hint.
      const newPassword = generatePassphrase().secret;
      await changePassword({
        loginName,
        oldPassword: password,
        newPassword,
        vaultRelayUrls,
      });
      const afterRotation = await loginWithPassword({
        loginName,
        password: newPassword,
        vaultRelayUrls,
      });
      expect(afterRotation.everydayKeyDerived).toBe(true);
    },
    ARGON2_TIMEOUT * 3,
  );

  it(
    "an imported key is never reported as derived, at login or at recovery",
    async () => {
      const loginName = "imported";
      const password = generatePassphrase().secret;
      const importedKey = generatePrivateKey();
      const registration = await registerAccount({
        loginName,
        password,
        vaultRelayUrls,
        everydayPrivateKey: importedKey,
      });
      expect(registration.imported).toBe(true);
      expect(registration.everydayKeyDerived).toBe(false);
      expect(registration.everydayPublicKey).toBe(getPublicKeyHex(importedKey));
      expect(registration.everydayPublicKey).not.toBe(
        await derivedPublicKey(registration.recoveryPhrase),
      );

      const login = await loginWithPassword({
        loginName,
        password,
        vaultRelayUrls,
      });
      expect(login.everydayKeyDerived).toBe(false);

      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(recovered.everydayKeyDerived).toBe(false);
      expect(recovered.everydayPublicKey).toBe(getPublicKeyHex(importedKey));
    },
    ARGON2_TIMEOUT * 2,
  );

  it(
    "every relay dropped the account: the phrase alone rebuilds the same identity",
    async () => {
      const registration = await registerAccount({
        loginName: "dropped",
        password: generatePassphrase().secret,
        vaultRelayUrls,
      });
      for (const relay of relays) relay.wipeAllData();

      // Ordinary recovery has nothing to find.
      await expect(
        recoverWithPhrase({
          phrase: registration.recoveryPhrase,
          vaultRelayUrls,
          discoveryRelayUrls: [],
        }),
      ).rejects.toThrow(AccountNotFoundError);

      const preview = await previewPhraseRebuild({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(preview.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(preview.profileFound).toBe(false);
      expect(preview.relayListFound).toBe(false);
      // The preview published nothing.
      expect(relays.flatMap((r) => r.storedEventKinds())).toEqual([]);

      const rebuilt = await rebuildAccountFromPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(rebuilt.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(rebuilt.everydayKeyDerived).toBe(true);
      expect(rebuilt.currentRecoveryPayload.recovery_generation).toBe(0);
      expect(rebuilt.currentRecoveryPayload.previous_recovery_event_id).toBeNull();
      // Random, capsule-only state is new, not restored.
      expect(rebuilt.accountId).not.toBe(registration.accountId);

      const newLoginName = "dropped-again";
      const newPassword = generatePassphrase().secret;
      const completed = await completeRecoveryWithNewCredentials({
        recovered: rebuilt,
        newLoginName,
        newPassword,
        vaultRelayUrls,
      });
      expect(completed.credentialPublish.success).toBe(true);

      const login = await loginWithPassword({
        loginName: newLoginName,
        password: newPassword,
        vaultRelayUrls,
      });
      expect(login.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(login.everydayKeyDerived).toBe(true);
      expect(login.connectionVaultRoot).toBeDefined();

      // And the phrase works the ordinary way again afterwards.
      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(recovered.everydayPublicKey).toBe(registration.everydayPublicKey);
      expect(recovered.currentRecoveryPayload.recovery_generation).toBe(1);
      expect(recovered.chainWarning).toBeUndefined();
    },
    ARGON2_TIMEOUT * 4,
  );

  it(
    "the preview reports public traces of the derived identity when they survive",
    async () => {
      const discovery = await MockRelay.start();
      try {
        const registration = await registerAccount({
          loginName: "traces",
          password: generatePassphrase().secret,
          vaultRelayUrls,
        });
        await publishInitialProfile({
          everydayPrivateKey: registration.everydayPrivateKey,
          name: "traces",
          generalRelays: [discovery.url],
          dmRelays: [discovery.url],
          discoveryRelays: [discovery.url],
        });
        for (const relay of relays) relay.wipeAllData();

        const preview = await previewPhraseRebuild({
          phrase: registration.recoveryPhrase,
          vaultRelayUrls,
          discoveryRelayUrls: [discovery.url],
        });
        expect(preview.everydayPublicKey).toBe(registration.everydayPublicKey);
        expect(preview.profileFound).toBe(true);
        expect(preview.relayListFound).toBe(true);
      } finally {
        await discovery.close();
      }
    },
    ARGON2_TIMEOUT * 2,
  );

  it(
    "refuses a rebuild while the capsule still exists, or when relays did not answer",
    async () => {
      const registration = await registerAccount({
        loginName: "present",
        password: generatePassphrase().secret,
        vaultRelayUrls,
      });
      const params = {
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
        timeoutMs: 1500,
      };
      await expect(previewPhraseRebuild(params)).rejects.toThrow(
        RecoveryFailedError,
      );
      await expect(rebuildAccountFromPhrase(params)).rejects.toThrow(
        RecoveryFailedError,
      );

      // Silence is not absence: with a quorum down, nothing can be concluded.
      await relays[1]!.close();
      await relays[2]!.close();
      relays[0]!.wipeAllData();
      await expect(previewPhraseRebuild(params)).rejects.toThrow(
        AccountNotFoundError,
      );
      await expect(rebuildAccountFromPhrase(params)).rejects.toThrow(
        AccountNotFoundError,
      );
      expect(relays[0]!.storedEventKinds()).toEqual([]);
    },
    ARGON2_TIMEOUT * 2,
  );

  it(
    "for an imported key, the preview shows a different identity than the account's own",
    async () => {
      // The reason the rebuild needs the user's confirmation (§17.6 step 3):
      // nothing on the wire tells an imported account's lost capsule apart
      // from a derived one's. Only the npub on screen does.
      const importedKey = generatePrivateKey();
      const registration = await registerAccount({
        loginName: "imported-lost",
        password: generatePassphrase().secret,
        vaultRelayUrls,
        everydayPrivateKey: importedKey,
      });
      for (const relay of relays) relay.wipeAllData();
      const preview = await previewPhraseRebuild({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(preview.everydayPublicKey).not.toBe(registration.everydayPublicKey);
      expect(preview.profileFound).toBe(false);
    },
    ARGON2_TIMEOUT * 2,
  );

  it(
    "an account fits its fixed-size capsule however long the relay list gets",
    async () => {
      // Found live on 2026-11-18: growing the built-in list from eight relays
      // to thirteen made every registration fail with "exceeds the largest
      // padding bucket", because the whole list was written into the payload
      // twice. Three mock relays could never catch that. This uses as many
      // relays as a client can end up with: the built-in list plus the most a
      // signed list may add (§19.1).
      const extra = await Promise.all(
        Array.from({ length: BUILTIN_VAULT_RELAYS.length * 2 - 1 - relays.length }, () => MockRelay.start()),
      );
      try {
        const many = [...vaultRelayUrls, ...extra.map((r) => r.url)];
        expect(many.length).toBe(BUILTIN_VAULT_RELAYS.length + maxRemoteAdditions(BUILTIN_VAULT_RELAYS.length));
        const loginName = "manyrelays";
        const password = generatePassphrase().secret;
        const registration = await registerAccount({ loginName, password, vaultRelayUrls: many });
        expect(registration.credentialPublish.acknowledgedCount).toBe(many.length);

        const { capsuleKey } = deriveRecoveryKeys(await recoveryPhraseToSeed(registration.recoveryPhrase));
        const payload = await decryptRecoveryCapsuleEvent(registration.recoveryEvent, capsuleKey);
        expect(payload.vault_relay_hints).toEqual(many.slice(0, MAX_VAULT_RELAY_HINTS));

        // Every later rewrite of the capsules has to fit as well.
        const newPassword = generatePassphrase().secret;
        await changePassword({ loginName, oldPassword: password, newPassword, vaultRelayUrls: many });
        const recovered = await recoverWithPhrase({ phrase: registration.recoveryPhrase, vaultRelayUrls: many, discoveryRelayUrls: [] });
        await completeRecoveryWithNewCredentials({
          recovered,
          newLoginName: "manyrelays-2",
          newPassword: generatePassphrase().secret,
          vaultRelayUrls: many,
        });
      } finally {
        await Promise.all(extra.map((r) => r.close()));
      }
    },
    ARGON2_TIMEOUT * 5,
  );

  it("the real built-in relay addresses leave room in the credential capsule", () => {
    // The payload is built from fixed-length fields plus the relay hints, so
    // this is the one input that can push it over. Longest plausible hints:
    expect(vaultRelayHints(BUILTIN_VAULT_RELAYS).length).toBeLessThanOrEqual(MAX_VAULT_RELAY_HINTS);
    expect(vaultRelayHints(["wss://" + "a".repeat(80) + ".example", "wss://ok.example", "wss://ok.example"])).toEqual(["wss://ok.example"]);
    expect(JSON.stringify(vaultRelayHints(Array.from({ length: 30 }, (_, i) => `wss://${"r".repeat(50)}${i}.example`))).length).toBeLessThan(300);
  });
});
