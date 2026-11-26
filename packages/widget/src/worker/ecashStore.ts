/**
 * Where an ecash wallet is kept (docs/ecash.md): on the account's relays, as
 * NIP-60 says, and in this browser, sealed the same way, so that a relay
 * being down loses nothing and the wallet still opens.
 *
 * The rule that keeps money safe: **this browser's copy is written first.**
 * New proofs are in the local copy before anything is sent to a relay, and a
 * record a relay did not take stays there, marked unsaved, and is sent again
 * the next time the wallet is opened.
 *
 * Runs in the crypto worker, with a full session. Every record is sealed to
 * the account's own key (NIP-44) before it is stored anywhere.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import { countAcknowledgements, verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import type { KeyValueStore } from "@bitlogin/core/storage";
import {
  cleanMint,
  cleanProofs,
  ECASH_LIMITS,
  HISTORY_KIND,
  liveTokens,
  readToken,
  readWallet,
  TOKEN_KIND,
  WALLET_KIND,
  writeHistory,
  writeToken,
  writeWallet,
  type EcashProof,
  type EcashToken,
  type EcashWallet
} from "../ecash/nip60.js";

/** The relays, as this needs them: ask all, publish to all. `RelayPool` is one. */
export interface EcashRelays {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  relayUrls: string[];
}

export interface EcashState {
  /** The mints the wallet names. Empty where there is no wallet yet. */
  mints: string[];
  /** What it holds. A token whose `event` starts "local:" is in this browser only, not yet on a relay. */
  tokens: EcashToken[];
  /** No relay answered: this is the browser's own copy. */
  offline: boolean;
  /** Something here is not on any relay yet. It is sent again when the wallet is next opened. */
  unsaved: boolean;
}

