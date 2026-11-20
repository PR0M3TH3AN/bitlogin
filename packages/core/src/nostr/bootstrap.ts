/**
 * Bootstrap relay list and its signed update channel (§19.1, §19.6).
 *
 * A pinned list ships in every client build. The maintainer key can only add
 * or deprecate relays via a signed kind-30078 list; it can never remove a
 * client's ability to query its built-in relays, and it confers no ability
 * to read or forge capsule ciphertext.
 */
import { signNostrEvent, verifyNostrEvent, findTagValue, type NostrEvent } from "./event.js";
import { RelayPool } from "./pool.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import type { KeyValueStore } from "../storage/interface.js";
import { D_TAG_BOOTSTRAP_RELAYS, KIND_APP_DATA } from "./kinds.js";
import { isAllowedRelayUrl } from "./relayUrl.js";

/**
 * The update channel is deliberately disabled until a real maintainer key is
 * pinned and announced out-of-band. `null` cannot accidentally verify an
 * attacker-controlled event, unlike a syntactically valid placeholder key.
 */
export const MAINTAINER_PUBLIC_KEY_HEX: string | null = null;

// §15.6's publishAndVerify enforces a fixed floor (minAcks/minReadbacks = 2)
// regardless of how many relays are configured, so this list needs enough
// healthy redundancy that losing any one relay still clears that floor
// comfortably -- a 3-relay list has zero margin the moment one relay is
// unreachable, which is exactly what "add more vault relays" (the
// registration failure message) is telling operators to fix.
/**
 * Relays that CANNOT accept an ordinary user's capsule, by their own policy.
 *
 * Measured 2026-08-05 from each relay's NIP-11 document, not from reputation:
 * `nostr.wine` advertises `payment_required: true` and
 * `restricted_writes: true`, so a free user's write is refused there no matter
 * how healthy the socket looks. It sat in the vault list below occupying one
 * of five write slots it could never fill.
 *
 * A relay here may still be perfectly good for READING. This list exists so
 * the test suite can refuse to let one back into a write path.
 */
export const WRITE_HOSTILE_RELAYS: readonly string[] = ["wss://nostr.wine", "wss://nostr21.com", "wss://nostr.land"];

/**
 * Vault relays: where capsules are PUBLISHED, so every entry must accept
 * anonymous writes.
 *
 * Widened 2026-08-05 after measuring the old five. Only two could actually
 * take a write from a fresh client: nostr.wine refuses by policy (above), and
 * relay.damus.io and relay.nostr.band were unreachable across three runs from
 * the machine under test. Two usable relays against a floor of two
 * acknowledgements is zero margin -- one hiccup and registration or a
 * password rotation fails outright.
 *
 * damus stays: it is the most widely used relay on the network and the
 * failure may be datacenter-IP filtering rather than downtime. The point of
 * widening is that quorum no longer DEPENDS on it.
 */
