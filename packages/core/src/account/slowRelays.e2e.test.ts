/**
 * Sign-in and recovery never read a slow or unreached relay as "no account" (2026-11-26, the record-not-found
 * fault; names given by the orchestrator). A quorum of empty answers alone never says "not found": a relay that
 * connected and didn't finish is asked once more, and "not found" is said only where every listed relay was reached
 * and answered empty. Otherwise `RelaysSlowError`, with `reason` "slow" or "unreached". Each failing before the mend.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { registerAccount } from "./create.js";
import { loginWithPassword } from "./login.js";
import { recoverWithPhrase } from "./recover.js";
import { generatePassphrase } from "./passphrase.js";
import { randomBytes } from "../crypto/random.js";
import { bytesToHex } from "../crypto/encoding.js";

const ARGON2_TIMEOUT = 120_000;
const QUICK = 1500;

describe("sign-in and recovery where the relays holding the account are slow or unreached", () => {
  let relays: MockRelay[] = [];
  let urls: string[] = [];
  beforeEach(async () => {
    relays = await Promise.all(Array.from({ length: 7 }, () => MockRelay.start()));
    urls = relays.map((r) => r.url);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });
  /** An account held by the first three relays only; the other four are empty. */
  const onFirstThree = async () => {
    const loginName = `held-${bytesToHex(randomBytes(4))}`;
    const password = generatePassphrase().secret;
    const made = await registerAccount({ loginName, password, vaultRelayUrls: urls.slice(0, 3) });
    return { loginName, password, made };
  };

  it(
    "signs in on the second ask where the three holders answer after the first ask's time",
    async () => {
      const { loginName, password, made } = await onFirstThree();
      for (const i of [0, 1, 2]) relays[i]!.eoseDelayMs = 2500;
      const login = await loginWithPassword({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK });
      expect(login.everydayPublicKey).toBe(made.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );

  it(
    "says not found only where every listed relay was reached and answered empty",
    async () => {
      await expect(loginWithPassword({ loginName: "nobody-here", password: generatePassphrase().secret, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toMatchObject({ name: "AccountNotFoundError", reason: "no-matching-event" });
    },
    ARGON2_TIMEOUT
  );

  it(
    "says try again, never not found, where the holders connected and never answered, even when asked again",
    async () => {
      const { loginName, password } = await onFirstThree();
      for (const i of [0, 1, 2]) relays[i]!.suppressEose = true;
      await expect(loginWithPassword({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toMatchObject({
        name: "RelaysSlowError",
        reason: "slow",
        message: "Some of your relays didn't answer in time, so your account couldn't be read. Try again."
      });
    },
    ARGON2_TIMEOUT
  );

  it(
    "says try again, never not found, where the holders couldn't be reached at all and the rest answered empty",
    async () => {
      const { loginName, password } = await onFirstThree();
      for (const i of [0, 1, 2]) relays[i]!.refuseConnections = true;
      await expect(loginWithPassword({ loginName, password, vaultRelayUrls: urls, timeoutMs: QUICK })).rejects.toMatchObject({
        name: "RelaysSlowError",
        reason: "unreached",
        unreached: 3,
        message: "Your account wasn't on the relays that answered, but 3 of your relays couldn't be reached. Try again."
      });
    },
    ARGON2_TIMEOUT
  );

  it(
    "holds recovery to the same: an unreached holder is try again, never not found (so never the rebuild)",
    async () => {
      const { made } = await onFirstThree();
      for (const i of [0, 1, 2]) relays[i]!.refuseConnections = true;
      await expect(recoverWithPhrase({ phrase: made.recoveryPhrase, vaultRelayUrls: urls, discoveryRelayUrls: urls, timeoutMs: QUICK })).rejects.toMatchObject({ name: "RelaysSlowError", reason: "unreached", unreached: 3 });
      // Reached again, it recovers.
      for (const i of [0, 1, 2]) relays[i]!.refuseConnections = false;
      expect((await recoverWithPhrase({ phrase: made.recoveryPhrase, vaultRelayUrls: urls, discoveryRelayUrls: urls, timeoutMs: QUICK })).everydayPublicKey).toBe(made.everydayPublicKey);
    },
    ARGON2_TIMEOUT
  );
});
