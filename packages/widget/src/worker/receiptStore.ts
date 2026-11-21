/**
 * Where a person's receipts are kept (docs/paying.md): in this browser first,
 * then on the account's relays, one sealed record per receipt. The same rule
 * as the ecash wallet and the files: a receipt no relay takes is sent again
 * later, and with no relay answering the list opens from the browser's copy
 * and says so.
 *
 * A receipt is a note the selling service signed. It is kept whole: it is
 * what a world checks. Beside it is kept what the listing was called, and
 * which site it was bought through, in BitLogin's own words and not the
 * receipt's.
 *
 * Runs in the crypto worker, with a full session.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import { countAcknowledgements, verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanOrigin } from "../embedded/policy.js";

export interface ReceiptRelays {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  relayUrls: string[];
}

export const RECEIPT_RECORD_KIND = 30078;
export const RECEIPT_RECORD_D = "bitlogin-receipt:";
/** The most receipts kept for one account. Past it, the oldest that has run out goes first. */
export const RECEIPTS_MOST = 300;

export interface KeptReceipt {
  /** The receipt, whole and unchanged. */
  event: NostrEvent;
  /** What the listing was called when it was bought. */
  title: string;
  /** The site it was bought through, where it was bought through one. */
  via: string;
}

export interface ReceiptsState {
  receipts: KeptReceipt[];
  /** No relay answered: this is the browser's own copy. */
  offline: boolean;
  /** Something here is not on any relay yet. It is sent again when the list is next opened. */
  unsaved: boolean;
}

interface Entry extends KeptReceipt {
  saved: boolean;
}

const LOCAL = "bitlogin:receipts:v1:";

/**
 * A receipt as it may be kept: a signed note of the right kind, whose words
 * name this account as the buyer. Which service signed it, and whether that
 * service is one BitLogin knows, is checked where a receipt is used (pay/listing.ts).
 */
function cleanKept(input: unknown, me: string): KeptReceipt | null {
  const k = input as { event?: unknown; title?: unknown; via?: unknown } | null;
  const e = k?.event as NostrEvent | undefined;
  if (!e || typeof e !== "object" || e.kind !== 30078 || typeof e.content !== "string" || e.content.length > 8000 || !Array.isArray(e.tags) || !verifyNostrEvent(e)) return null;
  try {
    if ((JSON.parse(e.content) as { buyerPubkey?: unknown }).buyerPubkey !== me) return null;
  } catch {
    return null;
  }
  return {
    event: { id: e.id, pubkey: e.pubkey, created_at: e.created_at, kind: e.kind, tags: e.tags.map((t) => t.map(String)), content: e.content, sig: e.sig },
    title: typeof k?.title === "string" ? k.title.slice(0, 80) : "",
    via: cleanOrigin(k?.via) || ""
  };
}

async function readLocal(store: KeyValueStore, signer: NostrSigner): Promise<Map<string, Entry>> {
  const me = signer.getPublicKey();
  const out = new Map<string, Entry>();
  const open = async (key: string): Promise<unknown> => {
    try {
      const sealed = await store.get(key);
      return sealed ? JSON.parse(signer.nip44Decrypt(me, sealed)) : null;
    } catch {
      return null;
    }
  };
  const head = (await open(LOCAL + me)) as { ids?: unknown } | null;
  for (const id of Array.isArray(head?.ids) ? head.ids.slice(0, RECEIPTS_MOST) : []) {
    if (typeof id !== "string") continue;
    const entry = (await open(`${LOCAL}${me}:${id}`)) as { saved?: unknown } | null;
    const kept = cleanKept(entry, me);
    if (kept && kept.event.id === id) out.set(id, { ...kept, saved: entry?.saved === true });
  }
  return out;
}

async function writeLocal(store: KeyValueStore, signer: NostrSigner, entries: Map<string, Entry>, changed: readonly string[]): Promise<void> {
  const me = signer.getPublicKey();
  const seal = (value: unknown) => signer.nip44Encrypt(me, JSON.stringify(value));
  for (const id of changed) {
    const entry = entries.get(id);
    if (entry) await store.set(`${LOCAL}${me}:${id}`, seal(entry));
  }
  await store.set(LOCAL + me, seal({ ids: [...entries.keys()] }));
}

