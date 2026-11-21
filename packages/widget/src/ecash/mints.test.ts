import { describe, expect, it } from "vitest";
import { rankMints } from "./mints.js";

const rec = (pubkey: string, ...urls: string[]) => ({ kind: 38000, pubkey, tags: [["k", "38172"], ["d", "x"], ...urls.map((u) => ["u", u])] });

describe("which mints people recommend (NIP-87)", () => {
  it("counts one voice per account, and the people the user follows first", () => {
    const events = [
      rec("a", "https://big.example"), rec("b", "https://big.example/"), rec("c", "https://big.example"),
      // The same account twice is one voice.
      rec("a", "https://big.example"),
      rec("friend", "https://small.example"),
      rec("d", "https://mid.example"), rec("e", "https://mid.example")
    ];
    expect(rankMints(events, new Set(["friend"]))).toEqual([
      { mint: "https://small.example", by: 1, byFollowed: 1 },
      { mint: "https://big.example", by: 3, byFollowed: 0 },
      { mint: "https://mid.example", by: 2, byFollowed: 0 }
    ]);
  });

  it("takes only Cashu mints named by an https address", () => {
    const events = [
      { kind: 38000, pubkey: "a", tags: [["k", "38173"], ["u", "https://fedi.example"]] },
      { kind: 38000, pubkey: "a", tags: [["k", "38172"], ["u", "fed11qgqzc2nhwden5te0vejkg6tdd9h8gepwvejkg6tdd9h8garhduhx6at5d9h8jmn9wshxxmmd9uqqzgxg6s3evnr6m9zdxr6hxkdkukexpcs3mn7mj3g5pc5dfh63l4tj6g9zk4er"]] },
      { kind: 38000, pubkey: "a", tags: [["k", "38172"], ["u", "http://plain.example"], ["u", "https://ok.example", "cashu"], ["u", "https://fedi2.example", "fedimint"]] },
      { kind: 1, pubkey: "b", tags: [["k", "38172"], ["u", "https://note.example"]] }
    ];
    expect(rankMints(events, new Set(["a"]))).toEqual([{ mint: "https://ok.example", by: 1, byFollowed: 1 }]);
    // One stranger's word is not shown at all, and a mint of pretend sats never is.
    expect(rankMints(events, new Set())).toEqual([]);
    expect(rankMints([rec("a", "https://testnut.cashu.space"), rec("b", "https://testnut.cashu.space")], new Set(["a"]))).toEqual([]);
  });

  it("does not let one account fill the list, or the list run on", () => {
    const flood = rec("spam", ...Array.from({ length: 40 }, (_, i) => `https://m${String(i).padStart(2, "0")}.example`));
    expect(rankMints([flood], new Set(["spam"]), 50).length).toBe(8);
    const many = Array.from({ length: 30 }, (_, i) => [rec(`p${i}`, `https://m${i}.example`), rec(`q${i}`, `https://m${i}.example`)]).flat();
    expect(rankMints(many, new Set()).length).toBe(10);
  });
});
