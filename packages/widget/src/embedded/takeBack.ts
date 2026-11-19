/**
 * Taking a site back (docs/take-back.md): the pure parts.
 *
 * What lets a site sign is a grant kept where no page of the sign-in address
 * can reach it (§SW11). So a user takes a site back by publishing a small
 * record that every embedded signer reads and obeys:
 *
 *   kind 30078, d = "bitlogin:taken-back:v1", content NIP-44 to their own key:
 *   { v: 1, all_before, sites: [{ site, before }] }
 *
 * A grant made at time t for a site is ended if `all_before >= t`, or if the
 * site is listed with `before >= t`. Allowing the site again makes a grant
 * with a later time, which the old entry does not touch.
 *
 * Nothing here signs, encrypts or contacts anything.
 */
import { isAllowedRelayUrl, verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { cleanOrigin } from "./policy.js";

export const TAKE_BACK_KIND = 30078;
export const TAKE_BACK_D = "bitlogin:taken-back:v1";
export const RELAY_LIST_KIND = 10002;

export const TAKE_BACK_LIMITS = {
  /** No more sites than this are listed. */
  sites: 200,
  /** An entry older than the longest a grant can live ends nothing that is left, and may be dropped. In seconds. */
  entrySec: 31 * 24 * 3600,
  /** A grant is checked when its last check is older than this. In seconds. */
  checkEverySec: 24 * 3600,
  /** A grant that has gone this long without a check that succeeded is locked until one does. In seconds. */
  staleSec: 3 * 24 * 3600,
  /** How many of the user's own write relays are carried to a signer. */
  relays: 4,
  /** How far ahead of this clock a record may be dated and still be believed. In seconds. */
  skewSec: 600
} as const;

export interface TakenBack {
  /** Every grant made at or before this moment is ended. 0 for none. */
  allBefore: number;
  /** Sites taken back, and when. */
  sites: { site: string; before: number }[];
}

export const NOTHING_TAKEN_BACK: TakenBack = { allBefore: 0, sites: [] };

const time = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** A record's content, read again: anything that is not an entry is dropped. Null when it is not a record at all. */
export function readTakenBack(input: unknown): TakenBack | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  if (r.v !== 1 || !Array.isArray(r.sites)) return null;
  const newest = new Map<string, number>();
  for (const entry of r.sites.slice(0, TAKE_BACK_LIMITS.sites * 2)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const site = cleanOrigin(e.site);
    const before = time(e.before);
    if (!site || site !== e.site || !before) continue;
    newest.set(site, Math.max(newest.get(site) ?? 0, before));
  }
  return { allBefore: time(r.all_before), sites: [...newest].map(([site, before]) => ({ site, before })) };
}

export const writeTakenBack = (record: TakenBack): string => JSON.stringify({ v: 1, all_before: record.allBefore, sites: record.sites });

/**
 * Two records as one: nothing either says is taken back is ever given back
 * by the other. This is what a writer publishes, so a record built from an
 * older copy cannot undo a newer one.
 */
export function mergeTakenBack(a: TakenBack, b: TakenBack, nowSeconds: number): TakenBack {
  const allBefore = Math.max(a.allBefore, b.allBefore);
  const newest = new Map<string, number>();
  for (const { site, before } of [...a.sites, ...b.sites]) newest.set(site, Math.max(newest.get(site) ?? 0, before));
  const sites = [...newest]
    .map(([site, before]) => ({ site, before }))
    // Covered by "everything before", or too old to end any grant that is left: not worth the room.
    .filter((entry) => entry.before > allBefore && entry.before + TAKE_BACK_LIMITS.entrySec > nowSeconds)
    .sort((x, y) => y.before - x.before)
    .slice(0, TAKE_BACK_LIMITS.sites);
  return { allBefore, sites };
}

/** Take one site back, or everything, as of now. */
export function takeBack(record: TakenBack, what: { site: string } | { all: true }, nowSeconds: number): TakenBack {
  const now = Math.floor(nowSeconds);
  if ("all" in what) return mergeTakenBack(record, { allBefore: now, sites: [] }, now);
  const site = cleanOrigin(what.site);
  if (!site) return record;
  return mergeTakenBack(record, { allBefore: 0, sites: [{ site, before: now }] }, now);
}

/** The rule: whether a grant made at `grantedAt` for `site` is ended by this record. */
export function isTakenBack(record: TakenBack, site: string, grantedAt: number): boolean {
  if (record.allBefore >= grantedAt) return true;
  return record.sites.some((entry) => entry.site === site && entry.before >= grantedAt);
}

