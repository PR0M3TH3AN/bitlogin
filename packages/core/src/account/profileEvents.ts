/** Public everyday-identity events excluded from the credential capsule by design (§12.2, §15.8, §19.6). */
import { signNostrEvent, type NostrEvent } from "../nostr/event.js";
import { KIND_PROFILE, KIND_RELAY_LIST, KIND_DM_RELAY_LIST } from "../nostr/kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";

export interface ProfileMetadata {
  name?: string;
  display_name?: string;
  about?: string;
  picture?: string;
  [key: string]: unknown;
}

export function buildProfileEvent(everydayPrivateKey: Uint8Array, metadata: ProfileMetadata, createdAt: number): NostrEvent {
  return signNostrEvent(
    { pubkey: getPublicKeyHex(everydayPrivateKey), created_at: createdAt, kind: KIND_PROFILE, tags: [], content: JSON.stringify(metadata) },
    everydayPrivateKey
  );
}

export interface RelayListEntry {
  url: string;
  read?: boolean;
  write?: boolean;
}

/** NIP-65 general relay preferences (§15.8, §17.4, §19.6). */
export function buildRelayListEvent(everydayPrivateKey: Uint8Array, relays: RelayListEntry[], createdAt: number): NostrEvent {
  const tags = relays.map((r) => {
    const tag = ["r", r.url];
    if (r.read && !r.write) tag.push("read");
    if (r.write && !r.read) tag.push("write");
    return tag;
  });
  return signNostrEvent(
    { pubkey: getPublicKeyHex(everydayPrivateKey), created_at: createdAt, kind: KIND_RELAY_LIST, tags, content: "" },
    everydayPrivateKey
  );
}

/** NIP-17 preferred DM relays (§15.8, §17.4, §19.6). */
export function buildDmRelayListEvent(everydayPrivateKey: Uint8Array, relayUrls: string[], createdAt: number): NostrEvent {
  return signNostrEvent(
    {
      pubkey: getPublicKeyHex(everydayPrivateKey),
      created_at: createdAt,
      kind: KIND_DM_RELAY_LIST,
      tags: relayUrls.map((url) => ["relay", url]),
      content: ""
    },
    everydayPrivateKey
  );
}

export function parseRelayListEvent(event: NostrEvent): string[] {
  return event.tags.filter((t) => t[0] === "r" && t[1]).map((t) => t[1]!);
}

export function parseDmRelayListEvent(event: NostrEvent): string[] {
  return event.tags.filter((t) => t[0] === "relay" && t[1]).map((t) => t[1]!);
}
