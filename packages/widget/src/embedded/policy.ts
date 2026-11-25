/**
 * The embedded signer's rules (docs/sign-in-window.md §SW5): the pure parts.
 *
 * A site that asks BitLogin's signer to sign something is held to a short
 * list. This file is that list, and the shape of what a site and the signer
 * say to each other. Nothing here signs anything, and nothing here is secret.
 *
 * The messages are those of NSWP-10, "Signing from a world", version 1: the
 * first protocol written for this, kept exactly so that a site built against
 * it works unchanged. An application's own permission list (§SW9) will be a
 * later version.
 */
import type { NostrEvent } from "@bitlogin/core/nostr";
import { readPermissions, type AppPermissions } from "./permissions.js";
import { cleanSlot, fitsInSave } from "./saves.js";
import { cleanInvoice } from "../ecash/nip60.js";
import { cleanSats } from "../pay/lightning.js";
import { GUEST_CHANGES, isListSubject, type GuestChange } from "./guests.js";
import { cleanCoordinate, readReceipt, type UnlockService } from "../pay/listing.js";
import { cleanFileName } from "../drive/tree.js";
import { cleanMore, type WorldMore } from "./follows.js";
import { readFamily } from "./family.js";
export { WORLD_MORE } from "./follows.js";
import { cleanMessage, type ReadMessage, type WrittenMessage } from "./messages.js";
import { cleanBoard, cleanBoardTitle, cleanScore, worldCoordinate } from "./scores.js";
import { cleanAchievementId, cleanTitle } from "./achievements.js";

export const SIGNER_PROTOCOL = "nswp-signer";
export const HANDOFF_PROTOCOL = "nswp-handoff";
export const PROTOCOL_VERSION = 1;

export const SIGN_LIMITS = {
  /** The longest a note's content may be, in characters. */
  contentChars: 8000,
  tags: 60,
  tagItems: 8,
  tagChars: 400,
  /** How long a remembered site BitLogin knows stays allowed, in seconds: thirty days from Allow, unless the user signs out of it sooner. */
  grantSec: 30 * 24 * 3600,
  /** The same for a site BitLogin does not know: seven days (§SW11). */
  unknownGrantSec: 7 * 24 * 3600,
  /** How long a site that is not remembered stays allowed while its page stays open, in seconds (§SW11). */
  visitSec: 12 * 3600,
  /** No more than this many signatures for one site in `perMs`. The same numbers as NSWP's own (kit 0.28.0). */
  burst: 3,
  perMs: 60_000,
  /** And no more than this many in an hour. */
  hourly: 20,
  /** Room passes are counted apart from notes (§SW16), so signing in does not use up a post: this many in `perMs`. */
  passBurst: 2,
  /** And this many in an hour. */
  passHourly: 10
} as const;

/** "ordinary": allowed once the user has unlocked the signer for that site. "careful": only with their say each
 *  time (not built: refused). "never": refused, whatever anyone says. */
export type SignClass = "ordinary" | "careful" | "never";

/** What a site may have signed once the user has said yes to it: a note, and a reaction to one. */
export const ORDINARY_KINDS: readonly number[] = [1, 7];

/**
 * What is never signed for a site: private messages and their wrappings,
 * passes and room signals, anything that proves who someone is to a server
 * or a relay, wallet and remote-signer traffic, and application data, which
 * is where BitLogin keeps an account (kind 30078).
 */
export const NEVER_KINDS: readonly number[] = [4, 13, 14, 15, 1059, 1060, 13194, 22242, 23194, 23195, 24133, 27235, 27300, 27301, 30078];

/**
 * The careful kinds a world may have put to the person, each time, on a page of BitLogin's own (§SW20): a profile,
 * a deletion, and the list of relays they use. Not a follow list: a whole list signed for a site could unfollow
 * everyone, and following is done one person at a time (follows.ts). Nothing else that is "careful" is askable.
 */
export const ASKED_KINDS: readonly number[] = [0, 5, 10002];

/** How many times a site may put something to the person: this many in a minute, and this many in an hour. */
export const ASK_LIMITS = { burst: 2, perMs: 60_000, hourly: 10 } as const;
/** How long a question waits for the person before it is dropped, in milliseconds. */
export const ASK_WAIT_MS = 5 * 60_000;

export function signClass(kind: unknown): SignClass {
  if (typeof kind !== "number" || !Number.isInteger(kind) || kind < 0 || kind > 65535) return "never";
  if (NEVER_KINDS.includes(kind)) return "never";
  if (ORDINARY_KINDS.includes(kind)) return "ordinary";
  return "careful";
}

/** The tag the signer puts on everything it signs for a site: which site asked. A site can't leave it off. */
export const SITE_TAG = "nswp:world";

