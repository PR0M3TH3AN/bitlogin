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

/**
 * Placeholder pinned maintainer public key for this reference build.
 * A real deployment must replace this with the key the maintainers actually
 * control and publish that fact out-of-band (release notes, source repo).
 */
export const MAINTAINER_PUBLIC_KEY_HEX =
  "0000000000000000000000000000000000000000000000000000000000000000".slice(0, 64);

// §15.6's publishAndVerify enforces a fixed floor (minAcks/minReadbacks = 2)
// regardless of how many relays are configured, so this list needs enough
// healthy redundancy that losing any one relay still clears that floor
// comfortably -- a 3-relay list has zero margin the moment one relay is
// unreachable, which is exactly what "add more vault relays" (the
// registration failure message) is telling operators to fix.
export const BUILTIN_VAULT_RELAYS: readonly string[] = [
  "wss://relay.damus.io",
  "wss://nos.lol",
  "wss://relay.nostr.band",
  "wss://nostr.wine",
  "wss://relay.snort.social"
];

export const BUILTIN_DISCOVERY_RELAYS: readonly string[] = [
  "wss://purplepag.es",
  "wss://relay.nostr.band",
  "wss://nostr-pub.wellorder.net"
];

/** Well-known static HTTPS fallback URLs for the signed relay-list document (§19.1). */
export const BOOTSTRAP_HTTPS_FALLBACK_URLS: readonly string[] = [];

export interface BootstrapRelayList {
  version: number;
  vaultRelays: string[];
  discoveryRelays: string[];
  deprecated?: string[];
}

export function parseAndVerifyBootstrapList(
  event: NostrEvent,
  maintainerPubkeyHex: string
): BootstrapRelayList | null {
  if (event.pubkey !== maintainerPubkeyHex) return null;
  if (event.kind !== KIND_APP_DATA) return null;
  if (findTagValue(event, "d") !== D_TAG_BOOTSTRAP_RELAYS) return null;
  if (!verifyNostrEvent(event)) return null;
  try {
    const parsed = JSON.parse(event.content) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as BootstrapRelayList).vaultRelays) &&
      Array.isArray((parsed as BootstrapRelayList).discoveryRelays)
    ) {
      return parsed as BootstrapRelayList;
    }
    return null;
  } catch {
    return null;
  }
}

/** Merges a verified fetched list into the built-in list. Never drops built-in relays outright — only marks them deprecated. */
export function mergeRelayLists(
  builtIn: readonly string[],
  fetched: BootstrapRelayList | null,
  kind: "vault" | "discovery"
): string[] {
  const fetchedUrls = fetched ? (kind === "vault" ? fetched.vaultRelays : fetched.discoveryRelays) : [];
  const deprecated = new Set(fetched?.deprecated ?? []);
  const merged = new Set<string>([...builtIn.filter((u) => !deprecated.has(u)), ...fetchedUrls]);
  return [...merged];
}

export async function fetchBootstrapListOverHttps(urls: readonly string[]): Promise<NostrEvent | null> {
  for (const url of urls) {
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const event = (await response.json()) as NostrEvent;
      if (verifyNostrEvent(event)) return event;
    } catch {
      // try the next fallback URL
    }
  }
  return null;
}
