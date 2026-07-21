/**
 * Generated credentials only — manual passwords are prohibited in the alpha (§9.3).
 * Default is a six-word passphrase from the EFF long wordlist (~77 bits, §9.2, §11.2).
 */
import { randomUniformInt } from "../crypto/random.js";
import { effLongWordlist, EFF_WORDLIST_BITS_PER_WORD } from "./wordlist.js";

export const DEFAULT_PASSPHRASE_WORD_COUNT = 6;
const MIN_ENTROPY_BITS = 64;

const CHAR_PASSWORD_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+";

export interface GeneratedCredential {
  kind: "passphrase" | "characters";
  secret: string;
  entropyBits: number;
}

/** Default generated credential: a multiword passphrase, memorable and suitable as a roaming secret (§9.2). */
export function generatePassphrase(wordCount = DEFAULT_PASSPHRASE_WORD_COUNT): GeneratedCredential {
  const words = effLongWordlist();
  const chosen: string[] = [];
  for (let i = 0; i < wordCount; i++) {
    chosen.push(words[randomUniformInt(words.length)]!);
  }
  const entropyBits = wordCount * EFF_WORDLIST_BITS_PER_WORD;
  if (entropyBits < MIN_ENTROPY_BITS) {
    throw new Error(`Passphrase of ${wordCount} words provides only ~${entropyBits.toFixed(1)} bits; must exceed ${MIN_ENTROPY_BITS}.`);
  }
  return { kind: "passphrase", secret: chosen.join(" "), entropyBits };
}

/** Offered for users who rely on a password manager rather than a memorable passphrase (§9.2). */
export function generateCharacterPassword(length = 20): GeneratedCredential {
  const alphabet = CHAR_PASSWORD_ALPHABET;
  let secret = "";
  for (let i = 0; i < length; i++) {
    secret += alphabet[randomUniformInt(alphabet.length)];
  }
  const entropyBits = length * Math.log2(alphabet.length);
  if (entropyBits < MIN_ENTROPY_BITS) {
    throw new Error(`Character password of length ${length} provides only ~${entropyBits.toFixed(1)} bits; must exceed ${MIN_ENTROPY_BITS}.`);
  }
  return { kind: "characters", secret, entropyBits };
}
