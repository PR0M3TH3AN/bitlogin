/**
 * The person's own settings for paying (docs/paying.md): the most a site may
 * ask for at once with no receipt. Kept in this browser first, then on the
 * account's relays as one sealed record, so that it follows them to another
 * device. The newer of the two wins. With no relay answering, the browser's
 * copy stands, and a browser that has neither starts at the default.
 *
 * Runs in the crypto worker, with a full session.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import { countAcknowledgements, verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanPayLimit, PAY_LIMIT } from "../pay/lightning.js";
import { cleanCoordinate } from "../pay/listing.js";
import { cleanOrigin } from "../embedded/policy.js";

/**
 * A purchase begun and not finished (docs/paying.md PY11): kept before the first payment is made, so that an
 * order money has gone into is never lost, and never has a second order made beside it.
 */
export interface OpenOrder {
  listing: string;
  /** The selling service's own id for the order, and the key the quote was asked with. */
  order: string;
  key: string;
  /** The service it is at, by address. */
  service: string;
  /** What the listing was called, and the site that asked, where one did. */
  title: string;
  via: string;
  /** The client the quote was asked with, by key, for a listing that shares its price with one. It is part of what `key` names. */
  client: string;
  at: number;
}
/** The most unfinished purchases kept. Past it, the oldest goes. */
export const OPEN_ORDERS_MOST = 20;

function cleanOrder(input: unknown): OpenOrder | null {
  const o = input as Partial<Record<keyof OpenOrder, unknown>> | null;
  if (!o || typeof o !== "object") return null;
  const listing = cleanCoordinate(o.listing);
  if (!listing || typeof o.order !== "string" || !/^order_[A-Za-z0-9_-]{12,80}$/u.test(o.order) || typeof o.key !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(o.key)) return null;
  const service = cleanOrigin(o.service);
  if (!service) return null;
  return { listing, order: o.order, key: o.key, service, title: typeof o.title === "string" ? o.title.slice(0, 80) : "", via: cleanOrigin(o.via) || "", client: typeof o.client === "string" && /^[0-9a-f]{64}$/u.test(o.client) ? o.client : "", at: typeof o.at === "number" && Number.isFinite(o.at) ? o.at : 0 };
}
const cleanOrders = (input: unknown): OpenOrder[] => (Array.isArray(input) ? input.map(cleanOrder).filter((o): o is OpenOrder => !!o).slice(-OPEN_ORDERS_MOST) : []);

export interface PaySettingsRelays {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  relayUrls: string[];
}

export const PAY_SETTINGS_KIND = 30078;
export const PAY_SETTINGS_D = "bitlogin-pay-settings";

export interface PaySettings {
  /** The most one payment with no receipt may be, in sats. 0: no limit. */
  limitSats: number;
  /** Purchases begun and not finished. */
  orders: OpenOrder[];
  /** Not on any relay yet: it is sent again the next time it is read. */
  unsaved: boolean;
}

interface Kept {
  limitSats: number;
  orders: OpenOrder[];
  at: number;
  saved: boolean;
}

const LOCAL = "bitlogin:pay-settings:v1:";
type Deps = { signer: NostrSigner; store: KeyValueStore; relays: PaySettingsRelays; now?: number };

async function readLocal({ signer, store }: Deps): Promise<Kept | null> {
  const me = signer.getPublicKey();
  try {
    const sealed = await store.get(LOCAL + me);
    const kept = sealed ? (JSON.parse(signer.nip44Decrypt(me, sealed)) as { limitSats?: unknown; orders?: unknown; at?: unknown; saved?: unknown }) : null;
    return kept && typeof kept.at === "number" ? { limitSats: cleanPayLimit(kept.limitSats), orders: cleanOrders(kept.orders), at: kept.at, saved: kept.saved === true } : null;
  } catch {
    return null;
  }
}
const writeLocal = ({ signer, store }: Deps, kept: Kept): Promise<void> => store.set(LOCAL + signer.getPublicKey(), signer.nip44Encrypt(signer.getPublicKey(), JSON.stringify(kept)));

