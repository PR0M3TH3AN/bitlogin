/**
 * The sign-in address's own record of the sites it allowed from this
 * browser (docs/sign-in-window.md §SW18): which site, as which account,
 * when, until when, and for what.
 *
 * It is a record and nothing more. It holds no key. It is not what lets a
 * site sign: that is the grant the embedded signer keeps, in storage a
 * browser walls off by the site it is embedded in, which no page of the
 * sign-in address can see or change. So this list can say what was allowed
 * and when it ends, and cannot say how often a site signed or switch one
 * off.
 */
import { knownAppName, readPermissions, type AppPermissions } from "./permissions.js";
import { cleanOrigin } from "./policy.js";

export const ALLOWED_KEY = "bitlogin:allowed-sites:v1";
export const ALLOWED_LIMITS = {
  /** No more entries than this are kept: the oldest go first. */
  entries: 200,
  /** How long an entry is kept after it has ended, in seconds. */
  keepEndedSec: 30 * 24 * 3600
} as const;

export interface AllowedSite {
  /** The site's origin, as the browser reported it to the signer. */
  site: string;
  /** The account it was allowed as: a public key, hex. */
  pubkey: string;
  /** When Allow was pressed, in seconds. */
  at: number;
  /** When it ends at the latest, in seconds. */
  until: number;
  /** Kept across page loads (thirty days), or for one visit. */
  remembered: boolean;
  /** For an application: what it was approved for. Absent for a site that declared nothing. */
  wants?: AppPermissions;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function readEntry(input: unknown): AllowedSite | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  const site = cleanOrigin(e.site);
  if (!site || site !== e.site || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return null;
  if (typeof e.at !== "number" || typeof e.until !== "number" || !Number.isFinite(e.at) || !Number.isFinite(e.until) || e.until < e.at) return null;
  const wants = e.wants === undefined ? undefined : readPermissions(e.wants);
  if (wants === null) return null;
  return { site, pubkey: e.pubkey, at: Math.floor(e.at), until: Math.floor(e.until), remembered: e.remembered === true, ...(wants ? { wants } : {}) };
}

/** The record as it was stored, read again: anything that is not an entry is dropped, and so is one long ended. Newest first. */
export function readAllowed(raw: string | null | undefined, nowSeconds: number): AllowedSite[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .slice(0, ALLOWED_LIMITS.entries * 2)
    .map(readEntry)
    .filter((entry): entry is AllowedSite => entry !== null && entry.until + ALLOWED_LIMITS.keepEndedSec > nowSeconds)
    .sort((a, b) => b.at - a.at)
    .slice(0, ALLOWED_LIMITS.entries);
}

/** Allowing a site again as the same account replaces what was there for it. */
export function addAllowed(list: readonly AllowedSite[], entry: AllowedSite): AllowedSite[] {
  const clean = readEntry(entry);
  if (!clean) return [...list];
  return [clean, ...list.filter((other) => !(other.site === clean.site && other.pubkey === clean.pubkey))].slice(0, ALLOWED_LIMITS.entries);
}

export function removeAllowed(list: readonly AllowedSite[], site: string, pubkey: string): AllowedSite[] {
  return list.filter((entry) => !(entry.site === site && entry.pubkey === pubkey));
}

/** What an entry is, in words, for the list. */
export function describeAllowed(entry: AllowedSite, nowSeconds: number): { known: string | null; ended: boolean; lasts: string } {
  const ended = entry.until <= nowSeconds;
  return {
    known: knownAppName(entry.site),
    ended,
    lasts: ended ? "Ended." : entry.remembered ? "Remembered on this device until then, unless you sign out there sooner." : "For one visit: it ended when that site's page was closed or loaded again, and by then at the latest."
  };
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const here = (): Storage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function loadAllowed(nowSeconds = Date.now() / 1000, storage: Storage | null = here()): AllowedSite[] {
  try {
    return readAllowed(storage?.getItem(ALLOWED_KEY), nowSeconds);
  } catch {
    return [];
  }
}

export function saveAllowed(list: readonly AllowedSite[], storage: Storage | null = here()): boolean {
  try {
    storage?.setItem(ALLOWED_KEY, JSON.stringify(list));
    return !!storage;
  } catch {
    return false;
  }
}

/** Write down that a site was allowed. Best-effort: Allow never fails for want of a record. */
export function recordAllowed(entry: AllowedSite, storage: Storage | null = here()): boolean {
  return saveAllowed(addAllowed(loadAllowed(entry.at, storage), entry), storage);
}
