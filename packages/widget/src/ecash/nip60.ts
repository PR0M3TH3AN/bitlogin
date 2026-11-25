/**
 * An ecash wallet kept with the account (NIP-60; docs/ecash.md): what its
 * records say, read and written. Nothing here touches a key, a relay or a
 * mint. Whoever can read a token can spend it, so every record is sealed to
 * the account's own key by the worker before it leaves it.
 */
import { laneEnd, laneStart, validLane } from "./seedLanes.js";

export const WALLET_KIND = 17375;
export const TOKEN_KIND = 7375;
export const HISTORY_KIND = 7376;

/** The only unit this wallet keeps. A token in another unit is left where it is, unread. */
export const ECASH_UNIT = "sat";
/** How many mints one wallet may name, and how many proofs one record may hold. */
export const ECASH_LIMITS = {
  mints: 5,
  proofsPerToken: 500,
  tokens: 500,
  /**
   * How many proofs this wallet writes into one token record. Kept small so that a record is well under the
   * 64 KB an ordinary NIP-44 message may hold, and under what relays take: another NIP-60 wallet can read it.
   */
  proofsWritten: 100
} as const;

export interface EcashProof {
  /** The mint's keyset. */
  id: string;
  amount: number;
  secret: string;
  /** The mint's signature on the secret. */
  C: string;
}

/** One token record as a relay holds it: its event's id, and what is in it. */
export interface EcashToken {
  event: string;
  mint: string;
  proofs: EcashProof[];
}

const HEX = /^[0-9a-f]+$/u;
const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * A mint's address as it is kept: https (plain http only on this machine, for
 * a mint under test), no name or password in it, no query, no trailing slash.
 * "" for anything else.
 */
export function cleanMint(input: unknown): string {
  if (typeof input !== "string" || input.length > 200) return "";
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return "";
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "";
  if (u.username || u.password || u.search || u.hash) return "";
  return `${u.origin}${u.pathname.replace(/\/+$/u, "")}`;
}

export function cleanProof(input: unknown): EcashProof | null {
  if (!input || typeof input !== "object") return null;
  const p = input as Record<string, unknown>;
  if (typeof p.id !== "string" || p.id.length < 2 || p.id.length > 66 || !HEX.test(p.id)) return null;
  if (typeof p.amount !== "number" || !Number.isSafeInteger(p.amount) || p.amount <= 0) return null;
  if (typeof p.secret !== "string" || p.secret.length === 0 || p.secret.length > 2048) return null;
  if (typeof p.C !== "string" || p.C.length !== 66 || !HEX.test(p.C)) return null;
  return { id: p.id, amount: p.amount, secret: p.secret, C: p.C };
}

/** Every proof, or null: a record with one proof that does not read is not kept in part. */
export function cleanProofs(input: unknown, most: number = ECASH_LIMITS.proofsPerToken): EcashProof[] | null {
  if (!Array.isArray(input) || input.length > most) return null;
  const out: EcashProof[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const proof = cleanProof(item);
    if (!proof || seen.has(proof.secret)) return null;
    seen.add(proof.secret);
    out.push(proof);
  }
  return out;
}

export const sumProofs = (proofs: readonly Pick<EcashProof, "amount">[]): number => proofs.reduce((sum, proof) => sum + proof.amount, 0);

// ---- The wallet record (kind 17375): which mints, and a key of the wallet's own.

/**
 * A mint keyset's trial (docs/ecash-seed-counter.md, rule 4): whether it refused an output it had signed before. Kept
 * in the wallet record as a row of BitLogin's own, which another NIP-60 wallet leaves alone, so one press decides it
 * for every device. Only a keyset that "passed" is used with the seed.
 */
export interface EcashTrial {
  mint: string;
  keysetId: string;
  outcome: "passed" | "failed";
  /** When, in seconds since 1970. */
  at: number;
}
const TRIAL_ROW = "bitlogin-trial";

