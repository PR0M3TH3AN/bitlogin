/**
 * A price divided between several people (docs/paying.md PY14; the rule is
 * NSWP's, `protocol/10-identity.md` "Shares", and this is run against its
 * vectors).
 *
 * A listing carries one `["nswp:share", <key or the word client>, <parts in
 * 10000>, <a word>]` for each person its price is divided between, the
 * seller among them. BitLogin works the division out for itself from the
 * listing its seller signed, and holds the selling service's payment plan to
 * it: how many parts, how much each, and which key each is said to be for.
 *
 * What that proves: nobody is paid an amount the seller didn't write, no
 * share is left out or added, and none is labelled for a key the seller
 * didn't name. What it does not prove: that an invoice really pays the key
 * it is labelled for. An invoice doesn't say whose it is. That rests on the
 * service being one BitLogin pins, as the seller's own part always has.
 */
const HEX64 = /^[0-9a-f]{64}$/u;
export const SHARE_TAG = "nswp:share";
export const SHARE_CLIENT = "client";
export const SHARE_LIMITS = { most: 4, whole: 10_000, least: 10, label: 32 } as const;

export interface Share {
  /** A key, or the word "client": the client that brought the buyer. */
  to: string;
  /** Parts in ten thousand. */
  parts: number;
  /** What the share is for, in the seller's word. */
  label: string;
}
export type SharesRead = { ok: true; shares: Share[] } | { ok: false; why: "not-a-share" | "too-many" | "twice" | "not-whole" | "no-seller" };

/** A share's word: trimmed, of plain characters, and not long. Empty for anything else. */
export function cleanShareLabel(input: unknown): string {
  if (typeof input !== "string") return "";
  const text = input.trim();
  if (!text || text.length > SHARE_LIMITS.label) return "";
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    // No control, direction-changing or unseen characters: a word can't rearrange or hide in the line it is shown on.
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff) return "";
  }
  return text;
}

/**
 * Read a listing's shares. None at all is no division: the seller is paid
 * everything. Otherwise every one must read, nobody twice, the seller among
 * them, four at most, adding up to exactly ten thousand. Nothing is made to
 * fit: a listing whose shares don't read is not one that can be sold.
 */
export function readShares(tags: unknown, seller: unknown): SharesRead {
  const no = (why: Exclude<SharesRead, { ok: true }>["why"]): SharesRead => ({ ok: false, why });
  if (!Array.isArray(tags)) return no("not-a-share");
  const mine = tags.filter((t): t is unknown[] => Array.isArray(t) && t[0] === SHARE_TAG);
  if (mine.length === 0) return { ok: true, shares: [] };
  if (typeof seller !== "string" || !HEX64.test(seller)) return no("no-seller");
  if (mine.length > SHARE_LIMITS.most) return no("too-many");
  const shares: Share[] = [];
  for (const t of mine) {
    const [, to, parts, label] = t;
    if (t.length < 3 || t.length > 4) return no("not-a-share");
    if (typeof to !== "string" || (to !== SHARE_CLIENT && !HEX64.test(to))) return no("not-a-share");
    if (typeof parts !== "string" || !/^[1-9][0-9]{0,4}$/u.test(parts) || Number(parts) > SHARE_LIMITS.whole) return no("not-a-share");
    const word = label === undefined ? (to === SHARE_CLIENT ? "client" : to === seller ? "seller" : "share") : cleanShareLabel(label);
    if (!word) return no("not-a-share");
    if (shares.some((s) => s.to === to)) return no("twice");
    shares.push({ to, parts: Number(parts), label: word });
  }
  if (!shares.some((s) => s.to === seller)) return no("no-seller");
  if (shares.reduce((sum, s) => sum + s.parts, 0) !== SHARE_LIMITS.whole) return no("not-whole");
  return { ok: true, shares };
}

export interface SharePart {
  to: string;
  sats: number;
  label: string;
  seller: boolean;
}
export type SplitRead = { ok: true; parts: SharePart[] } | { ok: false; why: "not-a-price" | "no-seller" | "too-small" };

/**
 * Divide a price. Each person but the seller gets their parts of it, rounded
 * down; the seller gets what is left, less the service's charge, which comes
 * out of the seller's part and nobody else's. The client's share goes to the
 * client that brought the buyer; with none, or where the client is the
 * seller, it is the seller's. No part may be under ten sats. Given smallest
 * first, two of a size by key, and the seller last: the order they are paid in.
 */
export function splitPrice(price: unknown, shares: readonly Share[], seller: unknown, o: { client?: string; charge?: number } = {}): SplitRead {
  const no = (why: Exclude<SplitRead, { ok: true }>["why"]): SplitRead => ({ ok: false, why });
  const charge = o.charge ?? 0;
  if (typeof price !== "number" || !Number.isSafeInteger(price) || price < 1 || !Number.isSafeInteger(price * SHARE_LIMITS.whole)) return no("not-a-price");
  if (!Number.isSafeInteger(charge) || charge < 0) return no("not-a-price");
  if (typeof seller !== "string" || !HEX64.test(seller)) return no("no-seller");
  if (shares.length > 0 && !shares.some((s) => s.to === seller)) return no("no-seller");
  const client = typeof o.client === "string" && HEX64.test(o.client) && o.client !== seller ? o.client : null;
  const others = new Map<string, { sats: number; label: string }>();
  for (const s of shares) {
    if (s.to === seller) continue;
    const to = s.to === SHARE_CLIENT ? client : s.to;
    if (!to) continue;
    const sats = Math.floor((price * s.parts) / SHARE_LIMITS.whole);
    const had = others.get(to);
    others.set(to, had ? { sats: had.sats + sats, label: had.label } : { sats, label: s.label });
  }
  const given = [...others.values()].reduce((sum, p) => sum + p.sats, 0);
  const parts: SharePart[] = [...others].map(([to, p]) => ({ to, sats: p.sats, label: p.label, seller: false }));
  parts.sort((a, b) => a.sats - b.sats || (a.to < b.to ? -1 : 1));
  parts.push({ to: seller, sats: price - given - charge, label: shares.find((s) => s.to === seller)?.label ?? "seller", seller: true });
  if (parts.some((p) => p.sats < SHARE_LIMITS.least)) return no("too-small");
  return { ok: true, parts };
}
