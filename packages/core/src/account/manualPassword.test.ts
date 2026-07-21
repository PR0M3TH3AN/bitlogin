import { describe, expect, it } from "vitest";
import { checkManualPassword, estimatePasswordEntropyBits } from "./manualPassword.js";

describe("checkManualPassword (§9.3)", () => {
  it("rejects passwords shorter than the minimum length", () => {
    expect(checkManualPassword("Sh0rt!", "adam").ok).toBe(false);
  });

  it("rejects common weak passwords", () => {
    expect(checkManualPassword("password123", "adam").ok).toBe(false);
    expect(checkManualPassword("correcthorsebatterystaple", "adam").ok).toBe(false);
  });

  it("rejects a password containing the login name", () => {
    expect(checkManualPassword("adamsSuperSecret1!", "adam").ok).toBe(false);
  });

  it("rejects repeated-character and sequence patterns", () => {
    expect(checkManualPassword("aaaaaaaaaaaaaaaa", "user").ok).toBe(false);
    expect(checkManualPassword("abcdabcdabcdabcd", "user").ok).toBe(false);
    expect(checkManualPassword("12345678901234", "user").ok).toBe(false);
  });

  it("rejects passwords below the entropy floor even if structurally fine", () => {
    // 12 lowercase letters ~= 12 * log2(26) ~= 56 bits, below the 64-bit floor.
    expect(checkManualPassword("qwertyuiopzx", "user").ok).toBe(false);
  });

  it("accepts a sufficiently long, varied, non-blocklisted password", () => {
    const result = checkManualPassword("Tr0mbone$Xylophone#42", "user");
    expect(result.ok).toBe(true);
    expect(result.entropyBits).toBeGreaterThanOrEqual(64);
  });

  it("estimates higher entropy for a longer, more varied password", () => {
    const short = estimatePasswordEntropyBits("abcdefgh");
    const long = estimatePasswordEntropyBits("abcdefghijklmnop123!@#");
    expect(long).toBeGreaterThan(short);
  });
});
