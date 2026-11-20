/**
 * A score someone made in a world (NSWP-15, protocol/15-scores.md;
 * docs/sign-in-window.md §SW16d).
 *
 * The pure part, and the whole of the signer's side. A world that keeps
 * score may ask for its visitor's score to be signed: a note of its own kind
 * (37306), one for each person on each board, that names the world, the
 * board and a whole number, and has no words in it. The signer builds all of
 * it, and marks it with the site that asked, as the browser gave it. A board
 * counts a score only where that mark is the world's own address, so another
 * site can't post to this world's board.
 *
 * A score is a claim: nothing checks it was earned. It is less than a note,
 * which a world its visitor allowed may already have signed.
 *
 * The shapes match NSWP's `scoreForWorld`, and are checked against its
 * vectors (vectors/scores.json).
 */
import { cleanOrigin, SITE_TAG } from "./policy.js";

export const SCORE_KIND = 37306;
const WORLD_KIND = 37300;

export const SCORE_LIMITS = {
  /** No more scores than this for one world in `perMs`, and in an hour. Counted apart from notes. */
  burst: 6,
  perMs: 60_000,
  hourly: 60,
  /** The most a score may be. */
  most: 9_007_199_254_740_991,
  /** The longest a board's title may be, in characters. */
  title: 60
} as const;

const BOARD = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const COORD = /^(\d+):([0-9a-f]{64}):(.*)$/su;

/** A world's coordinate as a score may name it, `37300:<publisher>:<d>`, or "". */
export function worldCoordinate(input: unknown): string {
  if (typeof input !== "string" || input.length > 200) return "";
  const m = COORD.exec(input);
  return m && Number(m[1]) === WORLD_KIND && m[3] !== "" ? `${WORLD_KIND}:${m[2]}:${m[3]}` : "";
}

/** A board's name as it may be used: lower-case letters, digits and hyphens, 32 at most. "" for anything else. */
export function cleanBoard(input: unknown): string {
  return typeof input === "string" && BOARD.test(input) ? input : "";
}

/** A score as it may be used: a whole number, zero or more. Null for anything else. */
export function cleanScore(input: unknown): number | null {
  const n = typeof input === "string" && /^\d{1,16}$/u.test(input) ? Number(input) : input;
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= SCORE_LIMITS.most ? n : null;
}

/** What a board is called, as it may be signed and shown: one plain line, 60 characters at most. "" where there is none. */
export function cleanBoardTitle(input: unknown): string {
  if (typeof input !== "string") return "";
  let out = "";
  for (const ch of input.slice(0, SCORE_LIMITS.title * 8).normalize("NFC")) {
    const c = ch.codePointAt(0)!;
    const unseen = c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x2060 && c <= 0x206f) || c === 0xfeff;
    out += unseen ? " " : ch;
  }
  return [...out.replace(/\s+/gu, " ").trim()].slice(0, SCORE_LIMITS.title).join("").trim();
}

/** A score in a few words, as its board counts it: "1,200", or "42.5 s" for a time in thousandths of a second. */
export function scoreWords(format: "number" | "time", score: number): string {
  if (format !== "time") return String(score).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const tenths = Math.round(score / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = (tenths % 600) / 10;
  return minutes ? `${minutes} min ${seconds.toFixed(1)} s` : `${seconds.toFixed(1)} s`;
}

/**
 * A score, ready to be signed by the visitor's key, marked with the site
 * that asked. `origin` is the signer's own word for which site that is,
 * never the world's. What the board is called and how it counts go with the
 * score where the world gives them, so that it can be shown where the world
 * isn't: "Lantern Run: 42.5 s". Null for anything malformed.
 */
export function scoreForWorld(o: { world: unknown; board: unknown; score: unknown; title?: unknown; format?: unknown; origin: string; nowSeconds: number }): { kind: number; created_at: number; tags: string[][]; content: string } | null {
  const origin = cleanOrigin(o.origin);
  const world = worldCoordinate(o.world);
  const board = cleanBoard(o.board);
  const score = cleanScore(o.score);
  if (!origin || !world || !board || score === null) return null;
  const title = cleanBoardTitle(o.title);
  const format = o.format === "time" ? "time" : "number";
  return {
    kind: SCORE_KIND,
    created_at: Math.floor(o.nowSeconds),
    tags: [
      ["d", `${world}/${board}`],
      ["a", world],
      ["board", board, ...(title ? [title] : [])],
      ["score", String(score), ...(format === "time" ? ["time"] : [])],
      ["alt", `A score in a world: ${title ? `${title}: ` : ""}${scoreWords(format, score)}`],
      [SITE_TAG, origin]
    ],
    content: ""
  };
}
