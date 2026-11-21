/**
 * What an application may ask the embedded signer for (docs/sign-in-window.md
 * §SW9): the pure parts. Nothing here signs, decrypts or stores anything.
 *
 * An application declares a permission set. The user sees it once, in the
 * window. This file is how that set is read, what it permits, and how it is
 * put into words. The signer's page uses it to prepare what it is asked, and
 * BitLogin's worker uses the same functions as a floor under that page.
 */
import { cleanName, cleanOrigin } from "./policy.js";

export interface AppPermissions {
  /** What the application calls itself. Shown after the address, never instead of it. */
  name?: string;
  /** Kinds it may have signed. */
  sign: number[];
  /** Prefixes of the `d` tag it may write kind 30078 under. "*" is any. */
  appData: string[];
  /** Other origins it may prove the user's identity to with a web-request proof (kind 27235). Its own is always allowed. */
  proofs: string[];
  /** Kinds whose content it may have decrypted, from a whole signed event. */
  read: number[];
  /** Fixed public keys it may encrypt to and decrypt from, outside any event. */
  peers: string[];
}

export const PERMISSION_CAPS = { kinds: 64, prefixes: 8, origins: 8, peers: 8, prefixChars: 64 } as const;

export const KIND_APP_DATA = 30078;
const KIND_HTTP_PROOF = 27235;
const KIND_FILE_PROOF = 24242;
const KIND_RELAY_PROOF = 22242;
const KIND_SEAL = 13;
const KIND_SAVE = 37304;

/** BitLogin's own names under kind 30078. No application may write them, whatever it was allowed. */
export const RESERVED_APP_DATA_PREFIX = "bitlogin:";

/**
 * Never signed for a site, whatever it declares and whatever the user
 * presses: remote-signer and wallet traffic, NSWP's room signals, and what a
 * world keeps for its visitor (a save, kind 37304: written and opened only by
 * the signer itself, for the world whose it is; embedded/saves.ts).
 */
export const NEVER_FOR_APPS: readonly number[] = [13194, 23194, 23195, 24133, 27301, 37304];

/**
 * Applications BitLogin knows by their address (owner's decision,
 * 2026-11-19; §SW9.10). Two things follow from being here, and nothing else:
 *
 * - The window says so. A look-alike of one of these, at another address,
 *   is shown as an application BitLogin does not know.
 * - `reserved` kinds may be asked for only by the address they are reserved
 *   to. NSWP's passes and grants (27300, 27302, 27303) can give a world a
 *   terminal on the user's own computer, so no other site may have them
 *   signed, whatever it declares and whatever the user presses.
 *
 * It is a list in the code of the sign-in address, changed only by a
 * reviewed release. Someone who serves their own sign-in address serves
 * their own list.
 */
export const KNOWN_APPS: Readonly<Record<string, { name: string; reserved?: readonly number[] }>> = {
  "https://bitvid.network": { name: "Bitvid" },
  "https://beta.bitvid.network": { name: "Bitvid (beta)" },
  "https://unstable.bitvid.network": { name: "Bitvid (unstable)" },
  "https://bitunlock.network": { name: "BitUnlock" },
  "https://portal.bitblocks.network": { name: "BitPortal", reserved: [27300, 27302, 27303] },
  "https://imsatisfied.app": { name: "Satisfied" },
  "https://adzaps.net": { name: "AdZap" },
  "https://www.adzaps.net": { name: "AdZap" },
  "https://tessera.bitblocks.network": { name: "Tessera" },
  "https://bitroad.network": { name: "BitRoad" },
  "https://www.bitroad.network": { name: "BitRoad" }
};

/** Kinds that only a named address may ask for. */
export const RESERVED_KINDS: readonly number[] = [27300, 27302, 27303];
/** NSWP's world grant: a terminal on the user's computer, brought to one world they are building. */
const KIND_WORLD_GRANT = 27303;

/** The name BitLogin knows an address by, or null. */
export function knownAppName(site: string): string | null {
  return Object.hasOwn(KNOWN_APPS, site) ? KNOWN_APPS[site]!.name : null;
}

