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
