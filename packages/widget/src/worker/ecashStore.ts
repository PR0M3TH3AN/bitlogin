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
  withCounters,
  withPins,
  withTrial,
  withTrials,
  type EcashCounter,
  type EcashProof,
  type EcashTrial,
  type EcashToken,
  type EcashWallet
} from "../ecash/nip60.js";
import { adoptPins, readCounters, readPins, workerLock } from "./ecashLanes.js";

/**
 * Every read-and-write of this browser's copy of the wallet, one at a time across tabs (the third review): between a
 * read and its write another tab's newly sealed proofs could otherwise be written over. `navigator.locks` where the
 * worker has it; one at a time within this worker where not.
 */
const localChain = new Map<string, Promise<unknown>>();
function withLocal<T>(signer: NostrSigner, fn: () => Promise<T>): Promise<T> {
  const me = signer.getPublicKey();
  const lock = workerLock();
  if (lock) return lock(`bitlogin:ecash-local:${me}`, fn);
  const run = (localChain.get(me) ?? Promise.resolve()).then(fn, fn);
  localChain.set(me, run.catch(() => {}));
  return run;
}

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
  /** Mints' keysets tried for the seed (docs/ecash-seed-counter.md, rule 4). Only one that "passed" is seeded. */
  trials?: EcashTrial[];
  /** How far each lane of each keyset has gone, as the wallet record says: what restore follows (rule 3). */
  counters?: EcashCounter[];
}

const LOCAL_KEY = "bitlogin:ecash:v1:";
const isLocal = (event: string): boolean => event.startsWith("local:");
const localId = (): string => `local:${Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("")}`;

interface LocalCopy {
  wallet: EcashWallet | null;
  tokens: EcashToken[];
  /** When the newest wallet record seen or written was dated: a record that replaces it is dated after (2026-11-24). */
  walletAt?: number;
  /** The wallet record here is newer than any relay took: it is sent again at the next opening (finding 9). */
  walletUnsent?: boolean;
}

async function readLocal(store: KeyValueStore, signer: NostrSigner): Promise<LocalCopy> {
  const me = signer.getPublicKey();
  try {
    const sealed = await store.get(LOCAL_KEY + me);
    if (!sealed) return { wallet: null, tokens: [] };
    const parsed = JSON.parse(signer.nip44Decrypt(me, sealed)) as { wallet?: unknown; tokens?: unknown; walletAt?: unknown; walletUnsent?: unknown };
    const wallet = typeof parsed.wallet === "string" ? readWallet(parsed.wallet) : null;
    const tokens: EcashToken[] = [];
    for (const item of Array.isArray(parsed.tokens) ? parsed.tokens : []) {
      const t = item as { event?: unknown; mint?: unknown; proofs?: unknown };
      const proofs = cleanProofs(t.proofs);
      if (typeof t.event === "string" && t.event.length <= 80 && cleanMint(t.mint) && proofs?.length) tokens.push({ event: t.event, mint: cleanMint(t.mint), proofs });
    }
    return { wallet, tokens, ...(Number.isSafeInteger(parsed.walletAt) ? { walletAt: parsed.walletAt as number } : {}), ...(parsed.walletUnsent === true ? { walletUnsent: true } : {}) };
  } catch {
    // A copy that can't be read is not a reason to lose what relays hold. It is left in place, untouched.
    return { wallet: null, tokens: [] };
  }
}

async function writeLocal(store: KeyValueStore, signer: NostrSigner, copy: LocalCopy): Promise<void> {
  const me = signer.getPublicKey();
  await store.set(LOCAL_KEY + me, signer.nip44Encrypt(me, JSON.stringify({ wallet: copy.wallet ? writeWallet(copy.wallet) : null, tokens: copy.tokens, ...(copy.walletAt ? { walletAt: copy.walletAt } : {}), ...(copy.walletUnsent ? { walletUnsent: true } : {}) })));
}

