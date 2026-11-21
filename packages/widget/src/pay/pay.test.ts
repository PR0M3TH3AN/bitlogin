import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { cleanLightningAddress, cleanPayLimit, invoiceFromAddress, invoiceSats, lightningAddressOfProfile, overPayLimit, PAY_LIMIT, readWorld, tipNote } from "./lightning.js";
import { belongsTo, bestReceipt, cleanCoordinate, localService, readListing, readReceipt, receiptGood, UNLOCK_SERVICES } from "./listing.js";
import { completePurchase, createUnlockClient, newOrderKey, openSandboxSession, PurchaseError, readPlan, type BuyerKeys } from "./unlock.js";
import { startMockUnlock, type MockUnlock } from "./mockUnlock.js";

/** The seller's wallet, and the buyer's: an invoice is paid when the buyer's side says so. */
const paid = new Set<string>();
let n = 0;
const wallet = {
  invoice: (sats: number) => `lnbc${sats * 10}n1mock${String(++n).replace(/1/gu, "q")}zz`,
  paid: (invoice: string) => paid.has(invoice)
};
let service: MockUnlock;
const local = { fetch: (url: string, init?: RequestInit) => fetch(url, init), local: true };

const buyerKeys = (signer: NostrSigner): BuyerKeys => ({
  pubkey: signer.getPublicKey(),
  async auth({ url, method, payload }) {
    const event = signer.signEvent({ kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags: [["u", url], ["method", method], ["bitunlock:nonce", crypto.randomUUID()], ...(payload ? [["payload", payload]] : [])] });
    return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`;
  },
  async open(from, sealed) {
    return signer.nip44Decrypt(from, sealed);
  }
});

beforeAll(async () => {
  service = await startMockUnlock(wallet);
});
afterAll(() => service.close());

describe("a tip, and the limit on a payment with no receipt (docs/paying.md)", () => {
  it("reads how many sats an invoice asks for, and refuses what is not a whole number of them", () => {
    expect(invoiceSats("lnbc10n1pxyz")).toBe(1);
    expect(invoiceSats("lnbc2500u1pxyz")).toBe(250_000);
    expect(invoiceSats("lnbc1m1pxyz")).toBe(100_000);
    expect(invoiceSats("lnbc21pxyz")).toBe(200_000_000);
    expect(invoiceSats("lnbc10000p1pxyz")).toBe(1);
    expect(invoiceSats("lntb500n1pxyz")).toBe(50);
    expect(invoiceSats("lnbcrt500n1pxyz")).toBe(50);
    // No amount, a fraction of a sat, and nonsense.
    expect(invoiceSats("lnbc1pxyz")).toBeNull();
    expect(invoiceSats("lnbc1n1pxyz")).toBeNull();
    expect(invoiceSats("lnbc15p1pxyz")).toBeNull();
    expect(invoiceSats("lnbc0n1pxyz")).toBeNull();
    expect(invoiceSats("bitcoin")).toBeNull();
    expect(invoiceSats(5)).toBeNull();
  });

  it("takes a lightning address for one, and nothing else", () => {
    expect(cleanLightningAddress(" Alice@Example.com ")).toBe("alice@example.com");
    expect(cleanLightningAddress("a.b+c@pay.example.co.uk")).toBe("a.b+c@pay.example.co.uk");
    for (const bad of ["alice", "@example.com", "alice@", "alice@localhost", "alice@127.0.0.1:8080", "al ice@example.com", "alice@exa mple.com", "alice@example", "a@b@c.com/x", "alice@example.com/path", 7, null]) {
      expect(cleanLightningAddress(bad)).toBe("");
    }
    // A host on this machine only where BitLogin itself is a local copy.
    expect(cleanLightningAddress("alice@127.0.0.1:8080", { local: true })).toBe("alice@127.0.0.1:8080");
    expect(lightningAddressOfProfile(JSON.stringify({ name: "A", lud16: "A@Example.com" }))).toBe("a@example.com");
    expect(lightningAddressOfProfile(JSON.stringify({ name: "A" }))).toBe("");
    expect(lightningAddressOfProfile("not json")).toBe("");
  });

  it("asks an address for an invoice of exactly the amount, and pays no other", async () => {
    const { invoice, note: none } = await invoiceFromAddress(service.address("alice"), 21, local);
    expect(none).toBe("");
    expect(invoiceSats(invoice)).toBe(21);
    // An address that answers with a larger invoice is not paid.
    service.overcharge = 5;
    await expect(invoiceFromAddress(service.address("alice"), 21, local)).rejects.toMatchObject({ code: "wrong-invoice" });
    // Out of the range it takes, and no address at all.
    await expect(invoiceFromAddress(service.address("alice"), 1_000_000, local)).rejects.toMatchObject({ code: "refused-amount" });
    await expect(invoiceFromAddress("alice@127.0.0.1:1", 21, local)).rejects.toMatchObject({ code: "unreachable" });
    // The real address never asks a host on this machine.
    await expect(invoiceFromAddress(service.address("alice"), 21, { fetch: local.fetch })).rejects.toMatchObject({ code: "no-address" });
    await expect(invoiceFromAddress("alice@example.com", 0, local)).rejects.toMatchObject({ code: "no-address" });
  });

  it("reads a world's own word for its tip address and its publishers, from that world's address only", async () => {
    const key = "ab".repeat(32);
    const fetcher = async (url: string) => {
      expect(url).toBe("https://world.example/.well-known/nswp.json");
      return new Response(JSON.stringify({ tip: "World@Pay.example", publishers: { [key]: { worlds: ["w"] }, nonsense: {} } }));
    };
    expect(await readWorld("https://world.example", { fetch: fetcher })).toEqual({ tip: "world@pay.example", publishers: [key] });
    expect(await readWorld("https://world.example/path", { fetch: fetcher })).toEqual({ tip: "", publishers: [] });
    expect(await readWorld("http://world.example", { fetch: fetcher })).toEqual({ tip: "", publishers: [] });
    expect(await readWorld("https://gone.example", { fetch: async () => new Response("no", { status: 404 }) })).toEqual({ tip: "", publishers: [] });
  });

  it("holds a payment with no receipt to a limit that is one of a few steps", () => {
    expect(PAY_LIMIT).toEqual({ default: 1000, steps: [1000, 10_000, 100_000, 0] });
    for (const step of PAY_LIMIT.steps) expect(cleanPayLimit(step)).toBe(step);
    for (const bad of [5000, -1, 1.5, "1000", null, undefined, 1_000_000]) expect(cleanPayLimit(bad)).toBe(1000);
    expect(overPayLimit(1000, 1000)).toBe(false);
    expect(overPayLimit(1001, 1000)).toBe(true);
    // 0 is "no limit".
    expect(overPayLimit(1_000_000, 0)).toBe(false);
  });

  it("sends a note with a tip only where the address takes one, and no longer than it takes", async () => {
    expect(tipNote("Ada", "https://gallery.example")).toBe("A tip from Ada, in gallery.example");
    expect(tipNote("", "https://gallery.example")).toBe("A tip, in gallery.example");
    expect(tipNote(`Ada${String.fromCodePoint(0x202e)}\n`, "nonsense")).toBe("A tip from Ada");
    const asked: string[] = [];
    const address = (commentAllowed?: number) => async (url: string) => {
      asked.push(url);
      if (url.includes("/.well-known/lnurlp/")) return new Response(JSON.stringify({ tag: "payRequest", callback: "https://pay.example/cb", minSendable: 1000, maxSendable: 10_000_000, ...(commentAllowed === undefined ? {} : { commentAllowed }) }));
      return new Response(JSON.stringify({ pr: "lnbc210n1mockzz" }));
    };
    const note = "A tip from Ada, in gallery.example";
    expect(await invoiceFromAddress("bob@pay.example", 21, { fetch: address(255), note })).toEqual({ invoice: "lnbc210n1mockzz", note });
    expect(new URL(asked.at(-1)!).searchParams.get("comment")).toBe(note);
    expect((await invoiceFromAddress("bob@pay.example", 21, { fetch: address(12), note })).note).toBe("A tip from A");
    // It takes none, or says nothing: none is sent, and the tip still goes.
    for (const allowed of [undefined, 0, 4]) {
      expect((await invoiceFromAddress("bob@pay.example", 21, { fetch: address(allowed), note })).note).toBe("");
      expect(new URL(asked.at(-1)!).searchParams.has("comment")).toBe(false);
    }
    expect((await invoiceFromAddress("bob@pay.example", 21, { fetch: address(255) })).note).toBe("");
  });
});

describe("a listing, and a receipt (docs/paying.md)", () => {
  it("pins the real service by its key", () => {
    expect(UNLOCK_SERVICES).toEqual([{ endpoint: "https://api.bitunlock.network", pubkey: "66be61cf5b8d286391f7b1a72ffa7c799ec2dc49eff0830c40df1cc964e6787d" }]);
    expect(localService(service.named)).toEqual({ endpoint: service.url, pubkey: service.pubkey });
    expect(localService(`https://evil.example|${service.pubkey}`)).toBeNull();
    expect(localService(`${service.url}/x|${service.pubkey}`)).toBeNull();
    expect(localService(service.url)).toBeNull();
  });

  it("reads a listing only if its seller signed it, for a service BitLogin knows", () => {
    const services = [localService(service.named)!];
    const made = service.listing({ d: "season-pass", priceSats: 500, title: `Season pass${String.fromCodePoint(0x202e)}`, tags: [["nswp:for", `37300:${"cd".repeat(32)}:foundry`], ["nswp:term", "86400"]] });
    expect(cleanCoordinate(made.coordinate)).toBe(made.coordinate);
    expect(readListing(made.event, made.coordinate, services)).toEqual({ coordinate: made.coordinate, seller: made.seller.getPublicKey(), title: "Season pass", priceSats: 500, service: services[0], for: `37300:${"cd".repeat(32)}:foundry`, termSeconds: 86400, nswp: true });
    // Not for the real service's list, not under another coordinate, and not once a word is changed.
    expect(readListing(made.event, made.coordinate)).toBeNull();
    expect(readListing(made.event, `30078:${"ef".repeat(32)}:season-pass`, services)).toBeNull();
    expect(readListing(made.event, `30078:${made.seller.getPublicKey()}:other`, services)).toBeNull();
    expect(readListing({ ...made.event, tags: made.event.tags.map((t) => (t[0] === "price" ? ["price", "5", "SAT"] : t)) }, made.coordinate, services)).toBeNull();
    // Someone else's listing with the seller's name on it.
    const other = service.listing({ d: "season-pass", priceSats: 1 });
    expect(readListing(other.event, made.coordinate, services)).toBeNull();
    for (const bad of ["30078:xyz:a", "1:" + "ab".repeat(32) + ":a", "30078:" + "ab".repeat(32) + ":", "30078:" + "ab".repeat(32) + "::a", "30078:" + "ab".repeat(32) + ":a\nb", "30078:" + "ab".repeat(32) + ":" + "a".repeat(257), 5]) expect(cleanCoordinate(bad)).toBe("");
    // As BitUnlock takes a name: up to 256 characters, spaces and colons inside it.
    for (const good of ["a", "example:relay runner", "a".repeat(256)]) expect(cleanCoordinate(`30078:${"ab".repeat(32)}:${good}`)).toBe(`30078:${"ab".repeat(32)}:${good}`);
  });

  it("buys: a quote, each part paid once, the unlock, a receipt a world can check", async () => {
    const services = [localService(service.named)!];
    const buyer = new NostrSigner(generatePrivateKey());
    const made = service.listing({ d: "key-to-the-vault", priceSats: 300, delivers: "open sesame" });
    const listing = readListing(made.event, made.coordinate, services)!;
    const client = createUnlockClient(services[0]!, buyerKeys(buyer));
    expect(await client.policy()).toEqual({ relays: [], sandbox: false });
    expect(await client.resume(listing)).toBeNull();
    const plan = await client.quote(listing);
    expect(plan.totalSats).toBe(300);
    expect(plan.legs.map((leg) => [leg.role, leg.sats, leg.status])).toEqual([["seller", 297, "pending"], ["service", 3, "pending"]]);

    const payments: string[] = [];
    const steps: string[] = [];
    const done = await completePurchase({
      client,
      listing,
      plan,
      wait: async () => {},
      progress: (step) => steps.push("paying" in step ? `pay ${step.paying.role}` : "unlock"),
      pay: async (leg) => {
        payments.push(leg.invoice);
        paid.add(leg.invoice);
        return { preimage: null };
      }
    });
    // The smallest part first, and the seller's last: a payment that stops half way strands the least.
    expect(payments).toEqual([plan.legs[1]!.invoice, plan.legs[0]!.invoice]);
    expect(steps).toEqual(["pay service", "pay seller", "unlock"]);
    expect(done.delivery).toBe("open sesame");
    expect(done.receipt).toMatchObject({ listing: made.coordinate, buyer: buyer.getPublicKey(), seller: made.seller.getPublicKey(), order: plan.order, expiresAt: 0, service: service.pubkey });
    // What a world checks: the service's signature, the listing, the buyer, that it hasn't run out.
    expect(readReceipt(done.receipt.event, services)).toEqual(done.receipt);
    expect(readReceipt(done.receipt.event)).toBeNull();
    const now = Date.now() / 1000;
    expect(receiptGood(done.receipt, { buyer: buyer.getPublicKey(), listing: made.coordinate, now })).toBe(true);
    expect(receiptGood(done.receipt, { buyer: "ab".repeat(32), listing: made.coordinate, now })).toBe(false);
    expect(receiptGood(done.receipt, { buyer: buyer.getPublicKey(), listing: `30078:${made.seller.getPublicKey()}:other`, now })).toBe(false);
    expect(readReceipt({ ...done.receipt.event, content: done.receipt.event.content.replace(buyer.getPublicKey(), "ab".repeat(32)) }, services)).toBeNull();
    // The service holds it too, and says whether it was taken back.
    expect((await client.receipts()).map((r) => [r.receipt.order, r.status])).toEqual([[plan.order, "active"]]);
    service.revoked.add(plan.order);
    expect((await client.receipts())[0]!.status).toBe("revoked");
    // Every request carried a fresh note for exactly that request, signed by the buyer.
    expect(service.auths.every((event) => event.pubkey === buyer.getPublicKey() && event.kind === 27235)).toBe(true);
  });

  it("takes up a purchase that stopped half way, and never pays a part twice", async () => {
    const services = [localService(service.named)!];
    const buyer = new NostrSigner(generatePrivateKey());
    const made = service.listing({ d: "day-pass", priceSats: 200, termSeconds: 86_400 });
    const listing = readListing(made.event, made.coordinate, services)!;
    const client = createUnlockClient(services[0]!, buyerKeys(buyer));
    const plan = await client.quote(listing);
    // The first part is paid, and then the page closes.
    paid.add(plan.legs[0]!.invoice);
    const again = await client.resume(listing);
    expect(again?.order).toBe(plan.order);
    expect(again?.legs.map((leg) => leg.status)).toEqual(["settled", "pending"]);
    const payments: string[] = [];
    service.omitReceipt = true;
    const done = await completePurchase({ client, listing, plan: again!, wait: async () => {}, pay: async (leg) => (payments.push(leg.invoice), paid.add(leg.invoice), {}) });
    expect(payments).toEqual([plan.legs[1]!.invoice]);
    // No receipt came with the unlock: it was found among the buyer's own.
    expect(done.receipt.order).toBe(plan.order);
    expect(done.receipt.expiresAt).toBeGreaterThan(Date.now() / 1000 + 86_000);
    expect(receiptGood(done.receipt, { buyer: buyer.getPublicKey(), listing: made.coordinate, now: done.receipt.expiresAt + 1 })).toBe(false);
    expect(bestReceipt([done.receipt], { buyer: buyer.getPublicKey(), listing: made.coordinate, now: Date.now() / 1000 })).toEqual(done.receipt);
    // A payment the service never sees arrive is said, and not paid again here.
    const stuck = await client.quote(readListing(service.listing({ d: "stuck", priceSats: 50, seller: made.seller }).event, `30078:${made.seller.getPublicKey()}:stuck`, services)!);
    // The money went (as far as the wallet knows), so it is said to have: how much, and that the rest didn't go.
    await expect(completePurchase({ client, listing: { ...listing, coordinate: `30078:${made.seller.getPublicKey()}:stuck`, priceSats: 50 }, plan: stuck, wait: async () => {}, tries: 2, pay: async () => ({}) })).rejects.toMatchObject({ name: "PartPaidError", paidSats: 1, cause_: { code: "not-settled" } });
    // The first part is paid and the second fails outright: one part's worth is said to have gone, and the order is taken up again later.
    const half = service.listing({ d: "half", priceSats: 500, seller: made.seller });
    const halfListing = readListing(half.event, half.coordinate, services)!;
    const halfPlan = await client.quote(halfListing);
    let calls = 0;
    await expect(
      completePurchase({ client, listing: halfListing, plan: halfPlan, wait: async () => {}, pay: async (leg) => {
        if (++calls === 2) throw new Error("the mint refused");
        paid.add(leg.invoice);
        return {};
      } })
    ).rejects.toMatchObject({ name: "PartPaidError", paidSats: 5 });
    // Five sats went, to the service, and not four hundred and ninety-five to the seller.
    const later = await client.resume(halfListing);
    expect(later?.order).toBe(halfPlan.order);
    expect(later?.legs.map((leg) => [leg.role, leg.status])).toEqual([["seller", "pending"], ["service", "settled"]]);
    const finished = await completePurchase({ client, listing: halfListing, plan: later!, wait: async () => {}, pay: async (leg) => (paid.add(leg.invoice), {}) });
    expect(finished.receipt.order).toBe(halfPlan.order);
    // Nothing paid at all: the plain error, and no word of money having gone.
    const none = await client.quote(readListing(service.listing({ d: "none", priceSats: 500, seller: made.seller }).event, `30078:${made.seller.getPublicKey()}:none`, services)!);
    await expect(completePurchase({ client, listing: { ...halfListing, coordinate: `30078:${made.seller.getPublicKey()}:none` }, plan: none, wait: async () => {}, pay: async () => { throw new Error("the mint refused"); } })).rejects.toThrow("the mint refused");
  });

  it("believes a payment plan only as far as it matches what was asked", () => {
    const buyer = "ab".repeat(32);
    const listing = `30078:${"cd".repeat(32)}:thing`;
    const leg = (sats: number, extra: Record<string, unknown> = {}) => ({ role: "seller", amountSats: sats, rail: "lightning", paymentRequest: wallet.invoice(sats), paymentHash: Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join(""), status: "pending", ...extra });
    const plan = (extra: Record<string, unknown> = {}) => ({ orderId: "order_0123456789abcdef", productCoordinate: listing, buyerPubkey: buyer, currency: "SAT", completionRule: "all", totalSats: 100, legs: [leg(90), leg(10, { role: "bitunlock" })], ...extra });
    const want = { listing, buyer, priceSats: 100 };
    expect(readPlan(plan(), want).legs.map((l) => l.sats)).toEqual([90, 10]);
    const bad = (input: unknown) => expect(() => readPlan(input, want)).toThrow(PurchaseError);
    bad(plan({ buyerPubkey: "ef".repeat(32) }));
    bad(plan({ productCoordinate: `30078:${"cd".repeat(32)}:other` }));
    // More than the listed price, parts that don't add up, an invoice for more than its part, a rail that isn't Lightning.
    bad(plan({ totalSats: 101, legs: [leg(91), leg(10)] }));
    bad(plan({ legs: [leg(90), leg(11)] }));
    bad(plan({ legs: [leg(90), { ...leg(10), paymentRequest: wallet.invoice(5000) }] }));
    bad(plan({ legs: [leg(90), leg(10, { rail: "sandbox", paymentRequest: "bitunlock-mock:1:" + "0".repeat(64) })] }));
    const same = leg(50);
    bad(plan({ legs: [same, same] }));
    bad(plan({ legs: [] }));
    bad(null);
  });

  it("says which listings are a world's own", () => {
    const seller = "cd".repeat(32);
    const listing = `30078:${seller}:thing`;
    expect(belongsTo(listing, { publishers: [seller], site: "https://w.example" })).toBe(true);
    expect(belongsTo(listing, { publishers: ["ef".repeat(32)], site: "https://w.example" })).toBe(false);
    expect(belongsTo(listing, { publishers: [], site: "https://w.example" }, "https://w.example")).toBe(true);
    expect(belongsTo(listing, { publishers: [], site: "https://w.example" }, "https://other.example")).toBe(false);
  });

  it("keeps the same order when asked again with the same key, gives a run-out part a new invoice, and says when it was withdrawn", async () => {
    const services = [localService(service.named)!];
    const buyer = new NostrSigner(generatePrivateKey());
    const made = service.listing({ d: "week pass", priceSats: 700 });
    const listing = readListing(made.event, made.coordinate, services)!;
    const client = createUnlockClient(services[0]!, buyerKeys(buyer));
    const key = newOrderKey();
    const plan = await client.quote(listing, key);
    expect((await client.quote(listing, key)).order).toBe(plan.order);
    expect((await client.quote(listing)).order).not.toBe(plan.order);
    // The fee part is paid, and then ten minutes pass with the seller's part unpaid.
    paid.add(plan.legs[1]!.invoice);
    await client.refresh(listing, plan.order);
    service.expire(plan.order);
    // Taken up again by the id BitLogin kept: the settled part stays settled, and the other has a new invoice.
    const again = await client.resume(listing, plan.order);
    expect(again?.order).toBe(plan.order);
    expect(again?.legs.map((leg) => [leg.role, leg.status])).toEqual([["seller", "pending"], ["service", "settled"]]);
    expect(again?.legs[0]!.invoice).not.toBe(plan.legs[0]!.invoice);
    // An id that is nobody's, or another buyer's, is no order.
    expect(await client.resume(listing, "order_0000000000000000")).toBeNull();
    expect(await createUnlockClient(services[0]!, buyerKeys(new NostrSigner(generatePrivateKey()))).resume(listing, plan.order)).toBeNull();
    // The seller withdraws it while it is half paid: it can't be finished, and that is what is said.
    service.withdraw(made.coordinate);
    await expect(client.resume(listing, plan.order)).rejects.toMatchObject({ code: "withdrawn" });
    await expect(client.refresh(listing, plan.order)).rejects.toMatchObject({ code: "withdrawn" });
    await expect(client.quote(listing)).rejects.toMatchObject({ code: "sold" });
  });
});

