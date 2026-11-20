/**
 * Private messages from inside a world (NSWP-14, "Messages from inside a
 * world"; NSWP-10, "Asking for more"; docs/sign-in-window.md §SW16c).
 *
 * The pure parts. A message is Nostr's own (NIP-17): written as a note that
 * is never signed or published (kind 14), sealed to its reader in a note the
 * sender signs (kind 13), and wrapped in a note signed by a key used once
 * (kind 1059). A world its visitor has let do this, by name, asks the signer
 * to seal a message it names the reader and the words of, and to open a wrap
 * a relay gave it. The world is never given a key, and can't have anything
 * else encrypted or decrypted.
 *
 * This is the largest thing a world can be let do. It can read every private
 * message to the visitor that it can find, and write as them to anyone.
 * Nothing here can stop a world that means to send what it read elsewhere:
 * that is the trust the visitor gives, and why it is asked by name, in plain
 * words, for one world at a time.
 *
 * The shapes match NSWP's `sealMessage`, `openWrap` and `buildMessageRelays`,
 * and are checked against its vectors (vectors/people.json).
 */
import { computeEventId, verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";

export const MESSAGE_KIND = 14;
export const SEAL_KIND = 13;
export const WRAP_KIND = 1059;
/** Where someone's private messages reach them (NIP-17). */
export const MESSAGE_RELAYS_KIND = 10050;

export const MESSAGE_LIMITS = {
  /** The most characters in one message. */
  chars: 2000,
  /** No more than this many relays are put in a list of where messages reach someone. */
  relays: 4,
  /** A wrap handed over to be opened is not read past this many characters of content. */
  wrapChars: 60_000
} as const;

/** How often a world may have a message sealed: the pace of a person writing. */
export const MESSAGE_WORLD_LIMITS = { burst: 10, perMs: 60_000, hourly: 200 } as const;
/** How often it may have one opened: a first look reads some hundreds in a row. */
export const UNWRAP_WORLD_LIMITS = { burst: 600, perMs: 60_000, hourly: 12_000 } as const;
/** How often it may have the list of where messages reach them signed: a setting, changed rarely. */
export const REACH_WORLD_LIMITS = { burst: 3, perMs: 60_000, hourly: 12 } as const;

const HEX64 = /^[0-9a-f]{64}$/u;

/** Code points never shown in a message: controls other than a new line, and the invisible ones that reorder or hide text. */
const UNSEEN: readonly (readonly [number, number])[] = [
  [0x00, 0x09],
  [0x0b, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200c],
  [0x200e, 0x200f],
  [0x2028, 0x202f],
  [0x2060, 0x206f],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb]
];

/** A message's words as they may be sent and shown: plain text, new lines kept (two together at most), nothing invisible, at most 2,000 characters. */
export function cleanMessage(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text.slice(0, MESSAGE_LIMITS.chars * 8).normalize("NFC")) {
    const code = ch.codePointAt(0)!;
    out += UNSEEN.some(([from, to]) => code >= from && code <= to) ? " " : ch;
  }
  out = out
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ ?\n ?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return [...out].slice(0, MESSAGE_LIMITS.chars).join("").trim();
}

/** What a signer needs to hold to seal and open: the visitor's key, never handed out. */
export interface MessageKey {
  getPublicKey(): string;
  signEvent(input: { kind: number; created_at: number; tags: string[][]; content: string }): NostrEvent;
  nip44Encrypt(peer: string, plaintext: string): string;
  nip44Decrypt(peer: string, payload: string): string;
}

export interface WrittenMessage {
  kind: number;
  pubkey: string;
  created_at: number;
  tags: string[][];
  content: string;
  id: string;
}

/** A message from one person to another, written and not signed. Null if either key isn't one, they are the same, or there are no words. */
export function buildMessage(o: { from: string; to: unknown; text: unknown; nowSeconds: number }): WrittenMessage | null {
  const text = cleanMessage(o.text);
  if (!HEX64.test(o.from) || typeof o.to !== "string" || !HEX64.test(o.to) || o.from === o.to || !text) return null;
  const written = { kind: MESSAGE_KIND, pubkey: o.from, created_at: Math.floor(o.nowSeconds), tags: [["p", o.to]], content: text };
  return { ...written, id: computeEventId(written) };
}

/**
 * Write a message and seal it twice: to its reader, and to its writer to
 * read back. The message, its writer, its one reader and its time are the
 * signer's own. Whoever asked wraps each seal and sends it. Null if the
 * reader isn't a key, is the writer, or there are no words.
 */