export const BUILTIN_VAULT_RELAYS: readonly string[] = [
  "wss://nos.lol",
  "wss://offchain.pub",
  "wss://nostr.bitcoiner.social",
  "wss://relay.mostr.pub",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.primal.net",
  "wss://relay.snort.social",
  "wss://relay.damus.io",
  // Added 2026-11-18 after `scripts/relay-probe.mjs` measured the eight above
  // from one machine: nos.lol, relay.primal.net and relay.snort.social stored
  // everything; relay.mostr.pub and nostr-pub.wellorder.net never connected;
  // relay.damus.io connected about one time in eight; nostr.bitcoiner.social
  // intermittently refused capsule keys ("pubkey is not in our web of
  // trust"); and offchain.pub acknowledged and returned capsules, then held
  // only half of them minutes later. That is about four dependable relays,
  // and an account whose owner lost it to exactly this.
  //
  // NOTHING ABOVE IS REMOVED. Existing accounts live on those relays, and a
  // client that stopped asking them could no longer find those accounts.
  // These five each stored 8 of 8 capsule-shaped test events from throwaway
  // keys and still held all 8 on two later re-reads. That is minutes of
  // evidence, not months: re-run the probe before trusting any of them more.
  "wss://nostr.mom",
  "wss://relay.nostr.net",
  "wss://nostr-01.yakihonne.com",
  "wss://relay.nostr.wirednet.jp",
  "wss://nostr.sathoarder.com",
  // Measured again 2026-11-20, from one machine, re-read 15 to 17 minutes after publishing. NOTHING IS CHANGED BY
  // IT: one run adds no relay and removes none.
  //   Held 8 of 8: nos.lol, nostr.bitcoiner.social, relay.primal.net, nostr-01.yakihonne.com,
  //     relay.nostr.wirednet.jp, nostr.sathoarder.com.
  //   Accepted 8, held about half: offchain.pub (4), nostr.mom (4, then 3).
  //   Accepted 8, held 0 in one run and 4 in another: relay.snort.social.
  //   One of eight stored: relay.damus.io. Never connected: relay.mostr.pub, nostr-pub.wellorder.net,
  //     relay.nostr.net.
  // So six of these thirteen kept an account, against the floor of two acknowledgements.
  // Of 60 relays that NIP-66 monitors listed as open, 49 refused a capsule from a key they did not know. Five not
  // on this list held 8 of 8 through the re-read, once: nostr.hanshan.io, relay.nearhood.co.uk, relay.jmoose.rocks,
  // relay-fra.zombi.cloudrodion.com, relay.solomonstr.com. They are candidates for the next run, and are added
  // only if they hold again on another day (CONTRIBUTING.md, "Before a promotion: the relay probe").
];

/**
 * Discovery relays: read-only lookups (profiles, relay lists), so a
 * search-oriented or write-restricted relay is appropriate here.
 */
export const BUILTIN_DISCOVERY_RELAYS: readonly string[] = [
  "wss://purplepag.es",
  "wss://relay.nostr.band",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.primal.net",
  // Added 2026-11-18: relay.nostr.band timed out and nostr-pub.wellorder.net
  // never connected in the same measurement, leaving two working lookups.
  "wss://nos.lol",
];

/** Well-known static HTTPS fallback URLs for the signed relay-list document (§19.1). */
export const BOOTSTRAP_HTTPS_FALLBACK_URLS: readonly string[] = [];

export interface BootstrapRelayList {
  version: number;
  vaultRelays: string[];
  discoveryRelays: string[];
  deprecated?: string[];
}

const HEX64 = /^[0-9a-f]{64}$/u;
const MAX_BOOTSTRAP_RELAYS_PER_LIST = 64;

function isValidRelayList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_BOOTSTRAP_RELAYS_PER_LIST && value.every((relay) => typeof relay === "string" && isAllowedRelayUrl(relay)) && new Set(value).size === value.length;
}

export function parseAndVerifyBootstrapList(event: unknown, maintainerPubkeyHex: string | null = MAINTAINER_PUBLIC_KEY_HEX, minimumVersionExclusive = -1): BootstrapRelayList | null {
  if (!maintainerPubkeyHex || !HEX64.test(maintainerPubkeyHex) || /^0{64}$/u.test(maintainerPubkeyHex)) return null;
  if (!verifyNostrEvent(event)) return null;
  if (event.pubkey !== maintainerPubkeyHex) return null;
  if (event.kind !== KIND_APP_DATA) return null;
  if (findTagValue(event, "d") !== D_TAG_BOOTSTRAP_RELAYS) return null;
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.version) ||
      (candidate.version as number) < 1 ||
      (candidate.version as number) <= minimumVersionExclusive ||
      !isValidRelayList(candidate.vaultRelays) ||
      !isValidRelayList(candidate.discoveryRelays) ||
      (candidate.deprecated !== undefined && !isValidRelayList(candidate.deprecated))
    )
      return null;
    return {
      version: candidate.version as number,
      vaultRelays: candidate.vaultRelays,
      discoveryRelays: candidate.discoveryRelays,
      ...(candidate.deprecated === undefined ? {} : { deprecated: candidate.deprecated })
    };
  } catch {
    return null;
  }
}

