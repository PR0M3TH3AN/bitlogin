/**
 * Buying from a service that sells (BitUnlock), as the buyer (docs/paying.md).
 *
 * BitLogin's own page runs the whole purchase: a world asks for a listing by
 * name and never signs as the buyer, never sees the wallet, and learns only
 * the receipt. This is the part with no screen: the service's policy, the
 * quote, each payment, the unlock, and the receipt, each checked against what
 * was asked before the next step.
 *
 * It holds no key. Each request to the service carries a permission note
 * (NIP-98) that BitLogin's worker signs for that one address, method and
 * body, and for a known service only.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { invoiceSats } from "./lightning.js";
import { cleanCoordinate, readReceipt, receiptGood, type Listing, type Receipt, type UnlockService } from "./listing.js";

/**
 * A purchase stopped after a part of it was paid. The money that went is with whoever it was paid to, there is no
 * receipt yet, and the same order is taken up again the next time it is asked for: what went is counted, not charged again.
 */
export class PartPaidError extends Error {
  constructor(
    public readonly paidSats: number,
    public readonly cause_: unknown
  ) {
    super("A part of this was paid, and the rest didn't go.");
    this.name = "PartPaidError";
  }
}

export class PurchaseError extends Error {
  constructor(
    public readonly code: "service" | "plan" | "expired" | "not-settled" | "delivery" | "receipt" | "sold" | "withdrawn",
    message: string,
    /** The service's own word for why it refused, where it gave one. Never shown: it picks the words that are. */
    public readonly serviceCode = ""
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** What the worker does for a purchase: sign a permission note for one request, and open what was sealed to the buyer. */
export interface BuyerKeys {
  pubkey: string;
  /** A NIP-98 note for exactly this request, as the `Authorization` header's value. */
  auth(request: { url: string; method: "GET" | "POST"; payload?: string }): Promise<string>;
  /** Open what the service sealed to the buyer (NIP-44). */
  open(from: string, sealed: string): Promise<string>;
}

export interface PlanLeg {
  /** Who this part goes to: the seller, or the service's own fee. */
  role: string;
  sats: number;
  invoice: string;
  hash: string;
  status: "pending" | "settled" | "expired";
}
export interface Plan {
  order: string;
  totalSats: number;
  legs: PlanLeg[];
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ORDER = /^order_[A-Za-z0-9_-]{12,80}$/u;
const sha256Hex = async (text: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))), (b) => b.toString(16).padStart(2, "0")).join("");
const newKey = (): string => crypto.randomUUID().replaceAll("-", "");

/**
 * Read a payment plan the service gave. It is believed only as far as it
 * matches what was asked: this listing, this buyer, parts that add up to the
 * total, a total no more than the listed price, and for each part an invoice
 * that asks for exactly that part.
 */
export function readPlan(input: unknown, want: { listing: string; buyer: string; priceSats: number; /** A test service's pretend payments are taken: only ever on a local copy of BitLogin. */ sandbox?: boolean }): Plan {
  const bad = (): never => {
    throw new PurchaseError("plan", "The seller's service answered with a payment plan that doesn't match what was asked. Nothing was spent.");
  };
  const p = input as Record<string, unknown> | null;
  if (!p || typeof p !== "object" || p.productCoordinate !== want.listing || p.buyerPubkey !== want.buyer || p.currency !== "SAT" || p.completionRule !== "all") return bad();
  if (typeof p.orderId !== "string" || !ORDER.test(p.orderId) || !Array.isArray(p.legs) || p.legs.length < 1 || p.legs.length > 16) return bad();
  const total = p.totalSats;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 1 || total > want.priceSats) return bad();
  const hashes = new Set<string>();
  const legs: PlanLeg[] = [];
  for (const raw of p.legs as Record<string, unknown>[]) {
    const sats = raw?.amountSats;
    const status = raw?.status;
    if (!raw || typeof sats !== "number" || !Number.isSafeInteger(sats) || sats < 1 || typeof raw.paymentHash !== "string" || !HEX64.test(raw.paymentHash) || hashes.has(raw.paymentHash)) return bad();
    if (status !== "pending" && status !== "settled" && status !== "expired") return bad();
    // Only Lightning is paid from here, and only an invoice for exactly this part. A settled part is paid already.
    // A test service's pretend request (`bitunlock-mock:`) is no invoice: it is taken only where `sandbox` says a
    // test service is being tried, and is refused outright anywhere else, before any wallet hears of it.
    const invoice = typeof raw.paymentRequest === "string" ? raw.paymentRequest.trim().toLowerCase() : "";
    const pretend = raw.rail === "sandbox" && raw.adapter === "mock" && /^bitunlock-mock:1:[0-9a-f]{64}$/u.test(invoice);
    if (status !== "settled" && !(want.sandbox ? pretend : raw.rail === "lightning" && invoiceSats(invoice) === sats)) return bad();
    hashes.add(raw.paymentHash);
    legs.push({ role: raw.role === "seller" ? "seller" : raw.role === "bitunlock" ? "service" : "other", sats, invoice, hash: raw.paymentHash, status });
  }
  if (legs.reduce((sum, leg) => sum + leg.sats, 0) !== total) return bad();
  return { order: p.orderId, totalSats: total, legs };
}