const state = (entries: Map<string, Entry>, offline: boolean): ReceiptsState => ({
  receipts: [...entries.values()].map(({ event, title, via }) => ({ event, title, via })).sort((a, b) => b.event.created_at - a.event.created_at),
  offline,
  unsaved: [...entries.values()].some((entry) => !entry.saved)
});

type Deps = { signer: NostrSigner; store: KeyValueStore; relays: ReceiptRelays; now?: number };

async function flush(deps: Deps, entries: Map<string, Entry>): Promise<void> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const now = Math.floor(deps.now ?? Date.now() / 1000);
  const changed: string[] = [];
  for (const [id, entry] of entries) {
    if (entry.saved) continue;
    const record = signer.signEvent({ kind: RECEIPT_RECORD_KIND, created_at: now, tags: [["d", RECEIPT_RECORD_D + id]], content: signer.nip44Encrypt(me, JSON.stringify({ v: 1, event: entry.event, title: entry.title, via: entry.via })) });
    const took = countAcknowledgements(await relays.publishAll(record, 6000).catch(() => [])) >= Math.min(2, relays.relayUrls.length);
    if (!took) continue;
    entry.saved = true;
    changed.push(id);
  }
  if (changed.length) await writeLocal(store, signer, entries, changed);
}

/** Open the list: what relays hold, joined with what this browser holds. Never "none" because relays were silent. */
export async function loadReceipts(deps: Deps): Promise<ReceiptsState> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const local = await readLocal(store, signer);
  const found = await relays.queryQuorum({ kinds: [RECEIPT_RECORD_KIND], authors: [me], limit: 500 }, 6000).catch(() => null);
  if (!found || found.respondedCount === 0) return state(local, true);
  const onRelays = new Set<string>();
  const changed: string[] = [];
  for (const record of found.outcomes.flatMap((o) => o.events)) {
    if (record.kind !== RECEIPT_RECORD_KIND || record.pubkey !== me || !verifyNostrEvent(record)) continue;
    const d = record.tags.find((tag) => tag[0] === "d")?.[1];
    if (typeof d !== "string" || !d.startsWith(RECEIPT_RECORD_D)) continue;
    let kept: KeptReceipt | null;
    try {
      kept = cleanKept(JSON.parse(signer.nip44Decrypt(me, record.content)), me);
    } catch {
      continue;
    }
    if (!kept || kept.event.id !== d.slice(RECEIPT_RECORD_D.length)) continue;
    onRelays.add(kept.event.id);
    if (local.has(kept.event.id) || local.size >= RECEIPTS_MOST) continue;
    local.set(kept.event.id, { ...kept, saved: true });
    changed.push(kept.event.id);
  }
  // What this browser has that no relay does is sent again, whether it was never taken or a relay has since lost it.
  for (const [id, entry] of local) {
    if (onRelays.has(id) === entry.saved) continue;
    entry.saved = onRelays.has(id);
    changed.push(id);
  }
  await writeLocal(store, signer, local, changed);
  await flush(deps, local);
  return state(local, false);
}

/** Keep receipts: in this browser first, then on relays. One already kept is left as it is. */
export async function keepReceipts(deps: Deps, input: unknown): Promise<ReceiptsState> {
  const { signer, store } = deps;
  const me = signer.getPublicKey();
  const offered = Array.isArray(input) ? input.slice(0, RECEIPTS_MOST).map((item) => cleanKept(item, me)) : [];
  if (offered.length === 0 || offered.some((kept) => !kept)) throw new Error("That is not a receipt of this account's.");
  const local = await readLocal(store, signer);
  const changed: string[] = [];
  for (const kept of offered as KeptReceipt[]) {
    if (local.has(kept.event.id)) continue;
    if (local.size >= RECEIPTS_MOST) throw new Error("This account keeps as many receipts as it can.");
    local.set(kept.event.id, { ...kept, saved: false });
    changed.push(kept.event.id);
  }
  // Written here before a relay is asked: a receipt just paid for is never only in memory.
  await writeLocal(store, signer, local, changed);
  await flush(deps, local).catch(() => {});
  return state(local, false);
}
