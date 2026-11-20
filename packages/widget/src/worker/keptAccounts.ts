/**
 * The accounts kept signed in on this device (docs/account-switching.md):
 * the list, which holds nothing secret.
 *
 * Each account's session is in a slot of its own (sessionCache.ts,
 * `keptSlot`), encrypted as the active one is, and sealed under the lock
 * where the lock is on. This list says which slots there are and what to
 * call them: a public key, and the name, picture and line from the account's
 * own signed profile as they were last read. It is what a chooser shows.
 *
 * The accounts are separate: separate credentials, separate keys, separate
 * recovery phrases. Nothing here links them anywhere but on this device.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import { encodeNpub } from "@bitlogin/core/nostr";
import { cleanName } from "../embedded/policy.js";
import { readProfile } from "../embedded/profile.js";

export const KEPT_ACCOUNTS_KEY = "bitlogin:kept-accounts:v1";
export const KEPT_LIMITS = {
  /** No more accounts than this are kept on one device. The one least lately used goes first. */
  accounts: 8
} as const;

export interface KeptAccount {
  pubkey: string;
  npub: string;
  /** The name from their own signed profile, or the login name where there is none. */
  name?: string;
  picture?: string;
  about?: string;
  /** When it was last signed in to or switched to, in seconds. */
  at: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;

function readEntry(input: unknown): KeptAccount | null {
  if (!input || typeof input !== "object") return null;
  const e = input as Record<string, unknown>;
  if (typeof e.pubkey !== "string" || !HEX64.test(e.pubkey)) return null;
  const profile = readProfile({ name: e.name, picture: e.picture, about: e.about }) ?? {};
  const at = typeof e.at === "number" && Number.isFinite(e.at) && e.at > 0 ? Math.floor(e.at) : 0;
  let npub: string;
  try {
    // Made from the key, never read back: a list that was tampered with cannot show one key for another.
    npub = encodeNpub(e.pubkey);
  } catch {
    return null;
  }
  return { pubkey: e.pubkey, npub, ...profile, at };
}

/** The list as it was stored, read again: anything that is not an entry is dropped. Most lately used first. */
export function readKept(raw: string | null | undefined): KeptAccount[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: KeptAccount[] = [];
  for (const entry of parsed.slice(0, KEPT_LIMITS.accounts * 2)) {
    const clean = readEntry(entry);
    if (!clean || seen.has(clean.pubkey)) continue;
    seen.add(clean.pubkey);
    out.push(clean);
  }
  return out.sort((a, b) => b.at - a.at).slice(0, KEPT_LIMITS.accounts);
}

/**
 * Put an account on the list, or bring it to the front. What it was called
 * before is kept where nothing new is said. Returns the new list, and the
 * accounts that fell off the end: their slots are the caller's to remove.
 */
export function keep(list: readonly KeptAccount[], pubkey: string, nowSeconds: number, more: { name?: unknown; picture?: unknown; about?: unknown } = {}): { list: KeptAccount[]; dropped: string[] } {
  const before = list.find((entry) => entry.pubkey === pubkey);
  const entry = readEntry({
    pubkey,
    at: nowSeconds,
    name: cleanName(more.name) || before?.name,
    picture: more.picture ?? before?.picture,
    about: more.about ?? before?.about
  });
  if (!entry) return { list: [...list], dropped: [] };
  const all = [entry, ...list.filter((other) => other.pubkey !== pubkey)];
  return { list: all.slice(0, KEPT_LIMITS.accounts), dropped: all.slice(KEPT_LIMITS.accounts).map((gone) => gone.pubkey) };
}

/** What an account is called, where its profile has been read since: its place in the list does not change. */
export function describe(list: readonly KeptAccount[], pubkey: string, more: { name?: unknown; picture?: unknown; about?: unknown }): KeptAccount[] {
  return list.map((entry) => (entry.pubkey === pubkey ? (readEntry({ ...entry, name: cleanName(more.name) || entry.name, picture: more.picture ?? entry.picture, about: more.about ?? entry.about }) ?? entry) : entry));
}

export const forget = (list: readonly KeptAccount[], pubkey: string): KeptAccount[] => list.filter((entry) => entry.pubkey !== pubkey);

export async function loadKept(store: KeyValueStore): Promise<KeptAccount[]> {
  try {
    return readKept(await store.get(KEPT_ACCOUNTS_KEY));
  } catch {
    return [];
  }
}

export async function saveKept(store: KeyValueStore, list: readonly KeptAccount[]): Promise<void> {
  try {
    if (list.length === 0) await store.delete(KEPT_ACCOUNTS_KEY);
    else await store.set(KEPT_ACCOUNTS_KEY, JSON.stringify(list));
  } catch {
    // Best-effort: an account that is not on the list is signed in to again the ordinary way.
  }
}