/** A site as it may be named in a tag or shown to someone: an http(s) origin, or "". */
export function cleanOrigin(input: unknown): string {
  if (typeof input !== "string" || input.length > 300) return "";
  try {
    const u = new URL(input);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin !== "null" ? u.origin : "";
  } catch {
    return "";
  }
}

/** A name as it may be shown: one line, nothing invisible that reorders or hides text, at most 48 characters. */
export function cleanName(input: unknown): string {
  if (typeof input !== "string") return "";
  let out = "";
  for (const ch of input.slice(0, 400).normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    const unseen = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
    out += unseen ? " " : ch;
  }
  return [...out.replace(/\s+/gu, " ").trim()].slice(0, 48).join("").trim();
}

export interface UnsignedForSite {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * What a site asked to have signed, as it may be signed for that site: an
 * ordinary kind, its words within the limit, its tags tidied, and marked with
 * the site that asked. The time is the signer's own, never the site's. Null
 * for anything else.
 */
export function prepareForSite(input: unknown, site: string, nowSeconds: number): UnsignedForSite | null {
  return prepare(input, site, nowSeconds, (kind) => signClass(kind) === "ordinary");
}

/** The room pass's kind (NSWP-12; profile.ts ROOM_PASS_KIND). */
const PASS_KIND = 27300;
/**
 * Whether a room pass may be made for this signer (2026-11-25): for a world or a guest, and for an application only
 * where the set the user approved already signs the pass's kind. It widens nothing the person didn't read.
 */
export function passAllowed(app: { sign: readonly number[] } | null): boolean {
  return !app || app.sign.includes(PASS_KIND);
}

/**
 * What a guest account's signer signs with no press (docs/guest-accounts.md G4, the owner's word of 2026-11-25): a
 * note and a reaction, as any site may, and its bag (NSWP-17: kind 37308, `d` "bag"), and nothing else.
 */
export const GUEST_BAG_KIND = 37308;
export function prepareForGuest(input: unknown, site: string, nowSeconds: number): UnsignedForSite | null {
  const e = input as { kind?: unknown; tags?: unknown } | null;
  const bag = e?.kind === GUEST_BAG_KIND && Array.isArray(e.tags) && e.tags.some((t) => Array.isArray(t) && t[0] === "d") && e.tags.filter((t) => Array.isArray(t) && t[0] === "d").every((t) => (t as unknown[])[1] === "bag" && (t as unknown[]).length === 2);
  return prepare(input, site, nowSeconds, (kind) => signClass(kind) === "ordinary" || (kind === GUEST_BAG_KIND && bag));
}

/**
 * The same, for a careful kind that may be put to the person (§SW20). It signs nothing and allows nothing: it is
 * what BitLogin's own page will show them, word for word, and what is signed if they say yes there.
 */
export function prepareAsked(input: unknown, site: string, nowSeconds: number): UnsignedForSite | null {
  return prepare(input, site, nowSeconds, (kind) => signClass(kind) === "careful" && ASKED_KINDS.includes(kind as number));
}

function prepare(input: unknown, site: string, nowSeconds: number, kindAllowed: (kind: unknown) => boolean): UnsignedForSite | null {
  const origin = cleanOrigin(site);
  if (!origin || !input || typeof input !== "object") return null;
  const e = input as { kind?: unknown; content?: unknown; tags?: unknown };
  if (!kindAllowed(e.kind)) return null;
  if (typeof e.content !== "string" || [...e.content].length > SIGN_LIMITS.contentChars) return null;
  if (!Array.isArray(e.tags) || e.tags.length > SIGN_LIMITS.tags) return null;
  const tags: string[][] = [];
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > SIGN_LIMITS.tagItems) return null;
    if (!tag.every((item) => typeof item === "string" && item.length <= SIGN_LIMITS.tagChars)) return null;
    // The mark is the signer's to write. A site's own is dropped, whatever it says.
    if (tag[0] === SITE_TAG) continue;
    tags.push([...(tag as string[])]);
  }
  tags.push([SITE_TAG, origin]);
  return { kind: e.kind as number, created_at: Math.floor(nowSeconds), tags, content: e.content };
}

export interface SignGate {
  /** Whether another signature may be made for this site now. Counts it if so. `now` is in milliseconds. */
  take(now: number): boolean;
  /** When the counted signatures were made, to keep across a page load. */
  times(): number[];
}

/**
 * One site's signatures, counted: a site the user said yes to still can't
 * pour notes out under their name. `already` is what was counted before this
 * page was loaded, so that loading the page again is not a way round it.
 */
