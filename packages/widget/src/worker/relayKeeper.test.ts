import { describe, expect, it } from "vitest";
import type { RelayConnection } from "@bitlogin/core/nostr";
import { RelayKeeper, REMEMBER_FAILED_MS } from "./relayKeeper.js";

/** Stand-ins for connections: what was opened and what was closed is all these tests need. */
function keeperAt(clock: { t: number }) {
  const opened: string[] = [];
  const closed: string[] = [];
  const keeper = new RelayKeeper(3000, () => clock.t, (url) => (opened.push(url), { url, close: () => closed.push(url) } as unknown as RelayConnection));
  return { keeper, opened, closed };
}

describe("RelayKeeper", () => {
  it("keeps one connection to a relay between actions", () => {
    const { keeper, opened } = keeperAt({ t: 0 });
    expect(keeper.connectionFor("wss://a.example")).toBe(keeper.connectionFor("wss://a.example"));
    expect(opened).toEqual(["wss://a.example"]);
  });

  it("remembers a relay that failed, for the memory's time and no longer, and drops its connection", () => {
    const clock = { t: 0 };
    const { keeper, opened, closed } = keeperAt(clock);
    keeper.connectionFor("wss://quiet.example");
    keeper.heard("wss://quiet.example", false);
    expect(closed).toEqual(["wss://quiet.example"]);
    expect(keeper.notWaitedFor("wss://quiet.example")).toBe(true);
    clock.t = REMEMBER_FAILED_MS - 1;
    expect(keeper.notWaitedFor("wss://quiet.example")).toBe(true);
    clock.t = REMEMBER_FAILED_MS;
    expect(keeper.notWaitedFor("wss://quiet.example")).toBe(false);
    // Tried again afresh: a new connection.
    keeper.connectionFor("wss://quiet.example");
    expect(opened).toEqual(["wss://quiet.example", "wss://quiet.example"]);
  });

  it("forgets a failure once the relay answers, and never remembers one that wasn't tried", () => {
    const { keeper } = keeperAt({ t: 0 });
    expect(keeper.notWaitedFor("wss://never-asked.example")).toBe(false);
    keeper.heard("wss://b.example", false);
    keeper.heard("wss://b.example", true);
    expect(keeper.notWaitedFor("wss://b.example")).toBe(false);
  });

  it("closes everything, and forgets everything, when the session goes", () => {
    const { keeper, closed } = keeperAt({ t: 0 });
    keeper.connectionFor("wss://a.example");
    keeper.connectionFor("wss://b.example");
    keeper.heard("wss://c.example", false);
    keeper.closeAll();
    expect(closed.sort()).toEqual(["wss://a.example", "wss://b.example"]);
    expect(keeper.notWaitedFor("wss://c.example")).toBe(false);
  });
});
