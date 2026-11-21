import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cleanShareLabel, readShares, SHARE_LIMITS, splitPrice } from "./shares.js";

// NSWP's own vectors for the rule, copied unchanged from its `vectors/shares.json` at commit f3ffc86 (2026-11-21).
// The kit and BitUnlock are run against the same file.
const vectors = JSON.parse(readFileSync(new URL("./vectors/shares.json", import.meta.url), "utf8"));

describe("a price divided between several people, by NSWP's own vectors (docs/paying.md PY14)", () => {
  it("has the limits the vectors were written to", () => {
    expect(SHARE_LIMITS).toEqual(vectors.limits);
  });

  for (const v of vectors.reading) {
    it(`reads a listing's shares: ${v.name}`, () => {
      expect(readShares(v.tags, v.seller)).toEqual(v.expect);
    });
  }

  for (const v of vectors.splitting) {
    it(`divides a price: ${v.name}`, () => {
      expect(splitPrice(v.price, v.shares, v.seller, { ...(v.client ? { client: v.client } : {}), ...(v.charge !== undefined ? { charge: v.charge } : {}) })).toEqual(v.expect);
    });
  }

  it("takes a share's word trimmed, and not one that hides or rearranges", () => {
    expect(cleanShareLabel("  maker ")).toBe("maker");
    for (const bad of ["", "   ", "x".repeat(33), `mak${String.fromCodePoint(0x202e)}er`, `mak${String.fromCodePoint(0x200b)}er`, "two\nlines", 5]) expect(cleanShareLabel(bad)).toBe("");
  });
});