/**
 * How many relays a signed list may add to a built-in list of this size.
 *
 * Capsule reads need a quorum of ceil(N/2) relays to answer (§16.2). If a
 * signed list could add as many relays as it liked, whoever held the
 * maintainer key could add enough of their own to answer that quorum alone,
 * and a new device would believe whatever they served. Capping additions one
 * below the built-in count keeps the built-in relays a strict majority: no
 * quorum can form without at least one relay that shipped in a reviewed
 * client release.
 */
export function maxRemoteAdditions(builtInCount: number): number {
  return Math.max(0, builtInCount - 1);
}

/**
 * Merges a verified fetched list without ever removing a built-in relay, and
 * without letting remote additions outnumber the built-in relays.
 */
export function mergeRelayLists(builtIn: readonly string[], fetched: BootstrapRelayList | null, kind: "vault" | "discovery"): string[] {
  const fetchedUrls = fetched ? (kind === "vault" ? fetched.vaultRelays : fetched.discoveryRelays) : [];
  const deprecated = new Set(fetched?.deprecated ?? []);
  const pinned = new Set(builtIn);
  // Deprecation suppresses only remotely-added relays. Removing the pinned
  // recovery path requires a reviewed client release, never a signed update.
  const additions = [...new Set(fetchedUrls)]
    .filter((url) => !deprecated.has(url) && !pinned.has(url))
    .slice(0, maxRemoteAdditions(builtIn.length));
  return [...builtIn, ...additions];
}

/**
 * Builds and signs the relay-list event (§19.1). Used by the maintainer's
 * signing script and by tests; clients only ever verify.
 */
export function buildBootstrapListEvent(list: BootstrapRelayList, maintainerPrivateKey: Uint8Array, createdAt: number = Math.floor(Date.now() / 1000)): NostrEvent {
  const content = JSON.stringify({
    version: list.version,
    vaultRelays: list.vaultRelays,
    discoveryRelays: list.discoveryRelays,
    ...(list.deprecated === undefined ? {} : { deprecated: list.deprecated })
  });
  const event = signNostrEvent(
    { kind: KIND_APP_DATA, created_at: createdAt, tags: [["d", D_TAG_BOOTSTRAP_RELAYS]], content, pubkey: getPublicKeyHex(maintainerPrivateKey) },
    maintainerPrivateKey
  );
  if (!parseAndVerifyBootstrapList(event, event.pubkey)) {
    throw new Error("The relay list is not valid: every relay must be a distinct wss:// URL and the version a positive integer.");
  }
  return event;
}

/**
 * Asks the given relays for the maintainer's relay-list event and returns the
 * highest-versioned one that verifies. Relays are untrusted transport here:
 * a relay can withhold the newest list, but it cannot forge one, and it
 * cannot make a client go back to a version it has already seen
 * (`minimumVersionExclusive`).
 */
export async function fetchBootstrapListFromRelays(
  relayUrls: readonly string[],
  maintainerPubkeyHex: string | null = MAINTAINER_PUBLIC_KEY_HEX,
  minimumVersionExclusive = -1,
  timeoutMs = 6000
): Promise<{ event: NostrEvent; list: BootstrapRelayList } | null> {
  if (!maintainerPubkeyHex || relayUrls.length === 0) return null;
  const pool = new RelayPool([...relayUrls]);
  let events: NostrEvent[];
  try {
    const result = await pool.queryQuorum(
      { kinds: [KIND_APP_DATA], authors: [maintainerPubkeyHex], "#d": [D_TAG_BOOTSTRAP_RELAYS], limit: 3 },
      timeoutMs
    );
    events = result.outcomes.flatMap((outcome) => outcome.events);
  } finally {
    pool.closeAll();
  }
  let best: { event: NostrEvent; list: BootstrapRelayList } | null = null;
  for (const event of events) {
    const list = parseAndVerifyBootstrapList(event, maintainerPubkeyHex, minimumVersionExclusive);
    if (list && (!best || list.version > best.list.version)) best = { event, list };
  }
  return best;
}

const CACHED_LIST_KEY = "bitlogin:bootstrap-relays:v1";