const accepted = (outcomes: RelayPublishOutcome[], of: number): boolean => countAcknowledgements(outcomes) >= Math.min(2, of);

function signToken(signer: NostrSigner, token: { mint: string; proofs: readonly EcashProof[]; del?: readonly string[] }, now: number): NostrEvent {
  const me = signer.getPublicKey();
  return signer.signEvent({ kind: TOKEN_KIND, created_at: Math.floor(now), tags: [], content: signer.nip44Encrypt(me, writeToken(token)) });
}

/**
 * Each proof once (2026-11-25, the review's finding 6): where two records hold the same proof (a restore in one tab of
 * what another tab added and hasn't sent yet), it is counted in the first only. A record left with nothing is dropped
 * from what is shown; it is still destroyed with the rest when the wallet next rolls over at that mint.
 */
function once(tokens: readonly EcashToken[]): EcashToken[] {
  const seen = new Set<string>();
  const out: EcashToken[] = [];
  for (const token of tokens) {
    const proofs = token.proofs.filter((proof) => !seen.has(proof.secret));
    for (const proof of proofs) seen.add(proof.secret);
    if (proofs.length) out.push(proofs.length === token.proofs.length ? token : { ...token, proofs });
  }
  return out;
}

const state = (copy: LocalCopy, offline: boolean): EcashState => ({
  mints: copy.wallet?.mints ?? [],
  tokens: once(copy.tokens),
  offline,
  unsaved: copy.tokens.some((token) => isLocal(token.event)) || !!copy.walletUnsent,
  ...(copy.wallet?.trials?.length ? { trials: copy.wallet.trials } : {}),
  ...(copy.wallet?.counters?.length ? { counters: copy.wallet.counters } : {})
});

/** This browser's pins of keysets' keys (ecashLanes.ts), as wallet-record rows. */
async function pinsHere(deps: { signer: NostrSigner; store: KeyValueStore }): Promise<{ keysetId: string; hash: string; at?: number }[]> {
  return Object.entries(await readPins(deps).catch(() => ({}) as Awaited<ReturnType<typeof readPins>>)).map(([keysetId, pin]) => ({ keysetId, hash: pin.hash, ...(pin.at ? { at: pin.at } : {}) }));
}
/** This browser's counters, from the worker's lanes (ecashLanes.ts), as wallet-record rows. */
async function laneCounters(deps: { signer: NostrSigner; store: KeyValueStore }): Promise<EcashCounter[]> {
  const kept = await readCounters(deps).catch(() => ({}) as Record<string, Record<string, number>>);
  return Object.entries(kept).flatMap(([keysetId, lanes]) => Object.entries(lanes).map(([lane, next]) => ({ keysetId, lane: Number(lane), next })));
}
/** Whether `a` already says everything `b` does: the same mints, every trial and counter at least as new. */
function covers(a: EcashWallet | null, b: EcashWallet | null): boolean {
  if (!b) return true;
  if (!a) return false;
  if (a.mints.join("\n") !== b.mints.join("\n")) return false;
  if (!(b.trials ?? []).every((t) => (a.trials ?? []).some((u) => u.mint === t.mint && u.keysetId === t.keysetId && u.at >= t.at))) return false;
  if (!(b.pins ?? []).every((p) => (a.pins ?? []).some((q) => q.keysetId === p.keysetId && (q.at ?? 0) >= (p.at ?? 0)))) return false;
  return (b.counters ?? []).every((c) => (a.counters ?? []).some((d) => d.keysetId === c.keysetId && d.lane === c.lane && d.next >= c.next));
}
/** A wallet record with the trials and counters of others joined in: the newer trial, the higher counter. */
function joined(base: EcashWallet, others: (EcashWallet | null | undefined)[], lanes: readonly EcashCounter[] = [], pinned: readonly { keysetId: string; hash: string; at?: number }[] = []): EcashWallet {
  const trials = withTrials(base.trials, ...others.map((o) => o?.trials));
  const counters = withCounters(base.counters, ...others.map((o) => o?.counters), lanes);
  const pins = withPins(pinned, base.pins, ...others.map((o) => o?.pins));
  const { trials: _t, counters: _c, pins: _p, ...rest } = base;
  return { ...rest, ...(trials.length ? { trials } : {}), ...(counters.length ? { counters } : {}), ...(pins.length ? { pins } : {}) };
}
/**
 * Send the wallet record again where this browser's lanes have gone further than it says. Joined onto the newest
 * record the relays hold (2026-11-25, the review's second round): a device whose list of mints is older must not send
 * that list over a newer one with a later date. This browser's copy is written before any relay is asked, and read
 * again after, so another tab's write in between is not undone. Null where there was nothing to send.
 */
