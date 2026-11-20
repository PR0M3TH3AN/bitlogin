/**
 * What a world keeps for its visitor: a save (NSWP-12, protocol/12-saves.md;
 * docs/sign-in-window.md §SW16a).
 *
 * The pure parts, and the whole of the signer's side. A save is a note of
 * its own kind (37304), signed by the visitor's key and encrypted to that
 * same key, so that it is there on their next device and only they can read
 * it. A world never names where a save is kept: the signer works that out
 * from the address of the world that asked, as the browser gave it. So a
 * world writes and reads its own saves and nobody else's, and nothing on a
 * relay says which worlds someone has been to.
 *
 * The shapes here match NSWP's `saveAddress`, `sealSave` and `openSave`, and
 * are checked against its vectors (vectors/saves.json).
 */
import { bytesToHex, hmacSha256, nip44Decrypt, nip44Encrypt, utf8ToBytes } from "@bitlogin/core/crypto";
import { cleanOrigin } from "./policy.js";

export const SAVE_KIND = 37304;

export const SAVE_LIMITS = {
  /** The most a save may hold, in bytes of UTF-8. It has to fit in one note that any relay will take. */
  dataBytes: 32_768,
  /** No more saves than this for one world in `perMs`, and in an hour. Counted apart from notes and passes. */
  burst: 6,
  perMs: 60_000,
  hourly: 60,
  /** A save handed over to be opened is not read past this many characters of content. */
  contentChars: 70_000
} as const;

const SLOT = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const HEX64 = /^[0-9a-f]{64}$/u;
const ALT = "Something a world keeps for its visitor. Only they can read it.";

/** A slot's name as it may be used: lower-case letters, digits and hyphens, 32 at most. "" for anything else. */
export function cleanSlot(input: unknown): string {
  return typeof input === "string" && SLOT.test(input) ? input : "";
}

/** Whether these words may be a save: text, within the limit. */
export function fitsInSave(data: unknown): data is string {
  return typeof data === "string" && data.length <= SAVE_LIMITS.dataBytes && utf8ToBytes(data).length <= SAVE_LIMITS.dataBytes;
}

/**
 * Where one world's save in one slot is kept: the save's `d`. Made from the
 * visitor's own secret (their key's NIP-44 conversation key with itself), so
 * only their signer can work it out. "" if the world or the slot can't be used.
 */
export function saveAddress(conversationKey: Uint8Array, world: string, slot: string): string {
  const origin = cleanOrigin(world);
  const name = cleanSlot(slot);
  if (!origin || !name) return "";
  return bytesToHex(hmacSha256(conversationKey, utf8ToBytes(`nswp-save\n${origin}\n${name}`)));
}

export interface UnsignedSave {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * A save, ready to be signed by the visitor's key. The world and the slot
 * are written inside what is encrypted, so that opening it checks them
 * again. Null if anything is wrong with what was asked.
 */
export function sealSave(o: { conversationKey: Uint8Array; world: string; slot: unknown; data: unknown; nowSeconds: number }): UnsignedSave | null {
  const origin = cleanOrigin(o.world);
  const slot = cleanSlot(o.slot);
  const d = saveAddress(o.conversationKey, origin, slot);
  if (!d || !fitsInSave(o.data)) return null;
  const inside = JSON.stringify({ v: 1, world: origin, slot, data: o.data });
  return {
    kind: SAVE_KIND,
    created_at: Math.floor(o.nowSeconds),
    tags: [
      ["d", d],
      ["alt", ALT]
    ],
    content: nip44Encrypt(o.conversationKey, inside)
  };
}

export interface OpenedSave {
  slot: string;
  data: string;
  /** When it was saved, in seconds, as its signer wrote it. */
  at: number;
}

/**
 * Open a save for the world that asks. Opened only if it is the visitor's
 * own, of this kind, and what is inside says it is that world's, in the slot
 * its address is for. Null for anything else: another world's save is never
 * opened for this one, whatever it was handed.
 *
 * The caller checks the signature first.
 */
export function openSave(event: unknown, o: { conversationKey: Uint8Array; pubkey: string; world: string }): OpenedSave | null {
  const origin = cleanOrigin(o.world);
  if (!origin || !event || typeof event !== "object" || !HEX64.test(o.pubkey)) return null;
  const e = event as { kind?: unknown; pubkey?: unknown; content?: unknown; tags?: unknown; created_at?: unknown };
  if (e.kind !== SAVE_KIND || e.pubkey !== o.pubkey || typeof e.content !== "string" || e.content.length > SAVE_LIMITS.contentChars || !Array.isArray(e.tags)) return null;
  let inside: { v?: unknown; world?: unknown; slot?: unknown; data?: unknown };
  try {
    inside = JSON.parse(nip44Decrypt(o.conversationKey, e.content)) as typeof inside;
  } catch {
    return null;
  }
  if (!inside || typeof inside !== "object" || inside.v !== 1 || inside.world !== origin) return null;
  const slot = cleanSlot(inside.slot);
  if (!slot || !fitsInSave(inside.data)) return null;
  // The address it was kept at must be the one this world's slot has: a save moved to another address is refused.
  const d = (e.tags as unknown[]).find((t): t is string[] => Array.isArray(t) && t[0] === "d");
  if (!d || d[1] !== saveAddress(o.conversationKey, origin, slot)) return null;
  return { slot, data: inside.data, at: typeof e.created_at === "number" && Number.isInteger(e.created_at) ? e.created_at : 0 };
}