export function createSignGate(limits: { burst: number; perMs: number; hourly: number } = SIGN_LIMITS, already: number[] = []): SignGate {
  let times: number[] = already.filter((t) => typeof t === "number" && Number.isFinite(t));
  return {
    times: () => [...times],
    take(now) {
      times = times.filter((t) => now - t < 3_600_000);
      if (times.length >= limits.hourly) return false;
      if (times.filter((t) => now - t < limits.perMs).length >= limits.burst) return false;
      times.push(now);
      return true;
    }
  };
}

// ---- What a site and the signer say to each other: `{ nswp: "nswp-signer", v: 1, t, ... }`.

export type SignerRequest =
  | { t: "state"; id: string }
  | { t: "lock"; id: string }
  | { t: "sign"; id: string; event: unknown }
  // Put to the person each time, on a page of BitLogin's own (§SW20). Answered "asking" at once, and later
  // "signed" / "wallet" or "refused", under the same id, once they have answered there.
  /** A careful kind: a profile, a deletion, a relay list. */
  | { t: "propose"; id: string; event: unknown }
  /** A wallet connection for this world to use. */
  | { t: "wallet"; id: string }
  /** A Lightning invoice, paid from the person's own ecash wallet if they say so (docs/ecash.md). The site never sees the wallet. */
  | { t: "pay"; id: string; invoice: string }
  /**
   * A tip of this many sats (docs/paying.md): to a person, by their key, or with no `to`, to the site itself. The
   * site names no invoice and no address: BitLogin's page finds the lightning address and pays only what was asked.
   */
  | { t: "tip"; id: string; to?: string; sats: number }
  /** Buy what a listing sells, by its coordinate. BitLogin's page runs the purchase; the site learns the receipt. */
  | { t: "buy"; id: string; listing: string }
  /**
   * Change one person on this world's guest list or block list (embedded/guests.ts): the newest list the world found
   * (or null, with `none` where it found none and says so), and the one change. BitLogin's page shows it in words,
   * every time, and builds the new list itself.
   */
  | { t: "guests"; id: string; world: string; list: unknown | null; change: GuestChange; key: string; none: boolean }
  /** Does the person hold a receipt for this listing? Answered at once, with no question, and only for a listing that is this site's own. */
  | { t: "have"; id: string; listing: string }
  // Files (docs/files.md). The person's own file browser is shown: the site sees none of it.
  /** Offer a file to be saved in the person's files: in this site's own folder, unless they choose another. */
  | { t: "file-save"; id: string; name: string; type: string; bytes: Uint8Array; private: boolean }
  /** Ask the person for one of their files. They choose it, or say no. */
  | { t: "file-pick"; id: string }
  /** A room pass for this site, naming the given session key (§SW16). Everything else in it is the signer's. */
  | { t: "pass"; id: string; session: string }
  // What a world keeps for its visitor (NSWP-12; saves.ts). Not for an application.
  /** Keep this for me. The world gives a slot's name and the words; where it is kept is the signer's to say. */
  | { t: "save"; id: string; slot: string; data: string }
  /** Where is my save in this slot kept? So the world can ask a relay for it. */
  | { t: "find"; id: string; slot: string }
  /** Open this save, which a relay gave me. Opened only if it is this world's. */
  | { t: "open"; id: string; event: unknown }
  // From an application (§SW9). A world sends none of these.
  /** What the application would like to be approved for. Shown in the window the next time it is opened. */
  | { t: "want"; id: string; permissions: AppPermissions }
  // From a world that would be let do more than a note and a reaction (NSWP-10, "Asking for more"; follows.ts).
  /** By name, from a short closed list. It approves nothing: the window shows it, in BitLogin's words. */
  | { t: "wantMore"; id: string; more: WorldMore[] }
  /**
   * A world asking, before its first sign-in, to be offered its whole family (docs/site-family.md SF4a): every site
   * under its domain. Written as BitLogin writes a family, or "" where it isn't one. It approves nothing: the signer
   * takes it only for its own family, one BitLogin knows, and the window offers it beside "Just this one".
   */
  /**
   * A headset asking to be signed in from a phone (docs/pair-a-headset.md): the signer answers `pairing` with a code
   * and an address to show, then `paired`, or `pairing-expired`. Only where nobody is signed in, or it is a guest.
   */
  | { t: "pair"; id: string }
  | { t: "pairCancel"; id: string }
  | { t: "wantFamily"; id: string; family: string; /** And a guest account, where nobody is signed in here (docs/guest-accounts.md). */ guest?: true }
  /** Follow or unfollow one person: the visitor's newest follow list as the world found it (or null), and the one change. */
  | { t: "follow"; id: string; list: unknown; add?: string; remove?: string }
  /** A score on one of a world's boards (NSWP-15; scores.ts). For any world its visitor allowed: less than a note. */
  | { t: "score"; id: string; world: string; board: string; score: number; /** What the board is called. */ title?: string; /** "time" where the score counts thousandths of a second. */ format?: "time" }
  /** An achievement held in a world (NSWP-16; achievements.ts). For any world its visitor allowed, as a score is. */
  | { t: "achieve"; id: string; world: string; achievement: string; title: string }
  // Private messages, for a world let do that by name (NSWP-14; messages.ts).
  /** Write a message to this reader with these words, and seal it to them and to its writer. */
  | { t: "seal"; id: string; to: string; text: string }
  /** Open this wrap (kind 1059), which a relay gave me. */
  | { t: "unwrap"; id: string; event: unknown }
  /** Sign the list of where their messages reach them, naming these relays. */
  | { t: "reach"; id: string; relays: string[] }
  | { t: "encrypt"; id: string; peer: string; text: string; scheme: "nip44" | "nip04" }
  | { t: "decrypt"; id: string; peer: string; text: string; scheme: "nip44" | "nip04" }
  | { t: "read"; id: string; event: unknown };