/** A test service's session (BitUnlock's sandbox): its id goes with every call, and its token settles a pretend payment. */
export interface SandboxSession {
  sessionId: string;
  token: string;
}

export interface UnlockClient {
  /**
   * Fetch the service's signed policy, and check it is the pinned key's. The relays it names are where listings
   * are. `sandbox`: it says it takes only pretend payments, so it is a test service and no real one.
   */
  policy(): Promise<{ relays: string[]; sandbox: boolean }>;
  /** Ask for a quote. `key` names this attempt: asked again with the same one, the service gives the same order. */
  quote(listing: Listing, key?: string): Promise<Plan>;
  /**
   * An unfinished order for this listing, where there is one: so a purchase begun before is taken up again, and
   * never a second order made beside it. `order` is one BitLogin kept the id of; without it the service is asked
   * for the buyer's orders. A part whose invoice ran out unpaid comes back with a new one.
   */
  resume(listing: Listing, order?: string): Promise<Plan | null>;
  /** On a test service only: settle one pretend payment, in place of a wallet paying it. */
  settle(hash: string): Promise<void>;
  /** Ask the service to look again at what was paid. Proofs of payment are offered where the wallet gave them. */
  refresh(listing: Listing, order: string, preimages?: string[]): Promise<Plan>;
  /** Once every part is settled: the receipt, and what the purchase delivers, where it delivers something. */
  unlock(listing: Listing, order: string): Promise<{ receipt: Receipt; delivery: string }>;
  /** Every receipt the service holds for this buyer, with what it says of each now. */
  receipts(): Promise<{ receipt: Receipt; status: "active" | "expired" | "revoked" }[]>;
}

/** A name for one attempt to buy: random, and long enough that it is nobody else's. */
export const newOrderKey = (): string => newKey();
const ORDER_KEY = /^[A-Za-z0-9_-]{16,128}$/u;

/** Open a session at a test service. Asked of nothing but a test service, and only on a local copy of BitLogin. */
export async function openSandboxSession(service: UnlockService, fetcher: Fetch = (url, init) => fetch(url, init)): Promise<SandboxSession> {
  const response = await fetcher(`${service.endpoint}/sandbox/v1/sessions`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ ttlSeconds: 3600 }) });
  const made = (await response.json().catch(() => null)) as { sessionId?: unknown; token?: unknown } | null;
  if (!response.ok || typeof made?.sessionId !== "string" || typeof made.token !== "string" || made.sessionId.length > 200 || made.token.length > 400) throw new PurchaseError("service", "The test service gave no session.");
  return { sessionId: made.sessionId, token: made.token };
}

