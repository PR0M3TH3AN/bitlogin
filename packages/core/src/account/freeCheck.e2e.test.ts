/**
 * "No account here" needs every relay asked to answer to the end with nothing at that address (2026-11-25). A quorum
 * of answers is not enough: where the relays that hold an existing account are the slow ones, the others' "nothing"
 * would have a new registration, or a password change, written over that account.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { registerAccount } from "./create.js";
import { changePassword } from "./changePassword.js";
import { loginWithPassword } from "./login.js";
import { completeRecoveryWithNewCredentials, recoverWithPhrase } from "./recover.js";
import { generatePassphrase } from "./passphrase.js";
import { AccountAlreadyExistsError } from "./errors.js";

const ARGON2_TIMEOUT = 60_000;
/** Short, so a relay that never finishes answering costs the test seconds, not the default eight. */
const QUICK = 1500;

describe("an account address is free only when every relay asked says so", () => {
  let relays: MockRelay[] = [];
  let urls: string[] = [];
  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    urls = relays.map((r) => r.url);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it(
    "refuses to register over an account the slow relay holds, though the others answer that nothing is there",
    async () => {
      const loginName = "slow-holder";
      const password = generatePassphrase().secret;
      const first = await registerAccount({ loginName, password, vaultRelayUrls: urls });
      // Only the first relay still holds it, and it never finishes answering; the other two answer, with nothing.
      relays[1]!.wipeAllData();
      relays[2]!.wipeAllData();
      relays[0]!.suppressEose = true;
      await expect(registerAccount({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toThrow(/not every vault relay answered/u);
      // The account is still the first one's.
      relays[0]!.suppressEose = false;
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls: [urls[0]!] });
      expect(login.everydayPublicKey).toBe(first.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "still refuses at once where any relay that answers holds it",
    async () => {
      const loginName = "held";
      const password = generatePassphrase().secret;
      await registerAccount({ loginName, password, vaultRelayUrls: urls });
      relays[2]!.suppressEose = true;
      await expect(registerAccount({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toBeInstanceOf(AccountAlreadyExistsError);
    },
    ARGON2_TIMEOUT
  );

  it(
    "registers where every relay answers with nothing",
    async () => {
      const made = await registerAccount({ loginName: "fresh", password: generatePassphrase().secret, vaultRelayUrls: urls, timeoutMs: QUICK });
      expect(made.everydayPublicKey).toMatch(/^[0-9a-f]{64}$/u);
    },
    ARGON2_TIMEOUT
  );

  it(
    "refuses a password change onto an address another account holds on the slow relay",
    async () => {
      const loginName = "shared-name";
      const takenPassword = generatePassphrase().secret;
      const other = await registerAccount({ loginName, password: takenPassword, vaultRelayUrls: urls });
      const mine = generatePassphrase().secret;
      await registerAccount({ loginName, password: mine, vaultRelayUrls: urls });
      // The other account now only on the first relay, which never finishes answering.
      const before = relays.map((r) => r.storedEventKinds().length);
      expect(before.every((n) => n > 0)).toBe(true);
      relays[1]!.wipeAllData();
      relays[2]!.wipeAllData();
      // Mine again on the two that answer, as the old password's capsule must be found to change it.
      await registerAccount({ loginName, password: mine, vaultRelayUrls: [urls[1]!, urls[2]!] }).catch(() => {});
      relays[0]!.suppressEose = true;
      await expect(changePassword({ loginName, oldPassword: mine, newPassword: takenPassword, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toThrow();
      relays[0]!.suppressEose = false;
      // The other account is untouched.
      const still = await loginWithPassword({ loginName, password: takenPassword, vaultRelayUrls: [urls[0]!] });
      expect(still.everydayPublicKey).toBe(other.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "refuses a recovery onto a login name and password another account holds on the slow relay",
    async () => {
      const takenName = "taken-at-recovery";
      const takenPassword = generatePassphrase().secret;
      const other = await registerAccount({ loginName: takenName, password: takenPassword, vaultRelayUrls: urls });
      const mine = await registerAccount({ loginName: "mine-recovering", password: generatePassphrase().secret, vaultRelayUrls: urls });
      const recovered = await recoverWithPhrase({ phrase: mine.recoveryPhrase, vaultRelayUrls: urls, discoveryRelayUrls: [] });
      // The other account now only on the first relay, which never finishes answering; the others hold nothing of it.
      relays[1]!.wipeAllData();
      relays[2]!.wipeAllData();
      relays[0]!.suppressEose = true;
      await expect(
        completeRecoveryWithNewCredentials({ recovered, newLoginName: takenName, newPassword: takenPassword, vaultRelayUrls: urls, timeoutMs: QUICK })
      ).rejects.toThrow(/not every vault relay answered/u);
      relays[0]!.suppressEose = false;
      const still = await loginWithPassword({ loginName: takenName, password: takenPassword, vaultRelayUrls: [urls[0]!] });
      expect(still.everydayPublicKey).toBe(other.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );
});
