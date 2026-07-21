import { describe, expect, it, afterEach } from "vitest";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { signNostrEvent, verifyNostrEvent } from "./event.js";
import { KIND_APP_DATA } from "./kinds.js";
import { RelayConnection } from "./relay.js";
import { RelayPool } from "./pool.js";
import { MockRelay } from "../test-support/mockRelay.js";

describe("NIP-01 event id/sign/verify", () => {
  it("signs an event and verifies it", () => {
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      { pubkey, created_at: 1700000000, kind: KIND_APP_DATA, tags: [["d", "bitlogin:password:v1"]], content: "hello" },
      sk
    );
    expect(verifyNostrEvent(event)).toBe(true);
  });

  it("rejects a tampered event", () => {
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      { pubkey, created_at: 1700000000, kind: KIND_APP_DATA, tags: [["d", "x"]], content: "hello" },
      sk
    );
    const tampered = { ...event, content: "goodbye" };
    expect(verifyNostrEvent(tampered)).toBe(false);
  });
});

describe("RelayConnection + MockRelay", () => {
  let relay: MockRelay;

  afterEach(async () => {
    await relay?.close();
  });

  it("publishes and reads back an addressable kind-30078 event", async () => {
    relay = await MockRelay.start();
    const conn = new RelayConnection(relay.url);
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      { pubkey, created_at: 1700000000, kind: KIND_APP_DATA, tags: [["d", "bitlogin:password:v1"]], content: "ciphertext" },
      sk
    );
    const result = await conn.publish(event);
    expect(result.ok).toBe(true);

    const found = await conn.queryOnce({ kinds: [KIND_APP_DATA], authors: [pubkey], "#d": ["bitlogin:password:v1"] });
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(event.id);
    conn.close();
  });

  it("replaces an addressable event only with a newer created_at (NIP-01 replacement)", async () => {
    relay = await MockRelay.start();
    const conn = new RelayConnection(relay.url);
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const older = signNostrEvent(
      { pubkey, created_at: 1000, kind: KIND_APP_DATA, tags: [["d", "bitlogin:recovery:v1"]], content: "gen1" },
      sk
    );
    const newer = signNostrEvent(
      { pubkey, created_at: 2000, kind: KIND_APP_DATA, tags: [["d", "bitlogin:recovery:v1"]], content: "gen2" },
      sk
    );
    await conn.publish(newer);
    await conn.publish(older); // stale replay attempt, must not win
    const found = await conn.queryOnce({ kinds: [KIND_APP_DATA], authors: [pubkey], "#d": ["bitlogin:recovery:v1"] });
    expect(found).toHaveLength(1);
    expect(found[0]?.content).toBe("gen2");
    conn.close();
  });
});

describe("RelayPool quorum", () => {
  let relays: MockRelay[] = [];

  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
    relays = [];
  });

  it("reports quorum met when a majority of relays respond", async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start(), MockRelay.start()]);
    const pool = new RelayPool(relays.map((r) => r.url));
    const sk = generatePrivateKey();
    const pubkey = getPublicKeyHex(sk);
    const event = signNostrEvent(
      { pubkey, created_at: 1700000000, kind: KIND_APP_DATA, tags: [["d", "bitlogin:password:v1"]], content: "x" },
      sk
    );
    await pool.publishAll(event);
    const result = await pool.queryQuorum({ kinds: [KIND_APP_DATA], authors: [pubkey], "#d": ["bitlogin:password:v1"] });
    expect(result.quorumMet).toBe(true);
    expect(result.respondedCount).toBe(3);
    const withEvents = result.outcomes.filter((o) => o.events.length > 0);
    expect(withEvents).toHaveLength(3);
    pool.closeAll();
  });
});