export function createUnlockClient(service: UnlockService, keys: BuyerKeys, options: { fetch?: Fetch; /** A test service's session. With it, pretend payments are taken, and nothing else changes. */ sandbox?: SandboxSession } = {}): UnlockClient {
  const session = options.sandbox ?? null;
  const fetcher = options.fetch ?? ((url, init) => fetch(url, init));
  const down = (): never => {
    throw new PurchaseError("service", "The seller's service didn't answer. Nothing was spent.");
  };
  const call = async (path: string, method: "GET" | "POST", input?: unknown, signed = true): Promise<unknown> => {
    const url = new URL(path, service.endpoint).toString();
    const body = input === undefined ? undefined : JSON.stringify(input);
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 20_000);
    try {
      const authorization = signed ? await keys.auth({ url, method, ...(method === "POST" ? { payload: await sha256Hex(body ?? "") } : {}) }) : "";
      const response = await fetcher(url, { method, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json", ...(authorization ? { authorization } : {}), ...(session && signed ? { "x-bitunlock-sandbox-session": session.sessionId } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }), signal: stop.signal });
      const text = await response.text();
      if (text.length > 1_000_000) return down();
      const value: unknown = text ? JSON.parse(text) : null;
      if (!response.ok) {
        const code = (value as { error?: { code?: unknown } } | null)?.error?.code;
        throw new PurchaseError("service", "The seller's service refused that. Nothing more was spent.", typeof code === "string" ? code.slice(0, 80) : "");
      }
      return value;
    } catch (err) {
      if (err instanceof PurchaseError) throw err;
      return down();
    } finally {
      clearTimeout(timer);
    }
  };
  const want = (listing: Listing) => ({ listing: listing.coordinate, buyer: keys.pubkey, priceSats: listing.priceSats, sandbox: !!session });
  /** Why the service refused, in its own word: it picks what the person is told. */
  const refusedAs = (err: unknown): string => (err instanceof PurchaseError ? err.serviceCode : "");
  const withdrawn = (): never => {
    throw new PurchaseError("withdrawn", "This was withdrawn by its seller, and can't be finished.");
  };
  const mine = (event: unknown): Receipt | null => {
    const receipt = readReceipt(event, [service]);
    return receipt && receipt.buyer === keys.pubkey ? receipt : null;
  };
  const client: UnlockClient = {
    async policy() {
      const found = (await call("/.well-known/bitunlock.json", "GET", undefined, false)) as { event?: NostrEvent } | null;
      const event = found?.event;
      // The policy is the pinned key's own signed word, and what is read is what was signed.
      if (!event || event.pubkey !== service.pubkey || event.kind !== 30078 || !verifyNostrEvent(event)) return down();
      let doc: { endpoint?: unknown; servicePubkey?: unknown; status?: unknown; relays?: unknown; paymentAdapters?: unknown };
      try {
        doc = JSON.parse(event.content) as typeof doc;
      } catch {
        return down();
      }
      if (doc.endpoint !== service.endpoint || doc.servicePubkey !== service.pubkey || doc.status !== "active") return down();
      const relays = Array.isArray(doc.relays) ? doc.relays.filter((r): r is string => typeof r === "string" && r.length <= 200 && /^wss?:\/\//u.test(r)).slice(0, 6) : [];
      return { relays, sandbox: Array.isArray(doc.paymentAdapters) && doc.paymentAdapters.includes("mock") };
    },
    async quote(listing, key) {
      try {
        return readPlan(await call("/v1/quotes", "POST", { productCoordinate: listing.coordinate, buyerPubkey: keys.pubkey, idempotencyKey: key && ORDER_KEY.test(key) ? key : newKey() }), want(listing));
      } catch (err) {
        if (/sold|inventory|reserved|revoked|inactive/u.test(refusedAs(err))) throw new PurchaseError("sold", "This isn't for sale just now. Nothing was spent.");
        throw err;
      }
    },
    async settle(hash) {
      if (!session || !HEX64.test(hash)) throw new PurchaseError("plan", "That is not a pretend payment a test service takes.");
      const response = await fetcher(`${service.endpoint}/sandbox/v1/payments/${hash}/settle`, { method: "POST", credentials: "omit", referrerPolicy: "no-referrer", headers: { accept: "application/json", authorization: `Bearer ${session.token}`, "x-bitunlock-sandbox-session": session.sessionId } }).catch(() => null);
      if (!response?.ok) throw new PurchaseError("service", "The test service didn't settle that pretend payment.");
    },
    async resume(listing, kept) {
      const OPEN = ["quoted", "partially_paid", "paid", "expired_pending_requote"];
      if (kept && ORDER.test(kept)) {
        // One BitLogin kept the id of. Whatever state it is in short of finished, it is the order: asked about again,
        // so that what was paid is counted and a part whose invoice ran out is given a new one.
        const order = (await call(`/v1/orders/${encodeURIComponent(kept)}`, "GET").catch(() => null)) as Record<string, unknown> | null;
        if (!order || order.orderId !== kept || !OPEN.includes(String(order.state))) return null;
        try {
          return await client.refresh(listing, kept);
        } catch (err) {
          if (err instanceof PurchaseError && err.code === "withdrawn") throw err;
          return readPlan(order.paymentPlan, want(listing));
        }
      }
      const found = (await call(`/v1/orders?${new URLSearchParams({ productCoordinate: listing.coordinate })}`, "GET").catch(() => null)) as { orders?: unknown } | null;
      for (const order of Array.isArray(found?.orders) ? (found.orders as Record<string, unknown>[]).slice(0, 20) : []) {
        // One the buyer has put money into, or that is paid and was never unlocked: never a second charge for it.
        if (order?.state !== "partially_paid" && order?.state !== "paid" && order?.state !== "expired_pending_requote") continue;
        try {
          // Asked to look again before it is taken up: a part whose invoice ran out unpaid is given a new one, and
          // a part paid while the page was closed is counted.
          const plan = readPlan(order.paymentPlan, want(listing));
          return await client.refresh(listing, plan.order).catch((err) => {
            if (err instanceof PurchaseError && err.code === "withdrawn") throw err;
            return plan;
          });
        } catch (err) {
          if (err instanceof PurchaseError && err.code === "withdrawn") throw err;
          continue;
        }
      }
      return null;
    },
    async refresh(listing, order, preimages = []) {
      const proofs = preimages.filter((p) => HEX64.test(p));
      const plan = readPlan(
        await call(`/v1/orders/${encodeURIComponent(order)}/refresh`, "POST", { idempotencyKey: newKey(), ...(proofs.length ? { preimages: proofs } : {}) }).catch((err) => (refusedAs(err) === "product_revoked" ? withdrawn() : Promise.reject(err))),
        want(listing)
      );
      if (plan.order !== order) throw new PurchaseError("plan", "The seller's service answered about a different order.");
      return plan;
    },
    async unlock(listing, order) {
      const f = (await call(`/v1/orders/${encodeURIComponent(order)}/unlock`, "POST", { idempotencyKey: newKey() })) as Record<string, unknown> | null;
      if (!f || f.orderId !== order || f.productCoordinate !== listing.coordinate || f.buyerPubkey !== keys.pubkey) throw new PurchaseError("delivery", "The seller's service answered about a different order.");
      // The receipt comes with the unlock; where it didn't, it is among the buyer's receipts.
      let receipt = mine(f.fulfillmentEvent);
      if (!receipt || receipt.order !== order) receipt = (await client.receipts()).map((r) => r.receipt).find((r) => r.order === order) ?? null;
      if (!receipt || receipt.order !== order || !receiptGood(receipt, { buyer: keys.pubkey, listing: listing.coordinate, now: Date.now() / 1000 })) {
        throw new PurchaseError("receipt", "It was paid, but the seller's service gave no receipt. Ask again from the site: you won't be charged twice.");
      }
      let delivery = "";
      if (typeof f.buyerEnvelope === "string" && f.buyerEnvelope.length > 0 && f.buyerEnvelope.length <= 200_000) {
        try {
          const envelope = JSON.parse(await keys.open(service.pubkey, f.buyerEnvelope)) as Record<string, unknown>;
          if (envelope.orderId !== order || envelope.productCoordinate !== listing.coordinate || envelope.buyerPubkey !== keys.pubkey) throw new Error("another order's");
          delivery = typeof envelope.payload === "string" ? envelope.payload : JSON.stringify(envelope.payload ?? "");
        } catch {
          throw new PurchaseError("delivery", "It was paid and the receipt is yours, but what it delivers couldn't be opened. Ask again from the site: you won't be charged twice.");
        }
      }
      return { receipt, delivery: delivery.length <= 20_000 ? delivery : "" };
    },
    async receipts() {
      const found = (await call("/v1/access-entitlements", "GET")) as { entitlements?: unknown } | null;
      const out: { receipt: Receipt; status: "active" | "expired" | "revoked" }[] = [];
      for (const row of Array.isArray(found?.entitlements) ? (found.entitlements as Record<string, unknown>[]).slice(0, 500) : []) {
        const receipt = mine(row?.event);
        if (receipt) out.push({ receipt, status: row.status === "revoked" ? "revoked" : row.status === "expired" ? "expired" : "active" });
      }
      return out;
    }
  };
  return client;
}

/**
 * Pay what is left of a plan and unlock it. `pay` pays one invoice from the
 * person's wallet and gives the proof where there is one. Each part is paid
 * once: a part the service already counts as settled is passed over, and the
 * service is asked again after each payment before the next is made.
 */
export async function completePurchase(input: {
  client: UnlockClient;
  listing: Listing;
  plan: Plan;
  pay(leg: PlanLeg): Promise<{ preimage?: string | null }>;
  /** Told as it goes: which part is being paid, then that it is being unlocked. */
  progress?(step: { paying: PlanLeg } | { unlocking: true }): void;
  wait?(ms: number): Promise<void>;
  /** How many times the service is asked whether a payment arrived, a second apart. */
  tries?: number;
}): Promise<{ receipt: Receipt; delivery: string }> {
  const { client, listing } = input;
  const wait = input.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const coordinate = cleanCoordinate(listing.coordinate);
  let plan = input.plan;
  const proofs: string[] = [];
  let paidSats = 0;
  try {
    return await run();
  } catch (err) {
    // Paid in full with no receipt yet is not "a part was paid": it is said as what it is, and the order is kept.
    if (err instanceof PurchaseError && (err.code === "receipt" || err.code === "delivery")) throw err;
    if (paidSats > 0) throw new PartPaidError(paidSats, err);
    throw err;
  }

  async function run(): Promise<{ receipt: Receipt; delivery: string }> {
  // The smallest part first, and the seller's last: a payment that stops half way then strands the least.
  const order = [...plan.legs].sort((a, b) => Number(a.role === "seller") - Number(b.role === "seller") || a.sats - b.sats);
  for (const first of order) {
    let leg = plan.legs.find((l) => l.hash === first.hash)!;
    if (leg.status === "settled") continue;
    if (leg.status === "expired") throw new PurchaseError("expired", "This offer ran out before it was paid. Ask again from the site for a new one.");
    input.progress?.({ paying: leg });
    const paid = await input.pay(leg);
    paidSats += leg.sats;
    if (typeof paid.preimage === "string" && HEX64.test(paid.preimage)) proofs.push(paid.preimage);
    let settled = false;
    for (let attempt = 0; attempt < (input.tries ?? 15) && !settled; attempt++) {
      if (attempt > 0) await wait(1000);
      plan = await client.refresh(listing, plan.order, proofs);
      const now = plan.legs.find((l) => l.hash === first.hash);
      if (!now) throw new PurchaseError("plan", "The seller's service changed the payment plan after a part of it was paid. Nothing more was spent.");
      leg = now;
      settled = leg.status === "settled";
    }
    if (!settled) throw new PurchaseError("not-settled", "The payment was sent, but the seller's service hasn't seen it arrive yet. Ask again from the site in a minute: you won't be charged twice.");
  }
  if (!coordinate || plan.legs.some((l) => l.status !== "settled")) throw new PurchaseError("not-settled", "Not every part of the payment arrived.");
  input.progress?.({ unlocking: true });
  try {
    return await client.unlock(listing, plan.order);
  } catch (err) {
    if (err instanceof PurchaseError && (err.code === "receipt" || err.code === "delivery")) throw err;
    // Every part is settled and the service gave no receipt (it may be busy, or broken for this listing). Nothing
    // is owed and nothing is lost: the order stays, and is unlocked when it is next asked for.
    throw new PurchaseError("receipt", "It is paid in full, and the seller's service hasn't given your receipt yet. Nothing more is owed. Try again later: you won't be charged again.", err instanceof PurchaseError ? err.serviceCode : "");
  }
  }
}
