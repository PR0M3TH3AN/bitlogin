/**
 * Optional manual password support (§9.3). The alpha's default and
 * recommendation is a generated credential (§9.2); a user may opt into
 * typing their own, gated by a hard minimum-entropy estimate, a small
 * known-weak-pattern check, and an explicit warning that offline guessing
 * against a downloaded capsule cannot be prevented by any client-side check
 * (§9.1). This is an alpha-grade heuristic, not a breach-database lookup —
 * BitLogin is static and makes no third-party network calls, so it cannot
 * check against HaveIBeenPwned-style corpora. A production release should
 * use a proper strength estimator (e.g. zxcvbn) and/or a bundled breach list.
 */

export const MANUAL_PASSWORD_MIN_ENTROPY_BITS = 64;
export const MANUAL_PASSWORD_MIN_LENGTH = 12;

const COMMON_WEAK_PASSWORDS = new Set([
  "password", "password1", "password123", "123456", "123456789", "12345678",
  "qwerty", "qwerty123", "letmein", "welcome", "monkey", "dragon", "master",
  "abc123", "iloveyou", "admin", "login", "starwars", "sunshine", "princess",
  "football", "baseball", "trustno1", "000000", "111111", "123123", "1234567890",
  "changeme", "passw0rd", "correcthorsebatterystaple"
]);

export interface ManualPasswordCheck {
  ok: boolean;
  entropyBits: number;
  reason?: string;
}

function characterClassAlphabetSize(password: string): number {
  let size = 0;
  if (/[a-z]/u.test(password)) size += 26;
  if (/[A-Z]/u.test(password)) size += 26;
  if (/[0-9]/u.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/u.test(password)) size += 33; // common printable symbols
  return size || 1;
}

/**
 * A conservative, dependency-free entropy estimate: character-class alphabet
 * size times length. This deliberately under-credits patterned passwords
 * rather than over-trusts them, but it cannot detect every weak pattern —
 * it is combined with the blocklist and structural checks below.
 */
export function estimatePasswordEntropyBits(password: string): number {
  return password.length * Math.log2(characterClassAlphabetSize(password));
}

function hasLowVarietyPattern(password: string): boolean {
  if (/^(.)\1*$/u.test(password)) return true; // all one character
  if (/(.)\1{2,}/u.test(password)) return true; // 3+ repeated character run
  const lower = password.toLowerCase();
  const sequences = ["0123456789", "abcdefghijklmnopqrstuvwxyz"];
  for (const seq of sequences) {
    for (let i = 0; i + 4 <= seq.length; i++) {
      const forward = seq.slice(i, i + 4);
      const backward = [...forward].reverse().join("");
      if (lower.includes(forward) || lower.includes(backward)) return true;
    }
  }
  return false;
}

/** Validates a user-chosen password against the alpha's manual-password floor (§9.3). */
export function checkManualPassword(password: string, normalizedLoginName: string): ManualPasswordCheck {
  const entropyBits = estimatePasswordEntropyBits(password);

  if (password.length < MANUAL_PASSWORD_MIN_LENGTH) {
    return { ok: false, entropyBits, reason: `Must be at least ${MANUAL_PASSWORD_MIN_LENGTH} characters.` };
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, entropyBits, reason: "This is on a list of extremely common passwords." };
  }
  if (normalizedLoginName.length >= 3 && password.toLowerCase().includes(normalizedLoginName)) {
    return { ok: false, entropyBits, reason: "Must not contain your login name." };
  }
  if (hasLowVarietyPattern(password)) {
    return { ok: false, entropyBits, reason: "Too predictable (repeated characters or a simple sequence)." };
  }
  if (entropyBits < MANUAL_PASSWORD_MIN_ENTROPY_BITS) {
    return {
      ok: false,
      entropyBits,
      reason: `Estimated entropy (~${entropyBits.toFixed(0)} bits) is below the required ${MANUAL_PASSWORD_MIN_ENTROPY_BITS}. Use a longer password or mix character types.`
    };
  }
  return { ok: true, entropyBits };
}
