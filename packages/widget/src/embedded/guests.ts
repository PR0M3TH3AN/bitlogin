/**
 * A world owner's guest list and block list (NSWP docs/plans/a-world-by-invitation.md; the shape is BitGate's,
 * docs/governance-lists.md in PR0M3TH3AN/bitgate, read here by its vectors).
 *
 * A list is one note of kind 30078, signed by the world's keeper, naming a world and one person per `p` tag. Newer
 * replaces older. Anyone can read it: it is published on purpose (owner, 2026-11-21).
 *
 * A world never signs one. It asks BitLogin, which shows the owner the one change in words on its own page, every
 * time, and builds the new list itself from the newest one and that change. This file is the part with no key and
 * no network: reading a list, the one change, and who the keepers of a world are by its own manifest.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";

export const LIST_KIND = 30078;
export const LIST_NAMESPACE = "nswp";
export const OWNER_LIST_LIMITS = { read: 2000, write: 500, ahead: 600, root: 4 } as const;
export type ListScope = "user-allow" | "user-deny";
export type ListRefusal =
  | "not_an_event"
  | "wrong_kind"
  | "bad_d"
  | "unsupported_version"
  | "unsupported_scope"
  | "bad_subject"
  | "tag_mismatch"
  | "wrong_signer"
  | "content_not_empty"
  | "too_many_entries"
  | "from_the_future"
  | "bad_signature";
export interface OwnerList {
  ok: true;
  scope: ListScope;
  subject: string;
  signer: string;
  entries: string[];
  skipped: number;
}
export type ListRead = OwnerList | { ok: false; reason: ListRefusal };

const HEX64 = /^[0-9a-f]{64}$/u;
const HEX128 = /^[0-9a-f]{128}$/u;
const NAMESPACE = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const D = /^([^:]*):governance:([^:]*):v([^:]*):([\s\S]*)$/u;
const isHex64 = (v: unknown): v is string => typeof v === "string" && HEX64.test(v);

/** A list's subject: `<kind>:<64 hex>:<name>`, where the name is everything after the second colon, plain, not empty. */
export function isListSubject(subject: unknown): subject is string {
  if (typeof subject !== "string") return false;
  const m = /^(0|[1-9][0-9]{0,4}):([0-9a-f]{64}):([\s\S]*)$/u.exec(subject);
  if (!m || Number(m[1]) > 65535) return false;
  const name = m[3]!;
  if (!name || new TextEncoder().encode(name).length > 512) return false;
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || c === 0x7f) return false;
  }
  return true;
}
export const listD = (scope: ListScope, subject: string): string => `${LIST_NAMESPACE}:governance:${scope}:v1:${subject}`;

const shaped = (e: unknown): e is NostrEvent => {
  const v = e as NostrEvent | null;
  return !!v && typeof v === "object" && isHex64(v.id) && isHex64(v.pubkey) && typeof v.sig === "string" && HEX128.test(v.sig) && Number.isInteger(v.kind) && Number.isInteger(v.created_at) && typeof v.content === "string" && Array.isArray(v.tags) && v.tags.every((t) => Array.isArray(t) && t.every((x) => typeof x === "string"));
};
const cleanRoot = (root: unknown): string[] | null => {
  const keys = Array.isArray(root) ? root : [root];
  return keys.length >= 1 && keys.length <= OWNER_LIST_LIMITS.root && keys.every(isHex64) ? [...new Set(keys as string[])] : null;
};
const signedRight = (e: NostrEvent): boolean => {
  try {
    return verifyNostrEvent({ ...e, tags: e.tags.map((t) => [...t]) });
  } catch {
    return false;
  }
};

/**
 * Read one list. Its signer must be in `root` (by default, the key in its own subject). `now` is in seconds. A
 * person named in a way that isn't a key is skipped, and counted; one named twice is named once; they are given in
 * order.
 */
