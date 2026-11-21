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
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 1000, unsaved: false });
    expect(await savePaySettings({ ...deps, now: 100 }, { limitSats: 10_000 })).toEqual({ limitSats: 10_000, unsaved: false });
    // Sealed on relays: the number can't be read there.
    expect(deps.relays.events.get(PAY_SETTINGS_D)!.content).not.toContain("10000");
    const other = { ...deps, store: new InMemoryKeyValueStore() };
    expect(await loadPaySettings(other)).toEqual({ limitSats: 10_000, unsaved: false });
    // Changed there, later: the newer one wins here too.
    await savePaySettings({ ...other, now: 200 }, { limitSats: 0 });
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 0, unsaved: false });
  });

  it("stands on the browser's copy with no relay, and sends it when one answers", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    deps.relays.up = false;
    expect(await savePaySettings({ ...deps, now: 100 }, { limitSats: 100_000 })).toEqual({ limitSats: 100_000, unsaved: true });
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 100_000, unsaved: true });
    deps.relays.up = true;
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 100_000, unsaved: false });
    expect(deps.relays.events.has(PAY_SETTINGS_D)).toBe(true);
  });

  it("keeps only one of the steps", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    for (const bad of [{ limitSats: 5000 }, { limitSats: -1 }, { limitSats: "1000" }, {}, null]) await expect(savePaySettings(deps, bad)).rejects.toThrow();
    expect(await loadPaySettings(deps)).toEqual({ limitSats: 1000, unsaved: false });
  });
});
