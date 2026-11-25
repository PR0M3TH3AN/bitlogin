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
import { Amount, blindMessage, deriveBlindingFactor, deriveKeysetId, deriveSecret, OutputData, pointFromHex, verifyDLEQProof, type Proof } from "@cashu/cashu-ts";

/** The label the seed is made under. Used for nothing else, so the seed can't equal anything else made from the key. */
export const ECASH_SEED_LABEL = "bitlogin/ecash-seed/v1";
/** The HKDF info, naming what the seed is for. */
export const ECASH_SEED_INFO = "nut13";

/** seed = HKDF-SHA256(ikm = the account's key, salt = SHA-256(label), info = "nut13"), 64 bytes. */
export function ecashSeed(accountKey: Uint8Array): Uint8Array {
  if (!(accountKey instanceof Uint8Array) || accountKey.length !== 32) throw new Error("An account key is 32 bytes.");
  return hkdfExpand(hkdfExtract(labelSalt(ECASH_SEED_LABEL), accountKey), ECASH_SEED_INFO, 64);
}

/**
 * One output as the page is handed it for an operation (2026-11-25, the third review): its blinded message only. The
 * secret and blinding factor stay in the worker until the mint has signed it, and come out only inside the finished
 * proof (seededUnblind). A script that ran once on the page could otherwise keep them, and take what the mint signs
 * there later.
 */
export interface ReservedOutput {
  amount: number;
  id: string;
  B_: string;
  counter: number;
}
/** One output, with what unblinds it: made and kept in the worker. */
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

/** A signature a mint handed back for one of this seed's counters, with the mint's proof that it made it (NUT-12). */
export interface FoundAt {
  counter: number;
  amount: number;
  C_: string;
  dleq?: { e: string; s: string };
}

/** A keyset as the mint lists it: its keys, and what its id is made from besides them. */
export interface KeysetGiven {
  keys: Record<string, string>;
  unit?: string;
  input_fee_ppk?: number;
  final_expiry?: number;
}

const bytes = (h: string): Uint8Array => {
  if (!/^(?:[0-9a-f]{2})+$/u.test(h)) throw new Error("That is not hex.");
  return new Uint8Array(h.match(/../gu)!.map((x) => parseInt(x, 16)));
};
/**
 * The keys handed over are this keyset's own: the id worked out from them (and, for the newer ids, from the unit, fee
 * and expiry they are listed with) must be the keyset id asked about. Otherwise a key of the page's own, passed as the
 * mint's, would have its own proofs taken as the mint's.
 */
function checkKeys(keysetId: string, given: KeysetGiven): Record<string, string> {
  const keys = given?.keys;
  if (!keys || typeof keys !== "object" || Object.keys(keys).length === 0 || Object.keys(keys).length > 64) throw new Error("Those are not a keyset's keys.");
  const made = keysetId.startsWith("00")
    ? deriveKeysetId(keys as never, { versionByte: 0 })
    : deriveKeysetId(keys as never, { versionByte: 1, unit: given.unit ?? "sat", ...(given.input_fee_ppk ? { input_fee_ppk: given.input_fee_ppk } : {}), ...(given.final_expiry ? { expiry: given.final_expiry } : {}) });
  if (made !== keysetId) throw new Error("Those keys are not this keyset's.");
  return keys;
}

/**
 * The proofs for signatures a mint handed back (restore), unblinded here: the page gets finished proofs, which it
 * would hold anyway, and never the secret or blinding factor of a counter.
 *
 * Only a signature the mint proved it made (2026-11-25, the review's second finding 1): each must carry a DLEQ proof
 * (NUT-12) that it is the mint's key times this counter's blinded message, checked here against keys that make this
 * keyset's id. Without that, a page could pass a point of its own choosing and be handed r·K back, enough to take, later,
 * whatever the mint signs at that counter. A mint whose restore gives no proofs is not restored from at all.
 */
export function seededUnblind(seed: Uint8Array, keysetId: unknown, keyset: unknown, found: unknown, unproved: ReadonlySet<number> = new Set()): Proof[] {
  const id = checkKeyset(keysetId);
  const keys = checkKeys(id, keyset as KeysetGiven);
  if (!Array.isArray(found) || found.length > 1000) throw new Error("At most a thousand at a time.");
  const derive = createSecretAndBlindingFactorDeriver(seed, id);
  const given = { id, keys };
  return (found as FoundAt[]).map((f) => {
    if (!Number.isSafeInteger(f?.counter) || f.counter < 1 || f.counter >= COUNTER_LIMIT || !Number.isSafeInteger(f.amount) || f.amount < 1 || typeof f.C_ !== "string") throw new Error("That is not a signature for a counter.");
    const key = keys[String(f.amount)];
    if (typeof key !== "string") throw new Error("This keyset has no key for that amount.");
    const made = at(derive, f.counter);
    // Without a proof only for a counter this worker reserved moments ago for the operation now being finished
    // (ecashLanes.ts): a mint's lapse doesn't strand a paid invoice, and no earlier script could have it.
    const proved = typeof f.dleq?.e === "string" && typeof f.dleq?.s === "string";
    if (!proved && unproved.has(f.counter)) return new OutputData({ amount: Amount.from(f.amount), id, B_: made.B_ }, made.r, made.secret).toProof({ id, amount: Amount.from(f.amount), C_: f.C_ }, given as never);
    if (!proved) throw Object.assign(new Error("This mint doesn't prove what it signs."), { code: "no-dleq" });
    if (!verifyDLEQProof({ e: bytes(f.dleq!.e), s: bytes(f.dleq!.s) }, pointFromHex(made.B_), pointFromHex(f.C_), pointFromHex(key))) throw new Error("That signature isn't proved to be the mint's.");
    return new OutputData({ amount: Amount.from(f.amount), id, B_: made.B_ }, made.r, made.secret).toProof({ id, amount: Amount.from(f.amount), C_: f.C_ }, given as never);
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
