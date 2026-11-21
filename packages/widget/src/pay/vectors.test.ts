import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { readListing, readReceipt, receiptGood, underFloor, UNLOCK_SERVICES } from "./listing.js";

const vector = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/${name}.json`, import.meta.url), "utf8"));

describe("BitUnlock's published vectors, read by BitLogin's buyer side (docs/paying.md)", () => {
  it("reads the product listing: its seller's signature, its price, and the real service by its pinned key", () => {
    const event = vector("product-event-v1");
    const d = event.tags.find((t: string[]) => t[0] === "d")[1];
    const listing = readListing(event, `30078:${event.pubkey}:${d}`);
    expect(listing).toMatchObject({ seller: event.pubkey, title: "Relay Runner", priceSats: 21_000, service: UNLOCK_SERVICES[0], for: "", termSeconds: 0, nswp: false, shared: false });
    // It carries no `nswp:` tag, so it is not held to the floor for things sold in a world.
    expect(underFloor(listing!)).toBe(false);
    expect(underFloor({ nswp: true, priceSats: 499 })).toBe(true);
    expect(underFloor({ nswp: true, priceSats: 500 })).toBe(false);
    expect(underFloor({ nswp: false, priceSats: 1 })).toBe(false);
  });

  it("reads the receipt's words, once a service has signed them", () => {
    const document = vector("entitlement-v1");
    const service = new NostrSigner(generatePrivateKey());
    const event = service.signEvent({ kind: 30078, created_at: document.issuedAt, tags: [["d", `bitunlock:entitlement:v1:${document.fulfillmentId}`]], content: JSON.stringify(document) });
    const receipt = readReceipt(event, [{ endpoint: "https://s.example", pubkey: service.getPublicKey() }]);
    expect(receipt).toMatchObject({ listing: document.productCoordinate, buyer: document.buyerPubkey, seller: document.sellerPubkey, order: document.orderId, fulfillment: document.fulfillmentId, issuedAt: document.issuedAt, expiresAt: 0 });
    expect(receiptGood(receipt, { buyer: document.buyerPubkey, listing: document.productCoordinate, now: document.issuedAt + 10 })).toBe(true);
    // The same words, signed by a key BitLogin doesn't know, are not a receipt.
    expect(readReceipt(event)).toBeNull();
  });
});