/**
 * How far this account has gone in one lane of a mint keyset (docs/ecash-seed-counter.md, rule 3): one past the
 * highest counter used. Kept in the wallet record so restore on another device follows a lane at least that far, gaps
 * and all. Only ever up: two records are joined by taking the higher.
 */
export interface EcashCounter {
  keysetId: string;
  lane: number;
  next: number;
}
const COUNTER_ROW = "bitlogin-counter";
const COUNTERS_KEPT = 200;
/** Two lists of counters as one: the higher for each keyset and lane. */
export function withCounters(...lists: (readonly EcashCounter[] | undefined)[]): EcashCounter[] {
  const by = new Map<string, EcashCounter>();
  for (const c of lists.flatMap((l) => l ?? [])) {
    const key = `${c.keysetId}:${c.lane}`;
    if ((by.get(key)?.next ?? 0) < c.next) by.set(key, { keysetId: c.keysetId, lane: c.lane, next: c.next });
  }
  return [...by.values()].slice(-COUNTERS_KEPT);
}
/** Two lists of trials as one: the newer for each mint and keyset. */
export function withTrials(...lists: (readonly EcashTrial[] | undefined)[]): EcashTrial[] {
  let out: EcashTrial[] = [];
  for (const t of lists.flatMap((l) => l ?? [])) {
    const older = out.find((o) => o.mint === t.mint && o.keysetId === t.keysetId);
    if (!older || older.at < t.at) out = withTrial(out, t);
  }
  return out;
}
const KEYSET = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/u;

export interface EcashWallet {
  /** A key used only to unlock ecash locked to this wallet (NIP-61). Never the account's key. */
  privkey: string;
  mints: string[];
  /** Trials of mints' keysets, newest kept for each. Absent where none was made. */
  trials?: EcashTrial[];
  /** How far each lane of each keyset has gone. Absent where nothing was added by the seed. */
  counters?: EcashCounter[];
}

export function writeWallet(wallet: EcashWallet): string {
  return JSON.stringify([
    ["privkey", wallet.privkey],
    ...wallet.mints.map((mint) => ["mint", mint]),
    ...(wallet.trials ?? []).map((t) => [TRIAL_ROW, t.mint, t.keysetId, t.outcome, String(t.at)]),
    ...(wallet.counters ?? []).map((c) => [COUNTER_ROW, c.keysetId, String(c.lane), String(c.next)])
  ]);
}

/** A trial as a row says it, or null. */
function readTrial(row: unknown[]): EcashTrial | null {
  const [, mint, keysetId, outcome, at] = row;
  const clean = cleanMint(mint);
  const when = Number(at);
  if (!clean || typeof keysetId !== "string" || !KEYSET.test(keysetId) || (outcome !== "passed" && outcome !== "failed") || !Number.isSafeInteger(when) || when <= 0) return null;
  return { mint: clean, keysetId, outcome, at: when };
}

/** Add a trial, replacing an older one for the same mint and keyset. */
export function withTrial(trials: readonly EcashTrial[] | undefined, trial: EcashTrial): EcashTrial[] {
  const others = (trials ?? []).filter((t) => !(t.mint === trial.mint && t.keysetId === trial.keysetId));
  return [...others, trial].slice(-50);
}

export function readWallet(text: string): EcashWallet | null {
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  let privkey = "";
  const mints: string[] = [];
  let trials: EcashTrial[] = [];
  let counters: EcashCounter[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== "string") continue;
    if (row[0] === "privkey" && typeof row[1] === "string" && HEX64.test(row[1])) privkey ||= row[1];
    if (row[0] === "mint" && cleanMint(row[1]) && !mints.includes(cleanMint(row[1])) && mints.length < ECASH_LIMITS.mints) mints.push(cleanMint(row[1]));
    if (row[0] === COUNTER_ROW) {
      const [, keysetId, lane, next] = row;
      const c = { keysetId, lane: Number(lane), next: Number(next) };
      if (typeof keysetId === "string" && KEYSET.test(keysetId) && validLane(c.lane) && Number.isSafeInteger(c.next) && c.next >= laneStart(c.lane) && c.next <= laneEnd(c.lane) + 1) counters = withCounters(counters, [c as EcashCounter]);
    }
    if (row[0] === TRIAL_ROW) {
      const trial = readTrial(row);
      if (trial) {
        const older = trials.find((t) => t.mint === trial.mint && t.keysetId === trial.keysetId);
        if (!older || older.at < trial.at) trials = withTrial(trials, trial);
      }
    }
  }
  return privkey ? { privkey, mints, ...(trials.length ? { trials } : {}), ...(counters.length ? { counters } : {}) } : null;
}

