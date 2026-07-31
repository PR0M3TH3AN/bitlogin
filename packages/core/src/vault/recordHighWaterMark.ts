import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { aesGcmOpen, aesGcmSeal } from "../crypto/aesGcm.js";
import {
  base64urlToBytes,
  bytesToBase64url,
  utf8ToBytes,
  bytesToUtf8,
} from "../crypto/encoding.js";
import { hkdfExpand } from "../crypto/hkdf.js";
import { wipe } from "../crypto/memory.js";
import { compareNip01ReplacementOrder } from "../nostr/event.js";
import type { KeyValueStore } from "../storage/interface.js";
import { decodeConnectionId, deriveVaultPublicKey } from "./derivation.js";

const STORAGE_PREFIX = "bitlogin:vault-hwm:v2:";
const INDEX_INFO = "bitlogin/vault-hwm-index/v2";
const ENCRYPTION_INFO = "bitlogin/vault-hwm-encryption/v2";
const HEX64 = /^[0-9a-f]{64}$/u;

export interface RecordHighWaterMark {
  createdAt: number;
  eventId: string;
}

interface SealedRecordHighWaterMark {
  v: 2;
  nonce: string;
  ciphertext: string;
}

export class RecordHighWaterMarkError extends Error {
  constructor() {
    super(
      "The local Connection Vault rollback marker is invalid or has been tampered with.",
    );
    this.name = "RecordHighWaterMarkError";
  }
}

function validateMark(value: unknown): value is RecordHighWaterMark {
  if (!value || typeof value !== "object") return false;
  const mark = value as Partial<RecordHighWaterMark>;
  return (
    Number.isInteger(mark.createdAt) &&
    (mark.createdAt ?? -1) >= 0 &&
    typeof mark.eventId === "string" &&
    HEX64.test(mark.eventId)
  );
}

function deriveStorageKey(vaultPrk: Uint8Array, connectionId: string): string {
  decodeConnectionId(connectionId);
  const indexKey = hkdfExpand(vaultPrk, INDEX_INFO, 32);
  const idBytes = utf8ToBytes(connectionId);
  try {
    return `${STORAGE_PREFIX}${bytesToBase64url(hmac(sha256, indexKey, idBytes))}`;
  } finally {
    wipe(indexKey, idBytes);
  }
}

function legacyStorageKey(vaultPrk: Uint8Array, connectionId: string): string {
  return `bitlogin:vault-hwm:${deriveVaultPublicKey(vaultPrk)}:${connectionId}`;
}

async function sealMark(
  vaultPrk: Uint8Array,
  storageKey: string,
  mark: RecordHighWaterMark,
): Promise<string> {
  const encryptionKey = hkdfExpand(vaultPrk, ENCRYPTION_INFO, 32);
  const plaintext = utf8ToBytes(JSON.stringify(mark));
  const associatedData = utf8ToBytes(storageKey);
  try {
    const sealed = await aesGcmSeal(encryptionKey, plaintext, associatedData);
    const stored: SealedRecordHighWaterMark = {
      v: 2,
      nonce: bytesToBase64url(sealed.nonce),
      ciphertext: bytesToBase64url(sealed.ciphertext),
    };
    return JSON.stringify(stored);
  } finally {
    wipe(encryptionKey, plaintext, associatedData);
  }
}

async function openMark(
  vaultPrk: Uint8Array,
  storageKey: string,
  raw: string,
): Promise<RecordHighWaterMark> {
  const encryptionKey = hkdfExpand(vaultPrk, ENCRYPTION_INFO, 32);
  const associatedData = utf8ToBytes(storageKey);
  let plaintext: Uint8Array | undefined;
  try {
    const stored = JSON.parse(raw) as Partial<SealedRecordHighWaterMark>;
    if (
      stored.v !== 2 ||
      typeof stored.nonce !== "string" ||
      typeof stored.ciphertext !== "string"
    ) {
      throw new RecordHighWaterMarkError();
    }
    plaintext = await aesGcmOpen(
      encryptionKey,
      base64urlToBytes(stored.nonce),
      base64urlToBytes(stored.ciphertext),
      associatedData,
    );
    const parsed = JSON.parse(bytesToUtf8(plaintext)) as unknown;
    if (!validateMark(parsed)) throw new RecordHighWaterMarkError();
    return parsed;
  } catch (error) {
    if (error instanceof RecordHighWaterMarkError) throw error;
    throw new RecordHighWaterMarkError();
  } finally {
    wipe(encryptionKey, associatedData);
    if (plaintext) wipe(plaintext);
  }
}

async function persistMark(
  store: KeyValueStore,
  vaultPrk: Uint8Array,
  connectionId: string,
  mark: RecordHighWaterMark,
): Promise<void> {
  const storageKey = deriveStorageKey(vaultPrk, connectionId);
  await store.set(storageKey, await sealMark(vaultPrk, storageKey, mark));
}

/**
 * Reads the authenticated, inventory-hiding v2 marker. A valid legacy marker
 * is migrated in place on first access; malformed legacy state fails closed.
 */
export async function getRecordHighWaterMark(
  store: KeyValueStore,
  vaultPrk: Uint8Array,
  connectionId: string,
): Promise<RecordHighWaterMark | null> {
  const storageKey = deriveStorageKey(vaultPrk, connectionId);
  const protectedRaw = await store.get(storageKey);
  if (protectedRaw !== undefined)
    return openMark(vaultPrk, storageKey, protectedRaw);

  const legacyKey = legacyStorageKey(vaultPrk, connectionId);
  const legacyRaw = await store.get(legacyKey);
  if (legacyRaw === undefined) return null;
  try {
    const mark = JSON.parse(legacyRaw) as unknown;
    if (!validateMark(mark)) throw new RecordHighWaterMarkError();
    await persistMark(store, vaultPrk, connectionId, mark);
    await store.delete(legacyKey);
    return mark;
  } catch (error) {
    if (error instanceof RecordHighWaterMarkError) throw error;
    throw new RecordHighWaterMarkError();
  }
}

/** Keeps the NIP-01-canonical maximum: newest timestamp, then lowest id. */
export async function raiseRecordHighWaterMark(
  store: KeyValueStore,
  vaultPrk: Uint8Array,
  connectionId: string,
  observed: RecordHighWaterMark,
): Promise<void> {
  if (!validateMark(observed)) throw new RecordHighWaterMarkError();
  const current = await getRecordHighWaterMark(store, vaultPrk, connectionId);
  if (
    current &&
    compareNip01ReplacementOrder(
      { created_at: observed.createdAt, id: observed.eventId },
      { created_at: current.createdAt, id: current.eventId },
    ) <= 0
  ) {
    return;
  }
  await persistMark(store, vaultPrk, connectionId, observed);
}