async function sendCounters(deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays }, now: number): Promise<LocalCopy | null> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const lanes = await laneCounters(deps);
  const before = await readLocal(store, signer);
  if (!before.wallet || covers(before.wallet, joined(before.wallet, [], lanes, await pinsHere(deps)))) return null;
  const found = await relays.queryQuorum({ kinds: [WALLET_KIND], authors: [me], limit: 2 }, 4000).catch(() => null);
  const newest = (found?.outcomes ?? [])
    .flatMap((o) => o.events)
    .filter((event) => event.kind === WALLET_KIND && event.pubkey === me && verifyNostrEvent(event))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  let onRelay: EcashWallet | null = null;
  try {
    onRelay = newest ? readWallet(signer.nip44Decrypt(me, newest.content)) : null;
  } catch {
    onRelay = null;
  }
  const pinned = await pinsHere(deps);
  // Read and written as one, under the lock: another tab's write between them is not undone.
  const written = await withLocal(signer, async () => {
    const local = await readLocal(store, signer);
    if (!local.wallet) return null;
    const relayNewer = !!onRelay && !!newest && newest.created_at >= (local.walletAt ?? 0);
    const wallet = joined(relayNewer ? onRelay! : local.wallet, [local.wallet, onRelay], lanes, pinned);
    const at = datedAfter(now, Math.max(local.walletAt ?? 0, newest?.created_at ?? 0));
    await writeLocal(store, signer, { ...local, wallet, walletAt: at, walletUnsent: true });
    return { wallet, at };
  });
  if (!written) return null;
  const took = await publishWallet(deps, written.wallet, written.at);
  return withLocal(signer, async () => {
    const after = await readLocal(store, signer);
    if (took && after.walletAt === written.at) {
      delete after.walletUnsent;
      await writeLocal(store, signer, after);
    }
    return after;
  });
}

