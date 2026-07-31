import { describe, expect, it } from "vitest";
import { buildVaultIntegrityWarnings } from "./integrityWarnings.js";

describe("buildVaultIntegrityWarnings", () => {
  it("surfaces rollback, quorum, truncation, and unreadable-record evidence", () => {
    const warnings = buildVaultIntegrityWarnings({
      connections: [],
      rollbackWarnings: ["opaque-connection-id"],
      unreadable: ["event-a", "event-b"],
      truncated: true,
      quorumMet: false,
    });

    expect(warnings).toHaveLength(4);
    expect(warnings.join(" ")).toContain("1 wallet record was withheld");
    expect(warnings.join(" ")).not.toContain("opaque-connection-id");
    expect(warnings.join(" ")).toContain("may be incomplete");
    expect(warnings.join(" ")).toContain("maximum record page");
    expect(warnings.join(" ")).toContain(
      "2 encrypted wallet records were unreadable",
    );
  });

  it("stays empty for a complete, readable result", () => {
    expect(
      buildVaultIntegrityWarnings({
        connections: [],
        rollbackWarnings: [],
        unreadable: [],
        truncated: false,
        quorumMet: true,
      }),
    ).toEqual([]);
  });
});
