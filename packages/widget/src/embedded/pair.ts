/**
 * Signing in a headset from your phone (docs/pair-a-headset.md): the parts that need no key and no relay. The code a
 * headset shows, its hash (what the offer carries, so no relay sees a code), the offer read back, the label a headset
 * is named by, and the three numbers the phone offers to match.
 */
import { labelSalt } from "@bitlogin/core/crypto";
import { cleanOrigin } from "./policy.js";

/** The kind both notes are sent as: ephemeral, passed on by relays and kept by none (the orchestrator's, 2026-11-25). */
export const PAIR_KIND = 27304;
/** How long an offer, and so a code, lasts. */
export const PAIR_TTL_SEC = 300;
/** How long a note from the phone lasts. */
export const ANSWER_TTL_SEC = 120;
/** The offer's tag naming the code, by its hash. */
export const PAIR_TAG = "nswp:pair";

/** Crockford base32: digits and letters, without I, L, O and U, which are read as others. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A new code: eight characters, shown as two groups of four, like K7QF-3MPX. */
export function makeCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const chars = Array.from(bytes, (b) => ALPHABET[b & 31]!).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}

/** A code as a person typed it, made into the one shown: "" where it isn't one. */
export function normalizeCode(input: unknown): string {
  if (typeof input !== "string") return "";
  const plain = input.toUpperCase().replace(/[\s-]/gu, "").replace(/O/gu, "0").replace(/[IL]/gu, "1");
  if (plain.length !== 8 || ![...plain].every((c) => ALPHABET.includes(c))) return "";
  return `${plain.slice(0, 4)}-${plain.slice(4)}`;
}

/** What an offer names the code by: SHA-256 of the code as shown, in hex. "" for what isn't a code. */
export function codeHash(input: unknown): string {
  const code = normalizeCode(input);
  return code ? Array.from(labelSalt(`bitlogin/pair/v1:${code}`), (b) => b.toString(16).padStart(2, "0")).join("") : "";
}

/** The QR's address: the code in the fragment, which a browser sends to no server. */
export const pairUrl = (signIn: string, code: string): string => `${signIn}/pair/#${code}`;

/** An offer, read back: the headset's one-time key, the code's hash, the site it is at, its label, until when. */
export interface PairOffer {
  id: string;
  /** The headset's one-time public key: what the phone seals to. */
  key: string;
  hash: string;
  site: string;
  device: string;
  expires: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const tag = (tags: unknown, name: string): string | undefined => (Array.isArray(tags) ? (tags.find((t) => Array.isArray(t) && t[0] === name && typeof t[1] === "string") as string[] | undefined)?.[1] : undefined);

/** An offer, where the event is one and is in date: null otherwise. Its signature is checked where it is received. */
export function readOffer(event: unknown, nowSeconds: number): PairOffer | null {
  const e = event as { id?: unknown; kind?: unknown; pubkey?: unknown; tags?: unknown; content?: unknown } | null;
  if (!e || e.kind !== PAIR_KIND || typeof e.id !== "string" || typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return null;
  const hash = tag(e.tags, PAIR_TAG);
  const origin = tag(e.tags, "nswp:origin");
  const expires = Number(tag(e.tags, "expiration"));
  const site = cleanOrigin(origin);
  if (!hash || !HEX64.test(hash) || !site || site !== origin) return null;
  // In date, and for no more than the five minutes a code lasts (and a little for clocks that differ).
  if (!Number.isSafeInteger(expires) || expires <= nowSeconds || expires > nowSeconds + PAIR_TTL_SEC + 30) return null;
  let device = "a device";
  try {
    const said = (JSON.parse(String(e.content ?? "")) as { device?: unknown }).device;
    if (typeof said === "string" && said.length > 0 && said.length <= 48 && /^[\p{L}\p{N} ._()-]+$/u.test(said)) device = said;
  } catch {
    /* "a device" */
  }
  return { id: e.id, key: e.pubkey, hash, site, device, expires };
}

/** What a headset is called on the phone, from its browser's own name for itself. Nothing more is read from it. */
export function deviceLabel(userAgent: string): string {
  if (/OculusBrowser|Quest/u.test(userAgent)) return "Meta Quest Browser";
  if (/PicoBrowser|Pico/u.test(userAgent)) return "Pico Browser";
  if (/Wolvic/u.test(userAgent)) return "Wolvic";
  if (/visionOS|Vision Pro/u.test(userAgent)) return "Apple Vision Pro";
  return "a browser";
}

/** The three numbers the phone offers, from 10 to 99: the right one and two others, in no order that gives it away. */
export function numberChoices(right: number): number[] {
  const pick = () => 10 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 90);
  const choices = new Set([right]);
  while (choices.size < 3) choices.add(pick());
  const list = [...choices];
  for (let i = list.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0]! % (i + 1);
    [list[i], list[j]] = [list[j]!, list[i]!];
  }
  return list;
}

/** A random number for the phone to send, from 10 to 99. */
export const pairNumber = (): number => 10 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 90);
