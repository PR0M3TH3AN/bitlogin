/**
 * Bootstrap relay list and its signed update channel (§19.1, §19.6).
 *
 * A pinned list ships in every client build. The maintainer key can only add
 * or deprecate relays via a signed kind-30078 list; it can never remove a
 * client's ability to query its built-in relays, and it confers no ability
 * to read or forge capsule ciphertext.
 */
import { verifyNostrEvent, findTagValue, type NostrEvent } from "./event.js";
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
export const BUILTIN_VAULT_RELAYS: readonly string[] = ["wss://relay.damus.io", "wss://nos.lol", "wss://relay.nostr.band", "wss://nostr.wine", "wss://relay.snort.social"];

export const BUILTIN_DISCOVERY_RELAYS: readonly string[] = ["wss://purplepag.es", "wss://relay.nostr.band", "wss://nostr-pub.wellorder.net"];

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

/** Merges a verified fetched list without ever removing a built-in relay. */
export function mergeRelayLists(builtIn: readonly string[], fetched: BootstrapRelayList | null, kind: "vault" | "discovery"): string[] {
  const fetchedUrls = fetched ? (kind === "vault" ? fetched.vaultRelays : fetched.discoveryRelays) : [];
  const deprecated = new Set(fetched?.deprecated ?? []);
  // Deprecation suppresses only remotely-added relays. Removing the pinned
  // recovery path requires a reviewed client release, never a signed update.
  const merged = new Set<string>([...builtIn, ...fetchedUrls.filter((url) => !deprecated.has(url))]);
  return [...merged];
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
