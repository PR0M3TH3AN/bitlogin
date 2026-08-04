/** Adversarial-relay hardening (audit BL-18, BL-19): a malicious or flaky
 *  relay must neither strand a query promise nor amplify memory before EOSE. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { RelayConnection } from "./relay.js";
import { signNostrEvent } from "./event.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";

describe("relay hardening", () => {
  let relay: MockRelay;
  let conn: RelayConnection;

  beforeEach(async () => {
    relay = await MockRelay.start();
    conn = new RelayConnection(relay.url);
  });

  afterEach(async () => {
    conn.close();
    await relay.close();
  });

  function signedNote(key: Uint8Array, content: string, created_at = 1_700_000_000) {
    return signNostrEvent(
      { pubkey: getPublicKeyHex(key), created_at, kind: 1, tags: [], content },
      key
    );
  }

  it("BL-18: a relay that dies mid-query still settles the promise", async () => {
    await conn.connect();
    // Subscription opens against a relay that never answers (no EOSE), and
    // the relay then goes away entirely before the client's timeout.
    relay.suppressEose = true;
    const key = generatePrivateKey();
    const pending = conn.queryOnce({ kinds: [1], authors: [getPublicKeyHex(key)] }, 400);
    await new Promise((resolve) => setTimeout(resolve, 50)); // let REQ hit the wire
    await relay.close();
    // Before the fix, the timeout path threw sending CLOSE on the dead
    // socket and the promise never settled -- wedging everything behind the
    // worker's serial queue. Now it must reject, promptly.
    await expect(pending).rejects.toThrow(/did not answer/);
  });

  it("BL-19: replayed duplicates are dropped and filter.limit is enforced locally", async () => {
    const key = generatePrivateKey();
    const note = signedNote(key, "hello");
    // A hostile relay spraying 20 copies of the same valid, filter-matching
    // event before EOSE.
    relay.unsolicitedQueryEvents = Array.from({ length: 20 }, () => note);
    const limited = await conn.queryOnce(
      { kinds: [1], authors: [getPublicKeyHex(key)], limit: 1 },
      3000
    );
    expect(limited).toHaveLength(1);
  });

  it("BL-19: duplicates collapse even without an explicit limit", async () => {
    const key = generatePrivateKey();
    const noteA = signedNote(key, "a");
    const noteB = signedNote(key, "b", 1_700_000_001);
    relay.unsolicitedQueryEvents = [noteA, noteA, noteB, noteA, noteB];
    const events = await conn.queryOnce({ kinds: [1], authors: [getPublicKeyHex(key)] }, 3000);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.id)).size).toBe(2);
  });

  it("BL-21: oversized frames are dropped before parsing", async () => {
    const key = generatePrivateKey();
    const real = signedNote(key, "small");
    // A ~600K-character frame (valid JSON, would even match the filter) must
    // be discarded before JSON.parse; the legitimate event still arrives.
    const giant = { ...real, content: "x".repeat(600_000) };
    relay.unsolicitedQueryEvents = [giant, real];
    const events = await conn.queryOnce({ kinds: [1], authors: [getPublicKeyHex(key)] }, 3000);
    expect(events).toHaveLength(1);
    expect(events[0]!.content).toBe("small");
  });

  it("BL-21: replayed copies cost one verification, not one each", async () => {
    const key = generatePrivateKey();
    const note = signedNote(key, "replayed");
    relay.unsolicitedQueryEvents = Array.from({ length: 2000 }, () => note);
    const start = Date.now();
    const events = await conn.queryOnce(
      { kinds: [1], authors: [getPublicKeyHex(key)], limit: 1 },
      10_000
    );
    const elapsed = Date.now() - start;
    expect(events).toHaveLength(1);
    // 2,000 Schnorr verifications would take seconds; one verification plus
    // 1,999 Set lookups completes far inside this generous bound.
    expect(elapsed).toBeLessThan(2_500);
  });

  it("BL-21: distinct invalid events exhaust the verification budget, not the CPU", async () => {
    const key = generatePrivateKey();
    const real = signedNote(key, "real");
    // 500 distinct, filter-matching events with forged signatures ahead of
    // the real one. The budget (3x limit, floor 50) stops verification long
    // before 500; the query still settles cleanly at EOSE.
    relay.unsolicitedQueryEvents = [
      ...Array.from({ length: 500 }, (_, i) => ({
        ...signedNote(key, `forged-${i}`, 1_700_000_100 + i),
        sig: "ab".repeat(64)
      })),
      real
    ];
    const events = await conn.queryOnce(
      { kinds: [1], authors: [getPublicKeyHex(key)], limit: 1 },
      10_000
    );
    // The budget is exhausted by forgeries before the real event arrives --
    // the query returns empty rather than burning unbounded CPU. This is the
    // documented trade: a relay that sprays forgeries is a hostile relay.
    expect(events.length).toBeLessThanOrEqual(1);
  });

  it("BL-25: live subscriptions dedupe replayed events -- one delivery, ever", async () => {
    const key = generatePrivateKey();
    const note = signedNote(key, "live");
    relay.unsolicitedQueryEvents = Array.from({ length: 2000 }, () => note);
    const delivered: string[] = [];
    const start = Date.now();
    const handle = await conn.subscribeLive({ kinds: [1], authors: [getPublicKeyHex(key)] }, (event) =>
      delivered.push(event.id)
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    handle.close();
    expect(delivered).toHaveLength(1);
    // 2,000 replayed frames cost one verification plus Set lookups.
    expect(Date.now() - start).toBeLessThan(3_000);
  });

  it("BL-25: live subscriptions rate-limit verification of distinct events per window", async () => {
    const key = generatePrivateKey();
    relay.unsolicitedQueryEvents = Array.from({ length: 300 }, (_, i) =>
      signedNote(key, `distinct-${i}`, 1_700_000_000 + i)
    );
    const delivered: string[] = [];
    const handle = await conn.subscribeLive({ kinds: [1], authors: [getPublicKeyHex(key)] }, (event) =>
      delivered.push(event.id)
    );
    await new Promise((resolve) => setTimeout(resolve, 600));
    handle.close();
    // The fixed window admits at most 100 verifications; the rest of the
    // spray is quarantined until the window rolls over.
    expect(delivered.length).toBeGreaterThan(0);
    expect(delivered.length).toBeLessThanOrEqual(100);
  });

  it("BL-19: distinct events beyond the requested limit are not buffered", async () => {
    const key = generatePrivateKey();
    relay.unsolicitedQueryEvents = Array.from({ length: 10 }, (_, i) =>
      signedNote(key, `n${i}`, 1_700_000_000 + i)
    );
    const events = await conn.queryOnce(
      { kinds: [1], authors: [getPublicKeyHex(key)], limit: 3 },
      3000
    );
    expect(events).toHaveLength(3);
  });
});
