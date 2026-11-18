import { describe, expect, it } from "vitest";
import type { ReplicaHealthResult, ReplicaStatus } from "@bitlogin/core/account";
import { buildKeyBackupText, replicaStatusLabel, summarizeReplicaHealth } from "./replicaHealth.js";

function health(rows: Array<[ReplicaStatus, ReplicaStatus]>): ReplicaHealthResult {
  const relays = rows.map(([credential, recovery], i) => ({
    relayUrl: `wss://relay${i}.example`,
    credential,
    recovery
  }));
  return {
    relays,
    totalCount: relays.length,
    reachableCount: relays.filter((r) => r.credential !== "unreachable" && r.recovery !== "unreachable").length,
    credentialCurrentCount: relays.filter((r) => r.credential === "current").length,
    recoveryCurrentCount: relays.filter((r) => r.recovery === "current").length,
    checkedAt: 1_800_000_000
  };
}

describe("summarizeReplicaHealth", () => {
  it("is healthy only when every relay holds both capsules", () => {
    const summary = summarizeReplicaHealth(
      health([
        ["current", "current"],
        ["current", "current"],
        ["current", "current"]
      ])
    );
    expect(summary.level).toBe("healthy");
    expect(summary.repairUseful).toBe(false);
    expect(summary.detail).toContain("Sign-in copy on 3 of 3 relays, recovery copy on 3 of 3.");
  });

  it("is degraded when a relay lacks a copy but two still hold each", () => {
    const summary = summarizeReplicaHealth(
      health([
        ["current", "current"],
        ["current", "current"],
        ["missing", "unreachable"]
      ])
    );
    expect(summary.level).toBe("degraded");
    expect(summary.repairUseful).toBe(true);
  });

  it("is at risk when either capsule is down to one relay", () => {
    const summary = summarizeReplicaHealth(
      health([
        ["current", "current"],
        ["current", "missing"],
        ["current", "missing"]
      ])
    );
    expect(summary.level).toBe("at-risk");
    expect(summary.detail).toContain("recovery copy on 1 of 3");
  });

  it("says which sign-in path is gone when a capsule is on no relay", () => {
    const recoveryGone = summarizeReplicaHealth(
      health([
        ["current", "missing"],
        ["current", "missing"]
      ])
    );
    expect(recoveryGone.level).toBe("lost");
    expect(recoveryGone.detail).toContain("your recovery phrase can find it");
    expect(recoveryGone.repairUseful).toBe(true);

    const bothGone = summarizeReplicaHealth(
      health([
        ["missing", "missing"],
        ["missing", "missing"],
        ["unreachable", "unreachable"]
      ])
    );
    expect(bothGone.level).toBe("lost");
    expect(bothGone.detail).toContain("neither your password nor your recovery phrase");
  });

  it("does not offer repair to a session a password change left behind", () => {
    const summary = summarizeReplicaHealth(
      health([
        ["newer", "current"],
        ["newer", "current"],
        ["missing", "current"]
      ])
    );
    expect(summary.level).toBe("stale");
    expect(summary.repairUseful).toBe(false);
  });

  it("claims nothing when no relay answered", () => {
    const summary = summarizeReplicaHealth(
      health([
        ["unreachable", "unreachable"],
        ["unreachable", "unreachable"]
      ])
    );
    expect(summary.level).toBe("unknown");
    expect(summary.headline).not.toContain("dropped");
  });
});

describe("replicaStatusLabel", () => {
  it("has a label for every status", () => {
    const statuses: ReplicaStatus[] = ["current", "newer", "older", "missing", "unreachable"];
    expect(statuses.map(replicaStatusLabel)).toEqual(["stored", "newer copy", "old copy", "missing", "no answer"]);
  });
});

describe("buildKeyBackupText", () => {
  it("carries both keys and never a recovery phrase", () => {
    const text = buildKeyBackupText({
      npub: "npub1example",
      nsec: "nsec1example",
      createdAt: new Date("2026-11-18T00:00:00Z")
    });
    expect(text).toContain("Public key (npub): npub1example");
    expect(text).toContain("Private key (nsec): nsec1example");
    expect(text).toContain("Saved: 2026-11-18T00:00:00.000Z");
    expect(text).toContain("Import a Nostr key");
  });
});
