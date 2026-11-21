/**
 * A selling service for tests: BitUnlock's buyer-side API as BitLogin uses
 * it, with real signatures, held in memory, served over HTTP on this machine.
 * It checks every permission note (NIP-98) as the real service does, signs
 * real receipts, and seals what it delivers to the buyer. It also answers as
 * a lightning address, for tips. TEST SUPPORT ONLY: nothing that ships
 * imports this.
 */
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";

const hex = (n = 32): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const PROTOCOL = "seller-unlock-service-v1";

interface Leg {
  role: "seller" | "bitunlock";
  amountSats: number;
  rail: "lightning";
  adapter: "lightning-nwc";
  paymentRequest: string;
  paymentHash: string;
  status: "pending" | "settled" | "expired";
  expiresAt: number;
}
interface Order {
  orderId: string;
  productCoordinate: string;
  buyerPubkey: string;
  state: "quoted" | "partially_paid" | "paid" | "fulfilled";
  legs: Leg[];
  totalSats: number;
  receipt?: NostrEvent;
}

export interface MockUnlock {
  url: string;
  pubkey: string;
  /** As `localService` reads it: `<url>|<pubkey>`. */
  named: string;
  /** Sign a listing as a new seller, or as `seller`. Returns the note and its coordinate. */
  listing(input: { d: string; priceSats: number; title?: string; seller?: NostrSigner; tags?: string[][]; delivers?: string; termSeconds?: number }): { event: NostrEvent; coordinate: string; seller: NostrSigner };
  /** A lightning address this answers as. */
  address(name: string): string;
  /** Next: answer a tip with an invoice for this many sats more than asked. */
  overcharge: number;
  /** How long a note its lightning addresses take with a payment. 0: none. */
  commentAllowed: number;
  /** Every note that came with a tip. */
  comments: string[];
  /** Next unlock: give no receipt with it (it is then among the buyer's receipts). */
  omitReceipt: boolean;
  /** Receipts taken back, by order. */
  revoked: Set<string>;
  orders: Map<string, Order>;
  /** Every request, as "METHOD path". */
  requests: string[];
  /** Every permission note that was accepted. */
  auths: NostrEvent[];
  close(): Promise<void>;
}

/**
 * `invoice(sats)` makes an invoice the test's mint can pay; `paid(invoice)`
 * says whether it has been. They stand for the seller's own wallet.
 */
