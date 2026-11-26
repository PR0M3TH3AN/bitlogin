/**
 * Who someone is, as a site they allowed may be told, and the pass that says
 * so to the other people in a room (docs/sign-in-window.md §SW16).
 *
 * The pure parts. A name, a picture and a few words come from one place
 * only: the person's own signed profile (kind 0), fetched and checked by
 * BitLogin's worker at the sign-in address. A site never supplies them, and
 * never fetches them.
 *
 * A room pass is NSWP's (protocol/10-identity.md, kind 27300): "at this
 * site, until this time, this session key speaks for me". The shapes and
 * the cleaning here match NSWP's `buildRoomPass` and `verifyRoomPass`, so a
 * pass made here is one a world's kit accepts.
 */
import { verifyNostrEvent } from "@bitlogin/core/nostr";
import { cleanName, cleanOrigin, type UnsignedForSite } from "./policy.js";

export const ROOM_PASS_KIND = 27300;

export const PROFILE_LIMITS = {
  /** The longest address a picture may have. */
  pictureChars: 300,
  /** The most that is said about someone, in their own words. */
  aboutChars: 280,
  /** How long a pass made here lasts, in seconds. NSWP's verifier allows twelve hours; this gives four. */
  passSec: 4 * 3600,
  /** A profile's content is not read past this many characters. */
  contentChars: 20_000
} as const;

export interface Profile {
  name?: string;
  picture?: string;
  about?: string;
}

/** Where a picture is, as it may be fetched: an https address with no credentials in it. "" for anything else. */
export function cleanPicture(url: unknown): string {
  if (typeof url !== "string" || url.length > PROFILE_LIMITS.pictureChars) return "";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.username || u.password || !u.hostname.includes(".")) return "";
    return u.href.length <= PROFILE_LIMITS.pictureChars ? u.href : "";
  } catch {
    return "";
  }
}

const unseen = (c: number): boolean =>
  c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;

/** A few words someone wrote about themselves: one line, nothing invisible, at most 280 characters. */
export function cleanAbout(text: unknown): string {
  if (typeof text !== "string") return "";
  let out = "";
  for (const ch of text.slice(0, PROFILE_LIMITS.aboutChars * 8).normalize("NFC")) out += unseen(ch.codePointAt(0)!) ? " " : ch;
  return [...out.replace(/\s+/gu, " ").trim()].slice(0, PROFILE_LIMITS.aboutChars).join("").trim();
}

/**
 * A profile as it may be kept, sealed and told: each part cleaned, and left
 * out when nothing is left of it. Null when there is nothing at all, or the
 * input is not an object.
 */
export function readProfile(input: unknown): Profile | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const p = input as Record<string, unknown>;
  const name = cleanName(p.name);
  const picture = cleanPicture(p.picture);
  const about = cleanAbout(p.about);
  if (!name && !picture && !about) return null;
  return { ...(name ? { name } : {}), ...(picture ? { picture } : {}), ...(about ? { about } : {}) };
}

/**
 * The profile out of a kind 0 event, if the event is validly signed by
 * `pubkey`. A relay is untrusted transport: it can withhold a profile, and
 * it cannot make one up.
 */
export function profileFromMetadata(event: unknown, pubkey: string): Profile | null {
  if (!verifyNostrEvent(event) || event.kind !== 0 || event.pubkey !== pubkey) return null;
  if (event.content.length > PROFILE_LIMITS.contentChars) return null;
  let content: unknown;
  try {
    content = JSON.parse(event.content);
  } catch {
    return null;
  }
  if (!content || typeof content !== "object" || Array.isArray(content)) return null;
  const c = content as Record<string, unknown>;
  // The name a person shows: `display_name`, then the older `displayName`, then the short `name`, as other Nostr clients and BitPortal show it.
  return readProfile({ name: cleanName(c.display_name) || cleanName(c.displayName) || c.name, picture: c.picture, about: c.about });
}

/** The newest validly signed profile among what relays returned, or null. */
export function newestProfile(events: readonly unknown[], pubkey: string): Profile | null {
  let best: { at: number; profile: Profile | null } | null = null;
  for (const event of events) {
    if (!verifyNostrEvent(event) || event.kind !== 0 || event.pubkey !== pubkey) continue;
    if (best && event.created_at <= best.at) continue;
    best = { at: event.created_at, profile: profileFromMetadata(event, pubkey) };
  }
  return best?.profile ?? null;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/**
 * A room pass, ready for the identity key to sign. Everything in it is the
 * signer's own: the site (the browser's word for it), the time, how long it
 * lasts, and the profile. A site supplies the session key and nothing else.
 * Null where it can't be made: no site, no usable session key, or a session
 * key that is the identity key itself.
 */
export function buildRoomPass(input: { session: unknown; site: string; identity: string; nowSeconds: number; profile?: Profile | null; /** A guest account (docs/guest-accounts.md G7): said on the pass. */ guest?: boolean }): UnsignedForSite | null {
  const origin = cleanOrigin(input.site);
  if (!origin || typeof input.session !== "string" || !HEX64.test(input.session) || input.session === input.identity) return null;
  const created = Math.floor(input.nowSeconds);
  const profile = readProfile(input.profile) ?? {};
  const tags: string[][] = [
    ["nswp:session", input.session],
    ["nswp:origin", origin],
    ...(input.guest ? [["nswp:guest", "1"]] : []),
    ["expiration", String(created + PROFILE_LIMITS.passSec)]
  ];
  if (profile.name) tags.push(["name", profile.name]);
  if (profile.picture) tags.push(["picture", profile.picture]);
  if (profile.about) tags.push(["about", profile.about]);
  return { kind: ROOM_PASS_KIND, created_at: created, tags, content: "" };
}
