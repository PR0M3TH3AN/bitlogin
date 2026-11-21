/**
 * What can be bought, and the receipt for it (docs/paying.md).
 *
 * A thing for sale is a listing: a note its seller signed, naming a price and
 * the service that sells it (BitUnlock). A purchase ends in a receipt: a note
 * that service signed, naming the listing and the buyer. Both are checked
 * here, by their signatures, before a word of either is shown or believed.
 *
 * No key and no network: this reads what it is given.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { readShares, type Share } from "./shares.js";

const HEX64 = /^[0-9a-f]{64}$/u;
export const LISTING_KIND = 30078;
export const RECEIPT_KIND = 30078;
const RECEIPT_D = "bitunlock:entitlement:v1:";
const PROTOCOL = "seller-unlock-service-v1";

/** A service that sells and signs receipts: where it answers, and the key it signs with. */
export interface UnlockService {
  endpoint: string;
  pubkey: string;
}

/**
 * The services BitLogin buys from and whose receipts it keeps. Pinned by key:
 * a listing that names any other service is not bought, and a receipt any
 * other key signed is not one.
 */
export const UNLOCK_SERVICES: readonly UnlockService[] = [{ endpoint: "https://api.bitunlock.network", pubkey: "66be61cf5b8d286391f7b1a72ffa7c799ec2dc49eff0830c40df1cc964e6787d" }];

/**
 * A service a local copy of BitLogin is tried against, written as
 * `http://127.0.0.1:8788|<its key>`: an address on this machine or a private
 * network, and never one on the internet. Read only where BitLogin itself is
 * a local copy: the real address knows the list above and no other.
 */
const NEAR = /^(?:localhost|127(?:\.[0-9]{1,3}){3}|10(?:\.[0-9]{1,3}){3}|192\.168(?:\.[0-9]{1,3}){2}|172\.(?:1[6-9]|2[0-9]|3[01])(?:\.[0-9]{1,3}){2})$/u;
export function localService(input: unknown): UnlockService | null {
  if (typeof input !== "string" || input.length > 300) return null;
  const [endpoint, pubkey] = input.split("|");
  try {
    const url = new URL(endpoint ?? "");
    if ((url.protocol !== "http:" && url.protocol !== "https:") || !NEAR.test(url.hostname) || url.origin !== endpoint) return null;
    return pubkey && HEX64.test(pubkey) ? { endpoint: url.origin, pubkey } : null;
  } catch {
    return null;
  }
}

/**
 * A listing's coordinate: `30078:<seller>:<name>`. Empty for anything else. The name is as BitUnlock takes it: 1 to
 * 256 characters, not beginning with a colon, and all on one line.
 */
export function cleanCoordinate(input: unknown): string {
  return typeof input === "string" && /^30078:[0-9a-f]{64}:[^:\r\n][^\r\n]{0,255}$/u.test(input) ? input : "";
}
export const sellerOf = (coordinate: string): string => coordinate.slice(6, 70);

export interface Listing {
  coordinate: string;
  seller: string;
  /** What it is called, in the seller's words. Shown as text, beside the seller. */
  title: string;
  priceSats: number;
  service: UnlockService;
  /** What it is for inside NSWP, where the listing says: a world or an item, by coordinate. */
  for: string;
  /** How long it lasts, in seconds, where the listing says. 0: it doesn't say. */
  termSeconds: number;
  /** Whether it is a listing for something in a world: it carries a tag that begins `nswp:`. */
  nswp: boolean;
  /**
   * Whether its seller wrote that the price is divided between several people (`nswp:share`). Dividing a price is
   * not built yet, so such a listing is not shown for sale at all: selling it with the shares ignored would pay the
   * seller what they wrote was someone else's.
   */
  shared: boolean;
  /** Those shares, read by the rule (shares.ts): none for an ordinary listing, and null where they don't read, which is a listing that can't be sold. */
  shares: Share[] | null;
}

/**
 * The least something in a world may be sold for (owner, 2026-11-21): under it, BitUnlock's fee of ten sats at
 * least is too large a part of the price. BitUnlock holds the same floor when a listing is registered.
 */
export const LEAST_PRICE_SATS = 500;
/** Whether a listing is under that floor. Only a listing for something in a world is held to it. */
export const underFloor = (listing: Pick<Listing, "nswp" | "priceSats">): boolean => listing.nswp && listing.priceSats < LEAST_PRICE_SATS;

const tag = (event: { tags: string[][] }, name: string): string => {
  const found = event.tags.find((t) => t[0] === name);
  return typeof found?.[1] === "string" ? found[1] : "";
};
const cleanWords = (input: unknown, most: number): string =>
  typeof input === "string"
    ? Array.from(input.normalize("NFC"))
        .filter((ch) => {
          const c = ch.codePointAt(0)!;
          // No control or direction-changing characters: a title can't rearrange the line it is shown on.
          return c >= 0x20 && c !== 0x7f && !(c >= 0x200b && c <= 0x200f) && !(c >= 0x202a && c <= 0x202e) && !(c >= 0x2066 && c <= 0x2069);
        })
        .join("")
        .trim()
        .slice(0, most)
    : "";

/**
 * Read a listing a relay gave. Null unless it is really the one asked for:
 * signed, by the seller the coordinate names, for sale now, and sold by a
 * service on `services`.
 */
