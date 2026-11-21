/**
 * Which mints people recommend (NIP-87; docs/ecash.md): kind 38000 notes
 * naming a Cashu mint. Counted one voice per account, and the voices of
 * people the user follows first, because anyone can publish a
 * recommendation, and a thousand new accounts can publish a thousand.
 */
import { cleanMint } from "./nip60.js";

export const MINT_RECOMMENDATION_KIND = 38000;
export const CASHU_MINT_KIND = "38172";

export interface RankedMint {
  mint: string;
  /** How many accounts recommend it. */
  by: number;
  /** How many of those the user follows. */
  byFollowed: number;
}

/** Mints that hand out pretend sats, for developers. People recommend them; nobody should keep money at one. */
const TEST_MINTS: readonly string[] = ["https://testnut.cashu.space", "https://nofees.testnut.cashu.space"];

/** How many mints one account's recommendations may count toward: a list longer than this is not a recommendation. */
const PER_ACCOUNT = 8;

export function rankMints(events: readonly { kind: number; pubkey: string; tags: string[][] }[], follows: ReadonlySet<string>, limit = 10): RankedMint[] {
  const voices = new Map<string, Set<string>>();
  const perAccount = new Map<string, Set<string>>();
  for (const event of events) {
    if (event.kind !== MINT_RECOMMENDATION_KIND || !event.tags.some((tag) => tag[0] === "k" && tag[1] === CASHU_MINT_KIND)) continue;
    for (const tag of event.tags) {
      // A Cashu mint is named by its https address. A Fedimint invite code, or anything else, is not one.
      if (tag[0] !== "u" || (tag[2] !== undefined && tag[2] !== "cashu")) continue;
      const mint = cleanMint(tag[1]);
      if (!mint || !mint.startsWith("https://") || TEST_MINTS.includes(mint)) continue;
      const mine = perAccount.get(event.pubkey) ?? new Set<string>();
      if (!mine.has(mint) && mine.size >= PER_ACCOUNT) continue;
      mine.add(mint);
      perAccount.set(event.pubkey, mine);
      (voices.get(mint) ?? voices.set(mint, new Set()).get(mint)!).add(event.pubkey);
    }
  }
  return [...voices]
    .map(([mint, who]) => ({ mint, by: who.size, byFollowed: [...who].filter((pubkey) => follows.has(pubkey)).length }))
    // One stranger's word is not a recommendation. One person the user follows is.
    .filter((pick) => pick.by >= 2 || pick.byFollowed >= 1)
    .sort((a, b) => b.byFollowed - a.byFollowed || b.by - a.by || a.mint.localeCompare(b.mint))
    .slice(0, limit);
}