export function readOwnerList(event: unknown, o: { root?: string | readonly string[]; now?: number } = {}): ListRead {
  const no = (reason: ListRefusal): ListRead => ({ ok: false, reason });
  const now = o.now ?? Math.floor(Date.now() / 1000);
  if (!shaped(event)) return no("not_an_event");
  const e = event;
  if (e.kind !== LIST_KIND) return no("wrong_kind");
  const ds = e.tags.filter((t) => t[0] === "d");
  const m = ds.length === 1 ? D.exec(ds[0]![1] ?? "") : null;
  if (!m || !NAMESPACE.test(m[1]!) || !/^[0-9]+$/u.test(m[3]!)) return no("bad_d");
  const [, , scope, version, subject] = m as unknown as [string, string, string, string, string];
  if (version !== "1") return no("unsupported_version");
  if (scope !== "user-allow" && scope !== "user-deny") return no("unsupported_scope");
  if (!isListSubject(subject)) return no("bad_subject");
  const one = (name: string, value: string) => {
    const found = e.tags.filter((t) => t[0] === name);
    return found.length === 1 && found[0]![1] === value;
  };
  if (!one("v", version) || !one("scope", scope) || !one("subject", subject)) return no("tag_mismatch");
  const root = o.root === undefined ? [subject.slice(subject.indexOf(":") + 1, subject.indexOf(":") + 65)] : cleanRoot(o.root);
  if (!root || !root.includes(e.pubkey)) return no("wrong_signer");
  if (e.content !== "") return no("content_not_empty");
  const people = e.tags.filter((t) => t[0] === "p");
  if (people.length > OWNER_LIST_LIMITS.read) return no("too_many_entries");
  if (e.created_at > now + OWNER_LIST_LIMITS.ahead) return no("from_the_future");
  if (!signedRight(e)) return no("bad_signature");
  const entries: string[] = [];
  let skipped = 0;
  for (const t of people) {
    if (!isHex64(t[1])) skipped++;
    else if (!entries.includes(t[1])) entries.push(t[1]);
  }
  entries.sort();
  return { ok: true, scope, subject, signer: e.pubkey, entries, skipped };
}

/** Of what relays gave, the list that stands: the newest signed copy by a root key for that `d`, a tie to the smallest id. */
export function resolveOwnerList(events: readonly unknown[], q: { scope: ListScope; subject: string; namespace?: string; root?: string | readonly string[]; now?: number }): (OwnerList | { ok: false; reason: ListRefusal | "not_found" }) & { futureDated: string[] } {
  const now = q.now ?? Math.floor(Date.now() / 1000);
  const d = `${q.namespace ?? LIST_NAMESPACE}:governance:${q.scope}:v1:${q.subject}`;
  const root = q.root === undefined ? (isListSubject(q.subject) ? [q.subject.split(":")[1]!] : null) : cleanRoot(q.root);
  if (!root) return { ok: false, reason: "wrong_signer", futureDated: [] };
  const candidates: NostrEvent[] = [];
  const futureDated: string[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!shaped(e) || e.kind !== LIST_KIND || !root.includes(e.pubkey) || seen.has(e.id)) continue;
    const ds = e.tags.filter((t) => t[0] === "d");
    if (ds.length !== 1 || ds[0]![1] !== d || !signedRight(e)) continue;
    seen.add(e.id);
    if (e.created_at > now + OWNER_LIST_LIMITS.ahead) futureDated.push(e.id);
    else candidates.push(e);
  }
  if (!candidates.length) return { ok: false, reason: "not_found", futureDated };
  candidates.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? -1 : 1));
  return { ...readOwnerList(candidates[0], { root, now }), futureDated };
}

/**
 * The unsigned list, as BitLogin's worker builds it: nothing in it a world wrote but the people. Each person once,
 * in order of their keys; dated `createdAt`, or a second after `notBefore` (the list it replaces) where that is
 * later, so relays keep the new one. As NSWP's `vectors/owner-list-writing.json` writes it.
 */
export function ownerListTemplate(o: { scope: ListScope; subject: string; people: readonly string[]; createdAt: number; notBefore?: number }): { kind: number; created_at: number; content: string; tags: string[][] } | null {
  const people = [...new Set(o.people)].sort();
  if (!isListSubject(o.subject) || people.length > OWNER_LIST_LIMITS.write || !people.every(isHex64) || !Number.isSafeInteger(o.createdAt)) return null;
  const at = Number.isSafeInteger(o.notBefore) && o.notBefore! + 1 > o.createdAt ? o.notBefore! + 1 : o.createdAt;
  return { kind: LIST_KIND, created_at: at, content: "", tags: [["d", listD(o.scope, o.subject)], ["v", "1"], ["scope", o.scope], ["subject", o.subject], ...people.map((p) => ["p", p])] };
}

