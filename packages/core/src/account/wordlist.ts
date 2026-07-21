/** EFF long Diceware wordlist (7776 words, ~12.9 bits/word) used for generated passphrases (§9.2). */
import effDiceMap from "diceware-wordlist-en-eff";

const EFF_LONG_WORDLIST: readonly string[] = Object.keys(effDiceMap)
  .sort()
  .map((key) => effDiceMap[key]!);

if (EFF_LONG_WORDLIST.length !== 7776) {
  throw new Error(`EFF long wordlist must contain 7776 entries, found ${EFF_LONG_WORDLIST.length}.`);
}

export function effLongWordlist(): readonly string[] {
  return EFF_LONG_WORDLIST;
}

export const EFF_WORDLIST_BITS_PER_WORD = Math.log2(EFF_LONG_WORDLIST.length);
