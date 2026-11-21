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
import { readShares, splitPrice } from "./shares.js";

const hex = (n = 32): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
const PROTOCOL = "seller-unlock-service-v1";

interface Leg {
  role: "seller" | "bitunlock" | "share";
  recipientPubkey?: string;
  label?: string;
  amountSats: number;
  rail: "lightning" | "sandbox";
  adapter: "lightning-nwc" | "mock";
  paymentRequest: string;
  paymentHash: string;
  status: "pending" | "settled" | "expired";
  expiresAt: number;
}
interface Order {
  orderId: string;
  productCoordinate: string;
  buyerPubkey: string;
  state: "quoted" | "partially_paid" | "paid" | "fulfilled" | "expired_pending_requote";
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
  /** How many unlocks to refuse next with 503 `fulfillment_unavailable`, though everything is paid. */
  failUnlocks: number;
  /** Next unlock: give no receipt with it (it is then among the buyer's receipts). */
  omitReceipt: boolean;
  /** Let an order's unpaid invoices run out, as ten minutes would. Asked about again, each gets a new one. */
  expire(order: string): void;
  /** Withdraw a listing, as its seller might: an order for it can then not be finished. */
  withdraw(coordinate: string): void;
  /** The keys registered here to be paid a share. A client named in a quote is paid only if it is one. */
  payees: Set<string>;
  /** Next quote for a shared listing: answer wrongly, as a service that cheats would. */
  cheat: "" | "amount" | "who" | "drop" | "extra";
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
export async function startMockUnlock(
  wallet: { invoice(sats: number): string; paid(invoice: string): boolean },
  /** `sandbox`: answer as BitUnlock's sandbox does: pretend payments, a session for every buyer call, and a route that settles one. */
  options: { sandbox?: boolean } = {}
): Promise<MockUnlock> {
  const sandbox = options.sandbox === true;
  const sessions = new Map<string, string>();
  const settled = new Set<string>();
  const withdrawn = new Set<string>();
  const request = (sats: number, hash: string) => (sandbox ? `bitunlock-mock:1:${hash}` : wallet.invoice(sats));
  const service = new NostrSigner(generatePrivateKey());
  const listings = new Map<string, { priceSats: number; delivers: string; termSeconds: number; tags: string[][]; seller: string }>();
  const nonces = new Set<string>();
  const keys = new Map<string, string>();
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
    failUnlocks: 0,
    payees: new Set(),
    cheat: "",
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
      listings.set(coordinate, { priceSats: input.priceSats, delivers: input.delivers ?? "", termSeconds: input.termSeconds ?? 0, tags: event.tags, seller: seller.getPublicKey() });
      return { event, coordinate, seller };
    },
    address: (name) => `${name}@${new URL(self.url).host}`,
    expire(orderId) {
      const order = self.orders.get(orderId)!;
      for (const leg of order.legs) if (leg.status === "pending") leg.status = "expired";
      if (order.state !== "fulfilled" && order.state !== "paid") order.state = "expired_pending_requote";
    },
    withdraw: (coordinate) => void withdrawn.add(coordinate),
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
  const look = (order: Order, reissue = false) => {
    for (const leg of order.legs) {
      if (leg.status === "pending" && (sandbox ? settled.has(leg.paymentHash) : wallet.paid(leg.paymentRequest))) leg.status = "settled";
      // Asked about again: an unpaid part whose invoice ran out is given a new one. A settled part never is.
      if (leg.status === "expired" && reissue) Object.assign(leg, { status: "pending", paymentHash: hex(), expiresAt: now() + 600 }, {}), (leg.paymentRequest = request(leg.amountSats, leg.paymentHash));
    }
    const done = order.legs.filter((leg) => leg.status === "settled").length;
    const ranOut = order.legs.some((leg) => leg.status === "expired");
    if (order.state !== "fulfilled") order.state = done === order.legs.length ? "paid" : ranOut ? "expired_pending_requote" : done > 0 ? "partially_paid" : "quoted";
  };