/** Send the wallet record. True where relays took it. */
async function publishWallet(deps: { signer: NostrSigner; relays: EcashRelays }, wallet: EcashWallet, at: number): Promise<boolean> {
  const me = deps.signer.getPublicKey();
  const event = deps.signer.signEvent({ kind: WALLET_KIND, created_at: at, tags: [], content: deps.signer.nip44Encrypt(me, writeWallet(wallet)) });
  return accepted(await deps.relays.publishAll(event, 6000).catch(() => []), deps.relays.relayUrls.length);
}

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
  // Newest first; two of the same second, the lower id, as NIP-01 says for replaceable events: every device agrees.
  const newestWallet = mine(wallets.outcomes.flatMap((o) => o.events), WALLET_KIND).sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  const onRelay = (newestWallet && readWallet(open(newestWallet) ?? "")) || null;
  // The record here wins where it is newer than any relay holds (a write no relay took: finding 9); otherwise the
  // relays'. Trials and counters are joined from both, and from this browser's lanes: none is lost to an older record.
  const localNewer = !!local.wallet && (!newestWallet || (local.walletAt ?? 0) > newestWallet.created_at);
  const base = localNewer ? local.wallet : (onRelay ?? local.wallet);
  // Keysets' keys pinned on another device are taken up here, where none is pinned yet: never replacing one.
  if (onRelay?.pins?.length) await adoptPins(deps, onRelay.pins).catch(() => {});
  const wallet = base ? joined(base, [onRelay, local.wallet], await laneCounters(deps), await pinsHere(deps)) : null;
  const deleted = new Set(mine(deletions.outcomes.flatMap((o) => o.events), 5).flatMap((event) => event.tags.filter((tag) => tag[0] === "e" && typeof tag[1] === "string").map((tag) => tag[1]!)));
  const byId = new Map<string, NostrEvent>();
  for (const event of mine(tokens.outcomes.flatMap((o) => o.events), TOKEN_KIND)) byId.set(event.id, event);
  const records = [...byId.values()].flatMap((event) => {
    const token = readToken(open(event) ?? "");
    return token ? [{ event: event.id, created_at: event.created_at, ...token }] : [];
  });
  const onRelays = liveTokens(records, deleted);
  // A record whose every proof is in another that stays is hidden from the balance, and would otherwise stay on relays
  // for ever, to come back once the other is spent (the review's second round): it is deleted.
  const shown = new Set(onRelays.map((token) => token.event));
  const held = new Set(onRelays.flatMap((token) => token.proofs.map((proof) => proof.secret)));
  const supersededIds = new Set(records.flatMap((record) => record.del));
  // Only where every relay that holds it also holds records that cover it (the third review): a relay with nothing
  // else of those proofs keeps its only copy.
  const proofsOf = new Map(records.map((record) => [record.event, record.proofs.map((proof) => proof.secret)]));
  const coveredEverywhere = (id: string): boolean =>
    tokens.outcomes.every((outcome) => {
      const ids = new Set(outcome.events.map((event) => event.id));
      if (!ids.has(id)) return true;
      const there = new Set([...ids].filter((other) => other !== id && shown.has(other)).flatMap((other) => proofsOf.get(other) ?? []));
      return (proofsOf.get(id) ?? []).every((secret) => there.has(secret));
    });
  const hidden = records.filter((record) => !shown.has(record.event) && !deleted.has(record.event) && !supersededIds.has(record.event) && record.proofs.length > 0 && record.proofs.every((proof) => held.has(proof.secret)) && coveredEverywhere(record.event));
  if (hidden.length) {
    const deletion = signer.signEvent({ kind: 5, created_at: Math.floor(deps.now ?? Date.now() / 1000), tags: [...hidden.map((record) => ["e", record.event]), ["k", String(TOKEN_KIND)]], content: "" });
    await relays.publishAll(deletion, 6000).catch(() => []);
  }

  // What this browser holds that no relay does: proofs written here and not yet taken by one. They are kept, and
  // sent again now. A proof a relay already has is the relay's: the local copy of it is dropped.
  const known = new Set(onRelays.flatMap((token) => token.proofs.map((proof) => proof.secret)));
  let walletAt = Math.max(newestWallet?.created_at ?? 0, local.walletAt ?? 0) || undefined;
  let walletUnsent = false;
  // What the relays hold says less than this browser knows: sent again, dated after both.
  if (wallet && !covers(onRelay, wallet)) {
    const at = datedAfter(deps.now ?? Date.now() / 1000, walletAt);
    if (await publishWallet(deps, wallet, at)) walletAt = at;
    else walletUnsent = true;
  }
  const next: LocalCopy = { wallet, tokens: [...onRelays], ...(walletAt ? { walletAt } : {}), ...(walletUnsent ? { walletUnsent } : {}) };
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
  // Written under the lock, with what another tab sealed here since this read began kept (the third review).
  const merged = await withLocal(signer, async () => {
    const now_ = await readLocal(store, signer);
    const before = new Set(local.tokens.map((t) => t.event));
    const have = new Set(next.tokens.flatMap((t) => t.proofs.map((p) => p.secret)));
    for (const token of now_.tokens.filter((t) => !before.has(t.event))) {
      const proofs = token.proofs.filter((p) => !have.has(p.secret));
      if (proofs.length) next.tokens.push({ ...token, proofs });
      for (const p of proofs) have.add(p.secret);
    }
    await writeLocal(store, signer, next);
    return next;
  });
  return state(merged, false);
}