export function readListing(event: unknown, coordinate: string, services: readonly UnlockService[] = UNLOCK_SERVICES): Listing | null {
  const wanted = cleanCoordinate(coordinate);
  const e = event as NostrEvent | null;
  if (!wanted || !e || typeof e !== "object" || !Array.isArray(e.tags) || !verifyNostrEvent(e)) return null;
  if (e.kind !== LISTING_KIND || e.pubkey !== sellerOf(wanted) || `30078:${e.pubkey}:${tag(e, "d")}` !== wanted) return null;
  if (tag(e, "status") !== "active" || tag(e, "br:delivery") !== PROTOCOL) return null;
  const price = e.tags.find((t) => t[0] === "price");
  const priceSats = price && price[2] === "SAT" && /^[1-9][0-9]{0,11}$/u.test(price[1] ?? "") ? Number(price[1]) : 0;
  const service = services.find((s) => s.endpoint === tag(e, "br:unlock-service") && s.pubkey === tag(e, "br:unlock-service-pubkey"));
  if (!priceSats || !service) return null;
  let words: { title?: unknown; name?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(e.content || "{}");
    if (parsed && typeof parsed === "object") words = parsed as typeof words;
  } catch {
    words = {};
  }
  const term = tag(e, "nswp:term");
  return {
    coordinate: wanted,
    seller: e.pubkey,
    title: cleanWords(tag(e, "title") || words.title || words.name, 80) || cleanWords(tag(e, "d"), 80),
    priceSats,
    service: { ...service },
    for: /^3730[0-9]:[0-9a-f]{64}:[^\s]{1,200}$/u.test(tag(e, "nswp:for")) ? tag(e, "nswp:for") : "",
    termSeconds: /^[1-9][0-9]{0,9}$/u.test(term) ? Number(term) : 0,
    nswp: e.tags.some((t) => typeof t[0] === "string" && t[0].startsWith("nswp:")),
    shared: e.tags.some((t) => t[0] === "nswp:share"),
    shares: ((read) => (read.ok ? read.shares : null))(readShares(e.tags, e.pubkey))
  };
}

export interface Receipt {
  /** The receipt itself, whole and unchanged: it is what a world checks. */
  event: NostrEvent;
  listing: string;
  seller: string;
  buyer: string;
  order: string;
  fulfillment: string;
  issuedAt: number;
  /** When it runs out, in seconds. 0: it doesn't. */
  expiresAt: number;
  /** The service that signed it. */
  service: string;
}

/**
 * Read a receipt. Null unless a service on `services` really signed it. That
 * it is for a given buyer and listing, and has not run out, is `receiptGood`:
 * whether it was taken back is the service's to say, and is asked apart.
 */
export function readReceipt(event: unknown, services: readonly UnlockService[] = UNLOCK_SERVICES): Receipt | null {
  const e = event as NostrEvent | null;
  if (!e || typeof e !== "object" || !Array.isArray(e.tags) || typeof e.content !== "string" || e.content.length > 8000) return null;
  if (e.kind !== RECEIPT_KIND || !services.some((s) => s.pubkey === e.pubkey) || !verifyNostrEvent(e)) return null;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(e.content) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!doc || typeof doc !== "object" || doc.schemaVersion !== 1 || doc.protocolVersion !== PROTOCOL || doc.status !== "active") return null;
  const text = (v: unknown): string => (typeof v === "string" && v.length > 0 && v.length <= 200 ? v : "");
  const listing = cleanCoordinate(doc.productCoordinate);
  const [buyer, seller, order, fulfillment] = [text(doc.buyerPubkey), text(doc.sellerPubkey), text(doc.orderId), text(doc.fulfillmentId)];
  const issuedAt = typeof doc.issuedAt === "number" && Number.isSafeInteger(doc.issuedAt) && doc.issuedAt > 0 ? doc.issuedAt : 0;
  if (!listing || !HEX64.test(buyer) || !HEX64.test(seller) || seller !== sellerOf(listing) || !order || !fulfillment || !issuedAt) return null;
  if (tag(e, "d") !== RECEIPT_D + fulfillment) return null;
  let expiresAt = 0;
  if (doc.accessPolicy !== "perpetual-v1") {
    const term = doc.accessPolicy as { kind?: unknown; expiresAt?: unknown } | null;
    if (!term || typeof term !== "object" || term.kind !== "term-v1" || typeof term.expiresAt !== "number" || !Number.isSafeInteger(term.expiresAt) || term.expiresAt <= issuedAt) return null;
    expiresAt = term.expiresAt;
  }
  return { event: { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map((t) => [...t]), content: e.content, sig: e.sig }, listing, seller, buyer, order, fulfillment, issuedAt, expiresAt, service: e.pubkey };
}

/** Whether a receipt is this buyer's, for this listing, and has not run out. `now` is in seconds. */
export function receiptGood(receipt: Receipt | null, want: { buyer: string; listing: string; now: number }): boolean {
  return !!receipt && receipt.buyer === want.buyer && receipt.listing === want.listing && (receipt.expiresAt === 0 || want.now < receipt.expiresAt);
}

/** Of several receipts for one listing, the one that lasts longest: one with no end first, then the latest end. */
export function bestReceipt(receipts: readonly Receipt[], want: { buyer: string; listing: string; now: number }): Receipt | null {
  const good = receipts.filter((r) => receiptGood(r, want));
  good.sort((a, b) => (a.expiresAt === 0 ? -1 : b.expiresAt === 0 ? 1 : b.expiresAt - a.expiresAt));
  return good[0] ?? null;
}

/**
 * Whether a listing belongs to a world: its seller is a key that world
 * publishes with (its own `/.well-known/nswp.json` says which), or the
 * receipt was bought through that world. Only such a receipt is ever handed
 * to a world unasked, so a world can't go through what a person bought
 * elsewhere.
 */
export function belongsTo(listing: string, world: { publishers: readonly string[]; site: string }, boughtThrough?: string): boolean {
  return world.publishers.includes(sellerOf(listing)) || (!!boughtThrough && boughtThrough === world.site);
}
