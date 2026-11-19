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

export const SIGNER_PROTOCOL = "nswp-signer";
export const HANDOFF_PROTOCOL = "nswp-handoff";
export const PROTOCOL_VERSION = 1;

export const SIGN_LIMITS = {
  /** The longest a note's content may be, in characters. */
  contentChars: 8000,
  tags: 60,
  tagItems: 8,
  tagChars: 400,
  /** How long an unlocked signer stays unlocked for a site, at most, in seconds. Closing the site's page ends it sooner. */
  grantSec: 4 * 3600,
  /** No more than this many signatures for one site in `perMs`. */
  burst: 6,
  perMs: 60_000,
  /** And no more than this many in an hour. */
  hourly: 60
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
  const origin = cleanOrigin(site);
  if (!origin || !input || typeof input !== "object") return null;
  const e = input as { kind?: unknown; content?: unknown; tags?: unknown };
  if (signClass(e.kind) !== "ordinary") return null;
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
}

/** One site's signatures, counted: a site the user said yes to still can't pour notes out under their name. */
export function createSignGate(limits: { burst: number; perMs: number; hourly: number } = SIGN_LIMITS): SignGate {
  let times: number[] = [];
  return {
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
  | { t: "sign"; id: string; event: unknown };

export type SignerReply =
  | { t: "ready" }
  | { t: "state"; id?: string; unlocked: boolean; pubkey?: string; name?: string; until?: number }
  | { t: "signed"; id: string; event: NostrEvent }
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
  if (d.t === "lock") return { t: "lock", id: d.id };
  if (d.t === "sign" && d.event && typeof d.event === "object") return { t: "sign", id: d.id, event: d.event };
  return null;
}

// ---- What BitLogin's window and its own signer say to each other, across the asking site's page. Only ever
// delivered between two pages of this origin: the browser sees to that, and each side checks it.

export type HandoffMessage =
  /** Window to every frame of the page that opened it: "is one of you mine?" */
  | { t: "hello"; nonce: string }
  /** Signer to window: which site embeds it (as the browser says), and a throwaway key to seal the hand-off to. */
  | { t: "frame"; nonce: string; world: string; recipient: string }
  /** Window to signer, after the user pressed Allow: the sealed hand-off, for that site. */
  | { t: "grant"; nonce: string; world: string; sealed: { senderPublicKey: string; payload: string }; name?: string }
  /** Signer to window: it is unlocked, or it could not be. */
  | { t: "done"; nonce: string; ok: boolean };

export const handoffMessage = (message: HandoffMessage): Record<string, unknown> => ({ nswp: HANDOFF_PROTOCOL, v: PROTOCOL_VERSION, ...message });

export function readHandoffMessage(data: unknown): HandoffMessage | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.nswp !== HANDOFF_PROTOCOL || d.v !== PROTOCOL_VERSION || typeof d.nonce !== "string" || !ID.test(d.nonce)) return null;
  const hex = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);
  if (d.t === "hello") return { t: "hello", nonce: d.nonce };
  if (d.t === "frame" && cleanOrigin(d.world) && hex(d.recipient)) return { t: "frame", nonce: d.nonce, world: cleanOrigin(d.world), recipient: d.recipient };
  if (d.t === "grant" && cleanOrigin(d.world) && d.sealed && typeof d.sealed === "object") {
    const s = d.sealed as Record<string, unknown>;
    if (!hex(s.senderPublicKey) || typeof s.payload !== "string" || s.payload.length > 4000) return null;
    const name = cleanName(d.name);
    return { t: "grant", nonce: d.nonce, world: cleanOrigin(d.world), sealed: { senderPublicKey: s.senderPublicKey, payload: s.payload }, ...(name ? { name } : {}) };
  }
  if (d.t === "done" && typeof d.ok === "boolean") return { t: "done", nonce: d.nonce, ok: d.ok };
  return null;
}
