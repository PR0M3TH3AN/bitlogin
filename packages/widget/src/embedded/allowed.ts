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
 *
 * A family of sites allowed at once (docs/site-family.md) is one entry, its
 * `site` written `https://*.domain`, with the sites it was allowed from. A
 * site of the family that signs in later by the family's grant never comes
 * back to this page, so it is not listed: the list cannot see it.
 */
import { familyDomain, inFamily, knownFamily, readFamily } from "./family.js";
import { knownAppName, mayHold, readPermissions, type AppPermissions } from "./permissions.js";
import { cleanName, cleanOrigin } from "./policy.js";

export const ALLOWED_KEY = "bitlogin:allowed-sites:v1";
export const ALLOWED_LIMITS = {
  /** No more entries than this are kept: the oldest go first. */
  entries: 200,
  /** How long an entry is kept after it has ended, in seconds. */
  keepEndedSec: 30 * 24 * 3600,
  /** After "Just this one", a family is not offered again for this long, in seconds (docs/site-family.md SF4). */
  familyDeclineSec: 30 * 24 * 3600,
  /** No more sites than this are listed under a family. */
  members: 20
} as const;

export interface AllowedSite {
  /** The site's origin, as the browser reported it to the signer: or a family, `https://*.domain`. */
  site: string;
  /** For a family: the sites of it the user allowed it from, newest first. */
  members?: string[];
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
  /**
   * What it was approved for is no longer anything a site may hold (a rule tightened since: docs/sign-in-window.md
   * §SW9.3). Its grant ended, and it is listed as ended, so the person sees that it had been allowed.
   */
  refused?: true;
  /** For a refused one: the data names it had been allowed, as kept, so the person can see what they were. */
  hadNames?: string[];
  /**
   * A headset signed in from this phone (docs/pair-a-headset.md): the id its grant carries, which "Sign out this
   * headset" names in a take-back, and the label its browser gave, as the phone showed it.
   */
  device?: string;
  deviceLabel?: string;
  /** Way 2: the headset's own key, public half, which "Sign out this headset" puts on the list of devices signed out. */
  deviceKey?: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const DEVICE = /^[0-9a-f]{32}$/u;
/** The same grant: one site, one account, and one headset or none. */
const same = (a: AllowedSite, b: AllowedSite): boolean => a.site === b.site && a.pubkey === b.pubkey && (a.device ?? "") === (b.device ?? "");

function readEntry(input: unknown): AllowedSite | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  const family = readFamily(e.site);
  const site = family || (typeof e.site === "string" && e.site.includes("*") ? "" : cleanOrigin(e.site));
  if (!site || site !== e.site || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return null;
  if (typeof e.at !== "number" || typeof e.until !== "number" || !Number.isFinite(e.at) || !Number.isFinite(e.until) || e.until < e.at) return null;
  const wants = e.wants === undefined ? undefined : readPermissions(e.wants);
  if (family && e.wants !== undefined) return null;
  // A set that no longer reads as one, or that this site may no longer hold, is not dropped from the list without a
  // word: the entry stays, as ended by BitLogin.
  const refused = wants === null || (wants !== undefined && !mayHold(site, wants));
  const had = (e.wants as { appData?: unknown } | undefined)?.appData;
  const hadNames = refused && Array.isArray(had) ? had.filter((n): n is string => typeof n === "string").map((n) => cleanName(n)).filter(Boolean).slice(0, 8) : [];
  const members = family && Array.isArray(e.members) ? [...new Set(e.members.filter((m): m is string => inFamily(m, family)))].slice(0, ALLOWED_LIMITS.members) : [];
  const device = typeof e.device === "string" && DEVICE.test(e.device) ? e.device : undefined;
  if (e.device !== undefined && !device) return null;
  const deviceKey = device && typeof e.deviceKey === "string" && HEX64.test(e.deviceKey) ? e.deviceKey : undefined;
  const label = device && typeof e.deviceLabel === "string" && e.deviceLabel.length <= 48 && /^[\p{L}\p{N} ._()-]+$/u.test(e.deviceLabel) ? e.deviceLabel : undefined;
  return { site, ...(members.length ? { members } : {}), pubkey: e.pubkey, at: Math.floor(e.at), until: Math.floor(e.until), remembered: e.remembered === true, ...(wants && !refused ? { wants } : {}), ...(refused ? { refused: true as const, ...(hadNames.length ? { hadNames } : {}) } : {}), ...(device ? { device, ...(label ? { deviceLabel: label } : {}), ...(deviceKey ? { deviceKey } : {}) } : {}) };
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

/**
 * Allowing a site again as the same account replaces what was there for it.
 * Allowing a family again keeps the sites it was allowed from before, so its
 * row still says where it came from.
 */
export function addAllowed(list: readonly AllowedSite[], entry: AllowedSite): AllowedSite[] {
  const clean = readEntry(entry);
  if (!clean) return [...list];
  const before = list.find((other) => same(other, clean));
  const merged =
    readFamily(clean.site) && before?.members ? (readEntry({ ...clean, members: [...(clean.members ?? []), ...before.members] }) ?? clean) : clean;
  return [merged, ...list.filter((other) => !same(other, clean))].slice(0, ALLOWED_LIMITS.entries);
}

/**
 * When a family may be offered (docs/site-family.md SF4): at a site of it,
 * where another site of the same family was allowed before as the same
 * account and remembered. Returns that earlier entry, the newest, to name in
 * the question; null where there is none.
 */
export function familyOffer(list: readonly AllowedSite[], site: string, family: string, pubkey: string): AllowedSite | null {
  if (!readFamily(family) || !inFamily(site, family)) return null;
  return list.find((entry) => entry.pubkey === pubkey && entry.remembered && !entry.device && entry.site !== site && inFamily(entry.site, family)) ?? null;
}

export function removeAllowed(list: readonly AllowedSite[], site: string, pubkey: string, device?: string): AllowedSite[] {
  return list.filter((entry) => !(entry.site === site && entry.pubkey === pubkey && (entry.device ?? "") === (device ?? "")));
}

/** What an entry is, in words, for the list. `family` is the domain, for a family's entry. */
export function describeAllowed(entry: AllowedSite, nowSeconds: number): { known: string | null; family: string | null; ended: boolean; lasts: string } {
  const ended = entry.refused === true || entry.until <= nowSeconds;
  const family = familyDomain(entry.site) || null;
  return {
    known: family ? (knownFamily(entry.site) ? `every site at ${family}` : null) : knownAppName(entry.site),
    family,
    ended,
    lasts: entry.refused
      ? "Ended by BitLogin: it had been allowed to write or read data under names no site may now have, such as BitLogin's own records or every application's. If you use it, it will ask you again."
      : ended
        ? "Ended."
        : entry.remembered ? "Remembered on this device until then, unless you sign out there sooner." : "For one visit: it ended when that site's page was closed or loaded again, and by then at the latest."
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

export const FAMILY_DECLINED_KEY = "bitlogin:family-declined:v1";

const readDeclined = (storage: Storage | null): Record<string, number> => {
  try {
    const parsed = JSON.parse(storage?.getItem(FAMILY_DECLINED_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
};

/** "Just this one": the family is not offered again for thirty days. Best-effort. */
export function declineFamily(family: string, nowSeconds = Date.now() / 1000, storage: Storage | null = here()): boolean {
  if (!readFamily(family)) return false;
  const now = Math.floor(nowSeconds);
  // Only what is still in force is kept, so the record stays small.
  const kept = Object.fromEntries(Object.entries(readDeclined(storage)).filter(([key, until]) => readFamily(key) && typeof until === "number" && until > now));
  kept[family] = now + ALLOWED_LIMITS.familyDeclineSec;
  try {
    storage?.setItem(FAMILY_DECLINED_KEY, JSON.stringify(kept));
    return !!storage;
  } catch {
    return false;
  }
}

/** Whether the user said "Just this one" for this family in the last thirty days. */
export function familyDeclined(family: string, nowSeconds = Date.now() / 1000, storage: Storage | null = here()): boolean {
  const until = readDeclined(storage)[family];
  return typeof until === "number" && until > nowSeconds;
}