export type SignerReply =
  | { t: "ready" }
  | {
      t: "state";
      id?: string;
      unlocked: boolean;
      pubkey?: string;
      name?: string;
      picture?: string;
      about?: string;
      until?: number;
      remembered?: boolean;
      permissions?: AppPermissions;
      /** What a world was let do beyond a note and a reaction, by name. */
      more?: WorldMore[];
      /** What a world can ask this signer to be let do, by name, said locked or unlocked: so it asks for nothing there is no question for. */
      offers?: WorldMore[];
      /** In answer to `want` only: whether that set may be shown to the user at this address. False approves
       *  nothing and true approves nothing: it says whether asking is worth it. */
      taken?: boolean;
      /** In answer to a `want` for a family only: whether the window will offer it. Approves nothing. */
      familyTaken?: boolean;
      /** In answer to a `want` for a guest: whether this signer is, or will be, a guest here (docs/guest-accounts.md). */
      guestTaken?: boolean;
      /** This signer is a guest account: made by BitLogin for a visitor who arrived signed out, not yet secured. */
      guest?: true;
    }
  | { t: "signed"; id: string; event: NostrEvent }
  /** A pairing under way: the code and address to show, until when, and, once a phone found it, its number. */
  | { t: "pairing"; id: string; code: string; url: string; expires: number; number?: number }
  /** The phone signed this headset in: the signer is unlocked, and says so in `state` too. */
  | { t: "paired"; id: string }
  /** The code ran out, or the phone said no (a wrong number, or "Not this one"): `why` says which. */
  | { t: "pairing-expired"; id: string; why?: "refused" }
  /** Answers `propose` and `wallet` at once: the question is waiting for the person. Show BitLogin's panel or window. */
  | { t: "asking"; id: string }
  /** Answers `wallet`, once the person agreed: the connection this world may use. */
  | { t: "wallet"; id: string; uri: string }
  /** Answers `pay`, once it was paid: the proof of payment, where the mint gave one. Nothing about the wallet. */
  | { t: "paid"; id: string; preimage?: string }
  /** Answers `buy`, once bought (or already held): the receipt, whole, and what the purchase delivers, where it delivers something. */
  | { t: "bought"; id: string; receipt: NostrEvent; delivery?: string }
  /** Answers `have`: the receipt held for that listing. */
  | { t: "receipt"; id: string; receipt: NostrEvent }
  /** Answers `have`: none is held that this site may be told of. */
  | { t: "none"; id: string }
  /** Answers `file-save`, once saved: the name it was given, and where anyone can fetch it if the person kept it public. Not where it is. */
  | { t: "file-saved"; id: string; name: string; size: number; private: boolean; url?: string }
  /** Answers `file-pick`: the one file the person chose. */
  | { t: "file"; id: string; name: string; type: string; bytes: Uint8Array; url?: string }
  | { t: "text"; id: string; text: string }
  /** Answers `seal`: the message as written (never signed), and its two seals: for the reader, then for the writer. */
  | { t: "sealed"; id: string; message: WrittenMessage; seals: [NostrEvent, NostrEvent] }
  /** Answers `unwrap`: the message that was inside. */
  | { t: "message"; id: string; message: ReadMessage }
  /** Answers `find`: the `d` of this world's save in that slot. */
  | { t: "found"; id: string; d: string }
  /** Answers `open`: what was kept, in which slot, and when. */
  | { t: "opened"; id: string; slot: string; data: string; at: number }
  | { t: "refused"; id: string };

const ID = /^[0-9a-z-]{1,40}$/iu;
const HEX64 = /^[0-9a-f]{64}$/u;

