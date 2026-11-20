/**
 * An achievement someone holds in a world (NSWP-16,
 * protocol/16-achievements.md; docs/sign-in-window.md §SW16e).
 *
 * The pure part, and the whole of the signer's side. Built as a score is
 * (scores.ts): a world its visitor allowed names its coordinate, one of its
 * achievements and what it is called, and the signer builds the note (kind
 * 37307), with no words of the world's beyond that one line, and marks it
 * with the site that asked, as the browser gave it. A reader counts one only
 * where that mark is the world's own address.
 *
 * It is a claim: nothing checks it was earned. The title is the holder's
 * word for what the world called it, one plain line, shown as text.
 *
 * The shapes match NSWP's `achievementForWorld`, and are checked against its
 * vector (vectors/achievements.json).
 */
import { cleanOrigin, SITE_TAG } from "./policy.js";
import { worldCoordinate } from "./scores.js";

export const ACHIEVEMENT_KIND = 37307;

export const ACHIEVEMENT_LIMITS = {
  /** No more than this many for one world in `perMs`, and in an hour. Counted apart from notes and scores. */
  burst: 6,
  perMs: 60_000,
  hourly: 60,
  /** The longest a title may be, in characters. */
  title: 60
} as const;

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** An achievement's name among a world's own: lower-case letters, digits and hyphens, 32 at most. "" for anything else. */
export function cleanAchievementId(input: unknown): string {
  return typeof input === "string" && NAME.test(input) ? input : "";
}

/** What an achievement is called, as it may be signed and shown: one line, nothing invisible that reorders or hides text, 60 characters at most. */
export function cleanTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  let out = "";
  for (const ch of input.slice(0, ACHIEVEMENT_LIMITS.title * 8).normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    const unseen = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
    out += unseen ? " " : ch;
  }
  return [...out.replace(/\s+/gu, " ").trim()].slice(0, ACHIEVEMENT_LIMITS.title).join("").trim();
}

/**
 * An achievement, ready to be signed by the visitor's key, marked with the
 * site that asked. `origin` is the signer's own word for which site that
 * is, never the world's. Null for anything malformed.
 */
export function achievementForWorld(o: { world: unknown; id: unknown; title: unknown; origin: string; nowSeconds: number }): { kind: number; created_at: number; tags: string[][]; content: string } | null {
  const origin = cleanOrigin(o.origin);
  const world = worldCoordinate(o.world);
  const id = cleanAchievementId(o.id);
  const title = cleanTitle(o.title);
  if (!origin || !world || !id || !title) return null;
  return {
    kind: ACHIEVEMENT_KIND,
    created_at: Math.floor(o.nowSeconds),
    tags: [
      ["d", `${world}/${id}`],
      ["a", world],
      ["achievement", id],
      ["title", title],
      ["alt", `An achievement in a world: ${title}`],
      [SITE_TAG, origin]
    ],
    content: ""
  };
}