export async function startMockUnlock(wallet: { invoice(sats: number): string; paid(invoice: string): boolean }): Promise<MockUnlock> {
  const service = new NostrSigner(generatePrivateKey());
  const listings = new Map<string, { priceSats: number; delivers: string; termSeconds: number }>();
  const nonces = new Set<string>();
  const now = () => Math.floor(Date.now() / 1000);
  const fail = (status: number, code: string): never => {
    throw Object.assign(new Error(code), { status, code });
  };

  const self: MockUnlock = {
    url: "",
    pubkey: service.getPublicKey(),
    named: "",
    overcharge: 0,
    commentAllowed: 0,
    comments: [],
    omitReceipt: false,
    revoked: new Set(),
    orders: new Map(),
    requests: [],
    auths: [],
    listing(input) {
      const seller = input.seller ?? new NostrSigner(generatePrivateKey());
      const event = seller.signEvent({
        kind: 30078,
        created_at: now(),
        content: JSON.stringify(input.title ? { title: input.title } : {}),
        tags: [["d", input.d], ["price", String(input.priceSats), "SAT"], ["status", "active"], ["br:delivery", PROTOCOL], ["br:delivery-mode", "static"], ["br:unlock-service", self.url], ["br:unlock-service-pubkey", self.pubkey], ["br:unlock-policy", `30078:${self.pubkey}:bitunlock:service-policy:v1`], ["br:claim-epoch", "1"], ...(input.tags ?? [])]
      });
      const coordinate = `30078:${seller.getPublicKey()}:${input.d}`;
      listings.set(coordinate, { priceSats: input.priceSats, delivers: input.delivers ?? "", termSeconds: input.termSeconds ?? 0 });
      return { event, coordinate, seller };
    },
    address: (name) => `${name}@${new URL(self.url).host}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };

  /** Who is asking: the key that signed a fresh note for exactly this request. */
  const buyerOf = (method: string, url: string, authorization: string | undefined, body: string): string => {
    const m = /^Nostr (.+)$/u.exec(authorization ?? "");
    if (!m) return fail(401, "missing_authorization");
    let event: NostrEvent;
    try {
      event = JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8")) as NostrEvent;
    } catch {
      return fail(401, "invalid_authorization");
    }
    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
    if (event.kind !== 27235 || !verifyNostrEvent(event) || Math.abs(event.created_at - now()) > 60) return fail(401, "invalid_authorization");
    if (tag("u") !== url || tag("method") !== method) return fail(401, "authorization_mismatch");
    if (method === "POST" && tag("payload") !== createHash("sha256").update(body).digest("hex")) return fail(401, "payload_mismatch");
    const nonce = tag("bitunlock:nonce");
    if (!nonce || nonces.has(nonce)) return fail(401, "replayed_authorization");
    nonces.add(nonce);
    self.auths.push(event);
    return event.pubkey;
  };
  const plan = (order: Order) => ({ schemaVersion: 1, protocolVersion: PROTOCOL, orderId: order.orderId, productCoordinate: order.productCoordinate, buyerPubkey: order.buyerPubkey, currency: "SAT", totalSats: order.totalSats, completionRule: "all", paymentMode: "direct-split", legs: order.legs });
  const receiptFor = (order: Order): NostrEvent => {
    const listing = listings.get(order.productCoordinate)!;
    const fulfillmentId = `ful_${order.orderId.slice(6)}`;
    const issuedAt = now();
    const document = {
      schemaVersion: 1,
      protocolVersion: PROTOCOL,
      accessPolicy: listing.termSeconds ? { kind: "term-v1", expiresAt: issuedAt + listing.termSeconds } : "perpetual-v1",
      status: "active",
      tenantId: "tenant_test",
      sellerPubkey: order.productCoordinate.slice(6, 70),
      productCoordinate: order.productCoordinate,
      buyerPubkey: order.buyerPubkey,
      orderId: order.orderId,
      fulfillmentId,
      claimEpoch: 1,
      paymentHashes: order.legs.map((leg) => leg.paymentHash),
      issuedAt
    };
    return service.signEvent({ kind: 30078, created_at: issuedAt, tags: [["d", `bitunlock:entitlement:v1:${fulfillmentId}`]], content: JSON.stringify(document) });
  };
  const look = (order: Order) => {
    for (const leg of order.legs) if (leg.status === "pending" && wallet.paid(leg.paymentRequest)) leg.status = "settled";
    const settled = order.legs.filter((leg) => leg.status === "settled").length;
    if (order.state !== "fulfilled") order.state = settled === order.legs.length ? "paid" : settled > 0 ? "partially_paid" : "quoted";
  };

  const handle = (method: string, url: URL, authorization: string | undefined, raw: string): unknown => {
    const path = url.pathname;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (method === "GET" && path === "/.well-known/bitunlock.json") {
      const document = { schemaVersion: 1, product: "BitUnlock", protocolVersions: [PROTOCOL], status: "active", endpoint: self.url, servicePubkey: self.pubkey, policyCoordinate: `30078:${self.pubkey}:bitunlock:service-policy:v1`, paymentAdapters: ["lightning-nwc"], completionRule: "all", relays: [] };
      return { schemaVersion: 1, signed: true, document, event: service.signEvent({ kind: 30078, created_at: now(), tags: [["d", "bitunlock:service-policy:v1"]], content: JSON.stringify(document) }) };
    }
    // A lightning address (LUD-16), for tips.
    if (method === "GET" && path.startsWith("/.well-known/lnurlp/")) {
      return { tag: "payRequest", callback: `${self.url}/lnurl/pay/${path.split("/").pop()}`, minSendable: 1000, maxSendable: 100_000_000, metadata: "[]", ...(self.commentAllowed ? { commentAllowed: self.commentAllowed } : {}) };
    }
    if (method === "GET" && path.startsWith("/lnurl/pay/")) {
      const sats = Number(url.searchParams.get("amount")) / 1000 + self.overcharge;
      self.overcharge = 0;
      if (url.searchParams.has("comment")) self.comments.push(url.searchParams.get("comment")!);
      return { pr: wallet.invoice(sats), routes: [] };
    }
    const buyer = buyerOf(method, url.toString(), authorization, raw);
    if (method === "POST" && path === "/v1/quotes") {
      const coordinate = String(body.productCoordinate);
      const listing = listings.get(coordinate);
      if (!listing || body.buyerPubkey !== buyer) return fail(404, "product_not_found");
      const fee = Math.min(listing.priceSats - 1, Math.max(1, Math.floor(listing.priceSats / 100)));
      const leg = (role: Leg["role"], amountSats: number): Leg => ({ role, amountSats, rail: "lightning", adapter: "lightning-nwc", paymentRequest: wallet.invoice(amountSats), paymentHash: hex(), status: "pending", expiresAt: now() + 600 });
      const order: Order = { orderId: `order_${hex(8)}`, productCoordinate: coordinate, buyerPubkey: buyer, state: "quoted", legs: [leg("seller", listing.priceSats - fee), leg("bitunlock", fee)], totalSats: listing.priceSats };
      self.orders.set(order.orderId, order);
      return plan(order);
    }
    if (method === "GET" && path === "/v1/orders") {
      const mine = [...self.orders.values()].filter((o) => o.buyerPubkey === buyer && o.productCoordinate === url.searchParams.get("productCoordinate"));
      for (const order of mine) look(order);
      return { orders: mine.map((o) => ({ orderId: o.orderId, productCoordinate: o.productCoordinate, buyerPubkey: o.buyerPubkey, state: o.state, paymentPlan: plan(o) })), nextCursor: null, inventory: null };
    }
    if (method === "GET" && path === "/v1/access-entitlements") {
      const mine = [...self.orders.values()].filter((o) => o.buyerPubkey === buyer && o.receipt);
      return { schemaVersion: 1, entitlements: mine.map((o) => ({ orderId: o.orderId, productCoordinate: o.productCoordinate, status: self.revoked.has(o.orderId) ? "revoked" : "active", event: o.receipt })) };
    }
    const m = /^\/v1\/orders\/(order_[0-9a-f]+)\/(refresh|unlock)$/u.exec(path);
    const order = m ? self.orders.get(m[1]!) : undefined;
    if (method !== "POST" || !m || !order || order.buyerPubkey !== buyer) return fail(404, "order_not_found");
    look(order);
    if (m[2] === "refresh") return plan(order);
    if (order.legs.some((leg) => leg.status !== "settled")) return fail(409, "payment_incomplete");
    order.receipt ??= receiptFor(order);
    order.state = "fulfilled";
    const delivers = listings.get(order.productCoordinate)!.delivers;
    const envelope = { schemaVersion: 1, orderId: order.orderId, productCoordinate: order.productCoordinate, buyerPubkey: buyer, claimEpoch: 1, payloadType: "license-key", payload: delivers };
    const omit = self.omitReceipt;
    self.omitReceipt = false;
    return { schemaVersion: 1, orderId: order.orderId, productCoordinate: order.productCoordinate, buyerPubkey: buyer, claimEpoch: 1, buyerEnvelope: delivers ? service.nip44Encrypt(buyer, JSON.stringify(envelope)) : "", ...(omit ? {} : { fulfillmentEvent: order.receipt }), fulfilledAt: now() };
  };

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
      if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
      const url = new URL(req.url ?? "/", self.url);
      self.requests.push(`${req.method} ${url.pathname}`);
      try {
        const out = handle(req.method ?? "GET", url, req.headers.authorization, Buffer.concat(chunks).toString("utf8"));
        res.writeHead(200, { "content-type": "application/json", ...cors }).end(JSON.stringify(out));
      } catch (err) {
        const e = err as { status?: number; code?: string; message: string };
        res.writeHead(e.status ?? 400, { "content-type": "application/json", ...cors }).end(JSON.stringify({ error: { code: e.code ?? "bad_request", message: e.message } }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  self.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  self.named = `${self.url}|${self.pubkey}`;
  return self;
}
