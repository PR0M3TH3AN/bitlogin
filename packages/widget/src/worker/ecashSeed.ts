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
import * as cashu from "@cashu/cashu-ts";
import { Amount, blindMessage, deriveBlindingFactor, deriveSecret, OutputData, type Proof } from "@cashu/cashu-ts";

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
 * One counter's secret (as the text the mint sees) and blinding factor, from a deriver made once per keyset: the
 * keyset's part of the path is worked out once, not for every counter (2026-11-25: twice as fast). The same values as
 * the library's own `OutputData.createSingleDeterministicData`, which the tests hold it to.
 */
type Deriver = (counter: number) => { secret: Uint8Array; blindingFactor: Uint8Array };
/**
 * The library's deriver for a keyset, where this version has it (it is not in its published types, so it may go);
 * otherwise its public per-counter functions, slower and the same.
 */
const internal = (cashu as unknown as { createSecretAndBlindingFactorDeriver?: (seed: Uint8Array, keysetId: string) => Deriver }).createSecretAndBlindingFactorDeriver;
function createSecretAndBlindingFactorDeriver(seed: Uint8Array, keysetId: string): Deriver {
  if (typeof internal === "function") return internal(seed, keysetId);
  return (counter) => ({ secret: deriveSecret(seed, keysetId, counter), blindingFactor: deriveBlindingFactor(seed, keysetId, counter) });
}
function at(derive: Deriver, counter: number): { secret: Uint8Array; r: bigint; B_: string } {
  const made = derive(counter);
  const secret = new TextEncoder().encode(toHex(made.secret));
  const { r, B_ } = blindMessage(secret, BigInt(`0x${toHex(made.blindingFactor)}`));
  return { secret, r, B_: B_.toHex(true) };
}
const checkKeyset = (keysetId: unknown): string => {
  if (typeof keysetId !== "string" || !KEYSET.test(keysetId)) throw new Error("That is not a keyset id.");
  return keysetId;
};

/** One counter's blinded message, as a mint is asked about it: nothing that unblinds it. */
export interface BlindedAt {
  counter: number;
  id: string;
  B_: string;
}

/**
 * The blinded messages at `count` counters from `from`: what restore and the check before use (rule 5) ask a mint.
 * Without the secret and blinding factor, a signature the mint hands back for one is of no use to anyone but the
 * worker, so these may be asked for at any counter. A counter that can't be made is left out.
 */
export function seededBlinded(seed: Uint8Array, keysetId: unknown, from: unknown, count: unknown): BlindedAt[] {
  const id = checkKeyset(keysetId);
  if (!Number.isSafeInteger(count) || (count as number) < 1 || (count as number) > 200) throw new Error("Between one and two hundred at a time.");
  if (!Number.isSafeInteger(from) || (from as number) < 1 || (from as number) + (count as number) > COUNTER_LIMIT) throw new Error("That counter is out of range.");
  const derive = createSecretAndBlindingFactorDeriver(seed, id);
  const out: BlindedAt[] = [];
  for (let c = from as number; c < (from as number) + (count as number); c++) {
    try {
      out.push({ counter: c, id, B_: at(derive, c).B_ });
    } catch {
      /* a counter the library steps over */
    }
  }
  return out;
}

/** A signature a mint handed back for one of this seed's counters. */
export interface FoundAt {
  counter: number;
  amount: number;
  C_: string;
}

/**
 * The proofs for signatures a mint handed back (restore), unblinded here: the page gets finished proofs, which it
 * would hold anyway, and never the secret or blinding factor of a counter. A signature that isn't the mint's for that
 * counter's blinded message gives a proof the mint won't take, and nothing else.
 */
export function seededUnblind(seed: Uint8Array, keysetId: unknown, keys: unknown, found: unknown): Proof[] {
  const id = checkKeyset(keysetId);
  if (!keys || typeof keys !== "object") throw new Error("Those are not a keyset's keys.");
  if (!Array.isArray(found) || found.length > 1000) throw new Error("At most a thousand at a time.");
  const derive = createSecretAndBlindingFactorDeriver(seed, id);
  const keyset = { id, keys: keys as Record<string, string> };
  return (found as FoundAt[]).map((f) => {
    if (!Number.isSafeInteger(f?.counter) || f.counter < 1 || f.counter >= COUNTER_LIMIT || !Number.isSafeInteger(f.amount) || f.amount < 1 || typeof f.C_ !== "string") throw new Error("That is not a signature for a counter.");
    const made = at(derive, f.counter);
    return new OutputData({ amount: Amount.from(f.amount), id, B_: made.B_ }, made.r, made.secret).toProof({ id, amount: Amount.from(f.amount), C_: f.C_ }, keyset as never);
  });
}

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
  const derive = createSecretAndBlindingFactorDeriver(seed, keysetId);
  let counter = from as number;
  for (const amount of amounts as number[]) {
    for (;;) {
      const c = counter++;
      try {
        const made = at(derive, c);
        outputs.push({ amount, id: keysetId, B_: made.B_, blindingFactor: made.r.toString(16).padStart(64, "0"), secret: toHex(made.secret), counter: c });
        break;
      } catch (err) {
        if (counter - (from as number) > amounts.length * 2) throw err;
      }
    }
  }
  return { outputs, next: counter };
}
