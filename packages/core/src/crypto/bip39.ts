/**
 * BIP-39 English mnemonic encoding for the BitLogin recovery phrase (§10, §11.1, §11.5).
 * This is a BitLogin recovery phrase, not a Bitcoin wallet seed (§10.2) — it is never
 * used with NIP-06 derivation (§10.4), and the MVP never exposes a BIP-39 passphrase (§10.3).
 */
import { wordlist } from "@scure/bip39/wordlists/english";
import { entropyToMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";

export const RECOVERY_PHRASE_WORD_COUNT = 12;
export const RECOVERY_PHRASE_ENTROPY_BITS = 128;

/** Encodes 128 bits of caller-supplied secure randomness as a 12-word English mnemonic (§15.2). */
export function entropyToRecoveryPhrase(entropy: Uint8Array): string {
  if (entropy.length !== 16) {
    throw new Error("Recovery phrase entropy must be exactly 128 bits (16 bytes).");
  }
  return entropyToMnemonic(entropy, wordlist);
}

export function isValidRecoveryPhrase(phrase: string): boolean {
  try {
    return validateMnemonic(normalizePhrase(phrase), wordlist);
  } catch {
    return false;
  }
}

/** NFKD-normalizes and collapses whitespace per BIP-39 phrase handling (§17.1). */
export function normalizePhrase(phrase: string): string {
  return phrase.trim().normalize("NFKD").split(/\s+/u).join(" ");
}

/**
 * BIP-39 seed via PBKDF2-HMAC-SHA512 with an empty BIP-39 passphrase (§11.5).
 * The optional BIP-39 passphrase feature is deliberately never exposed (§10.3).
 */
export async function recoveryPhraseToSeed(phrase: string): Promise<Uint8Array> {
  return mnemonicToSeed(normalizePhrase(phrase), "");
}

export function englishWordlist(): readonly string[] {
  return wordlist;
}
