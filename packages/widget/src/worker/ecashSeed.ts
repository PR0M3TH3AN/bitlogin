/**
 * The wallet's seed, and the outputs made from it (docs/ecash-seed-counter.md, rule 7). Runs in the crypto worker:
 * the account's key never leaves it, and neither does the seed. The wallet's page asks for the outputs of one
 * operation (its keyset, the amounts, the counters reserved for it) and is handed those outputs alone: each one's
 * blinded message, blinding factor and secret, which it would hold as proofs anyway.
 *
 * The outputs are the Cashu library's own deterministic ones (NUT-13), so a mint's restore (NUT-09) finds them, from
 * the same seed, in any wallet that makes them the same way.
 */
import { hkdfExpand, hkdfExtract, labelSalt } from "@bitlogin/core/crypto";
import { OutputData } from "@cashu/cashu-ts";

/** The label the seed is made under. Used for nothing else, so the seed can't equal anything else made from the key. */
export const ECASH_SEED_LABEL = "bitlogin/ecash-seed/v1";
/** The HKDF info, naming what the seed is for. */
export const ECASH_SEED_INFO = "nut13";

/** seed = HKDF-SHA256(ikm = the account's key, salt = SHA-256(label), info = "nut13"), 64 bytes. */
export function ecashSeed(accountKey: Uint8Array): Uint8Array {
  if (!(accountKey instanceof Uint8Array) || accountKey.length !== 32) throw new Error("An account key is 32 bytes.");
  return hkdfExpand(hkdfExtract(labelSalt(ECASH_SEED_LABEL), accountKey), ECASH_SEED_INFO, 64);
}

/** One output, as the page is handed it: nothing of the seed. */
export interface SeededOutput {
  amount: number;
  /** The keyset it is for. */
  id: string;
  /** The blinded message the mint signs. */
  B_: string;
  /** Hex. */
  blindingFactor: string;
  /** Hex: the bytes of the secret. */
  secret: string;
  /** The counter it was made at. */
  counter: number;
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const KEYSET = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/u;
/** Older keysets take the counter as a hardened BIP32 index: it must stay below 2³¹. */
export const COUNTER_LIMIT = 2 ** 31 - 1;

/**
 * The outputs for `amounts`, one counter each from `from` on. A counter whose blinding factor would be out of range is
 * stepped over, as the library asks, and burned. Returns the outputs and the next counter not used.
 */
export function seededOutputs(seed: Uint8Array, keysetId: unknown, amounts: unknown, from: unknown): { outputs: SeededOutput[]; next: number } {
  if (typeof keysetId !== "string" || !KEYSET.test(keysetId)) throw new Error("That is not a keyset id.");
  if (!Array.isArray(amounts) || amounts.length === 0 || amounts.length > 100) throw new Error("Between one and a hundred outputs.");
  if (!amounts.every((a) => Number.isSafeInteger(a) && a > 0 && a <= 2 ** 30)) throw new Error("Each output is a whole number of sats.");
  if (!Number.isSafeInteger(from) || (from as number) < 1 || (from as number) + amounts.length * 2 > COUNTER_LIMIT) throw new Error("That counter is out of range.");
  const outputs: SeededOutput[] = [];
  let counter = from as number;
  for (const amount of amounts as number[]) {
    for (;;) {
      const at = counter++;
      try {
        const data = OutputData.createSingleDeterministicData(amount, seed, at, keysetId);
        outputs.push({
          amount,
          id: keysetId,
          B_: data.blindedMessage.B_,
          blindingFactor: data.blindingFactor.toString(16).padStart(64, "0"),
          secret: toHex(data.secret),
          counter: at
        });
        break;
      } catch (err) {
        if (counter - (from as number) > amounts.length * 2) throw err;
      }
    }
  }
  return { outputs, next: counter };
}