export const signerMessage = (reply: SignerReply): Record<string, unknown> => ({ nswp: SIGNER_PROTOCOL, v: PROTOCOL_VERSION, ...reply });

/** Read what a site sent the signer. Null for anything else. The event itself is checked by `prepareForSite`. */
export function readSignerRequest(data: unknown): SignerRequest | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.nswp !== SIGNER_PROTOCOL || d.v !== PROTOCOL_VERSION || typeof d.id !== "string" || !ID.test(d.id)) return null;
  if (d.t === "state") return { t: "state", id: d.id };
  if (d.t === "pair") return { t: "pair", id: d.id };
  if (d.t === "pairCancel") return { t: "pairCancel", id: d.id };
  if (d.t === "lock") return { t: "lock", id: d.id };
  if (d.t === "sign" && d.event && typeof d.event === "object") return { t: "sign", id: d.id, event: d.event };
  if (d.t === "propose" && d.event && typeof d.event === "object") return { t: "propose", id: d.id, event: d.event };
  if (d.t === "wallet") return { t: "wallet", id: d.id };
  if (d.t === "pay" && cleanInvoice(d.invoice)) return { t: "pay", id: d.id, invoice: cleanInvoice(d.invoice) };
  if (d.t === "tip" && cleanSats(d.sats) && (d.to === undefined || (typeof d.to === "string" && HEX64.test(d.to)))) return { t: "tip", id: d.id, sats: cleanSats(d.sats), ...(typeof d.to === "string" ? { to: d.to } : {}) };
  if (d.t === "guests" && typeof d.world === "string" && d.world.startsWith("37300:") && isListSubject(d.world) && GUEST_CHANGES.includes(d.change as GuestChange) && typeof d.key === "string" && HEX64.test(d.key) && (d.list === null || (!!d.list && typeof d.list === "object"))) {
    return { t: "guests", id: d.id, world: d.world, list: d.list, change: d.change as GuestChange, key: d.key, none: d.none === true };
  }
  if ((d.t === "buy" || d.t === "have") && cleanCoordinate(d.listing)) return { t: d.t, id: d.id, listing: cleanCoordinate(d.listing) };
  if (d.t === "file-pick") return { t: "file-pick", id: d.id };
  if (d.t === "file-save") {
    const offered = readOfferedFile(d);
    return offered ? { t: "file-save", id: d.id, ...offered, private: d.private !== false } : null;
  }
  if (d.t === "pass" && typeof d.session === "string" && HEX64.test(d.session)) return { t: "pass", id: d.id, session: d.session };
  if (d.t === "save" && cleanSlot(d.slot) && fitsInSave(d.data)) return { t: "save", id: d.id, slot: cleanSlot(d.slot), data: d.data };
  if (d.t === "find" && cleanSlot(d.slot)) return { t: "find", id: d.id, slot: cleanSlot(d.slot) };
  if (d.t === "open" && d.event && typeof d.event === "object") return { t: "open", id: d.id, event: d.event };
  // A world asking for more, by name. A message that carries a permission set is an application's, below.
  if (d.t === "want" && d.permissions === undefined && Array.isArray(d.more)) return { t: "wantMore", id: d.id, more: cleanMore(d.more) };
  // A world asking for its family, and nothing else with it.
  if (d.t === "want" && d.permissions === undefined && d.more === undefined && d.family !== undefined) return { t: "wantFamily", id: d.id, family: readFamily(d.family), ...(d.guest === true ? { guest: true as const } : {}) };
  if (d.t === "follow" && (d.list === null || (!!d.list && typeof d.list === "object"))) {
    const add = typeof d.add === "string" && HEX64.test(d.add);
    const remove = typeof d.remove === "string" && HEX64.test(d.remove);
    if (add === remove) return null;
    return { t: "follow", id: d.id, list: d.list, ...(add ? { add: d.add as string } : { remove: d.remove as string }) };
  }
  if (d.t === "score" && worldCoordinate(d.world) && cleanBoard(d.board) && cleanScore(d.score) !== null) return { t: "score", id: d.id, world: worldCoordinate(d.world), board: cleanBoard(d.board), score: cleanScore(d.score)!, ...(cleanBoardTitle(d.title) ? { title: cleanBoardTitle(d.title) } : {}), ...(d.format === "time" ? { format: "time" as const } : {}) };
  if (d.t === "achieve" && worldCoordinate(d.world) && cleanAchievementId(d.achievement) && cleanTitle(d.title)) {
    return { t: "achieve", id: d.id, world: worldCoordinate(d.world), achievement: cleanAchievementId(d.achievement), title: cleanTitle(d.title) };
  }
  if (d.t === "seal" && typeof d.to === "string" && HEX64.test(d.to) && cleanMessage(d.text)) return { t: "seal", id: d.id, to: d.to, text: cleanMessage(d.text) };
  if (d.t === "unwrap" && d.event && typeof d.event === "object") return { t: "unwrap", id: d.id, event: d.event };
  if (d.t === "reach" && Array.isArray(d.relays) && d.relays.length <= 8 && d.relays.every((r) => typeof r === "string" && r.length <= 200)) return { t: "reach", id: d.id, relays: d.relays as string[] };
  if (d.t === "want") {
    const permissions = readPermissions(d.permissions);
    return permissions ? { t: "want", id: d.id, permissions } : null;
  }
  if ((d.t === "encrypt" || d.t === "decrypt") && typeof d.peer === "string" && HEX64.test(d.peer) && typeof d.text === "string" && d.text.length <= 200_000) {
    return { t: d.t, id: d.id, peer: d.peer, text: d.text, scheme: d.scheme === "nip04" ? "nip04" : "nip44" };
  }
  if (d.t === "read" && d.event && typeof d.event === "object") return { t: "read", id: d.id, event: d.event };
  return null;
}

