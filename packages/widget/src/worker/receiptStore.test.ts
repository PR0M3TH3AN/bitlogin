import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { keepReceipts, loadReceipts, RECEIPT_RECORD_D, type ReceiptRelays } from "./receiptStore.js";

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
  return self as typeof self & ReceiptRelays;
}
const service = new NostrSigner(generatePrivateKey());
const receipt = (buyer: string, n: number): NostrEvent =>
  service.signEvent({ kind: 30078, created_at: 1_800_000_000 + n, tags: [["d", `bitunlock:entitlement:v1:ful_${n}`]], content: JSON.stringify({ buyerPubkey: buyer, productCoordinate: `30078:${"cd".repeat(32)}:thing-${n}`, orderId: `order_${n}` }) });

describe("where a person's receipts are kept (docs/paying.md)", () => {
  it("keeps a receipt in the browser first, then sealed on relays, and another device reads it", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    const me = deps.signer.getPublicKey();
    expect(await loadReceipts(deps)).toEqual({ receipts: [], offline: false, unsaved: false });
    const one = receipt(me, 1);
    const kept = await keepReceipts(deps, [{ event: one, title: "Season pass", via: "https://world.example" }]);
    expect(kept).toEqual({ receipts: [{ event: one, title: "Season pass", via: "https://world.example" }], offline: false, unsaved: false });
    // On relays it is one sealed record: nothing of it can be read by anyone else.
    const record = deps.relays.events.get(RECEIPT_RECORD_D + one.id)!;
    expect(record.pubkey).toBe(me);
    expect(record.content).not.toContain("Season");
    expect(record.content).not.toContain(one.id);
    // Another device, with nothing in its browser.
    const other = { ...deps, store: new InMemoryKeyValueStore() };
    expect((await loadReceipts(other)).receipts).toEqual(kept.receipts);
    // Kept twice is kept once.
    expect((await keepReceipts(deps, [{ event: one, title: "x", via: "" }])).receipts).toHaveLength(1);
  });

  it("holds a receipt no relay took, says so, and sends it again later", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    const me = deps.signer.getPublicKey();
    deps.relays.up = false;
    const one = receipt(me, 2);
    expect(await keepReceipts(deps, [{ event: one, title: "", via: "" }])).toMatchObject({ unsaved: true });
    expect(await loadReceipts(deps)).toMatchObject({ offline: true, unsaved: true, receipts: [{ event: one }] });
    deps.relays.up = true;
    expect(await loadReceipts(deps)).toMatchObject({ offline: false, unsaved: false, receipts: [{ event: one }] });
    expect(deps.relays.events.has(RECEIPT_RECORD_D + one.id)).toBe(true);
    // A relay that later loses it is sent it again.
    deps.relays.events.clear();
    expect(await loadReceipts(deps)).toMatchObject({ unsaved: false });
    expect(deps.relays.events.has(RECEIPT_RECORD_D + one.id)).toBe(true);
  });

  it("keeps only this account's own receipts, and only real ones", async () => {
    const deps = { signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() };
    const me = deps.signer.getPublicKey();
    await expect(keepReceipts(deps, [{ event: receipt("ab".repeat(32), 3), title: "", via: "" }])).rejects.toThrow();
    await expect(keepReceipts(deps, [{ event: { ...receipt(me, 4), sig: "00".repeat(64) }, title: "", via: "" }])).rejects.toThrow();
    await expect(keepReceipts(deps, [])).rejects.toThrow();
    await expect(keepReceipts(deps, "nonsense")).rejects.toThrow();
    // Where it was bought is an address or nothing.
    expect((await keepReceipts(deps, [{ event: receipt(me, 5), title: "T", via: "javascript:alert(1)" }])).receipts[0]!.via).toBe("");
  });
});
