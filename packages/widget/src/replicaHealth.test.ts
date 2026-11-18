import { describe, expect, it } from "vitest";
import type { ReplicaHealthResult, ReplicaStatus } from "@bitlogin/core/account";
import {
  buildKeyBackupText,
  cleanRelayText,
  relayProblemNotes,
  replicaStatusLabel,
  summarizeReplicaHealth
} from "./replicaHealth.js";

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

describe("relayProblemNotes", () => {
  const relayUrl = "wss://relay.example";
  const ok = { ok: true, message: "" };

  it("says nothing about a relay that holds both capsules", () => {
    expect(relayProblemNotes({ relayUrl, credential: "current", recovery: "current" })).toEqual([]);
    expect(
      relayProblemNotes(
        { relayUrl, credential: "current", recovery: "current" },
        { relayUrl, credential: { ok: false, message: "duplicate" }, recovery: ok }
      )
    ).toEqual([]);
  });

  it("quotes the relay's refusal for the capsule it refused", () => {
    expect(
      relayProblemNotes(
        { relayUrl, credential: "missing", recovery: "current" },
        { relayUrl, credential: { ok: false, message: "rate-limited: slow down" }, recovery: ok }
      )
    ).toEqual(["Refused the sign-in copy: rate-limited: slow down"]);
    expect(
      relayProblemNotes(
        { relayUrl, credential: "missing", recovery: "missing" },
        { relayUrl, credential: { ok: false, message: "" }, recovery: { ok: false, message: "blocked" } }
      )
    ).toEqual(["Refused the sign-in copy without giving a reason", "Refused the recovery copy: blocked"]);
  });

  it("calls out a relay that accepts a capsule and then does not serve it", () => {
    expect(
      relayProblemNotes({ relayUrl, credential: "missing", recovery: "current" }, { relayUrl, credential: ok, recovery: ok })
    ).toEqual(["Said it accepted the sign-in copy, but does not return it"]);
  });

  it("falls back to the connection error for a relay that did not answer", () => {
    expect(
      relayProblemNotes({ relayUrl, credential: "unreachable", recovery: "unreachable", error: "WebSocket error" })
    ).toEqual(["No answer: WebSocket error"]);
    // A failed connection during a re-send is still "no answer", not a refusal.
    const down = { ok: false, message: "WebSocket error" };
    expect(
      relayProblemNotes(
        { relayUrl, credential: "unreachable", recovery: "unreachable", error: "WebSocket error" },
        { relayUrl, credential: down, recovery: down }
      )
    ).toEqual(["No answer: WebSocket error"]);
  });

  it("flattens and caps whatever a relay sends", () => {
    const hostile = `blocked:\n\n<b>pay</b>\u0000\u2028 ${"x".repeat(500)}`;
    const cleaned = cleanRelayText(hostile);
    expect(cleaned.startsWith("blocked: <b>pay</b> xxx")).toBe(true);
    expect(cleaned.length).toBe(140);
    expect(cleaned.endsWith("…")).toBe(true);
    expect(cleaned).not.toMatch(/[\u0000-\u001f\u2028]/u);
  });
});