// ---- What BitLogin's window and its own signer say to each other, across the asking site's page. Only ever
// delivered between two pages of this origin: the browser sees to that, and each side checks it.

export type HandoffMessage =
  /** Window to every frame of the page that opened it: "is one of you mine?" */
  | { t: "hello"; nonce: string }
  /** Signer to window: which site embeds it (as the browser says), a throwaway key to seal the hand-off to, and
   *  what that site said it wants, if it is an application (§SW9). */
  | { t: "frame"; nonce: string; world: string; recipient: string; wants?: AppPermissions; /** The site asked for a set it may not hold here. */ turnedDown?: boolean; /** A world asked to be let do more, by name. */ more?: WorldMore[]; /** What it was already let do, by name: kept when the user allows it again. */ has?: WorldMore[]; /** The world asked for its family (SF4a), and the signer took it. */ family?: true; /** Something the site put to the person (§SW20), and who it is signed in as. */ ask?: Asked; pubkey?: string }
  /** Window to signer: what the person answered to `ask`. Neither field: they said no. */
  | { t: "answer"; nonce: string; world: string; event?: NostrEvent; wallet?: string; /** It was paid: the invoice that was, and the proof where there is one. */ paid?: { invoice: string; preimage?: string }; /** A file was saved. */ saved?: { name: string; size: number; private: boolean; url?: string }; /** The file the person chose. */ file?: OfferedFile & { url?: string }; /** A tip was paid: how much, and the proof where there is one. */ tipped?: { sats: number; preimage?: string }; /** It was bought, or was held already: the receipt, and what it delivers. */ bought?: { receipt: NostrEvent; delivery?: string }; /** A world's list, signed on BitLogin's page with the one change made. */ listed?: NostrEvent }
  /** Window to signer: the person's receipts for this site's own listings, so `have` can be answered with no question. They replace what it held. */
  | { t: "held"; nonce: string; world: string; receipts: NostrEvent[] }
  /** Window to signer, after the user pressed Allow: the sealed hand-off, for that site. */
  | { t: "grant"; nonce: string; world: string; sealed: { senderPublicKey: string; payload: string }; name?: string }
  /** Signer to window: it is unlocked, or it could not be. */
  | { t: "done"; nonce: string; ok: boolean };

/** What a site put to the person: a careful kind to sign, exactly as it would be signed, or the use of a wallet. */
export type Asked =
  | { what: "sign"; event: UnsignedForSite }
  | { what: "wallet" }
  | { what: "pay"; invoice: string }
  | { what: "tip"; to?: string; sats: number }
  | { what: "buy"; listing: string }
  | { what: "guests"; world: string; list: NostrEvent | null; change: GuestChange; key: string; none: boolean }
  | ({ what: "save"; private: boolean } & OfferedFile)
  | { what: "pick" };

/** The longest text a purchase may deliver to a site (a key for a sealed world, say). */
export const DELIVERY_MOST = 20_000;
/** The most receipts BitLogin's page hands a site's signer at once: the ones for that site's own listings. */
export const HELD_MOST = 60;

/** A file as it passes between pages: its name, what it is, and its bytes. */
export interface OfferedFile {
  name: string;
  type: string;
  bytes: Uint8Array;
}
/** The most a site may offer, or be handed, in one file. */
export const FILE_LIMIT_BYTES = 25 * 1024 * 1024;

