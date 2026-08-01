/*
 * Compatibility check for accounts created before manual passwords were removed
 * from the widget UI.
 *
 * The removal (2026-07-31 hardening) took the *controls* away: you can no
 * longer type your own password when creating, recovering, or rotating an
 * account. It did not change the derivation chain, and nothing on the login
 * path inspects the shape of the password — `derivePasswordKeys` normalizes any
 * string to bytes and runs Argon2id over it.
 *
 * That distinction matters because BitLogin has no server-side record: if
 * sign-in ever stopped accepting a password shape it previously issued, those
 * accounts would be unrecoverable except through their recovery phrase. These
 * tests assert the distinction holds, so a future change that quietly adds a
 * format gate to the login path fails here rather than in someone's browser.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { registerAccount } from "./create.js";
import { loginWithPassword } from "./login.js";
import { changePassword } from "./changePassword.js";
import { derivePasswordKeys } from "./normalize.js";
import { bytesToHex } from "../crypto/encoding.js";

const ARGON2_TIMEOUT = 20000;

// The kinds of password a human actually picks, which the old UI accepted:
// short, no spaces, mixed case, symbols, unicode, and a very long passphrase.
const LEGACY_PASSWORDS = [
  "hunter2",
  "correct horse battery staple",
  "P@ssw0rd!2019",
  "  leading and trailing  ",
  "übergrößé-πassword",
  "x".repeat(256),
];

describe("passwords created before manual entry was removed still work", () => {
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
    "registers and signs back in with a hand-typed password",
    async () => {
      const password = "correct horse battery staple";
      const registered = await registerAccount({
        loginName: "legacy-user",
        password,
        vaultRelayUrls,
      });

      const login = await loginWithPassword({
        loginName: "legacy-user",
        password,
        vaultRelayUrls,
      });

      expect(login.everydayPublicKey).toBe(registered.everydayPublicKey);
      expect(login.accountId).toBe(registered.accountId);
    },
    ARGON2_TIMEOUT,
  );

  it(
    "still refuses the wrong password for such an account",
    async () => {
      const password = "P@ssw0rd!2019";
      await registerAccount({ loginName: "legacy-two", password, vaultRelayUrls });

      await expect(
        loginWithPassword({
          loginName: "legacy-two",
          password: "P@ssw0rd!2020",
          vaultRelayUrls,
        }),
      ).rejects.toThrow();
    },
    ARGON2_TIMEOUT,
  );

  it(
    "lets a legacy-password account rotate onto a generated one",
    async () => {
      // The migration path a real user takes: sign in with the old typed
      // password, rotate to a generated one. Both halves must work.
      const oldPassword = "hunter2";
      await registerAccount({ loginName: "legacy-rotate", password: oldPassword, vaultRelayUrls });

      const newPassword = "casket vividly rerun dusk hazily uncle";
      await changePassword({
        loginName: "legacy-rotate",
        oldPassword,
        newPassword,
        vaultRelayUrls,
      });

      const login = await loginWithPassword({
        loginName: "legacy-rotate",
        password: newPassword,
        vaultRelayUrls,
      });
      expect(login.everydayPublicKey).toBeTruthy();

      await expect(
        loginWithPassword({ loginName: "legacy-rotate", password: oldPassword, vaultRelayUrls }),
      ).rejects.toThrow();
    },
    ARGON2_TIMEOUT,
  );

  it(
    "derives keys from every legacy password shape without inspecting it",
    async () => {
      // No length floor, no charset rule, no entropy gate on the derivation
      // path — that is what keeps old accounts reachable.
      const seen = new Set<string>();
      for (const password of LEGACY_PASSWORDS) {
        const { locatorPrivateKey, capsuleKey } = await derivePasswordKeys(password, "someone");
        expect(locatorPrivateKey).toHaveLength(32);
        expect(capsuleKey).toHaveLength(32);
        seen.add(bytesToHex(locatorPrivateKey));
      }
      expect(seen.size).toBe(LEGACY_PASSWORDS.length);
    },
    ARGON2_TIMEOUT * 3,
  );
});
