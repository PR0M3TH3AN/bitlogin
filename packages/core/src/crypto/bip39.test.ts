import { describe, expect, it } from "vitest";
import { entropyToRecoveryPhrase, isValidRecoveryPhrase, normalizePhrase, recoveryPhraseToSeed } from "./bip39.js";

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

describe("a recovery phrase as a person types it", () => {
  const phrase = entropyToRecoveryPhrase(new Uint8Array(16).fill(7));

  it("is the same phrase with capitals, with extra spaces, and across lines", async () => {
    const seed = hex(await recoveryPhraseToSeed(phrase));
    const typed = [
      phrase.toUpperCase(),
      // A phone capitalises the first word of a field.
      phrase[0]!.toUpperCase() + phrase.slice(1),
      `  ${phrase.replace(/ /gu, "   ")}  `,
      phrase.replace(/ /gu, "\n"),
      phrase.replace(/ /gu, "\t")
    ];
    for (const as of typed) {
      expect(normalizePhrase(as), as).toBe(phrase);
      expect(isValidRecoveryPhrase(as), as).toBe(true);
      expect(hex(await recoveryPhraseToSeed(as)), as).toBe(seed);
    }
  });

  it("is still refused when a word is wrong, missing or out of order", () => {
    const words = phrase.split(" ");
    expect(isValidRecoveryPhrase(words.slice(0, 11).join(" "))).toBe(false);
    expect(isValidRecoveryPhrase([...words.slice(0, 11), "zzzz"].join(" "))).toBe(false);
    expect(isValidRecoveryPhrase([words[1], words[0], ...words.slice(2)].join(" "))).toBe(words[0] === words[1]);
    expect(isValidRecoveryPhrase("")).toBe(false);
  });
});