export function sealMessage(key: MessageKey, o: { to: unknown; text: unknown; nowSeconds: number }): { message: WrittenMessage; seals: [NostrEvent, NostrEvent] } | null {
  const from = key.getPublicKey();
  const message = buildMessage({ from, to: o.to, text: o.text, nowSeconds: o.nowSeconds });
  if (!message) return null;
  const inside = JSON.stringify(message);
  // A seal has no tags, so nothing on it says who it is for.
  const seal = (reader: string) => key.signEvent({ kind: SEAL_KIND, created_at: Math.floor(o.nowSeconds), tags: [], content: key.nip44Encrypt(reader, inside) });
  return { message, seals: [seal(message.tags[0]![1]!), seal(from)] };
}

export interface ReadMessage {
  /** Worked out here from what it says, never taken from it. */
  id: string;
  /** Who wrote it: the key that signed the seal. */
  from: string;
  to: string[];
  text: string;
  at: number;
}

function readSeal(opened: string): NostrEvent | null {
  let seal: unknown;
  try {
    seal = JSON.parse(opened);
  } catch {
    return null;
  }
  if (!verifyNostrEvent(seal) || seal.kind !== SEAL_KIND || seal.tags.length !== 0) return null;
  return seal;
}

function readMessage(opened: string, sealedBy: string, reader: string): ReadMessage | null {
  let m: { kind?: unknown; pubkey?: unknown; created_at?: unknown; tags?: unknown; content?: unknown };
  try {
    m = JSON.parse(opened) as typeof m;
  } catch {
    return null;
  }
  // A message that says it is from one person, sealed by another, is somebody passing themselves off.
  if (!m || typeof m !== "object" || m.kind !== MESSAGE_KIND || m.pubkey !== sealedBy || typeof m.pubkey !== "string" || !HEX64.test(m.pubkey)) return null;
  if (typeof m.content !== "string" || typeof m.created_at !== "number" || !Number.isInteger(m.created_at) || !Array.isArray(m.tags)) return null;
  if (!m.tags.every((t): t is string[] => Array.isArray(t) && t.every((item) => typeof item === "string"))) return null;
  const to = [...new Set(m.tags.filter((t) => t[0] === "p" && typeof t[1] === "string" && HEX64.test(t[1])).map((t) => t[1]!))];
  const text = cleanMessage(m.content);
  if (to.length === 0 || !text || (m.pubkey !== reader && !to.includes(reader))) return null;
  const id = computeEventId({ kind: MESSAGE_KIND, pubkey: m.pubkey, created_at: m.created_at, tags: m.tags, content: m.content });
  return { id, from: m.pubkey, to, text, at: m.created_at };
}

/**
 * Open a wrap for the visitor whose key this is: both layers, and every
 * check. Null unless it is a wrap for them with a real signature, holding a
 * real seal with no tags, holding a message written by whoever signed the
 * seal, with words, that they wrote or are one of the readers of.
 */
export function openWrap(key: MessageKey, wrap: unknown): ReadMessage | null {
  const reader = key.getPublicKey();
  if (!wrap || typeof wrap !== "object") return null;
  const w = wrap as { kind?: unknown; content?: unknown; tags?: unknown };
  if (w.kind !== WRAP_KIND || typeof w.content !== "string" || w.content.length > MESSAGE_LIMITS.wrapChars || !Array.isArray(w.tags) || w.tags.length > 20) return null;
  if (!verifyNostrEvent(wrap) || !wrap.tags.some((t) => t[0] === "p" && t[1] === reader)) return null;
  try {
    const seal = readSeal(key.nip44Decrypt(wrap.pubkey, wrap.content));
    if (!seal) return null;
    return readMessage(key.nip44Decrypt(seal.pubkey, seal.content), seal.pubkey, reader);
  } catch {
    return null;
  }
}

/** A relay's address as it may be listed: `wss`, a public name, no credentials, at most 200 characters. "" for anything else. Matches NSWP's `cleanRelayUrl`. */
export function cleanMessageRelay(url: unknown): string {
  if (typeof url !== "string" || url.length > 200) return "";
  try {
    const u = new URL(url.trim());
    const host = u.hostname;
    if (u.protocol !== "wss:" || u.username || u.password) return "";
    if (!host.includes(".") || host.startsWith("[") || /^[0-9.]+$/u.test(host) || /\.(local|localhost|internal|lan|home)$/iu.test(host)) return "";
    u.hash = "";
    return u.href.replace(/\/$/u, "");
  } catch {
    return "";
  }
}

/** A list of where someone's private messages reach them, ready to be signed by them. Null with no usable relay. */
export function buildMessageRelays(relays: unknown, nowSeconds: number): { kind: number; created_at: number; tags: string[][]; content: string } | null {
  if (!Array.isArray(relays) || relays.length > 8) return null;
  const clean = [...new Set(relays.map(cleanMessageRelay).filter(Boolean))].slice(0, MESSAGE_LIMITS.relays);
  if (clean.length === 0) return null;
  return { kind: MESSAGE_RELAYS_KIND, created_at: Math.floor(nowSeconds), tags: clean.map((url) => ["relay", url]), content: "" };
}
