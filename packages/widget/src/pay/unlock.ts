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

export class PurchaseError extends Error {
  constructor(
    public readonly code: "service" | "plan" | "expired" | "not-settled" | "delivery" | "receipt" | "sold",
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
export function readPlan(input: unknown, want: { listing: string; buyer: string; priceSats: number }): Plan {
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
    const invoice = typeof raw.paymentRequest === "string" ? raw.paymentRequest.trim().toLowerCase() : "";
    if (status !== "settled" && (raw.rail !== "lightning" || invoiceSats(invoice) !== sats)) return bad();
    hashes.add(raw.paymentHash);
    legs.push({ role: raw.role === "seller" ? "seller" : raw.role === "bitunlock" ? "service" : "other", sats, invoice, hash: raw.paymentHash, status });
  }
  if (legs.reduce((sum, leg) => sum + leg.sats, 0) !== total) return bad();
  return { order: p.orderId, totalSats: total, legs };
}

export interface UnlockClient {
  /** Fetch the service's signed policy, and check it is the pinned key's. The relays it names are where listings are. */
  policy(): Promise<{ relays: string[] }>;
  quote(listing: Listing): Promise<Plan>;
  /** The newest unfinished order for this listing, where there is one: so a purchase begun before is taken up again. */
  resume(listing: Listing): Promise<Plan | null>;
  /** Ask the service to look again at what was paid. Proofs of payment are offered where the wallet gave them. */
  refresh(listing: Listing, order: string, preimages?: string[]): Promise<Plan>;
  /** Once every part is settled: the receipt, and what the purchase delivers, where it delivers something. */
  unlock(listing: Listing, order: string): Promise<{ receipt: Receipt; delivery: string }>;
  /** Every receipt the service holds for this buyer, with what it says of each now. */
  receipts(): Promise<{ receipt: Receipt; status: "active" | "expired" | "revoked" }[]>;
}

export function createUnlockClient(service: UnlockService, keys: BuyerKeys, options: { fetch?: Fetch } = {}): UnlockClient {
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
      const response = await fetcher(url, { method, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", headers: { accept: "application/json", ...(authorization ? { authorization } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }), signal: stop.signal });
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
  const want = (listing: Listing) => ({ listing: listing.coordinate, buyer: keys.pubkey, priceSats: listing.priceSats });
  const mine = (event: unknown): Receipt | null => {
    const receipt = readReceipt(event, [service]);
    return receipt && receipt.buyer === keys.pubkey ? receipt : null;
  };
  const client: UnlockClient = {
    async policy() {
      const found = (await call("/.well-known/bitunlock.json", "GET", undefined, false)) as { event?: NostrEvent; document?: { endpoint?: unknown; servicePubkey?: unknown; status?: unknown; relays?: unknown } } | null;
      const event = found?.event;
      // The policy is the pinned key's own signed word, and what is read is what was signed.
      if (!event || event.pubkey !== service.pubkey || event.kind !== 30078 || !verifyNostrEvent(event)) return down();
      let doc: { endpoint?: unknown; servicePubkey?: unknown; status?: unknown; relays?: unknown };
      try {
        doc = JSON.parse(event.content) as typeof doc;
      } catch {
        return down();
      }
      if (doc.endpoint !== service.endpoint || doc.servicePubkey !== service.pubkey || doc.status !== "active") return down();
      const relays = Array.isArray(doc.relays) ? doc.relays.filter((r): r is string => typeof r === "string" && r.length <= 200 && /^wss?:\/\//u.test(r)).slice(0, 6) : [];
      return { relays };
    },
    async quote(listing) {
      try {
        return readPlan(await call("/v1/quotes", "POST", { productCoordinate: listing.coordinate, buyerPubkey: keys.pubkey, idempotencyKey: newKey() }), want(listing));
      } catch (err) {
        const code = err instanceof PurchaseError ? err.serviceCode : "";
        if (/sold|inventory|reserved|revoked|inactive/u.test(code)) throw new PurchaseError("sold", "This isn't for sale just now. Nothing was spent.");
        throw err;
      }
    },
    async resume(listing) {
      const found = (await call(`/v1/orders?${new URLSearchParams({ productCoordinate: listing.coordinate })}`, "GET").catch(() => null)) as { orders?: unknown } | null;
      for (const order of Array.isArray(found?.orders) ? (found.orders as Record<string, unknown>[]).slice(0, 20) : []) {
        // One the buyer has put money into, or that is paid and was never unlocked: never a second charge for it.
        if (order?.state !== "partially_paid" && order?.state !== "paid") continue;
        try {
          return readPlan(order.paymentPlan, want(listing));
        } catch {
          continue;
        }
      }
      return null;
    },
    async refresh(listing, order, preimages = []) {
      const proofs = preimages.filter((p) => HEX64.test(p));
      const plan = readPlan(await call(`/v1/orders/${encodeURIComponent(order)}/refresh`, "POST", { idempotencyKey: newKey(), ...(proofs.length ? { preimages: proofs } : {}) }), want(listing));
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
  for (const first of plan.legs) {
    let leg = plan.legs.find((l) => l.hash === first.hash)!;
    if (leg.status === "settled") continue;
    if (leg.status === "expired") throw new PurchaseError("expired", "This offer ran out before it was paid. Ask again from the site for a new one.");
    input.progress?.({ paying: leg });
    const paid = await input.pay(leg);
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
  return client.unlock(listing, plan.order);
}