describe("a test service with pretend sats, as BitUnlock's sandbox is (docs/paying.md PY12)", () => {
  it("is bought from with a session and a settle call, and no wallet", async () => {
    const test = await startMockUnlock(wallet, { sandbox: true });
    try {
      const named = localService(test.named)!;
      const buyer = new NostrSigner(generatePrivateKey());
      const made = test.listing({ d: "season pass", priceSats: 500, tags: [["nswp:term", "86400"]], termSeconds: 86_400 });
      const listing = readListing(made.event, made.coordinate, [named])!;
      // Without a session it is not a service anything can be bought from.
      const plain = createUnlockClient(named, buyerKeys(buyer));
      expect(await plain.policy()).toEqual({ relays: [], sandbox: true });
      await expect(plain.quote(listing)).rejects.toThrow();
      await expect(plain.settle("ab".repeat(32))).rejects.toMatchObject({ code: "plan" });

      const session = await openSandboxSession(named);
      const client = createUnlockClient(named, buyerKeys(buyer), { sandbox: session });
      const plan = await client.quote(listing, newOrderKey());
      expect(plan.legs.map((leg) => [leg.role, leg.sats])).toEqual([["seller", 495], ["service", 5]]);
      expect(plan.legs.every((leg) => /^bitunlock-mock:1:[0-9a-f]{64}$/u.test(leg.invoice))).toBe(true);
      // It has no list of orders: an order is found again only by the id that was kept.
      expect(await client.resume(listing)).toBeNull();
      expect((await client.resume(listing, plan.order))?.order).toBe(plan.order);
      const done = await completePurchase({ client, listing, plan, wait: async () => {}, pay: async (leg) => (await client.settle(leg.hash), {}) });
      expect(readReceipt(done.receipt.event, [named])).toEqual(done.receipt);
      expect(done.receipt.expiresAt - done.receipt.issuedAt).toBe(86_400);
      // Its key is not the real service's: nowhere real believes the receipt.
      expect(readReceipt(done.receipt.event)).toBeNull();
      // Another session's token settles nothing.
      const other = await openSandboxSession(named);
      const next = await client.quote(listing, newOrderKey());
      await expect(createUnlockClient(named, buyerKeys(buyer), { sandbox: { sessionId: session.sessionId, token: other.token } }).settle(next.legs[0]!.hash)).rejects.toMatchObject({ code: "service" });
    } finally {
      await test.close();
    }
  });

  it("is refused outright anywhere a test service is not being tried: a pretend request never reaches a wallet", () => {
    const buyer = "ab".repeat(32);
    const listing = `30078:${"cd".repeat(32)}:thing`;
    const hash = "ef".repeat(32);
    const plan = { orderId: "order_0123456789abcdef", productCoordinate: listing, buyerPubkey: buyer, currency: "SAT", completionRule: "all", totalSats: 500, legs: [{ role: "seller", amountSats: 500, rail: "sandbox", adapter: "mock", paymentRequest: `bitunlock-mock:1:${hash}`, paymentHash: hash, status: "pending" }] };
    expect(() => readPlan(plan, { listing, buyer, priceSats: 500 })).toThrow(PurchaseError);
    expect(readPlan(plan, { listing, buyer, priceSats: 500, sandbox: true }).legs[0]!.invoice).toBe(`bitunlock-mock:1:${hash}`);
    // And a test service is never handed a real invoice's worth of trust: a Lightning part is not taken in its plan.
    expect(() => readPlan({ ...plan, legs: [{ ...plan.legs[0], rail: "lightning", adapter: "lightning-nwc", paymentRequest: wallet.invoice(500) }] }, { listing, buyer, priceSats: 500, sandbox: true })).toThrow(PurchaseError);
    // A test service is named only at an address on this machine or a private network.
    const key = "ab".repeat(32);
    expect(localService(`https://192.168.68.84:4312|${key}`)).toEqual({ endpoint: "https://192.168.68.84:4312", pubkey: key });
    expect(localService(`https://localhost:8789|${key}`)).toEqual({ endpoint: "https://localhost:8789", pubkey: key });
    for (const far of ["https://sandbox.bitunlock.network", "https://8.8.8.8:4312", "https://192.169.1.1", "https://172.32.0.1", "ftp://127.0.0.1"]) expect(localService(`${far}|${key}`)).toBeNull();
  });
});
