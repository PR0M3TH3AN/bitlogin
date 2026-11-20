/**
 * Following from inside a world (NSWP-14, "Following from inside a world";
 * NSWP-10, "Asking for more"; docs/sign-in-window.md §SW16b).
 *
 * The pure parts. A world its visitor has let change who they follow hands
 * the signer their newest follow list (kind 3) and one change. The signer
 * makes the change and signs. So a world can't have a list of its own making
 * signed: only one the visitor signed before, with one line changed.
 *
 * A follow list is one note that replaces the last, so a wrong one loses
 * everyone its owner follows. What guards that is here and in the worker
 * (cryptoWorker.ts, `worldFollow`): a real signature by the visitor's own
 * key, never older than the newest list seen, and the worker's own look at
 * the visitor's relays before it believes a world's.
 *
 * The shapes match NSWP's `changeFollows` and `followForWorld`, and are
 * checked against its vectors (vectors/people.json, `fromAWorld`).
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";

export const FOLLOWS_KIND = 3;

/** How often, for one world: the pace of a person pressing a button, never of a script. */
export const FOLLOW_LIMITS = { burst: 6, perMs: 60_000, hourly: 60 } as const;

export const FOLLOW_LIST_LIMITS = {
  /** A list handed over to be changed is not read past this many tags, or this much content. */
  tags: 20_000,
  contentChars: 100_000,
  tagItems: 16,
  tagChars: 1000
} as const;

/**
 * What a world may ask to be let do beyond a note and a reaction, by name:
 * a short closed list, each one thing a person can be asked in a few plain
 * words. None is "sign whatever I hand you".
 *
 * - "follows": follow and unfollow people for them, one at a time (this file).
 * - "messages": send and read their private messages (messages.ts).
 */
export const WORLD_MORE = ["follows", "messages"] as const;
export type WorldMore = (typeof WORLD_MORE)[number];

/** The names that are on the list, each once, in the list's order. Empty for anything else. */
export function cleanMore(input: unknown): WorldMore[] {
  return Array.isArray(input) ? WORLD_MORE.filter((name) => input.includes(name)) : [];
}

/** The marks a signer puts on what it signs for a site. Never carried from one follow list into the next. */
const SITE_MARKS: readonly string[] = ["nswp:world", "bitlogin:site"];
const HEX64 = /^[0-9a-f]{64}$/u;

export interface UnsignedFollows {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
}

/**
 * A follow list with one person added or taken out, ready to be signed by
 * its owner. Null when there is nothing to sign: no change or two, a key
 * that isn't one, following oneself, someone already followed, someone not
 * followed, or no list to change unless `fromNothing`.
 *
 * Everything else in the list is kept as it was and in its order: other
 * people, the relay and name each was written with, tags of other kinds, and
 * the content, where older clients keep their relays.
 */
export function changeFollows(
  newest: Pick<NostrEvent, "kind" | "pubkey" | "created_at" | "tags" | "content"> | null,
  change: { add?: unknown; remove?: unknown; nowSeconds: number; fromNothing?: boolean; /** Whose list a first one is. */ pubkey?: string }
): UnsignedFollows | null {
  if (newest && (newest.kind !== FOLLOWS_KIND || !Array.isArray(newest.tags))) return null;
  if (!newest && !change.fromNothing) return null;
  const add = typeof change.add === "string" ? change.add.toLowerCase() : "";
  const remove = typeof change.remove === "string" ? change.remove.toLowerCase() : "";
  // One thing at a time: a press is one person.
  if ((add === "") === (remove === "")) return null;
  const who = add || remove;
  if (!HEX64.test(who) || (add && (newest?.pubkey ?? change.pubkey) === add)) return null;
  const had = newest ? newest.tags.filter((t) => Array.isArray(t) && t.every((item) => typeof item === "string") && !SITE_MARKS.includes(t[0] ?? "")) : [];
  const names = (t: string[]): boolean => t[0] === "p" && typeof t[1] === "string" && t[1].toLowerCase() === who;
  const follows = had.some(names);
  if (add ? follows : !follows) return null;
  const tags = add ? [...had.map((t) => [...t]), ["p", add]] : had.filter((t) => !names(t)).map((t) => [...t]);
  // Never older than the one it replaces: a relay would keep the old one.
  const created_at = Math.max(Math.floor(change.nowSeconds), newest ? newest.created_at + 1 : 0);
  return { kind: FOLLOWS_KIND, created_at, tags, content: typeof newest?.content === "string" ? newest.content : "" };
}

/** A follow list as it may be handed over: the visitor's own, really signed, and of a size that is read. */
export function readFollowList(list: unknown, pubkey: string): NostrEvent | null {
  if (!list || typeof list !== "object") return null;
  const l = list as { kind?: unknown; pubkey?: unknown; tags?: unknown; content?: unknown };
  if (l.kind !== FOLLOWS_KIND || l.pubkey !== pubkey || !Array.isArray(l.tags) || l.tags.length > FOLLOW_LIST_LIMITS.tags) return null;
  if (typeof l.content !== "string" || l.content.length > FOLLOW_LIST_LIMITS.contentChars) return null;
  for (const tag of l.tags) {
    if (!Array.isArray(tag) || tag.length > FOLLOW_LIST_LIMITS.tagItems || !tag.every((item) => typeof item === "string" && item.length <= FOLLOW_LIST_LIMITS.tagChars)) return null;
  }
  return verifyNostrEvent(list) ? list : null;
}

/**
 * What a signer signs when a world it was let asks for one person to be
 * followed or unfollowed. Null for anything else.
 *
 * `list` null is "they have none yet": refused once `seen` says there was
 * one. A list older than `seen` is refused: a world can't take its visitor
 * back to an old list. `seen` is the time of the newest list of theirs the
 * signer has signed, been handed, or found on their relays.
 */
export function followForWorld(o: { list: unknown; add?: unknown; remove?: unknown; pubkey: string; nowSeconds: number; seen?: number }): UnsignedFollows | null {
  const change = { add: o.add, remove: o.remove, nowSeconds: o.nowSeconds, pubkey: o.pubkey };
  if (o.list === null || o.list === undefined) return o.seen ? null : changeFollows(null, { ...change, fromNothing: true });
  const list = readFollowList(o.list, o.pubkey);
  if (!list) return null;
  if (o.seen && list.created_at < o.seen) return null;
  return changeFollows(list, change);
}

/**
 * Whether a world's word about a list may be believed, given what the
 * signer's own look at the visitor's relays found (`answered`: how many
 * relays answered; `newestAt`: the newest list of theirs any had, or 0).
 *
 * - A list older than one a relay has is refused: the world is behind.
 * - "They have none" is believed only where a relay answered and had none.
 *   With no relay answering it is refused: a list written from nothing
 *   replaces one that merely couldn't be reached.
 * - A list handed over stands where no relay answered: it is theirs, signed,
 *   and not older than any seen before.
 */
export function believedList(list: Pick<NostrEvent, "created_at"> | null, found: { answered: number; newestAt: number }): boolean {
  if (list === null) return found.answered > 0 && found.newestAt === 0;
  return list.created_at >= found.newestAt;
}
