import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { MockRelay } from "../test-support/mockRelay.js";
import { RelayPool } from "./pool.js";
import { RelayConnection } from "./relay.js";
import { signNostrEvent } from "./event.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";

/** A relay that takes the connection and then answers nothing, as relay.nostr.band did on 2026-11-23. */
async function silentRelay(): Promise<{ url: string; close: () => Promise<void> }> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((done) => wss.once("listening", done));
  return {
    url: `ws://127.0.0.1:${(wss.address() as { port: number }).port}`,
    close: () =>
      new Promise<void>((done) => {
        for (const client of wss.clients) client.terminate();
        wss.close(() => done());
      })
  };
}

describe("RelayPool.publishEnough", () => {
  const closing: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });
  const event = () => {
    const key = generatePrivateKey();
    return signNostrEvent({ pubkey: getPublicKeyHex(key), kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "x" }, key);
  };

  it("stops waiting a moment after two relays took it, and says the silent one didn't", async () => {
    const [a, b] = [await MockRelay.start(), await MockRelay.start()];
    const quiet = await silentRelay();
    closing.push(() => a.close(), () => b.close(), quiet.close);
    const pool = new RelayPool([a.url, b.url, quiet.url]);
    const start = Date.now();
    const outcomes = await pool.publishEnough(event(), 6000, 2, 300);
    pool.closeAll();
    expect(Date.now() - start).toBeLessThan(3000);
    expect(outcomes.map((o) => [o.relayUrl, o.result.ok])).toEqual([[a.url, true], [b.url, true], [quiet.url, false]]);
  });

  it("waits the whole timeout when fewer than two take it: nothing is called taken out of impatience", async () => {
    const a = await MockRelay.start();
    const quiet = await silentRelay();
    closing.push(() => a.close(), quiet.close);
    const pool = new RelayPool([a.url, quiet.url]);
    const start = Date.now();
    const outcomes = await pool.publishEnough(event(), 1500, 2, 100);
    pool.closeAll();
    expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
    expect(outcomes.filter((o) => o.result.ok)).toHaveLength(1);
  });

describe("RelayPool with kept connections and relays not waited for", () => {
  const closing: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const close of closing.splice(0)) await close();
  });
  const event = () => {
    const key = generatePrivateKey();
    return signNostrEvent({ pubkey: getPublicKeyHex(key), kind: 1, created_at: Math.floor(Date.now() / 1000), tags: [], content: "kept" }, key);
  };

  it("asks nothing of a relay not waited for, still sends it the record, and leaves kept connections open", async () => {
    const [a, b] = [await MockRelay.start(), await MockRelay.start()];
    closing.push(() => a.close(), () => b.close());
    const kept = new Map<string, RelayConnection>();
    const heard: [string, boolean][] = [];
    const options = {
      connectionFor: (url: string) => kept.get(url) ?? (kept.set(url, new RelayConnection(url)), kept.get(url)!),
      notWaitedFor: (url: string) => url === b.url,
      heard: (url: string, answered: boolean) => void heard.push([url, answered])
    };
    const pool = new RelayPool([a.url, b.url], options);
    const sent = event();
    const outcomes = await pool.publishAll(sent, 3000);
    expect(outcomes.find((o) => o.relayUrl === b.url)?.result).toEqual({ ok: false, message: "Not waited for: it didn't answer a moment ago." });
    const found = await pool.queryQuorum({ ids: [sent.id] }, 3000);
    expect(found.outcomes.find((o) => o.relayUrl === b.url)).toMatchObject({ responded: false, events: [] });
    expect(found.respondedCount).toBe(1);
    pool.closeAll();
    // Still open, kept: the next pool asks over the same connection. And the relay not waited for got the record.
    const again = new RelayPool([b.url], { connectionFor: options.connectionFor });
    expect((await again.queryQuorum({ ids: [sent.id] }, 3000)).outcomes[0]!.events.map((e) => e.id)).toEqual([sent.id]);
    expect(heard.filter(([url]) => url === a.url).every(([, answered]) => answered)).toBe(true);
    for (const conn of kept.values()) conn.close();
  });

  it("asks every relay when every one is not waited for: never nobody", async () => {
    const a = await MockRelay.start();
    closing.push(() => a.close());
    const pool = new RelayPool([a.url], { notWaitedFor: () => true });
    expect((await pool.queryQuorum({ kinds: [1] }, 3000)).respondedCount).toBe(1);
    pool.closeAll();
  });
});
});
