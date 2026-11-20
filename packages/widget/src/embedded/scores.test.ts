import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanBoard, cleanScore, SCORE_KIND, scoreForWorld, scoreWords, worldCoordinate } from "./scores.js";
import { prepareForSite, readSignerRequest, SIGNER_PROTOCOL } from "./policy.js";
import { prepareForApp, readPermissions } from "./permissions.js";

/** From NSWP's vectors/scores.json at a087c0d: `world` and `signed`. */
const vectors = JSON.parse(readFileSync(new URL("./scores.vectors.json", import.meta.url), "utf8")) as {
  world: string;
  signed: { board: string; score: number; title: string; format: string; origin: string; now: number; expect: unknown };
  signedPlain: { board: string; score: number; origin: string; now: number; expect: unknown };
};

describe("a score in a world (NSWP-15)", () => {
  it("builds the scores NSWP's vectors have, mark and all: with a title and a format, and with neither", () => {
    const v = vectors.signed;
    expect(scoreForWorld({ world: vectors.world, board: v.board, score: v.score, title: v.title, format: v.format, origin: v.origin, nowSeconds: v.now })).toEqual(v.expect);
    const p = vectors.signedPlain;
    expect(scoreForWorld({ world: vectors.world, board: p.board, score: p.score, origin: p.origin, nowSeconds: p.now })).toEqual(p.expect);
  });

  it("carries what the board is called and how it counts only where the world gives them, tidied", () => {
    const base = { world: vectors.world, board: "main", origin: "https://arcade.example", nowSeconds: 1 };
    expect(scoreForWorld({ ...base, score: 1200 })!.tags.slice(2, 5)).toEqual([["board", "main"], ["score", "1200"], ["alt", "A score in a world: 1,200"]]);
    expect(scoreForWorld({ ...base, score: 754000, title: "  Long\n Run ", format: "time" })!.tags.slice(2, 5)).toEqual([["board", "main", "Long Run"], ["score", "754000", "time"], ["alt", "A score in a world: Long Run: 12 min 34.0 s"]]);
    // Anything but "time" is a plain number, and a title that is not text is no title.
    expect(scoreForWorld({ ...base, score: 5, title: 7, format: "stars" })!.tags.slice(2, 4)).toEqual([["board", "main"], ["score", "5"]]);
    expect(scoreWords("time", 42500)).toBe("42.5 s");
  });

  it("marks it with the site the signer names, whatever page of it asked", () => {
    const made = scoreForWorld({ world: vectors.world, board: "lantern-run", score: 7, origin: "https://arcade.example/play/?level=3", nowSeconds: 5 })!;
    expect(made.tags.at(-1)).toEqual(["nswp:world", "https://arcade.example"]);
    expect(made.tags.filter((t) => t[0] === "nswp:world")).toHaveLength(1);
    expect(made.content).toBe("");
  });

  it("builds nothing from a world, a board or a number that isn't one", () => {
    const ok = { world: vectors.world, board: "main", score: 1, origin: "https://arcade.example", nowSeconds: 1 };
    expect(scoreForWorld(ok)).not.toBeNull();
    for (const bad of [{ world: "37300:abc:arcade" }, { world: vectors.world.replace("37300", "1") }, { world: `${vectors.world.split(":").slice(0, 2).join(":")}:` }, { world: 7 }, { board: "Main" }, { board: "" }, { board: "a b" }, { score: -1 }, { score: 1.5 }, { score: "12x" }, { score: Number.MAX_SAFE_INTEGER + 1 }, { score: null }, { origin: "not an address" }]) {
      expect(scoreForWorld({ ...ok, ...bad } as never), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanScore("42500")).toBe(42500);
    expect(cleanScore(0)).toBe(0);
    expect(cleanBoard("lantern-run")).toBe("lantern-run");
    expect(worldCoordinate(vectors.world)).toBe(vectors.world);
  });

  it("reads the message, tidied, and nothing malformed", () => {
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "a1", ...more });
    expect(say({ t: "score", world: vectors.world, board: "main", score: "12", origin: "https://other.example", tags: [["nswp:world", "https://other.example"]] })).toEqual({ t: "score", id: "a1", world: vectors.world, board: "main", score: 12 });
    expect(say({ t: "score", world: vectors.world, board: "main", score: 12, title: " Main  board ", format: "time" })).toEqual({ t: "score", id: "a1", world: vectors.world, board: "main", score: 12, title: "Main board", format: "time" });
    expect(say({ t: "score", world: vectors.world, board: "main", score: 12, title: 7, format: "stars" })).toEqual({ t: "score", id: "a1", world: vectors.world, board: "main", score: 12 });
    expect(say({ t: "score", world: vectors.world, board: "Main", score: 12 })).toBeNull();
    expect(say({ t: "score", world: "x", board: "main", score: 12 })).toBeNull();
    expect(say({ t: "score", world: vectors.world, board: "main" })).toBeNull();
  });

  it("can't be had any other way: `sign` refuses the kind for a world", () => {
    expect(prepareForSite({ kind: SCORE_KIND, content: "", tags: [["score", "999999"]] }, "https://arcade.example", 1)).toBeNull();
  });

  it("an application that may sign scores has them marked as its own site's, never as a world's", () => {
    const perms = readPermissions({ sign: [SCORE_KIND] })!;
    const made = prepareForApp(perms, { kind: SCORE_KIND, content: "", tags: [["score", "9"], ["nswp:world", "https://arcade.example"]] }, "https://app.example", 1)!;
    expect(made.tags.some((t) => t[0] === "nswp:world")).toBe(false);
    expect(made.tags.at(-1)).toEqual(["bitlogin:site", "https://app.example"]);
  });
});
