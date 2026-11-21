import { describe, expect, it } from "vitest";
import type { NostrEvent, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { quickRelays } from "./quickRelays.js";

const event = (id: string) => ({ id, kind: 1, pubkey: "", created_at: 0, tags: [], content: "", sig: "" }) as NostrEvent;
/** A relay that answers after `ms`, or never (`ms` < 0), or with nothing because it is down. */
const relay = (url: string, ms: number, up = true) => ({
  closed: false,
  queryQuorum: (_f: unknown, timeout = 1000) => new Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>((done) => setTimeout(() => done(up && ms >= 0 ? { outcomes: [{ events: [event(url)] }], respondedCount: 1 } : { outcomes: [{ events: [] }], respondedCount: 0 }), ms >= 0 ? ms : timeout)),
  publishAll: (_e: NostrEvent, timeout = 1000) => new Promise<RelayPublishOutcome[]>((done) => setTimeout(() => done([{ relayUrl: url, result: { ok: up && ms >= 0, message: "" } }] as RelayPublishOutcome[]), ms >= 0 ? ms : timeout)),
  closeAll() {
    this.closed = true;
  }
});
const ids = (found: { outcomes: { events: NostrEvent[] }[] }) => found.outcomes.flatMap((o) => o.events.map((e) => e.id)).sort();

describe("relays asked together, and not waited on to the last one (docs/paying.md PY13)", () => {
  it("is finished a moment after two have answered, whatever the slow ones do", async () => {
    const made = new Map([["a", relay("a", 10)], ["b", relay("b", 20)], ["dead", relay("dead", -1)], ["slow", relay("slow", 400)]]);
    const pool = quickRelays([...made.keys()], (url) => made.get(url)!, { enough: 2, graceMs: 60 });
    const began = Date.now();
    const found = await pool.queryQuorum({ kinds: [1] }, 2000);
    expect(Date.now() - began).toBeLessThan(300);
    expect(ids(found)).toEqual(["a", "b"]);
    expect(found.respondedCount).toBe(2);
    const sent = await pool.publishAll(event("x"), 2000);
    expect(Date.now() - began).toBeLessThan(600);
    expect(sent.filter((o) => o.result.ok).map((o) => o.relayUrl).sort()).toEqual(["a", "b"]);
    pool.closeAll();
    expect([...made.values()].every((r) => r.closed)).toBe(true);
  });

  it("takes a relay that answers within the moment", async () => {
    const made = new Map([["a", relay("a", 5)], ["b", relay("b", 10)], ["c", relay("c", 40)]]);
    const pool = quickRelays([...made.keys()], (url) => made.get(url)!, { enough: 2, graceMs: 200 });
    expect(ids(await pool.queryQuorum({ kinds: [1] }, 2000))).toEqual(["a", "b", "c"]);
  });

  it("waits the whole time where fewer than two answer, and says how many did: never 'none' because it was impatient", async () => {
    const made = new Map([["a", relay("a", 10)], ["dead", relay("dead", -1)], ["down", relay("down", 15, false)]]);
    const pool = quickRelays([...made.keys()], (url) => made.get(url)!, { enough: 2, graceMs: 20 });
    const began = Date.now();
    const found = await pool.queryQuorum({ kinds: [1] }, 250);
    expect(Date.now() - began).toBeGreaterThanOrEqual(240);
    expect(found.respondedCount).toBe(1);
    // With one relay, one answer is all there is to wait for; with none, there is nothing.
    expect((await quickRelays(["a"], () => relay("a", 5), { enough: 2, graceMs: 20 }).queryQuorum({ kinds: [1] })).respondedCount).toBe(1);
    expect(await quickRelays([], () => relay("x", 5)).queryQuorum({ kinds: [1] })).toEqual({ outcomes: [], respondedCount: 0 });
  });
});