/** The newest validly signed take-back event by `pubkey` among what relays returned, or null. Its content is still sealed. */
export function newestTakeBackEvent(events: readonly unknown[], pubkey: string, nowSeconds: number): NostrEvent | null {
  let best: NostrEvent | null = null;
  for (const event of events) {
    if (!verifyNostrEvent(event) || event.kind !== TAKE_BACK_KIND || event.pubkey !== pubkey) continue;
    if (!event.tags.some((tag) => tag[0] === "d" && tag[1] === TAKE_BACK_D)) continue;
    // A record dated far ahead would outrank every honest one for as long as it was dated ahead.
    if (event.created_at > nowSeconds + TAKE_BACK_LIMITS.skewSec) continue;
    if (!best || event.created_at > best.created_at) best = event;
  }
  return best;
}

/**
 * Whether a host is one a signer may be sent to on a user's say: a public
 * name. Not an address written as numbers, not this machine, and not a name
 * that only means something inside a private network. A relay list is input
 * from whoever wrote it, and the page that follows it holds a key: it is not
 * to be pointed at a router or a service on the user's own network.
 *
 * It cannot tell where a public-looking name really leads. That is the
 * browser's and the network's to refuse.
 */
export function isPublicRelayHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/u, "");
  if (!host.includes(".") || host.startsWith("[") || host.includes(":")) return false;
  if (/^[0-9.]+$/u.test(host) || /^0x/u.test(host)) return false;
  // Every label an ordinary one, and the last not a number: "1.2.3.4" in any spelling is not a name.
  const labels = host.split(".");
  if (!labels.every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) || /^[0-9]+$/u.test(labels[labels.length - 1]!)) return false;
  return !["localhost", "local", "internal", "lan", "home", "intranet", "private", "corp", "test", "invalid", "onion"].includes(labels[labels.length - 1]!);
}

/** A relay address as a signer may be handed one: `wss://` to a public name, with nothing odd in it. */
export function cleanRelays(input: unknown, limit: number = TAKE_BACK_LIMITS.relays): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const value of input) {
    if (typeof value !== "string" || value.length > 200 || !isAllowedRelayUrl(value)) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      continue;
    }
    if (url.protocol !== "wss:" || url.search || !isPublicRelayHost(url.hostname)) continue;
    const clean = `${url.protocol}//${url.host}${url.pathname === "/" ? "" : url.pathname}`;
    if (!out.includes(clean)) out.push(clean);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Where a user writes, from their own signed relay list (NIP-65, kind
 * 10002): `r` tags with no marker, or marked "write". The newest validly
 * signed list by `pubkey` is the one used. [] when there is none.
 */
export function writeRelaysFrom(events: readonly unknown[], pubkey: string, limit: number = TAKE_BACK_LIMITS.relays): string[] {
  let best: NostrEvent | null = null;
  for (const event of events) {
    if (!verifyNostrEvent(event) || event.kind !== RELAY_LIST_KIND || event.pubkey !== pubkey) continue;
    if (!best || event.created_at > best.created_at) best = event;
  }
  if (!best) return [];
  return cleanRelays(
    best.tags.filter((tag) => tag[0] === "r" && (tag[2] === undefined || tag[2] === "write")).map((tag) => tag[1]),
    limit
  );
}

/**
 * Whether a round of asking relays told a signer anything it can rely on,
 * given that it found no record that ends the grant. Not every answer does:
 *
 *  - one relay alone saying "nothing" is not "nothing was taken back": two
 *    must answer (or the one, where only one was asked);
 *  - once a record has been seen, a round that returns none at all, or only
 *    an older one, did not find what is known to exist: a record cannot
 *    stop existing, so it is being held back or has been dropped;
 *  - a newest record that cannot be read says nothing either way.
 *
 * A round that told it nothing is not a check, and the three-day clock
 * keeps running.
 */
export function checkLearned(round: { asked: number; answered: number; seenAt: number; newestAt: number | null; readable: boolean }): boolean {
  if (round.answered < Math.min(2, round.asked) || round.answered === 0) return false;
  if (round.newestAt === null) return round.seenAt === 0;
  return round.readable && round.newestAt >= round.seenAt;
}

/** What to do about a kept grant now: nothing, check behind the answer, or check before answering. */
export function checkDue(nowSeconds: number, grantedAt: number, checkedAt: number): "fresh" | "due" | "overdue" {
  const last = Math.max(checkedAt, 0);
  if (last && nowSeconds - last < TAKE_BACK_LIMITS.checkEverySec) return "fresh";
  // Never checked: the moment it was made counts as the last time anything was known about it.
  return nowSeconds - Math.max(last, grantedAt) >= TAKE_BACK_LIMITS.staleSec ? "overdue" : "due";
}
