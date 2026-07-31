import { describe, expect, it } from "vitest";
import { bytesToBase64url, bytesToHex } from "../crypto/encoding.js";
import { deriveLegacyVaultMaterial } from "./derivation.js";

describe("legacy Connection Vault migration material", () => {
  const recoveryCapsuleKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  const accountId = bytesToBase64url(Uint8Array.from({ length: 16 }, (_, index) => 0xa0 + index));

  it("is deterministic so concurrent migrations cannot mint split roots", () => {
    const first = deriveLegacyVaultMaterial(recoveryCapsuleKey, accountId);
    const second = deriveLegacyVaultMaterial(recoveryCapsuleKey, accountId);

    expect(bytesToHex(first.connectionVaultRoot)).toBe(bytesToHex(second.connectionVaultRoot));
    expect(bytesToHex(first.vaultSudoKey)).toBe(bytesToHex(second.vaultSudoKey));
    expect(bytesToHex(first.connectionVaultRoot)).not.toBe(bytesToHex(first.vaultSudoKey));
  });

  it("domain-separates accounts and does not consume the caller's recovery key", () => {
    const before = recoveryCapsuleKey.slice();
    const otherAccountId = bytesToBase64url(new Uint8Array(16).fill(0x55));
    const first = deriveLegacyVaultMaterial(recoveryCapsuleKey, accountId);
    const other = deriveLegacyVaultMaterial(recoveryCapsuleKey, otherAccountId);

    expect(recoveryCapsuleKey).toEqual(before);
    expect(bytesToHex(first.connectionVaultRoot)).not.toBe(bytesToHex(other.connectionVaultRoot));
    expect(bytesToHex(first.vaultSudoKey)).not.toBe(bytesToHex(other.vaultSudoKey));
  });

  it("rejects malformed secret and account-id inputs", () => {
    expect(() => deriveLegacyVaultMaterial(new Uint8Array(31), accountId)).toThrow();
    expect(() => deriveLegacyVaultMaterial(recoveryCapsuleKey, bytesToBase64url(new Uint8Array(15)))).toThrow();
  });
});
