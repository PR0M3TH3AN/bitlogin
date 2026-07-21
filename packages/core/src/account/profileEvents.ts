/** Public everyday-identity events excluded from the credential capsule by design (§12.2, §15.8, §19.6). */
import { signNostrEvent, type NostrEvent } from "../nostr/event.js";
import { KIND_PROFILE, KIND_RELAY_LIST, KIND_DM_RELAY_LIST } from "../nostr/kinds.js";
import { RelayPool, countAcknowledgements, type RelayPublishOutcome } from "../nostr/pool.js";
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

export interface PublishInitialProfileParams {
  everydayPrivateKey: Uint8Array;
  name?: string;
  about?: string;
  picture?: string;
  generalRelays: string[];
  dmRelays: string[];
  discoveryRelays: string[];
}

export interface PublishInitialProfileResult {
  profilePublished: boolean;
  relayListAcknowledgedCount: number;
  dmRelayListAcknowledgedCount: number;
  /** True when an existing kind 0 profile was already found for this identity, so it was left untouched (§28.1). */
  profileSkippedExisting: boolean;
  /** True when an existing NIP-65 relay list was already found and left untouched (§28.1). */
  relayListSkippedExisting: boolean;
  /** True when an existing NIP-17 DM relay list was already found and left untouched (§28.1). */
  dmRelayListSkippedExisting: boolean;
}

/**
 * Publishes default kind 0 / 10002 / 10050 events for a freshly registered or imported
 * everyday identity, but never over an event that already exists for this public key —
 * all three are NIP-01/NIP-65/NIP-17 *replaceable* events, so an imported identity's real
 * profile and relay lists would otherwise be silently superseded by these defaults (§15.8,
 * §28.1).
 */
export async function publishInitialProfile(params: PublishInitialProfileParams): Promise<PublishInitialProfileResult> {
  const pubkeyHex = getPublicKeyHex(params.everydayPrivateKey);
  const now = Math.floor(Date.now() / 1000);
  const targets = [...new Set([...params.generalRelays, ...params.dmRelays, ...params.discoveryRelays])];

  const probePool = new RelayPool(targets);
  const [existingProfile, existingRelayList, existingDmRelayList] = await Promise.all([
    probePool.queryQuorum({ authors: [pubkeyHex], kinds: [KIND_PROFILE] }),
    probePool.queryQuorum({ authors: [pubkeyHex], kinds: [KIND_RELAY_LIST] }),
    probePool.queryQuorum({ authors: [pubkeyHex], kinds: [KIND_DM_RELAY_LIST] })
  ]);
  probePool.closeAll();
  const hasExistingProfile = existingProfile.outcomes.some((o) => o.events.length > 0);
  const hasExistingRelayList = existingRelayList.outcomes.some((o) => o.events.length > 0);
  const hasExistingDmRelayList = existingDmRelayList.outcomes.some((o) => o.events.length > 0);

  const pool = new RelayPool(targets);
  let profileOutcomes: RelayPublishOutcome[] | null = null;
  let relayListOutcomes: RelayPublishOutcome[] | null = null;
  let dmRelayListOutcomes: RelayPublishOutcome[] | null = null;

  const publishes: Promise<void>[] = [];
  if (!hasExistingProfile && (params.name || params.about || params.picture)) {
    const profileEvent = buildProfileEvent(
      params.everydayPrivateKey,
      { name: params.name, about: params.about, picture: params.picture },
      now
    );
    publishes.push(pool.publishAll(profileEvent).then((o) => void (profileOutcomes = o)));
  }
  if (!hasExistingRelayList) {
    const relayListEvent = buildRelayListEvent(
      params.everydayPrivateKey,
      params.generalRelays.map((url) => ({ url, read: true, write: true })),
      now
    );
    publishes.push(pool.publishAll(relayListEvent).then((o) => void (relayListOutcomes = o)));
  }
  if (!hasExistingDmRelayList) {
    const dmRelayListEvent = buildDmRelayListEvent(params.everydayPrivateKey, params.dmRelays, now);
    publishes.push(pool.publishAll(dmRelayListEvent).then((o) => void (dmRelayListOutcomes = o)));
  }
  await Promise.all(publishes);
  pool.closeAll();

  return {
    profilePublished: profileOutcomes !== null && countAcknowledgements(profileOutcomes) > 0,
    relayListAcknowledgedCount: relayListOutcomes !== null ? countAcknowledgements(relayListOutcomes) : 0,
    dmRelayListAcknowledgedCount: dmRelayListOutcomes !== null ? countAcknowledgements(dmRelayListOutcomes) : 0,
    profileSkippedExisting: hasExistingProfile,
    relayListSkippedExisting: hasExistingRelayList,
    dmRelayListSkippedExisting: hasExistingDmRelayList
  };
}
