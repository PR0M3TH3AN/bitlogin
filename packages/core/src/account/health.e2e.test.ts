import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { generatePassphrase } from "./passphrase.js";
import { registerAccount } from "./create.js";
import { loginWithPassword } from "./login.js";
import { recoverWithPhrase } from "./recover.js";
import { changePassword } from "./changePassword.js";
import { rebroadcastCapsules, repairReplicas } from "./repair.js";
import { checkReplicaHealth } from "./health.js";
import { AccountNotFoundError } from "./errors.js";
import { RelayPool } from "../nostr/pool.js";

const ARGON2_TIMEOUT = 20000;

describe("replica health check (§24.4)", () => {
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

  async function register(loginName: string) {
    const password = generatePassphrase().secret;
    const registration = await registerAccount({
      loginName,
      password,
      vaultRelayUrls,
    });
    return { password, registration };
  }

  it(
    "reports every relay as current right after registration",
    async () => {
      const { registration } = await register("healthy");
      const health = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(health.totalCount).toBe(3);
      expect(health.reachableCount).toBe(3);
      expect(health.credentialCurrentCount).toBe(3);
      expect(health.recoveryCurrentCount).toBe(3);
      expect(health.relays.map((r) => r.relayUrl)).toEqual(vaultRelayUrls);
    },
    ARGON2_TIMEOUT,
  );

  it(
    "tells a relay that dropped the capsules apart from one that is down",
    async () => {
      const { registration } = await register("partial");
      relays[1]!.wipeAllData();
      await relays[2]!.close();

      const health = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
        timeoutMs: 1500,
      });
      expect(health.relays[0]).toMatchObject({
        credential: "current",
        recovery: "current",
      });
      expect(health.relays[1]).toMatchObject({
        credential: "missing",
        recovery: "missing",
      });
      expect(health.relays[2]).toMatchObject({
        credential: "unreachable",
        recovery: "unreachable",
      });
      expect(health.relays[2]!.error).toBeTruthy();
      expect(health.reachableCount).toBe(2);
      expect(health.credentialCurrentCount).toBe(1);
      expect(health.recoveryCurrentCount).toBe(1);
    },
    ARGON2_TIMEOUT,
  );

  it(
    "every relay dropped the account: the check sees it, and repair from a live session brings both sign-in paths back",
    async () => {
      const loginName = "dropped";
      const { password, registration } = await register(loginName);
      for (const relay of relays) relay.wipeAllData();

      // What the user hits without a live session: neither path finds the account.
      await expect(
        loginWithPassword({ loginName, password, vaultRelayUrls }),
      ).rejects.toThrow(AccountNotFoundError);
      await expect(
        recoverWithPhrase({
          phrase: registration.recoveryPhrase,
          vaultRelayUrls,
          discoveryRelayUrls: [],
        }),
      ).rejects.toThrow(AccountNotFoundError);

      const before = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(before.reachableCount).toBe(3);
      expect(before.credentialCurrentCount).toBe(0);
      expect(before.recoveryCurrentCount).toBe(0);

      const pool = new RelayPool(vaultRelayUrls);
      await repairReplicas(
        pool,
        registration.credentialEvent,
        registration.recoveryEvent,
      );
      pool.closeAll();

      const after = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(after.credentialCurrentCount).toBe(3);
      expect(after.recoveryCurrentCount).toBe(3);

      const login = await loginWithPassword({
        loginName,
        password,
        vaultRelayUrls,
      });
      expect(login.everydayPublicKey).toBe(registration.everydayPublicKey);
      const recovered = await recoverWithPhrase({
        phrase: registration.recoveryPhrase,
        vaultRelayUrls,
        discoveryRelayUrls: [],
      });
      expect(recovered.everydayPublicKey).toBe(registration.everydayPublicKey);
    },
    ARGON2_TIMEOUT * 3,
  );

  it(
    "rebroadcastCapsules tops up a relay that dropped the account and reports what was accepted",
    async () => {
      const { registration } = await register("topup");
      relays[2]!.wipeAllData();
      relays[1]!.refusePublishFrom = new Set([registration.recoveryPublicKey]);

      const result = await rebroadcastCapsules({
        relayUrls: [...vaultRelayUrls, vaultRelayUrls[0]!],
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(result.relaysTried).toBe(3);
      expect(result.credentialAcknowledgedCount).toBe(3);
      expect(result.recoveryAcknowledgedCount).toBe(2);

      const health = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(health.credentialCurrentCount).toBe(3);
      expect(health.recoveryCurrentCount).toBe(3);
    },
    ARGON2_TIMEOUT,
  );

  it(
    "does not count a copy whose signature fails to verify",
    async () => {
      const { registration } = await register("forged");
      relays[0]!.wipeAllData();
      // Same id, same address, wrong signature: a relay claiming to hold the
      // capsule without actually holding a usable one.
      const forgedSig = "0".repeat(128);
      relays[0]!.unsolicitedQueryEvents = [
        { ...registration.credentialEvent, sig: forgedSig },
        { ...registration.recoveryEvent, sig: forgedSig },
      ];

      const health = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(health.relays[0]).toMatchObject({
        credential: "missing",
        recovery: "missing",
      });
      expect(health.credentialCurrentCount).toBe(2);
      expect(health.recoveryCurrentCount).toBe(2);
    },
    ARGON2_TIMEOUT,
  );

  it(
    "flags a session left behind by a password change on another device",
    async () => {
      const loginName = "rotated";
      const { password, registration } = await register(loginName);
      await changePassword({
        loginName,
        oldPassword: password,
        newPassword: generatePassphrase().secret,
        vaultRelayUrls,
      });

      // The old session still holds the pre-rotation credential event; the
      // relays now hold its tombstone at that address.
      const health = await checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: registration.credentialEvent,
        recoveryEvent: registration.recoveryEvent,
      });
      expect(health.credentialCurrentCount).toBe(0);
      expect(health.relays.every((r) => r.credential === "newer")).toBe(true);
      // Password rotation never touches the recovery capsule (§14.1).
      expect(health.recoveryCurrentCount).toBe(3);
    },
    ARGON2_TIMEOUT * 3,
  );

  it("refuses to check against an event that is not a valid capsule", async () => {
    const { registration } = await register("invalid");
    await expect(
      checkReplicaHealth({
        relayUrls: vaultRelayUrls,
        credentialEvent: { ...registration.credentialEvent, sig: "0".repeat(128) },
        recoveryEvent: registration.recoveryEvent,
      }),
    ).rejects.toThrow(/not a valid capsule/u);
  }, ARGON2_TIMEOUT);
});
