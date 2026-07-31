/*
 * Known-answer tests for the derivation chain.
 *
 * BitLogin accounts are encrypted capsules living on public relays, and the
 * login name plus password derive the locator, the signing scalar, and the
 * capsule key deterministically. Those outputs are therefore a COMPATIBILITY
 * CONTRACT with every account that already exists: if any of them changes,
 * existing users cannot log in and their capsules cannot be decrypted. There
 * is no server-side record to migrate, because that is the entire design.
 *
 * The existing crypto tests check self-consistency -- same input, same output
 * within one run -- which cannot catch that. A dependency upgrade that alters
 * HKDF, the scalar loop, base64url, BIP-39 seeding, or JCS ordering would keep
 * every one of those tests green while locking every user out.
 *
 * These vectors were captured from the shipping implementation on 2026-07-31.
 * They are not claims about what the values SHOULD be in the abstract; they
 * are a record of what live accounts already depend on. A change here is
 * therefore never "update the expected value" -- it means the upgrade being
 * attempted is account-breaking and needs a migration plan or rejection.
 *
 * Prompted by a Dependabot PR proposing @noble/hashes 1.8 -> 2.2 and
 * @scure/base 1.2 -> 2.2 in a single grouped change.
 */
import { describe, expect, it } from "vitest";
import { hkdfExtract, hkdfExpand, labelSalt } from "./hkdf.js";
import { scalarExpand } from "./scalarExpand.js";
import { getPublicKeyHex } from "./secp256k1.js";
import { bytesToHex, utf8ToBytes, bytesToBase64url } from "./encoding.js";
import { entropyToRecoveryPhrase, recoveryPhraseToSeed } from "./bip39.js";
import { canonicalJson } from "./jcs.js";

const IKM = "kat-ikm-v1";
const ROOT_LABEL = "bitlogin/password-root/v1";
const SIGNING_LABEL = "bitlogin/password-locator-signing/v1";

describe("derivation chain known answers (account compatibility)", () => {
  it("HKDF-Extract is unchanged", () => {
    const prk = hkdfExtract(labelSalt(ROOT_LABEL), utf8ToBytes(IKM));
    expect(bytesToHex(prk)).toBe(
      "a6cd2bc970db284dc11d54e25428789558e6bc3e3e8d254c1f80acd6ec42b246",
    );
  });

  it("HKDF-Expand is unchanged", () => {
    const prk = hkdfExtract(labelSalt(ROOT_LABEL), utf8ToBytes(IKM));
    expect(bytesToHex(hkdfExpand(prk, "bitlogin/kat/v1", 32))).toBe(
      "0f9d275238cdb502b5d08dbe94ec6d91b03124fd7735334b39fb7110826f40aa",
    );
  });

  it("ScalarExpand yields the same scalar, counter, and public key", () => {
    // The public key is the one a relay has seen sign this account's capsule.
    // If it moves, the account's own history stops verifying.
    const prk = hkdfExtract(labelSalt(ROOT_LABEL), utf8ToBytes(IKM));
    const result = scalarExpand(prk, SIGNING_LABEL);
    expect(bytesToHex(result.scalar)).toBe(
      "f4838ec5489f243540ce4323a532be0d5246069d4375cb30b5a450aeb4553f8a",
    );
    expect(result.counter).toBe(0);
    expect(getPublicKeyHex(result.scalar)).toBe(
      "f047bc5a592d2a53c19503c14c2ba8fcfa4437d1d2e2c68fc03f9f9752bbe482",
    );
  });

  it("BIP-39 phrase and seed derivation are unchanged", () => {
    // Recovery is the last way back into an account. A changed wordlist or
    // seeding function turns every printed recovery phrase into confetti.
    const phrase = entropyToRecoveryPhrase(new Uint8Array(16).fill(7));
    expect(phrase).toBe(
      "alpha deal scrub asthma idea logic bright thought alpha deal scrub autumn",
    );
  });

  it("BIP-39 seed bytes are unchanged", async () => {
    const seed = await recoveryPhraseToSeed(
      "alpha deal scrub asthma idea logic bright thought alpha deal scrub autumn",
    );
    expect(bytesToHex(seed).slice(0, 64)).toBe(
      "8252a324fac1a2960625f829d70d720c912cdf7c683f9772c3a55d57d9f8a983",
    );
  });

  it("base64url encoding is unchanged", () => {
    // @scure/base is in the Dependabot bump. Unpadded, URL-safe alphabet: a
    // change here alters every stored capsule payload's framing.
    expect(bytesToBase64url(new Uint8Array([0, 1, 250, 255]))).toBe("AAH6_w");
  });

  it("JCS canonicalisation ordering is unchanged", () => {
    // Capsules are signed over canonical JSON, so a different key order is a
    // different signature over what is otherwise the same object.
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe('{"a":[2,{"c":3,"d":4}],"b":1}');
  });
});