/** A wallet record's date: now, or a second after the record it replaces where the clock says the same or earlier. */
const datedAfter = (now: number, before: number | undefined): number => Math.max(Math.floor(now), (before ?? 0) + 1);

/**
 * Once a wallet record is on relays: this browser's copy, read again under the lock, says so, where it is still the
 * record that was sent (2026-11-25, the fourth review's 3). What another tab wrote meanwhile is kept as it wrote it.
 */
async function markSent(deps: { signer: NostrSigner; store: KeyValueStore }, at: number): Promise<LocalCopy> {
  return withLocal(deps.signer, async () => {
    const now = await readLocal(deps.store, deps.signer);
    if (now.walletAt !== at || !now.walletUnsent) return now;
    const next = { ...now };
    delete next.walletUnsent;
    await writeLocal(deps.store, deps.signer, next);
    return next;
  });
}

/** Name the wallet's mints, making the wallet (and a key of its own) where there is none. */
export async function setEcashMints(deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays; newKey: () => string; now?: number }, mints: unknown): Promise<EcashState> {
  const { signer, store } = deps;
  const clean = [...new Set((Array.isArray(mints) ? mints : []).map(cleanMint).filter(Boolean))];
  if (clean.length === 0 || clean.length > ECASH_LIMITS.mints) throw new Error("Name between one and five mints, each an https address.");
  const lanes = await laneCounters(deps);
  const pinned = await pinsHere(deps);
  // Read and written as one, under the lock; no relay is waited on while it is held.
  const { wallet, at } = await withLocal(signer, async () => {
    const local = await readLocal(store, signer);
    // The mints change; the trials made of them stay, for whichever of them are still named.
    const trials = (local.wallet?.trials ?? []).filter((t) => clean.includes(t.mint));
    const wallet = joined({ privkey: local.wallet?.privkey ?? deps.newKey(), mints: clean, ...(trials.length ? { trials } : {}) }, [{ privkey: "", mints: [], ...(local.wallet?.counters ? { counters: local.wallet.counters } : {}), ...(local.wallet?.pins ? { pins: local.wallet.pins } : {}) }], lanes, pinned);
    const at = datedAfter(deps.now ?? Date.now() / 1000, local.walletAt);
    await writeLocal(store, signer, { ...local, wallet, walletAt: at, walletUnsent: true });
    return { wallet, at };
  });
  const took = await publishWallet(deps, wallet, at);
  if (!took) throw new Error("The wallet was saved in this browser, but no relay took it. Try again when you are online.");
  return state(await markSent(deps, at), false);
}