/** The one change a world may ask for, and which list it is made to. */
export type GuestChange = "allow" | "unallow" | "block" | "unblock";
export const GUEST_CHANGES: readonly GuestChange[] = ["allow", "unallow", "block", "unblock"];
export const scopeOf = (change: GuestChange): ListScope => (change === "allow" || change === "unallow" ? "user-allow" : "user-deny");

/** The people on a list after one change. Null where the change changes nothing: they are on it, or not, already. */
export function applyChange(entries: readonly string[], change: GuestChange, key: string): string[] | null {
  const has = entries.includes(key);
  if (change === "allow" || change === "block") return has ? null : [...entries, key].sort();
  return has ? entries.filter((e) => e !== key) : null;
}

/** A world, as its own manifest says it: its coordinate, the keys whose lists count, and its name. */
export interface WorldKeepers {
  coordinate: string;
  keepers: string[];
  d: string;
}

/**
 * Who keeps a world's lists, by that world's own `/.well-known/nswp.json`, fetched from the origin asking. The world
 * named by `coordinate` must be one the file names (its publisher lists it), and its entry must be at `origin`: a site
 * can't ask about a world that isn't itself. The keepers are its entry's `keepers` (up to four good keys), or where it
 * names none that read, the publishers that list it. Null where the file says none of that.
 */
export function keepersOf(manifest: unknown, origin: string, coordinate: string): WorldKeepers | null {
  const m = /^37300:([0-9a-f]{64}):([\s\S]{1,128})$/u.exec(coordinate);
  const doc = manifest as { publishers?: Record<string, { worlds?: unknown }>; worlds?: Record<string, { entry?: { url?: unknown }; keepers?: unknown }> } | null;
  if (!m || !doc || typeof doc !== "object" || !doc.publishers || !doc.worlds || typeof doc.publishers !== "object" || typeof doc.worlds !== "object") return null;
  const [, publisher, d] = m as unknown as [string, string, string];
  const lists = (key: string) => {
    const w = doc.publishers![key]?.worlds;
    return Array.isArray(w) && w.includes(d);
  };
  if (!Object.prototype.hasOwnProperty.call(doc.worlds, d) || !lists(publisher)) return null;
  const world = doc.worlds[d]!;
  let at = "";
  try {
    at = new URL(String(world.entry?.url)).origin;
  } catch {
    return null;
  }
  if (at !== origin) return null;
  const said = Array.isArray(world.keepers) ? [...new Set(world.keepers.filter(isHex64))] : [];
  const keepers = said.length ? said.slice(0, OWNER_LIST_LIMITS.root) : Object.keys(doc.publishers).filter((key) => isHex64(key) && lists(key)).slice(0, OWNER_LIST_LIMITS.root);
  return keepers.length ? { coordinate, keepers, d } : null;
}

/**
 * Whether a list BitLogin's page signed is exactly what was asked: by this account, for that world and the list
 * the change belongs to, naming exactly the people the list it was handed named after the one change. The embedded
 * signer checks this before passing a list to the world, as it does for a proposed profile.
 */
export function isListAsked(signed: unknown, asked: { pubkey: string; world: string; change: GuestChange; key: string; list: unknown | null; now: number }): boolean {
  const read = readOwnerList(signed, { root: [asked.pubkey], now: asked.now });
  if (!read.ok || read.subject !== asked.world || read.scope !== scopeOf(asked.change) || read.skipped !== 0) return false;
  const before = asked.list === null ? [] : ((r) => (r.ok && r.subject === asked.world && r.scope === scopeOf(asked.change) ? r.entries : null))(readOwnerList(asked.list, { root: [asked.pubkey], now: asked.now }));
  if (!before) return false;
  const after = applyChange(before, asked.change, asked.key);
  return !!after && JSON.stringify(after) === JSON.stringify(read.entries) && Math.abs((signed as NostrEvent).created_at - asked.now) < 600;
}