// ---- A token record (kind 7375): proofs at one mint, and the records it replaced.

export function writeToken(token: { mint: string; proofs: readonly EcashProof[]; del?: readonly string[] }): string {
  return JSON.stringify({ mint: token.mint, unit: ECASH_UNIT, proofs: token.proofs.map(({ id, amount, secret, C }) => ({ id, amount, secret, C })), ...(token.del?.length ? { del: [...token.del] } : {}) });
}

/** What a token record holds, or null where it is not one this wallet reads (another unit, or malformed). */
export function readToken(text: string): { mint: string; proofs: EcashProof[]; del: string[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const t = parsed as Record<string, unknown>;
  const mint = cleanMint(t.mint);
  const proofs = cleanProofs(t.proofs);
  if (!mint || !proofs || (t.unit !== undefined && t.unit !== ECASH_UNIT)) return null;
  const del = Array.isArray(t.del) ? t.del.filter((id): id is string => typeof id === "string" && HEX64.test(id)).slice(0, 200) : [];
  return { mint, proofs, del };
}

/**
 * The token records that still count: not replaced by a newer one (`del`),
 * not deleted, and holding no proof an earlier-kept record already holds. A
 * relay that never honoured a deletion can't bring spent ecash back.
 */
export function liveTokens(records: readonly { event: string; created_at: number; mint: string; proofs: EcashProof[]; del: string[] }[], deleted: ReadonlySet<string>): EcashToken[] {
  const replaced = new Set(records.flatMap((record) => record.del));
  const seen = new Set<string>();
  const out: EcashToken[] = [];
  // Newest first: where two records hold the same proof, the newer is the one a client last wrote.
  for (const record of [...records].sort((a, b) => b.created_at - a.created_at || a.event.localeCompare(b.event))) {
    if (replaced.has(record.event) || deleted.has(record.event)) continue;
    const proofs = record.proofs.filter((proof) => !seen.has(proof.secret));
    for (const proof of proofs) seen.add(proof.secret);
    if (proofs.length && out.length < ECASH_LIMITS.tokens) out.push({ event: record.event, mint: record.mint, proofs });
  }
  return out;
}

/** What the wallet holds at each mint, in sats. */
export function balances(tokens: readonly EcashToken[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const token of tokens) out[token.mint] = (out[token.mint] ?? 0) + sumProofs(token.proofs);
  return out;
}

// ---- A line of history (kind 7376): informational only.

export function writeHistory(entry: { direction: "in" | "out"; amount: number; created?: readonly string[]; destroyed?: readonly string[] }): string {
  return JSON.stringify([
    ["direction", entry.direction],
    ["amount", String(entry.amount)],
    ["unit", ECASH_UNIT],
    ...(entry.created ?? []).map((id) => ["e", id, "", "created"]),
    ...(entry.destroyed ?? []).map((id) => ["e", id, "", "destroyed"])
  ]);
}

/** A Lightning invoice as it may be passed on: the bolt11 form, lower case, and no longer than one could be. */
export const cleanInvoice = (input: unknown): string => {
  if (typeof input !== "string") return "";
  const invoice = input.trim().toLowerCase().replace(/^lightning:/u, "");
  return invoice.length <= 2000 && /^ln(bc|tb|tbs|bcrt)[0-9a-z]+$/u.test(invoice) ? invoice : "";
};