async function send(deps: Deps, kept: Kept): Promise<boolean> {
  const { signer, relays } = deps;
  const me = signer.getPublicKey();
  const record = signer.signEvent({ kind: PAY_SETTINGS_KIND, created_at: Math.floor(kept.at), tags: [["d", PAY_SETTINGS_D]], content: signer.nip44Encrypt(me, JSON.stringify({ v: 1, limitSats: kept.limitSats, orders: kept.orders, at: kept.at })) });
  return countAcknowledgements(await relays.publishAll(record, 5000).catch(() => [])) >= Math.min(2, relays.relayUrls.length);
}

/** Read the settings: the newer of what this browser holds and what relays hold. Never slower than a few seconds. */
export async function loadPaySettings(deps: Deps): Promise<PaySettings> {
  const { signer, relays } = deps;
  const me = signer.getPublicKey();
  let local = await readLocal(deps);
  const found = await relays.queryQuorum({ kinds: [PAY_SETTINGS_KIND], authors: [me], "#d": [PAY_SETTINGS_D], limit: 2 }, 3000).catch(() => null);
  if (found && found.respondedCount > 0) {
    const newest = found.outcomes
      .flatMap((o) => o.events)
      .filter((event) => event.kind === PAY_SETTINGS_KIND && event.pubkey === me && event.tags.some((tag) => tag[0] === "d" && tag[1] === PAY_SETTINGS_D) && verifyNostrEvent(event))
      .sort((a, b) => b.created_at - a.created_at)[0];
    let theirs: Kept | null = null;
    try {
      const body = newest ? (JSON.parse(signer.nip44Decrypt(me, newest.content)) as { limitSats?: unknown; orders?: unknown; at?: unknown }) : null;
      if (body) theirs = { limitSats: cleanPayLimit(body.limitSats), orders: cleanOrders(body.orders), at: typeof body.at === "number" ? body.at : newest!.created_at, saved: true };
    } catch {
      theirs = null;
    }
    if (theirs && (!local || theirs.at > local.at)) {
      local = theirs;
      await writeLocal(deps, local);
    } else if (local && (!local.saved || !theirs)) {
      // This browser's is the newer, or no relay has one: it is sent again.
      local.saved = await send(deps, local);
      await writeLocal(deps, local);
    }
  }
  return { limitSats: local?.limitSats ?? PAY_LIMIT.default, orders: local?.orders ?? [], unsaved: !!local && !local.saved };
}

/**
 * Keep a change: a new limit, an unfinished purchase to remember, or one to let go. In this browser first, then on
 * relays. The browser's copy is written before this returns: a purchase is not paid for until its order is kept.
 */
export async function savePaySettings(deps: Deps, input: unknown): Promise<PaySettings> {
  const change = (input ?? {}) as { limitSats?: unknown; addOrder?: unknown; removeOrder?: unknown };
  const was = await readLocal(deps);
  const kept: Kept = { limitSats: was?.limitSats ?? PAY_LIMIT.default, orders: was?.orders ?? [], at: deps.now ?? Date.now() / 1000, saved: false };
  if (change.limitSats !== undefined) {
    if (cleanPayLimit(change.limitSats) !== change.limitSats) throw new Error("That is not a limit this wallet keeps.");
    kept.limitSats = change.limitSats as number;
  } else if (change.addOrder !== undefined) {
    const order = cleanOrder({ ...(change.addOrder as object), at: kept.at });
    if (!order) throw new Error("That is not an order this wallet can keep.");
    // One open order for a listing at a service: a newer one takes the older one's place.
    kept.orders = [...kept.orders.filter((o) => !(o.listing === order.listing && o.service === order.service)), order].slice(-OPEN_ORDERS_MOST);
  } else if (typeof change.removeOrder === "string") {
    kept.orders = kept.orders.filter((o) => o.order !== change.removeOrder);
  } else throw new Error("That is not a change this wallet keeps.");
  await writeLocal(deps, kept);
  kept.saved = await send(deps, kept).catch(() => false);
  if (kept.saved) await writeLocal(deps, kept);
  return { limitSats: kept.limitSats, orders: kept.orders, unsaved: !kept.saved };
}