  const handle = (method: string, url: URL, authorization: string | undefined, raw: string, sessionOf?: string): unknown => {
    const path = url.pathname;
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    if (method === "GET" && path === "/.well-known/bitunlock.json") {
      const document = { schemaVersion: 1, product: "BitUnlock", protocolVersions: [PROTOCOL], status: "active", endpoint: self.url, servicePubkey: self.pubkey, policyCoordinate: `30078:${self.pubkey}:bitunlock:service-policy:v1`, paymentAdapters: [sandbox ? "mock" : "lightning-nwc"], completionRule: "all", feePolicy: { feeBps: 100, minimumSats: 1, maximumSats: 5000 }, relays: [] };
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
    // A test service's own routes: a session, and settling a pretend payment with the session's token.
    if (sandbox && method === "POST" && path === "/sandbox/v1/sessions") {
      const made = { sessionId: `sess_${hex(8)}`, token: hex(24) };
      sessions.set(made.sessionId, made.token);
      return { ...made, clockAt: now(), expiresAt: now() + 3600 };
    }
    const settling = /^\/sandbox\/v1\/payments\/([0-9a-f]{64})\/settle$/u.exec(path);
    if (sandbox && method === "POST" && settling) {
      if (!sessionOf || sessions.get(sessionOf) !== /^Bearer (.+)$/u.exec(authorization ?? "")?.[1]) return fail(401, "sandbox_token_invalid");
      if (![...self.orders.values()].some((o) => o.legs.some((leg) => leg.paymentHash === settling[1] && leg.status === "pending"))) return fail(404, "payment_not_found");
      settled.add(settling[1]!);
      return { paymentHash: settling[1], settledAt: now() };
    }
    const buyer = buyerOf(method, url.toString(), authorization, raw);
    if (sandbox && !sessions.has(sessionOf ?? "")) return fail(400, "sandbox_session_required");
    if (method === "POST" && path === "/v1/quotes") {
      const coordinate = String(body.productCoordinate);
      const listing = listings.get(coordinate);
      if (!listing || body.buyerPubkey !== buyer) return fail(404, "product_not_found");
      if (withdrawn.has(coordinate)) return fail(409, "product_revoked");
      // Asked again with the same key: the same order.
      const same = [...self.orders.values()].find((o) => o.buyerPubkey === buyer && keys.get(o.orderId) === body.idempotencyKey);
      if (same) return plan(same);
      const fee = Math.min(listing.priceSats - 1, Math.max(1, Math.floor(listing.priceSats / 100)));
      const leg = (role: Leg["role"], amountSats: number, share?: { to: string; label: string }): Leg => {
        const paymentHash = hex();
        return { role, ...(share ? { recipientPubkey: share.to, label: share.label } : {}), amountSats, rail: sandbox ? "sandbox" : "lightning", adapter: sandbox ? "mock" : "lightning-nwc", paymentRequest: request(amountSats, paymentHash), paymentHash, status: "pending", expiresAt: now() + 600 };
      };
      // A price shared between several people: divided by the rule, the seller's part and the fee first, as the
      // real service lays a plan out, then one part for each other person. A client is paid only if registered here.
      const read = readShares(listing.tags, listing.seller);
      if (!read.ok) return fail(409, "shares_unavailable");
      const client = typeof body.clientPubkey === "string" && self.payees.has(body.clientPubkey) ? body.clientPubkey : undefined;
      const split = splitPrice(listing.priceSats, read.shares, listing.seller, { ...(client ? { client } : {}), charge: fee });
      if (!split.ok) return fail(409, "shares_unavailable");
      let others = split.parts.filter((part) => !part.seller).map((part) => ({ ...part }));
      let forSeller = split.parts.find((part) => part.seller)!.sats;
      const cheat = self.cheat;
      self.cheat = "";
      if (cheat === "amount" && others[0]) (others[0].sats += 5), (forSeller -= 5);
      if (cheat === "who" && others[0]) others[0].to = hex();
      // Not the client's, whose absence is one of the two right plans: a named person's share, kept by the seller.
      if (cheat === "drop" && others.length) (forSeller += others[others.length - 1]!.sats), (others = others.slice(0, -1));
      if (cheat === "extra") (others.push({ to: hex(), sats: 20, label: "friend", seller: false })), (forSeller -= 20);
      const order: Order = { orderId: `order_${hex(8)}`, productCoordinate: coordinate, buyerPubkey: buyer, state: "quoted", legs: [leg("seller", forSeller), leg("bitunlock", fee), ...others.map((part) => leg("share", part.sats, part))], totalSats: listing.priceSats };
      self.orders.set(order.orderId, order);
      keys.set(order.orderId, String(body.idempotencyKey));
      return plan(order);
    }
    const one = /^\/v1\/orders\/(order_[0-9a-f]+)$/u.exec(path);
    if (method === "GET" && one) {
      const order = self.orders.get(one[1]!);
      if (!order || order.buyerPubkey !== buyer) return fail(404, "order_not_found");
      look(order);
      return { orderId: order.orderId, productCoordinate: order.productCoordinate, buyerPubkey: order.buyerPubkey, state: order.state, paymentPlan: plan(order) };
    }
    // The sandbox has no list of a buyer's orders: an order is found again only by its id.
    if (method === "GET" && path === "/v1/orders" && sandbox) return fail(404, "not_found");
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
    if (m[2] === "refresh" && withdrawn.has(order.productCoordinate) && order.state !== "fulfilled") return fail(409, "product_revoked");
    look(order, m[2] === "refresh");
    if (m[2] === "refresh") return plan(order);
    if (order.legs.some((leg) => leg.status !== "settled")) return fail(409, "payment_incomplete");
    if (self.failUnlocks > 0) return (self.failUnlocks--, fail(503, "fulfillment_unavailable"));
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
        const session = req.headers["x-bitunlock-sandbox-session"];
        const out = handle(req.method ?? "GET", url, req.headers.authorization, Buffer.concat(chunks).toString("utf8"), typeof session === "string" ? session : undefined);
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
