/** NIP-01 event serialization, id calculation, signing, and verification. */
import { sha256 } from "@noble/hashes/sha2";
import { sign as schnorrSign, verify as schnorrVerify } from "../crypto/secp256k1.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "../crypto/encoding.js";

export type NostrTag = string[];

export interface UnsignedNostrEvent {
  pubkey: string;
  created_at: number;
  kind: number;
  tags: NostrTag[];
  content: string;
}

export interface NostrEvent extends UnsignedNostrEvent {
  id: string;
  sig: string;
}

/** NIP-01 canonical serialization for id computation: [0, pubkey, created_at, kind, tags, content]. */
export function serializeForId(event: UnsignedNostrEvent): string {
  return JSON.stringify([0, event.pubkey, event.created_at, event.kind, event.tags, event.content]);
}

export function computeEventId(event: UnsignedNostrEvent): string {
  return bytesToHex(sha256(utf8ToBytes(serializeForId(event))));
}

export function signNostrEvent(unsigned: UnsignedNostrEvent, privateKey: Uint8Array): NostrEvent {
  const id = computeEventId(unsigned);
  const sig = bytesToHex(schnorrSign(hexToBytes(id), privateKey));
  return { ...unsigned, id, sig };
}

/**
 * Verifies untrusted runtime input without ever throwing. Relay messages and
 * imported capsules are JSON, so their compile-time type is not evidence of
 * their shape. Keeping the structural guard here makes every caller safe by
 * default and lets successful verification narrow `unknown` to NostrEvent.
 */
export function verifyNostrEvent(event: unknown): event is NostrEvent {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return false;
  const candidate = event as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.pubkey !== "string" ||
    typeof candidate.sig !== "string" ||
    typeof candidate.content !== "string" ||
    !Number.isSafeInteger(candidate.created_at) ||
    (candidate.created_at as number) < 0 ||
    !Number.isSafeInteger(candidate.kind) ||
    (candidate.kind as number) < 0 ||
    (candidate.kind as number) > 0xffff ||
    !Array.isArray(candidate.tags) ||
    !candidate.tags.every((tag) => Array.isArray(tag) && tag.every((value) => typeof value === "string"))
  ) {
    return false;
  }
  if (!/^[0-9a-f]{64}$/u.test(candidate.id) || !/^[0-9a-f]{64}$/u.test(candidate.pubkey) || !/^[0-9a-f]{128}$/u.test(candidate.sig)) {
    return false;
  }
  const typed = candidate as unknown as NostrEvent;
  const expectedId = computeEventId(typed);
  if (expectedId !== typed.id) return false;
  try {
    return schnorrVerify(hexToBytes(typed.sig), hexToBytes(typed.id), hexToBytes(typed.pubkey));
  } catch {
    return false;
  }
}

export interface NostrEventCoordinate {
  created_at: number;
  id: string;
}

/**
 * NIP-01 replacement ordering. Positive means `candidate` wins over
 * `current`: a newer timestamp wins and, at equal timestamps, the
 * lexicographically lower event id wins.
 */
export function compareNip01ReplacementOrder(candidate: NostrEventCoordinate, current: NostrEventCoordinate): number {
  if (candidate.created_at !== current.created_at) {
    return candidate.created_at > current.created_at ? 1 : -1;
  }
  if (candidate.id === current.id) return 0;
  return candidate.id < current.id ? 1 : -1;
}

export function findTagValue(event: Pick<UnsignedNostrEvent, "tags">, tagName: string): string | undefined {
  return event.tags.find((t) => t[0] === tagName)?.[1];
}