/**
 * Whether an origin is this machine or this network: localhost, a loopback address, or a private range. Never a
 * public name, whatever it is called.
 */
export function isLocalAddress(origin: unknown): boolean {
  if (typeof origin !== "string" || origin.length > 300) return false;
  let host: string;
  try {
    const u = new URL(origin);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    host = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") return true;
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(host)?.slice(1).map(Number);
  if (!parts || parts.some((n) => n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/**
 * BitLogin's own sign-in addresses: where its window and its panel are served, and the only places a page may
 * name ANOTHER site as the one a wallet connection is for (the panel, answering for a world: §SW20). Anywhere
 * else, a vendored copy in an application, a connection is for the page's own origin and nobody else's.
 */
export const SIGN_IN_ADDRESSES: readonly string[] = ["https://bitlogin.network", "https://bitlogin-beta.vercel.app"];

/** Whether this origin is one of BitLogin's sign-in addresses, or a local copy of one. */
export const isSignInAddress = (origin: unknown): boolean => typeof origin === "string" && (SIGN_IN_ADDRESSES.includes(origin) || isLocalAddress(origin));

/**
 * Where `buy` is taken (docs/paying.md PY11): the test address and a local copy, and not yet BitLogin's real
 * address. A purchase has not been tried end to end against the selling service, so at the real address a site
 * that asks to buy is answered as for a request the signer doesn't know: nobody can pay real sats down a path no one
 * has tried. Opening it there is the owner's decision, made by adding the address here.
 */
export const BUYING_OPEN_AT: readonly string[] = ["https://bitlogin-beta.vercel.app"];
export const buyingOpenAt = (origin: unknown): boolean => typeof origin === "string" && (BUYING_OPEN_AT.includes(origin) || isLocalAddress(origin));

/**
 * The reserved kinds a site may hold, given the address BitLogin itself is running at.
 *
 * At BitLogin's real address they are a named address's and nobody else's. Where BitLogin is itself a local
 * copy (a developer's own machine or network), a site that is also local may hold them: otherwise an
 * application that uses them could not be tried before it is live, and what was tried would not be what
 * ships. A local copy of BitLogin cannot be reached from a page on the internet, and the user is still shown
 * all of it and still has to allow it. Nothing here changes what the real address does.
 */
export function reservedKindsFor(site: string, signInAddress: string): readonly number[] {
  if (Object.hasOwn(KNOWN_APPS, site)) return KNOWN_APPS[site]!.reserved ?? [];
  return isLocalAddress(signInAddress) && isLocalAddress(site) ? RESERVED_KINDS : [];
}

/** Where this code is running: a page's or a worker's own origin. "" where there is none (a test, a script). */
const here = (): string => {
  try {
    return (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
  } catch {
    return "";
  }
};

const reservedFor = (site: string): readonly number[] => reservedKindsFor(site, here());

/** Whether a site holds reserved kinds only because BitLogin and the site are both local copies. For the window to say so. */
export const heldAsLocal = (site: string): boolean => !Object.hasOwn(KNOWN_APPS, site) && reservedFor(site).length > 0;

/**
 * Whether this site may be given this set at all. A set is read without
 * knowing who sent it; this is the question of who. False when it names a
 * reserved kind the site is not the named address for.
 */
export function mayHold(site: string, perms: AppPermissions): boolean {
  const mine = reservedFor(site);
  return [...perms.sign, ...perms.read].every((kind) => !RESERVED_KINDS.includes(kind) || mine.includes(kind));
}

/** Kinds that change how others see the user, or what reaches them. Listed apart in the window. */
export const SENSITIVE_KINDS: readonly number[] = [0, 3, 5, 10000, 10002, 10050, KIND_RELAY_PROOF];

/** Listed with the sensitive kinds in the window, though not counted with them: a file-host proof can delete, and
 *  a pass or a grant lets a world in. */
const WARNED_KINDS: readonly number[] = [...SENSITIVE_KINDS, KIND_FILE_PROOF, ...RESERVED_KINDS];

/** Reading any of these is reading the user's private messages. */
export const MESSAGE_KINDS: readonly number[] = [4, KIND_SEAL, 1059];

const PROOF_KINDS: readonly number[] = [KIND_HTTP_PROOF, KIND_FILE_PROOF, KIND_RELAY_PROOF];

const HEX64 = /^[0-9a-f]{64}$/u;
const isKind = (k: unknown): k is number => typeof k === "number" && Number.isInteger(k) && k >= 0 && k <= 65535;
const distinct = <T>(items: T[]): T[] => [...new Set(items)];

/**
 * Read a permission set as an application sent it. Null for anything that is
 * not exactly one: a set that is wrong in any part is refused whole, because
 * approving part of it would be approving something the user was not shown.
 */
export function readPermissions(input: unknown): AppPermissions | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const list = (v: unknown): unknown[] | null => (v === undefined ? [] : Array.isArray(v) ? v : null);
  const sign = list(p.sign);
  const appData = list(p.appData);
  const proofs = list(p.proofs);
  const read = list(p.read);
  const peers = list(p.peers);
  if (!sign || !appData || !proofs || !read || !peers) return null;
  if (sign.length > PERMISSION_CAPS.kinds || read.length > PERMISSION_CAPS.kinds) return null;
  if (appData.length > PERMISSION_CAPS.prefixes || proofs.length > PERMISSION_CAPS.origins || peers.length > PERMISSION_CAPS.peers) return null;

  if (!sign.every(isKind) || !read.every(isKind)) return null;
  if ((sign as number[]).some((k) => NEVER_FOR_APPS.includes(k))) return null;
  // Nor read one world's save for another: a save is opened only by the signer, for the world whose it is.
  if ((read as number[]).includes(KIND_SAVE)) return null;
  // A set that asks for nothing is not a set.
  if (sign.length === 0 && read.length === 0 && peers.length === 0) return null;

  for (const prefix of appData) {
    if (typeof prefix !== "string" || prefix.length === 0 || prefix.length > PERMISSION_CAPS.prefixChars) return null;
    if (prefix !== "*" && (prefix.startsWith(RESERVED_APP_DATA_PREFIX) || RESERVED_APP_DATA_PREFIX.startsWith(prefix))) return null;
    // One line of ordinary characters: this is shown to the user.
    if (cleanName(prefix) !== prefix) return null;
  }
  // Prefixes mean something only with the kind they belong to, and the kind only with a prefix.
  if (((sign as number[]).includes(KIND_APP_DATA) || (read as number[]).includes(KIND_APP_DATA)) !== appData.length > 0) return null;

  const origins: string[] = [];
  for (const origin of proofs) {
    const clean = cleanOrigin(origin);
    // Exactly an origin, and never plain http to somewhere else.
    if (!clean || clean !== origin || !clean.startsWith("https://")) return null;
    origins.push(clean);
  }
  if (origins.length > 0 && !(sign as number[]).includes(KIND_HTTP_PROOF)) return null;
  if (!peers.every((k) => typeof k === "string" && HEX64.test(k))) return null;

  const name = cleanName(p.name);
  return {
    ...(name ? { name } : {}),
    sign: distinct(sign as number[]).sort((a, b) => a - b),
    appData: distinct(appData as string[]),
    proofs: distinct(origins),
    read: distinct(read as number[]).sort((a, b) => a - b),
    peers: distinct(peers as string[])
  };
}

// ---- Limits (§SW9.6)

export type LimitClass = "quiet" | "public" | "sensitive" | "read";

export const APP_LIMITS: Readonly<Record<LimitClass, { burst: number; perMs: number; hourly: number }>> = {
  /** Proofs, and the application's own data: what applications sign on timers. */
  quiet: { burst: 300, perMs: 60_000, hourly: 6000 },
  public: { burst: 60, perMs: 60_000, hourly: 1200 },
  sensitive: { burst: 30, perMs: 60_000, hourly: 300 },
  read: { burst: 600, perMs: 60_000, hourly: 12_000 }
};

export const APP_SIGN_LIMITS = { contentChars: 100_000, tags: 2500, /** Who someone follows (kind 3) is one note with a tag for each person: more are let through. */ followTags: 20_000, tagItems: 16, tagChars: 1000, clockSlackSec: 600 } as const;

const isAddressable = (kind: number): boolean => kind >= 30000 && kind < 40000;

/** Which count a signature of this kind is taken from. */
export function limitClass(kind: number): Exclude<LimitClass, "read"> {
  // The reserved kinds (a pass, a terminal on the user's computer, access granted to a world) are shown in the
  // window as deserving a second look, and are counted that way too.
  if ((SENSITIVE_KINDS.includes(kind) && kind !== KIND_RELAY_PROOF) || RESERVED_KINDS.includes(kind)) return "sensitive";
  if (PROOF_KINDS.includes(kind) || isAddressable(kind)) return "quiet";
  return "public";
}

// ---- What a set permits

/** The mark put on what is signed for an application: which site asked. */
export const APP_SITE_TAG = "bitlogin:site";

const tagValues = (tags: string[][], name: string): string[] => tags.filter((t) => t[0] === name && typeof t[1] === "string").map((t) => t[1]!);

function allowedAppData(perms: AppPermissions, tags: string[][]): boolean {
  const d = tagValues(tags, "d")[0];
  if (d === undefined || d.startsWith(RESERVED_APP_DATA_PREFIX)) return false;
  return perms.appData.some((prefix) => prefix === "*" || d.startsWith(prefix));
}

/**
 * A web-request proof may only name places the user was shown: the asking
 * site itself, or an origin in the set. One with no address is refused: it
 * would be good anywhere. This is what stops a site from collecting a proof
 * that works at someone else's server.
 *
 * A file-host proof (24242) is not bound this way. File hosts are the user's
 * own choice, often several, and the proof commonly names none of them. So
 * that kind is approved as what it is, and the window says so (see
 * WARNED_KINDS): it can upload and delete the user's files wherever they are.
 */
function allowedWebProof(perms: AppPermissions, site: string, tags: string[][]): boolean {
  const named = tagValues(tags, "u");
  if (named.length === 0) return false;
  return named.every((address) => {
    const origin = cleanOrigin(address);
    return origin !== "" && (origin === site || perms.proofs.includes(origin));
  });
}

export interface PreparedForApp {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * What an application asked to have signed, as it may be signed for that
 * site under that set. Null for anything the set does not cover. This is the
 * one function that decides, and both the signer's page and BitLogin's
 * worker call it.
 */
export function prepareForApp(perms: AppPermissions, input: unknown, siteInput: string, nowSeconds: number): PreparedForApp | null {
  const site = cleanOrigin(siteInput);
  if (!site || !input || typeof input !== "object") return null;
  const e = input as { kind?: unknown; content?: unknown; tags?: unknown; created_at?: unknown };
  if (!isKind(e.kind) || NEVER_FOR_APPS.includes(e.kind) || !perms.sign.includes(e.kind)) return null;
  // A reserved kind is signed only for the address it is reserved to, whatever set this session was given.
  if (RESERVED_KINDS.includes(e.kind) && !reservedFor(site).includes(e.kind)) return null;
  if (typeof e.content !== "string" || e.content.length > APP_SIGN_LIMITS.contentChars) return null;
  if (!Array.isArray(e.tags) || e.tags.length > (e.kind === 3 ? APP_SIGN_LIMITS.followTags : APP_SIGN_LIMITS.tags)) return null;
  const tags: string[][] = [];
  for (const tag of e.tags) {
    if (!Array.isArray(tag) || tag.length === 0 || tag.length > APP_SIGN_LIMITS.tagItems) return null;
    if (!tag.every((item) => typeof item === "string" && item.length <= APP_SIGN_LIMITS.tagChars)) return null;
    // The mark is the signer's to write, under either of its names. One exception: in a world grant (27303),
    // "nswp:world" is not the mark of the site that asked. It is the grant's subject, the one world a terminal
    // may be brought to, and NSWP's Bridge requires exactly one. That kind is signed only for the address it is
    // reserved to (checked above), and still carries the signer's own mark.
    if (tag[0] === APP_SITE_TAG) continue;
    if (tag[0] === "nswp:world") {
      if (e.kind !== KIND_WORLD_GRANT) continue;
      // Exactly one, naming an origin and nothing else. A grant that is not that is not signed at all.
      if (tag.length !== 2 || cleanOrigin(tag[1]) !== tag[1] || tags.some((kept) => kept[0] === "nswp:world")) return null;
    }
    tags.push([...(tag as string[])]);
  }
  if (e.kind === KIND_APP_DATA && !allowedAppData(perms, tags)) return null;
  if (e.kind === KIND_HTTP_PROOF && !allowedWebProof(perms, site, tags)) return null;
  // A seal carries no tags at all (NIP-59), so it cannot carry the mark either.
  if (e.kind === KIND_SEAL) {
    if (tags.length > 0) return null;
  } else {
    tags.push([APP_SITE_TAG, site]);
  }
  const now = Math.floor(nowSeconds);
  const asked = typeof e.created_at === "number" && Number.isInteger(e.created_at) ? e.created_at : now;
  const created_at = Math.abs(asked - now) <= APP_SIGN_LIMITS.clockSlackSec ? asked : now;
  return { kind: e.kind, created_at, tags, content: e.content };
}

/** Whether an application may encrypt to this key outside an event: the user's own, or one they were shown. */
export function mayEncryptTo(perms: AppPermissions, me: string, peer: unknown): peer is string {
  return typeof peer === "string" && HEX64.test(peer) && (peer === me || perms.peers.includes(peer));
}

/** Whether an application may decrypt against this key outside an event: only one the user was shown. */
export function mayDecryptFrom(perms: AppPermissions, peer: unknown): peer is string {
  return typeof peer === "string" && HEX64.test(peer) && perms.peers.includes(peer);
}

/**
 * The key a signed event's content is to be decrypted against, if this set
 * may read it; null if it may not. The caller must already have checked the
 * event's signature. Someone else's event is read against its author; the
 * user's own against the key it was addressed to, or their own.
 */
export function readPeerFor(perms: AppPermissions, me: string, event: { kind?: unknown; pubkey?: unknown; tags?: unknown }): string | null {
  if (!isKind(event.kind) || !perms.read.includes(event.kind)) return null;
  if (typeof event.pubkey !== "string" || !HEX64.test(event.pubkey) || !Array.isArray(event.tags)) return null;
  const tags = (event.tags as unknown[]).filter((t): t is string[] => Array.isArray(t) && t.every((i) => typeof i === "string"));
  if (event.kind === KIND_APP_DATA && !allowedAppData(perms, tags)) return null;
  if (event.pubkey !== me) return event.pubkey;
  const to = tagValues(tags, "p")[0];
  return to !== undefined && HEX64.test(to) ? to : me;
}

/**
 * The keys an event's content may be opened against, in the order to try them. One, as `readPeerFor` has it:
 * and, for an event the user signed themselves that names somebody in a "p" tag, their own key after that. A
 * note an application saved for the user alone is sealed to the user's own key whatever tags it carries, and a
 * "p" tag on it used to make it unreadable. Nothing more is read by this: the event is one the set may read, and
 * the user's own key is what opens it where there is no "p" tag at all.
 */
export function readPeersFor(perms: AppPermissions, me: string, event: { kind?: unknown; pubkey?: unknown; tags?: unknown }): string[] {
  const first = readPeerFor(perms, me, event);
  if (!first) return [];
  return event.pubkey === me && first !== me ? [first, me] : [first];
}

// ---- In words, for the window (§SW9.7)

const KIND_WORDS: Readonly<Record<number, string>> = {
  0: "change your profile",
  1: "post notes",
  3: "change who you follow",
  4: "send private messages (older kind)",
  5: "delete what you have posted",
  6: "repost notes",
  7: "post reactions",
  13: "send private messages",
  15: "send files in private messages",
  16: "repost other things",
  21: "post videos",
  22: "post short videos",
  1063: "post file details",
  1111: "post comments",
  1573: "place orders",
  1984: "report content",
  7376: "record what your Cashu wallet spent",
  9734: "ask for zaps",
  10000: "change who you have muted",
  10002: "change which relays you use",
  10050: "change where private messages reach you",
  20001: "send read receipts",
  20002: "show when you are typing",
  22242: "sign in to relays as you",
  24242: "upload, list and delete your files at file hosts",
  27300: "give worlds a pass that says who you are",
  27302: "let a world open a terminal on a computer of yours",
  27303: "give a world access you have granted it",
  30000: "change your lists",
  30004: "change your lists of worlds",
  30015: "change your interests",
  34235: "post videos",
  34236: "post short videos",
  37300: "announce a world as yours",
  37305: "rate worlds, from one to five stars",
  37306: "post your scores on worlds' boards",
  37307: "show which achievements you hold in worlds",
  37308: "change what is in your bag: the items you carry between worlds"
};

const READ_WORDS: Readonly<Record<number, string>> = {
  4: "read your private messages (older kind)",
  13: "read your private messages",
  1059: "read your private messages",
  1573: "read orders sent to you",
  7375: "read the money in your Cashu wallet",
  7376: "read what your Cashu wallet spent",
  10000: "read who you have muted",
  30000: "read your private lists"
};

export interface PermissionWords {
  ordinary: string[];
  sensitive: string[];
}

const host = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** A permission set in plain words, the ones that deserve a second look apart. `site` is the asking site's origin. */
export function describePermissions(perms: AppPermissions, site: string): PermissionWords {
  const ordinary: string[] = [];
  const sensitive: string[] = [];
  const unknown: number[] = [];
  const add = (list: string[], words: string) => {
    if (!list.includes(words)) list.push(words);
  };

  if (perms.sign.includes(KIND_HTTP_PROOF)) add(ordinary, `prove who you are to ${[host(site), ...perms.proofs.map(host)].join(", ")}`);

  for (const kind of perms.sign) {
    if (kind === KIND_HTTP_PROOF) continue;
    if (kind === KIND_APP_DATA) {
      if (perms.appData.includes("*")) add(sensitive, "save application data under any name, including other applications' data");
      else add(ordinary, `save its own data (${perms.appData.join(", ")})`);
      continue;
    }
    const words = KIND_WORDS[kind];
    if (!words) {
      if (isAddressable(kind)) add(ordinary, `save its own kind of data (kind ${kind})`);
      else unknown.push(kind);
      continue;
    }
    add(WARNED_KINDS.includes(kind) ? sensitive : ordinary, words);
  }
  if (unknown.length > 0) add(ordinary, `sign kinds BitLogin has no words for: ${unknown.join(", ")}`);

  for (const kind of perms.read) {
    if (kind === KIND_APP_DATA) {
      if (perms.appData.includes("*")) add(sensitive, "read application data saved under any name");
      else add(ordinary, "read its own saved data");
      continue;
    }
    const words = READ_WORDS[kind];
    if (words) add(MESSAGE_KINDS.includes(kind) || kind === 7375 ? sensitive : ordinary, words);
    else add(ordinary, isAddressable(kind) ? `read its own kind of data (kind ${kind})` : `read what is encrypted in kind ${kind}`);
  }
  if (perms.peers.length > 0) {
    add(ordinary, `exchange encrypted messages with ${perms.peers.length === 1 ? "one service" : `${perms.peers.length} services`} it names (${perms.peers.map((k) => `${k.slice(0, 8)}…`).join(", ")})`);
  }
  return { ordinary, sensitive };
}
