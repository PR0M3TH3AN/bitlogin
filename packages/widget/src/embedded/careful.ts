/**
 * What a careful kind says, in words a person can check before it is signed
 * (docs/sign-in-window.md §SW20): a profile, a deletion, a list of relays.
 * Everything is returned as plain text, for a page to write as text.
 */
import { cleanName } from "./policy.js";

export interface AskedWords {
  /** The question. */
  title: string;
  /** What signing it does that the person might not expect. */
  warning: string;
  /** What is in it, a line each. */
  lines: string[];
}

/** One line of text: nothing invisible, no line breaks, and not too long. */
const line = (input: unknown, max = 200): string => {
  if (typeof input !== "string") return "";
  const hidden = (c: number): boolean => c < 32 || (c >= 127 && c <= 159) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;
  const tidy = Array.from(input, (ch) => (hidden(ch.codePointAt(0) ?? 0) ? " " : ch)).join("").split(" ").filter(Boolean).join(" ");
  return [...tidy].length > max ? `${[...tidy].slice(0, max).join("")}…` : tidy;
};

const PROFILE_FIELDS: readonly [string, string][] = [
  ["name", "Name"],
  ["display_name", "Display name"],
  ["about", "About"],
  ["picture", "Picture"],
  ["banner", "Banner"],
  ["website", "Website"],
  ["nip05", "Verified name (NIP-05)"],
  ["lud16", "Lightning address"],
  ["lud06", "Lightning address (LNURL)"]
];

export function describeAsked(event: { kind: number; content: string; tags: string[][] }): AskedWords {
  if (event.kind === 0) {
    let profile: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(event.content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) profile = parsed as Record<string, unknown>;
    } catch {
      /* not a profile anyone can read: said below */
    }
    const lines = PROFILE_FIELDS.filter(([key]) => line(profile[key])).map(([key, label]) => `${label}: ${key === "name" || key === "display_name" ? cleanName(profile[key]) || line(profile[key], 48) : line(profile[key])}`);
    const others = Object.keys(profile).filter((key) => !PROFILE_FIELDS.some(([known]) => known === key));
    if (others.length) lines.push(`And ${others.length} other ${others.length === 1 ? "field" : "fields"}: ${line(others.join(", "), 120)}`);
    if (lines.length === 0) lines.push("An empty profile: no name, no picture, nothing about you.");
    return {
      title: "Replace your Nostr profile?",
      warning: "This replaces your whole profile, everywhere you use this account. Anything not listed here is removed from it. A lightning address is where people send you money: check it.",
      lines
    };
  }
  if (event.kind === 5) {
    const notes = event.tags.filter((tag) => tag[0] === "e" && tag[1]).map((tag) => `Note ${line(tag[1], 64)}`);
    const things = event.tags.filter((tag) => tag[0] === "a" && tag[1]).map((tag) => `Item ${line(tag[1], 120)}`);
    const lines = [...notes, ...things].slice(0, 12);
    if (notes.length + things.length > 12) lines.push(`And ${notes.length + things.length - 12} more.`);
    if (lines.length === 0) lines.push("It names nothing to delete.");
    if (line(event.content)) lines.push(`Reason given: ${line(event.content)}`);
    return {
      title: `Ask relays to delete ${notes.length + things.length === 1 ? "this" : `these ${notes.length + things.length} things`}?`,
      warning: "A deletion can't be undone. Relays that honour it remove what is named, anywhere it was posted from, not only what you posted in this world. Some relays, and anyone who already has a copy, keep it.",
      lines
    };
  }
  if (event.kind === 10002) {
    const relays = event.tags.filter((tag) => tag[0] === "r" && tag[1]);
    const lines = relays.slice(0, 20).map((tag) => `${line(tag[1], 120)}${tag[2] === "read" ? " (read only)" : tag[2] === "write" ? " (write only)" : ""}`);
    if (relays.length > 20) lines.push(`And ${relays.length - 20} more.`);
    if (lines.length === 0) lines.push("An empty list: no relays at all.");
    return {
      title: "Replace the list of relays you use?",
      warning: "This replaces your whole relay list. Other apps look there to find your notes and to reach you, and BitLogin looks there when you take a site back. A list of relays you don't know could hide you, or what you do, from the people who follow you.",
      lines
    };
  }
  return { title: "Sign this?", warning: "BitLogin can't say what this does.", lines: [`Kind ${event.kind}`] };
}
