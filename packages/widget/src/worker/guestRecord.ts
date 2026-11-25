/**
 * A guest account (docs/guest-accounts.md): an account BitLogin makes, with no press, for a visitor who arrives
 * signed out at a site of a family it knows. Made from a recovery phrase of its own, exactly as a new account's
 * everyday key is (§11.6), so that securing it later is an ordinary account whose phrase rebuilds it.
 *
 * Kept where the family's grant would be: the embedded signer's own storage, sealed with the same non-extractable
 * device key, filed under the family. One per family, in this browser: while one is kept, it is the one used, and
 * no other is made. Nothing of it is anywhere else: a browser whose data for the site is cleared has lost it.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import { deriveEverydayPrivateKey } from "@bitlogin/core/account";
import { entropyToRecoveryPhrase, randomEntropy128, recoveryPhraseToSeed, wipe } from "@bitlogin/core/crypto";
import { readFamily } from "../embedded/family.js";

type GuestStore = KeyValueStore & Partial<{ getOrCreateDeviceKey(key: string): Promise<CryptoKey> }>;
const GUEST_PREFIX = "bitlogin:signer-guest:v1:";
/** The same device key the signer's grants are sealed with. */
const GUEST_DEVICE_KEY = "bitlogin:signer-grant-device-key:v1";

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const buffer = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export interface Guest {
  key: Uint8Array;
  /** The recovery phrase it was made from: shown only when the person secures the account. */
  phrase: string;
}

async function fromPhrase(phrase: string): Promise<Uint8Array> {
  const seed = await recoveryPhraseToSeed(phrase);
  try {
    return deriveEverydayPrivateKey(seed);
  } finally {
    wipe(seed);
  }
}

/** The guest kept for a family, or null: none, unreadable, or no storage. */
export async function loadGuest(store: GuestStore, familyInput: string): Promise<Guest | null> {
  const family = readFamily(familyInput);
  if (!family || typeof store.getOrCreateDeviceKey !== "function") return null;
  try {
    const raw = await store.get(GUEST_PREFIX + family);
    if (!raw) return null;
    const sealed = JSON.parse(raw) as { v?: unknown; iv?: unknown; ciphertext?: unknown };
    if (sealed.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") return null;
    const deviceKey = await store.getOrCreateDeviceKey(GUEST_DEVICE_KEY);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(fromBase64(sealed.iv)) }, deviceKey, buffer(fromBase64(sealed.ciphertext)));
    const p = JSON.parse(new TextDecoder().decode(plain)) as { family?: unknown; phrase?: unknown };
    if (p.family !== family || typeof p.phrase !== "string") return null;
    return { key: await fromPhrase(p.phrase), phrase: p.phrase };
  } catch {
    return null;
  }
}

/**
 * The family's guest: the one kept, or a new one made and kept. Never a second while one is kept. Throws where it
 * can't be kept (no storage here): a guest that would vanish with the page is not made.
 */
export async function makeGuest(store: GuestStore, familyInput: string): Promise<Guest> {
  const family = readFamily(familyInput);
  if (!family) throw new Error("A guest is made only for a family.");
  const kept = await loadGuest(store, family);
  if (kept) return kept;
  if (typeof store.getOrCreateDeviceKey !== "function") throw new Error("No storage here to keep a guest in.");
  const phrase = entropyToRecoveryPhrase(randomEntropy128());
  const deviceKey = await store.getOrCreateDeviceKey(GUEST_DEVICE_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, deviceKey, new TextEncoder().encode(JSON.stringify({ family, phrase })));
  await store.set(GUEST_PREFIX + family, JSON.stringify({ v: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) }));
  // Read back: what is used is what was kept.
  const made = await loadGuest(store, family);
  if (!made) throw new Error("The guest could not be kept here.");
  return made;
}

/** Forget a family's guest: only when the person secures it, or chooses to. */
export async function forgetGuest(store: GuestStore, familyInput: string): Promise<void> {
  const family = readFamily(familyInput);
  if (family) await store.delete(GUEST_PREFIX + family);
}
