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

export function verifyNostrEvent(event: NostrEvent): boolean {
  if (!/^[0-9a-f]{64}$/u.test(event.id) || !/^[0-9a-f]{64}$/u.test(event.pubkey) || !/^[0-9a-f]{128}$/u.test(event.sig)) {
    return false;
  }
  const expectedId = computeEventId(event);
  if (expectedId !== event.id) return false;
  try {
    return schnorrVerify(hexToBytes(event.sig), hexToBytes(event.id), hexToBytes(event.pubkey));
  } catch {
    return false;
  }
}

export function findTagValue(event: Pick<UnsignedNostrEvent, "tags">, tagName: string): string | undefined {
  return event.tags.find((t) => t[0] === tagName)?.[1];
}