/**
 * The last relay list this device accepted, re-verified on every read. The
 * store is not trusted: an entry that no longer verifies against the pinned
 * key is ignored, which is also what happens to every cached list if a
 * client release changes the maintainer key.
 */
export async function loadCachedBootstrapList(store: KeyValueStore, maintainerPubkeyHex: string | null = MAINTAINER_PUBLIC_KEY_HEX): Promise<BootstrapRelayList | null> {
  if (!maintainerPubkeyHex) return null;
  try {
    const raw = await store.get(CACHED_LIST_KEY);
    return raw ? parseAndVerifyBootstrapList(JSON.parse(raw) as unknown, maintainerPubkeyHex) : null;
  } catch {
    return null;
  }
}

export interface RelaySets {
  vaultRelays: string[];
  discoveryRelays: string[];
  /** Version of the signed list in effect, or null when only the built-in lists apply. */
  listVersion: number | null;
}

export function relaySetsFor(list: BootstrapRelayList | null): RelaySets {
  return {
    vaultRelays: mergeRelayLists(BUILTIN_VAULT_RELAYS, list, "vault"),
    discoveryRelays: mergeRelayLists(BUILTIN_DISCOVERY_RELAYS, list, "discovery"),
    listVersion: list?.version ?? null
  };
}

/**
 * Looks for a newer signed relay list and remembers it (§19.1). Returns the
 * relay sets to use from now on. Never throws and never shrinks the built-in
 * lists; with no maintainer key pinned it does nothing at all.
 */
export async function refreshBootstrapList(
  store: KeyValueStore,
  options: {
    maintainerPubkeyHex?: string | null;
    httpsFallbackUrls?: readonly string[];
    timeoutMs?: number;
    /** Relays to ask instead of the current sets. For tests and for hosts that run their own relays. */
    queryRelayUrls?: readonly string[];
  } = {}
): Promise<RelaySets> {
  const maintainerPubkeyHex = options.maintainerPubkeyHex === undefined ? MAINTAINER_PUBLIC_KEY_HEX : options.maintainerPubkeyHex;
  const cached = await loadCachedBootstrapList(store, maintainerPubkeyHex);
  if (!maintainerPubkeyHex) return relaySetsFor(null);
  const current = relaySetsFor(cached);
  const floor = cached?.version ?? -1;
  try {
    let found = await fetchBootstrapListFromRelays(
      options.queryRelayUrls ?? [...new Set([...current.vaultRelays, ...current.discoveryRelays])],
      maintainerPubkeyHex,
      floor,
      options.timeoutMs
    );
    if (!found) {
      const event = await fetchBootstrapListOverHttps(options.httpsFallbackUrls ?? BOOTSTRAP_HTTPS_FALLBACK_URLS, maintainerPubkeyHex, floor);
      const list = event ? parseAndVerifyBootstrapList(event, maintainerPubkeyHex, floor) : null;
      if (event && list) found = { event, list };
    }
    if (!found) return current;
    await store.set(CACHED_LIST_KEY, JSON.stringify(found.event));
    return relaySetsFor(found.list);
  } catch {
    return current;
  }
}

export async function fetchBootstrapListOverHttps(urls: readonly string[], maintainerPubkeyHex: string | null = MAINTAINER_PUBLIC_KEY_HEX, minimumVersionExclusive = -1): Promise<NostrEvent | null> {
  if (!maintainerPubkeyHex) return null;
  for (const url of urls) {
    try {
      if (new URL(url).protocol !== "https:") continue;
      const response = await fetch(url);
      if (!response.ok) continue;
      const contentLength = Number(response.headers.get("content-length") ?? 0);
      if (contentLength > 1_000_000) continue;
      const body = await response.text();
      if (body.length > 1_000_000) continue;
      const event = JSON.parse(body) as unknown;
      if (verifyNostrEvent(event) && parseAndVerifyBootstrapList(event, maintainerPubkeyHex, minimumVersionExclusive)) return event;
    } catch {
      // try the next fallback URL
    }
  }
  return null;
}