function readOfferedFile(input: unknown): OfferedFile | null {
  if (!input || typeof input !== "object") return null;
  const f = input as { name?: unknown; type?: unknown; bytes?: unknown };
  const name = cleanFileName(f.name);
  const bytes = f.bytes instanceof Uint8Array ? f.bytes : f.bytes instanceof ArrayBuffer ? new Uint8Array(f.bytes) : null;
  if (!name || !bytes || bytes.length === 0 || bytes.length > FILE_LIMIT_BYTES) return null;
  return { name, type: typeof f.type === "string" && /^[\x21-\x7e]{3,120}$/u.test(f.type) && f.type.includes("/") ? f.type.toLowerCase() : "application/octet-stream", bytes };
}
const httpsUrl = (input: unknown): string => {
  try {
    const u = new URL(String(input));
    return typeof input === "string" && input.length <= 400 && (u.protocol === "https:" || u.protocol === "http:") ? u.href : "";
  } catch {
    return "";
  }
};

/** A wallet connection as it may be passed on: the NWC form, and no longer than one could be. */
export const cleanWalletUri = (input: unknown): string => (typeof input === "string" && input.length <= 2000 && /^nostr\+walletconnect:\/\/[0-9a-f]{64}\?[\x21-\x7e]+$/u.test(input) ? input : "");

function readAsked(input: unknown, world: string): Asked | null {
  if (!input || typeof input !== "object") return null;
  const a = input as { what?: unknown; event?: unknown };
  if (a.what === "wallet") return { what: "wallet" };
  if (a.what === "pick") return { what: "pick" };
  if (a.what === "save") {
    const offered = readOfferedFile(a);
    return offered ? { what: "save", ...offered, private: (a as { private?: unknown }).private !== false } : null;
  }
  if (a.what === "tip") {
    const t = a as { to?: unknown; sats?: unknown };
    if (!cleanSats(t.sats) || (t.to !== undefined && !(typeof t.to === "string" && HEX64.test(t.to)))) return null;
    return { what: "tip", sats: cleanSats(t.sats), ...(typeof t.to === "string" ? { to: t.to } : {}) };
  }
  if (a.what === "guests") {
    const g = a as { world?: unknown; list?: unknown; change?: unknown; key?: unknown; none?: unknown };
    if (typeof g.world !== "string" || !g.world.startsWith("37300:") || !isListSubject(g.world) || !GUEST_CHANGES.includes(g.change as GuestChange) || typeof g.key !== "string" || !HEX64.test(g.key)) return null;
    if (g.list !== null && !(g.list && typeof g.list === "object")) return null;
    return { what: "guests", world: g.world, list: (g.list as NostrEvent | null) ?? null, change: g.change as GuestChange, key: g.key, none: g.none === true };
  }
  if (a.what === "buy") return cleanCoordinate((a as { listing?: unknown }).listing) ? { what: "buy", listing: cleanCoordinate((a as { listing?: unknown }).listing) } : null;
  if (a.what === "pay") return cleanInvoice((a as { invoice?: unknown }).invoice) ? { what: "pay", invoice: cleanInvoice((a as { invoice?: unknown }).invoice) } : null;
  if (a.what !== "sign") return null;
  const event = prepareAsked(a.event, world, (a.event as { created_at?: number } | null)?.created_at ?? 0);
  // What the signer prepared reads back as itself: the same kind, words and tags, the site's mark included.
  return event && JSON.stringify(event.tags) === JSON.stringify((a.event as { tags?: unknown }).tags) ? { what: "sign", event } : null;
}

export const handoffMessage = (message: HandoffMessage): Record<string, unknown> => ({ nswp: HANDOFF_PROTOCOL, v: PROTOCOL_VERSION, ...message });

