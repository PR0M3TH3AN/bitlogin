import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ACHIEVEMENT_KIND, ACHIEVEMENT_LIMITS, achievementForWorld, cleanAchievementId, cleanTitle } from "./achievements.js";
import { prepareForSite, readSignerRequest, SIGNER_PROTOCOL } from "./policy.js";

/** From NSWP's vectors/achievements.json at cdb91a4: `world` and `signed`. */
const vectors = JSON.parse(readFileSync(new URL("./achievements.vectors.json", import.meta.url), "utf8")) as {
  world: string;
  signed: { id: string; title: string; origin: string; now: number; expect: unknown };
};

describe("an achievement held in a world (NSWP-16)", () => {
  it("builds the achievement NSWP's vector has, mark and all", () => {
    const v = vectors.signed;
    expect(achievementForWorld({ world: vectors.world, id: v.id, title: v.title, origin: v.origin, nowSeconds: v.now })).toEqual(v.expect);
  });

  it("makes the title one plain line of at most 60 characters", () => {
    expect(cleanTitle("  All\u202e twelve\n\tcaught ")).toBe("All twelve caught");
    expect([...cleanTitle("x".repeat(500))]).toHaveLength(ACHIEVEMENT_LIMITS.title);
    expect(cleanTitle(" ​ ")).toBe("");
    expect(cleanTitle(7)).toBe("");
  });

  it("builds nothing from a world, a name or a title that isn't one, and marks it with the signer's own word for the site", () => {
    const ok = { world: vectors.world, id: "first-steps", title: "First steps", origin: "https://arcade.example/play/", nowSeconds: 1 };
    const made = achievementForWorld(ok)!;
    expect(made.tags.at(-1)).toEqual(["nswp:world", "https://arcade.example"]);
    expect(made.content).toBe("");
    for (const bad of [{ world: "37300:abc:arcade" }, { world: vectors.world.replace("37300", "37306") }, { id: "First Steps" }, { id: "" }, { title: "" }, { title: "\n" }, { title: null }, { origin: "nowhere" }]) {
      expect(achievementForWorld({ ...ok, ...bad } as never), JSON.stringify(bad)).toBeNull();
    }
    expect(cleanAchievementId("all-twelve")).toBe("all-twelve");
  });

  it("reads the message, tidied, and nothing malformed", () => {
    const say = (more: Record<string, unknown>) => readSignerRequest({ nswp: SIGNER_PROTOCOL, v: 1, id: "a1", ...more });
    expect(say({ t: "achieve", world: vectors.world, achievement: "all-twelve", title: " All  twelve ", origin: "https://other.example" })).toEqual({ t: "achieve", id: "a1", world: vectors.world, achievement: "all-twelve", title: "All twelve" });
    expect(say({ t: "achieve", world: vectors.world, achievement: "All Twelve", title: "x" })).toBeNull();
    expect(say({ t: "achieve", world: vectors.world, achievement: "all-twelve", title: " " })).toBeNull();
    expect(say({ t: "achieve", world: "x", achievement: "all-twelve", title: "x" })).toBeNull();
  });

  it("can't be had any other way: `sign` refuses the kind for a world", () => {
    expect(prepareForSite({ kind: ACHIEVEMENT_KIND, content: "", tags: [["title", "Anything"]] }, "https://arcade.example", 1)).toBeNull();
  });
});