const LOCAL_KEY = "bitlogin:ecash:v1:";
const isLocal = (event: string): boolean => event.startsWith("local:");
const localId = (): string => `local:${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

interface LocalCopy {
  wallet: EcashWallet | null;
  tokens: EcashToken[];
}

async function readLocal(store: KeyValueStore, signer: NostrSigner): Promise<LocalCopy> {
  const me = signer.getPublicKey();
  try {
    const sealed = await store.get(LOCAL_KEY + me);
    if (!sealed) return { wallet: null, tokens: [] };
    const parsed = JSON.parse(signer.nip44Decrypt(me, sealed)) as { wallet?: unknown; tokens?: unknown };
    const wallet = typeof parsed.wallet === "string" ? readWallet(parsed.wallet) : null;
    const tokens: EcashToken[] = [];
    for (const item of Array.isArray(parsed.tokens) ? parsed.tokens : []) {
      const t = item as { event?: unknown; mint?: unknown; proofs?: unknown };
      const proofs = cleanProofs(t.proofs);
      if (typeof t.event === "string" && t.event.length <= 80 && cleanMint(t.mint) && proofs?.length) tokens.push({ event: t.event, mint: cleanMint(t.mint), proofs });
    }
    return { wallet, tokens };
  } catch {
    // A copy that can't be read is not a reason to lose what relays hold. It is left in place, untouched.
    return { wallet: null, tokens: [] };
  }
}

async function writeLocal(store: KeyValueStore, signer: NostrSigner, copy: LocalCopy): Promise<void> {
  const me = signer.getPublicKey();
  await store.set(LOCAL_KEY + me, signer.nip44Encrypt(me, JSON.stringify({ wallet: copy.wallet ? writeWallet(copy.wallet) : null, tokens: copy.tokens })));
}

const accepted = (outcomes: RelayPublishOutcome[], of: number): boolean => countAcknowledgements(outcomes) >= Math.min(2, of);

function signToken(signer: NostrSigner, token: { mint: string; proofs: readonly EcashProof[]; del?: readonly string[] }, now: number): NostrEvent {
  const me = signer.getPublicKey();
  return signer.signEvent({ kind: TOKEN_KIND, created_at: Math.floor(now), tags: [], content: signer.nip44Encrypt(me, writeToken(token)) });
}

const state = (copy: LocalCopy, offline: boolean): EcashState => ({ mints: copy.wallet?.mints ?? [], tokens: copy.tokens, offline, unsaved: copy.tokens.some((token) => isLocal(token.event)) });

/**
 * Open the wallet: what relays hold, joined with what this browser holds that
 * no relay has yet. With no relay answering, the browser's copy alone, and it
 * says so. Never "empty" because relays were silent.
 */
/** The browser's own copy, and nothing asked of relays: to show at once, marked as being checked. It writes nothing. */
export async function peekEcash(deps: { signer: NostrSigner; store: KeyValueStore }): Promise<EcashState> {
  return state(await readLocal(deps.store, deps.signer), true);
}

export async function loadEcash(deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays; now?: number }): Promise<EcashState> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const local = await readLocal(store, signer);
  const [wallets, tokens, deletions] = await Promise.all([
    relays.queryQuorum({ kinds: [WALLET_KIND], authors: [me], limit: 2 }, 5000),
    relays.queryQuorum({ kinds: [TOKEN_KIND], authors: [me], limit: ECASH_LIMITS.tokens }, 6000),
    relays.queryQuorum({ kinds: [5], authors: [me], "#k": [String(TOKEN_KIND)], limit: ECASH_LIMITS.tokens }, 6000)
  ]).catch(() => [null, null, null] as const);
  if (!tokens || !wallets || !deletions || tokens.respondedCount === 0) return state(local, true);

  const mine = (events: NostrEvent[], kind: number) => events.filter((event) => event.kind === kind && event.pubkey === me && verifyNostrEvent(event));
  const open = (event: NostrEvent): string | null => {
    try {
      return signer.nip44Decrypt(me, event.content);
    } catch {
      return null;
    }
  };
  const newestWallet = mine(wallets.outcomes.flatMap((o) => o.events), WALLET_KIND).sort((a, b) => b.created_at - a.created_at)[0];
  const wallet = (newestWallet && readWallet(open(newestWallet) ?? "")) || local.wallet;
  const deleted = new Set(mine(deletions.outcomes.flatMap((o) => o.events), 5).flatMap((event) => event.tags.filter((tag) => tag[0] === "e" && typeof tag[1] === "string").map((tag) => tag[1]!)));
  const byId = new Map<string, NostrEvent>();
  for (const event of mine(tokens.outcomes.flatMap((o) => o.events), TOKEN_KIND)) byId.set(event.id, event);
  const records = [...byId.values()].flatMap((event) => {
    const token = readToken(open(event) ?? "");
    return token ? [{ event: event.id, created_at: event.created_at, ...token }] : [];
  });
  const onRelays = liveTokens(records, deleted);

  // What this browser holds that no relay does: proofs written here and not yet taken by one. They are kept, and
  // sent again now. A proof a relay already has is the relay's: the local copy of it is dropped.
  const known = new Set(onRelays.flatMap((token) => token.proofs.map((proof) => proof.secret)));
  const next: LocalCopy = { wallet, tokens: [...onRelays] };
  // A saved record the relays that answered didn't return, and didn't delete or replace, is kept here as it was
  // (2026-11-24): the relays holding it may have been slow, or gone. Dropped, its sats would then be on nothing but
  // those relays. Whether they are spent is the mint's to say: the wallet's check asks it, and only then are they
  // dropped. It is not sent again: it is on relays, which may only not have answered.
  const replaced = new Set(records.flatMap((record) => record.del));
  for (const token of local.tokens.filter((t) => !isLocal(t.event))) {
    if (byId.has(token.event) || deleted.has(token.event) || replaced.has(token.event)) continue;
    const proofs = token.proofs.filter((proof) => !known.has(proof.secret));
    if (proofs.length === 0) continue;
    for (const proof of proofs) known.add(proof.secret);
    next.tokens.push({ event: token.event, mint: token.mint, proofs });
  }
  // Gathered by mint into as few records as will hold them, and all sent at once (2026-11-24): one at a time, each
  // waited for, ten of them on relays that never say whether they took a record ran past the panel's minute, and the
  // wallet said it couldn't be opened. Now the opening waits for one sending, however many there are.
  const unsent = new Map<string, EcashProof[]>();
  for (const token of local.tokens.filter((t) => isLocal(t.event))) {
    const proofs = token.proofs.filter((proof) => !known.has(proof.secret));
    for (const proof of proofs) known.add(proof.secret);
    if (proofs.length) unsent.set(token.mint, [...(unsent.get(token.mint) ?? []), ...proofs]);
  }
  const resend: { mint: string; proofs: EcashProof[] }[] = [];
  for (const [mint, proofs] of unsent) for (let i = 0; i < proofs.length; i += ECASH_LIMITS.proofsWritten) resend.push({ mint, proofs: proofs.slice(i, i + ECASH_LIMITS.proofsWritten) });
  const now = deps.now ?? Date.now() / 1000;
  const signed = resend.map((record) => signToken(signer, record, now));
  const took = await Promise.all(signed.map(async (event) => accepted(await relays.publishAll(event, 6000).catch(() => []), relays.relayUrls.length)));
  for (const [i, record] of resend.entries()) next.tokens.push({ event: took[i] ? signed[i]!.id : localId(), ...record });
  await writeLocal(store, signer, next);
  return state(next, false);
}

/** Name the wallet's mints, making the wallet (and a key of its own) where there is none. */
export async function setEcashMints(deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays; newKey: () => string; now?: number }, mints: unknown): Promise<EcashState> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const clean = [...new Set((Array.isArray(mints) ? mints : []).map(cleanMint).filter(Boolean))];
  if (clean.length === 0 || clean.length > ECASH_LIMITS.mints) throw new Error("Name between one and five mints, each an https address.");
  const local = await readLocal(store, signer);
  const wallet: EcashWallet = { privkey: local.wallet?.privkey ?? deps.newKey(), mints: clean };
  const next: LocalCopy = { wallet, tokens: local.tokens };
  await writeLocal(store, signer, next);
  const event = signer.signEvent({ kind: WALLET_KIND, created_at: Math.floor(deps.now ?? Date.now() / 1000), tags: [], content: signer.nip44Encrypt(me, writeWallet(wallet)) });
  const took = accepted(await relays.publishAll(event, 6000).catch(() => []), relays.relayUrls.length);
  if (!took) throw new Error("The wallet was saved in this browser, but no relay took it. Try again when you are online.");
  return state(next, false);
}

export interface EcashRoll {
  /** Token records that are spent or replaced: by event id, or by local id. */
  destroy: string[];
  /** What takes their place: the proofs still unspent, and any new ones. */
  keep: { mint: string; proofs: EcashProof[] }[];
  /** A line for the history, where the balance changed. */
  history?: { direction: "in" | "out"; amount: number; /** VR way: the site it was made in (set by the worker, never a page). */ vr?: string };
}

/**
 * Replace token records with new ones (NIP-60's roll-over). The browser's
 * copy is written first, so nothing new exists only in memory. Then relays:
 * the new records, the deletion of the old, a line of history. A record no
 * relay takes stays in the browser, unsaved, and is sent again later.
 */
export async function rollEcash(
  deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays; now?: number },
  roll: EcashRoll,
  /** Told the moment the new proofs are sealed in this browser, before any relay is asked: they can't be lost from here. */
  sealed?: (state: EcashState) => void
): Promise<EcashState> {
  const { signer, store, relays } = deps;
  const now = deps.now ?? Date.now() / 1000;
  const destroy = new Set(roll.destroy.filter((id) => typeof id === "string" && id.length <= 80));
  // Everything held at a mint may be handed over at once: it is written as several records, below.
  const keep = roll.keep.map((token) => ({ mint: cleanMint(token.mint), proofs: cleanProofs(token.proofs, 5000) }));
  if (keep.some((token) => !token.mint || !token.proofs)) throw new Error("That is not ecash this wallet can keep.");
  const local = await readLocal(store, signer);
  // Many proofs are written as several records, each small enough for any NIP-60 wallet, and any relay, to take.
  const added: EcashToken[] = keep.flatMap((token) => {
    const records: EcashToken[] = [];
    for (let i = 0; i < token.proofs!.length; i += ECASH_LIMITS.proofsWritten) records.push({ event: localId(), mint: token.mint, proofs: token.proofs!.slice(i, i + ECASH_LIMITS.proofsWritten) });
    return records;
  });
  const next: LocalCopy = { wallet: local.wallet, tokens: [...local.tokens.filter((token) => !destroy.has(token.event)), ...added] };
  // First, here. From this line on, a crash or a dead relay loses nothing.
  await writeLocal(store, signer, next);
  sealed?.(state(next, false));

  const gone = [...destroy].filter((id) => !isLocal(id));
  // Every new record is signed first, so the line of history can name them, and all are sent at once.
  const signed = added.map((token, i) => signToken(signer, { mint: token.mint, proofs: token.proofs, ...(gone.length && i === 0 ? { del: gone } : {}) }, now));
  const me = signer.getPublicKey();
  const history =
    roll.history && Number.isSafeInteger(roll.history.amount) && roll.history.amount > 0
      ? signer.signEvent({ kind: HISTORY_KIND, created_at: Math.floor(now), tags: [], content: signer.nip44Encrypt(me, writeHistory({ ...roll.history, created: signed.map((event) => event.id), destroyed: gone })) })
      : null;
  const [took, historyTook] = await Promise.all([
    Promise.all(signed.map(async (event) => accepted(await relays.publishAll(event, 6000).catch(() => []), relays.relayUrls.length))),
    history ? relays.publishAll(history, 6000).then((o) => accepted(o, relays.relayUrls.length)).catch(() => false) : Promise.resolve(false)
  ]);
  for (const [i, token] of added.entries()) if (took[i]) token.event = signed[i]!.id;
  await writeLocal(store, signer, next);
  const allSaved = took.every(Boolean);
  // The line of history names records that must be on relays. Where one isn't, it is sent again later under another
  // name, so the line is taken back: no history names a record that relays don't have.
  if (history && historyTook && !allSaved) {
    const withdraw = signer.signEvent({ kind: 5, created_at: Math.floor(now), tags: [["e", history.id], ["k", String(HISTORY_KIND)]], content: "" });
    await relays.publishAll(withdraw, 6000).catch(() => []);
  }
  // The old records are deleted only once what replaced them is on relays, or where nothing replaced them.
  if (gone.length && allSaved) {
    const deletion = signer.signEvent({ kind: 5, created_at: Math.floor(now), tags: [...gone.map((id) => ["e", id]), ["k", String(TOKEN_KIND)]], content: "" });
    await relays.publishAll(deletion, 6000).catch(() => []);
  }
  return state(next, false);
}