export function readHandoffMessage(data: unknown): HandoffMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.nswp !== HANDOFF_PROTOCOL || d.v !== PROTOCOL_VERSION || typeof d.nonce !== "string" || !ID.test(d.nonce)) return null;
  const hex = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
  if (d.t === "hello") return { t: "hello", nonce: d.nonce };
  if (d.t === "frame" && cleanOrigin(d.world) && hex(d.recipient)) {
    // A set that does not read as one is no frame at all: the window must not show part of what was asked.
    const wants = d.wants === undefined ? undefined : readPermissions(d.wants);
    if (wants === null) return null;
    return { t: "frame", nonce: d.nonce, world: cleanOrigin(d.world), recipient: d.recipient, ...(wants ? { wants } : {}), ...(d.turnedDown === true ? { turnedDown: true } : {}), ...(!wants && cleanMore(d.more).length ? { more: cleanMore(d.more) } : {}), ...(!wants && cleanMore(d.has).length ? { has: cleanMore(d.has) } : {}), ...(d.family === true ? { family: true as const } : {}), ...(readAsked(d.ask, cleanOrigin(d.world)) && hex(d.pubkey) && !(wants && readAsked(d.ask, cleanOrigin(d.world))!.what === "wallet") ? { ask: readAsked(d.ask, cleanOrigin(d.world))!, pubkey: d.pubkey } : {}) };
  }
  if (d.t === "answer" && cleanOrigin(d.world)) {
    const wallet = d.wallet === undefined ? "" : cleanWalletUri(d.wallet);
    if (d.wallet !== undefined && !wallet) return null;
    const event = d.event && typeof d.event === "object" ? (d.event as NostrEvent) : undefined;
    const p = d.paid && typeof d.paid === "object" ? (d.paid as Record<string, unknown>) : null;
    const paid = p && cleanInvoice(p.invoice) ? { invoice: cleanInvoice(p.invoice), ...(typeof p.preimage === "string" && HEX64.test(p.preimage) ? { preimage: p.preimage } : {}) } : null;
    if (d.paid !== undefined && !paid) return null;
    const sv = d.saved && typeof d.saved === "object" ? (d.saved as Record<string, unknown>) : null;
    const saved = sv && cleanFileName(sv.name) && typeof sv.size === "number" && Number.isSafeInteger(sv.size) && sv.size >= 0 ? { name: cleanFileName(sv.name), size: sv.size, private: sv.private !== false, ...(sv.private === false && httpsUrl(sv.url) ? { url: httpsUrl(sv.url) } : {}) } : null;
    if (d.saved !== undefined && !saved) return null;
    const picked = d.file === undefined ? null : readOfferedFile(d.file);
    if (d.file !== undefined && !picked) return null;
    const file = picked ? { ...picked, ...(httpsUrl((d.file as { url?: unknown }).url) ? { url: httpsUrl((d.file as { url?: unknown }).url) } : {}) } : null;
    const tp = d.tipped && typeof d.tipped === "object" ? (d.tipped as Record<string, unknown>) : null;
    const tipped = tp && cleanSats(tp.sats) ? { sats: cleanSats(tp.sats), ...(typeof tp.preimage === "string" && HEX64.test(tp.preimage) ? { preimage: tp.preimage } : {}) } : null;
    if (d.tipped !== undefined && !tipped) return null;
    const bt = d.bought && typeof d.bought === "object" ? (d.bought as Record<string, unknown>) : null;
    const bought = bt && bt.receipt && typeof bt.receipt === "object" ? { receipt: bt.receipt as NostrEvent, ...(typeof bt.delivery === "string" && bt.delivery.length > 0 && bt.delivery.length <= DELIVERY_MOST ? { delivery: bt.delivery } : {}) } : null;
    if (d.bought !== undefined && !bought) return null;
    const listed = d.listed && typeof d.listed === "object" ? (d.listed as NostrEvent) : undefined;
    if (d.listed !== undefined && !listed) return null;
    if ([event, wallet, paid, saved, file, tipped, bought, listed].filter(Boolean).length > 1) return null;
    return { t: "answer", nonce: d.nonce, world: cleanOrigin(d.world), ...(event ? { event } : {}), ...(listed ? { listed } : {}), ...(wallet ? { wallet } : {}), ...(paid ? { paid } : {}), ...(saved ? { saved } : {}), ...(file ? { file } : {}), ...(tipped ? { tipped } : {}), ...(bought ? { bought } : {}) };
  }
  if (d.t === "held" && cleanOrigin(d.world) && Array.isArray(d.receipts) && d.receipts.length <= HELD_MOST && d.receipts.every((r) => r && typeof r === "object")) {
    return { t: "held", nonce: d.nonce, world: cleanOrigin(d.world), receipts: d.receipts as NostrEvent[] };
  }
  if (d.t === "grant" && cleanOrigin(d.world) && d.sealed && typeof d.sealed === "object") {
    const s = d.sealed as Record<string, unknown>;
    if (!hex(s.senderPublicKey) || typeof s.payload !== "string" || s.payload.length > 12_000) return null;
    const name = cleanName(d.name);
    return { t: "grant", nonce: d.nonce, world: cleanOrigin(d.world), sealed: { senderPublicKey: s.senderPublicKey, payload: s.payload }, ...(name ? { name } : {}) };
  }
  if (d.t === "done" && typeof d.ok === "boolean") return { t: "done", nonce: d.nonce, ok: d.ok };
  return null;
}

/**
 * The receipts a site's signer may hold, of those BitLogin's page handed it:
 * each really signed by a service on `services`, and this account's. What is
 * left is what `have` answers from.
 */
export function heldReceipts(input: readonly unknown[], pubkey: string, services: readonly UnlockService[]): NostrEvent[] {
  const out: NostrEvent[] = [];
  for (const item of input.slice(0, HELD_MOST)) {
    const receipt = readReceipt(item, services);
    if (receipt && receipt.buyer === pubkey) out.push(receipt.event);
  }
  return out;
}
