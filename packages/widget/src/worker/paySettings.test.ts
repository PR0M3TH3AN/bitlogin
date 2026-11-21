import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { loadPaySettings, PAY_SETTINGS_D, savePaySettings, type PaySettingsRelays } from "./paySettings.js";

function fakeRelays() {
  const events = new Map<string, NostrEvent>();
  const self = {
    up: true,
    events,
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      if (!self.up) return { outcomes: [], respondedCount: 0 };
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent): Promise<RelayPublishOutcome[]> {
      if (self.up) events.set(event.tags.find((t) => t[0] === "d")?.[1] ?? event.id, event);
      return self.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: self.up, message: "" } })) as RelayPublishOutcome[];
    }
  };
  return self as typeof self & PaySettingsRelays;
}

describe("the limit on a payment with no receipt, kept with the account (docs/paying.md)", () => {
  it("starts at a thousand sats, and follows the account to another device", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 1000, orders: [], unsaved: false });
    expect(await savePaySettings({ ...deps, now: 100 }, { limitSats: 10_000 })).toEqual({ limitSats: 10_000, orders: [], unsaved: false });
    // Sealed on relays: the number can't be read there.
    expect(deps.relays.events.get(PAY_SETTINGS_D)!.content).not.toContain("10000");
    const other = { ...deps, store: new InMemoryKeyValueStore() };
    expect(await loadPaySettings(other)).toEqual({ limitSats: 10_000, orders: [], unsaved: false });
    // Changed there, later: the newer one wins here too.
    await savePaySettings({ ...other, now: 200 }, { limitSats: 0 });
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 0, orders: [], unsaved: false });
  });

  it("stands on the browser's copy with no relay, and sends it when one answers", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    deps.relays.up = false;
    expect(await savePaySettings({ ...deps, now: 100 }, { limitSats: 100_000 })).toEqual({ limitSats: 100_000, orders: [], unsaved: true });
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 100_000, orders: [], unsaved: true });
    deps.relays.up = true;
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 100_000, orders: [], unsaved: false });
    expect(deps.relays.events.has(PAY_SETTINGS_D)).toBe(true);
  });

  it("keeps only one of the steps", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    for (const bad of [{ limitSats: 5000 }, { limitSats: -1 }, { limitSats: "1000" }, {}, null]) await expect(savePaySettings(deps, bad)).rejects.toThrow();
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 1000, orders: [], unsaved: false });
  });

  it("keeps a purchase begun, before anything is paid, and lets it go when it is finished", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    const listing = `30078:${"cd".repeat(32)}:season pass`;
    const order = { listing, order: "order_0123456789abcdef", key: "k".repeat(32), service: "https://api.bitunlock.network", title: "Season pass", via: "https://world.example", client: "" };
    // No relay answers: it is kept in the browser all the same, which is what paying waits for.
    deps.relays.up = false;
    expect(await savePaySettings({ ...deps, now: 100 }, { addOrder: order })).toEqual({ limitSats: 1000, orders: [{ ...order, at: 100 }], unsaved: true });
    deps.relays.up = true;
    expect((await loadPaySettings(deps)).orders).toEqual([{ ...order, at: 100 }]);
    // Another device finds it, with the limit, which a change to one never loses for the other.
    await savePaySettings({ ...deps, now: 150 }, { limitSats: 10_000 });
    expect(await loadPaySettings({ ...deps, store: new InMemoryKeyValueStore() })).toEqual({ limitSats: 10_000, orders: [{ ...order, at: 100 }], unsaved: false });
    // One open order for a listing: a newer one takes its place.
    const newer = { ...order, order: "order_fedcba9876543210" };
    expect((await savePaySettings({ ...deps, now: 200 }, { addOrder: newer })).orders).toEqual([{ ...newer, at: 200 }]);
    expect((await savePaySettings({ ...deps, now: 300 }, { removeOrder: newer.order })).orders).toEqual([]);
    for (const bad of [{ addOrder: { ...order, order: "nope" } }, { addOrder: { ...order, listing: "x" } }, { addOrder: { ...order, key: "short" } }, { addOrder: { ...order, service: "not an address" } }, { addOrder: null }]) {
      await expect(savePaySettings(deps, bad)).rejects.toThrow();
    }
  });
});
