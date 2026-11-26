/**
 * Securing a guest account (docs/guest-accounts.md G6): an account made from the phrase the guest was made from,
 * so the account's key is the guest's, and its phrase rebuilds it, as for any account made here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { registerAccount } from "./create.js";
import { generatePassphrase } from "./passphrase.js";
import { deriveEverydayPrivateKey } from "./normalize.js";
import { entropyToRecoveryPhrase, recoveryPhraseToSeed } from "../crypto/bip39.js";
import { randomEntropy128 } from "../crypto/random.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";

describe("an account made from a guest's own recovery phrase", () => {
  let relays: MockRelay[] = [];
  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start()]);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it("has the key that phrase makes, recorded as derived, and refuses a phrase that isn't one", async () => {
    const phrase = entropyToRecoveryPhrase(randomEntropy128());
    const guestKey = deriveEverydayPrivateKey(await recoveryPhraseToSeed(phrase));
    const urls = relays.map((r) => r.url);
    const made = await registerAccount({ loginName: "secured-guest", password: generatePassphrase().secret, vaultRelayUrls: urls, recoveryPhrase: phrase });
    expect(made.everydayPublicKey).toBe(getPublicKeyHex(guestKey));
    expect(made.recoveryPhrase).toBe(phrase);
    expect(made.everydayKeyDerived).toBe(true);
    expect(made.imported).toBe(false);
    await expect(registerAccount({ loginName: "not-a-phrase", password: generatePassphrase().secret, vaultRelayUrls: urls, recoveryPhrase: "one two three" })).rejects.toThrow(/recovery phrase/u);
  }, 120_000);
});