export interface EcashRoll {
  /** Token records that are spent or replaced: by event id, or by local id. */
  destroy: string[];
  /** What takes their place: the proofs still unspent, and any new ones. */
  keep: { mint: string; proofs: EcashProof[] }[];
  /** A line for the history, where the balance changed. */
  history?: { direction: "in" | "out"; amount: number };
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
  // Read, worked out and written as one, under the lock (the third review): another tab's newly sealed proofs are
  // never written over between this read and its write.
  const first = await withLocal(signer, async () => {
  const local = await readLocal(store, signer);
  // A record kept only here whose every proof another record holds goes with this roll, so it isn't left hidden.
  // Never a relay's record: whether what covers it is on relays isn't known here; loadEcash, which asks them, decides.
  {
    const seen = new Set<string>();
    for (const token of local.tokens.filter((t) => !destroy.has(t.event))) {
      if (isLocal(token.event) && token.proofs.length && token.proofs.every((proof) => seen.has(proof.secret))) destroy.add(token.event);
      for (const proof of token.proofs) seen.add(proof.secret);
    }
  }
  // Many proofs are written as several records, each small enough for any NIP-60 wallet, and any relay, to take.
  // A proof this browser already holds in a record that stays is not written again (finding 6): a restore in one tab
  // of what another tab added and hasn't sent yet would otherwise hold it twice.
  const staying = new Set(local.tokens.filter((token) => !destroy.has(token.event)).flatMap((token) => token.proofs.map((proof) => proof.secret)));
  const added: EcashToken[] = keep.flatMap((token) => {
    const records: EcashToken[] = [];
    const proofs = token.proofs!.filter((proof) => !staying.has(proof.secret));
    for (let i = 0; i < proofs.length; i += ECASH_LIMITS.proofsWritten) records.push({ event: localId(), mint: token.mint, proofs: proofs.slice(i, i + ECASH_LIMITS.proofsWritten) });
    return records;
  });
  const next: LocalCopy = { wallet: local.wallet, tokens: [...local.tokens.filter((token) => !destroy.has(token.event)), ...added], ...(local.walletAt ? { walletAt: local.walletAt } : {}), ...(local.walletUnsent ? { walletUnsent: true } : {}) };
  // First, here. From this line on, a crash or a dead relay loses nothing.
  await writeLocal(store, signer, next);
  return { added, next };
  });
  const { added } = first;
  sealed?.(state(first.next, false));

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
  // The records relays took get their names, in the copy as it is now, read again under the lock.
  const next = await withLocal(signer, async () => {
    const now_ = await readLocal(store, signer);
    const named = new Map(added.flatMap((token, i) => (took[i] ? [[token.event, signed[i]!.id] as const] : [])));
    for (const token of now_.tokens) if (named.has(token.event)) token.event = named.get(token.event)!;
    await writeLocal(store, signer, now_);
    return now_;
  });
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
  // Where this browser's lanes have gone further than the wallet record says (sats just added by the seed), the record
  // is sent again with the counters, so restore elsewhere follows each lane that far (finding 2).
  const sent = await sendCounters(deps, now);
  return state(sent ? { ...next, wallet: sent.wallet, ...(sent.walletAt ? { walletAt: sent.walletAt } : {}), walletUnsent: !!sent.walletUnsent } : next, false);
}

/**
 * Keep a mint keyset's trial with the wallet record (docs/ecash-seed-counter.md, rule 4): in this browser first, then
 * on relays, so every device knows whether that mint is used with the seed. Newest wins for a mint and keyset.
 */
export async function keepEcashTrial(deps: { signer: NostrSigner; store: KeyValueStore; relays: EcashRelays; now?: number }, trial: unknown): Promise<EcashState> {
  const { signer, store } = deps;
  const t = trial as Partial<EcashTrial> | null;
  const mint = cleanMint(t?.mint);
  if (!mint || typeof t?.keysetId !== "string" || !/^[0-9a-f]{16}$|^[0-9a-f]{66}$/u.test(t.keysetId) || (t.outcome !== "passed" && t.outcome !== "failed")) throw new Error("That is not a trial of a mint.");
  const keysetId = t.keysetId;
  const outcome = t.outcome;
  const lanes = await laneCounters(deps);
  const pinned = await pinsHere(deps);
  // Kept here first, marked as not yet on a relay, under the lock (the fourth review's 3): where no relay takes it, it
  // is sent again at the next opening.
  const { wallet, at } = await withLocal(signer, async () => {
    const local = await readLocal(store, signer);
    if (!local.wallet || !local.wallet.mints.includes(mint)) throw new Error("That mint is not in this wallet.");
    const at = datedAfter(deps.now ?? Date.now() / 1000, local.walletAt);
    const wallet = joined({ ...local.wallet, trials: withTrial(local.wallet.trials, { mint, keysetId, outcome, at }) }, [], lanes, pinned);
    await writeLocal(store, signer, { ...local, wallet, walletAt: at, walletUnsent: true });
    return { wallet, at };
  });
  if (await publishWallet(deps, wallet, at)) return state(await markSent(deps, at), false);
  return state(await withLocal(signer, () => readLocal(store, signer)), false);
}
