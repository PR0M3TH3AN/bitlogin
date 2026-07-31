/**
 * Local per-account generation high-water mark (§16.2, §21.1). Keyed by the
 * everyday public key — the canonical account identity (§4.4) — so the mark
 * survives password changes, which rotate the locator address entirely.
 */
import type { KeyValueStore } from "../storage/interface.js";

export interface HighWaterMark {
  generation: number;
  recoveryGeneration: number;
}

const NONE: HighWaterMark = { generation: -1, recoveryGeneration: -1 };

function key(everydayPublicKeyHex: string): string {
  return `bitlogin:hwm:${everydayPublicKeyHex}`;
}

export async function getHighWaterMark(store: KeyValueStore, everydayPublicKeyHex: string): Promise<HighWaterMark> {
  const raw = await store.get(key(everydayPublicKeyHex));
  return raw ? (JSON.parse(raw) as HighWaterMark) : NONE;
}

/** Merges in the observed generation(s), keeping the maximum ever seen, and persists the result. */
export async function raiseHighWaterMark(
  store: KeyValueStore,
  everydayPublicKeyHex: string,
  observed: Partial<HighWaterMark>
): Promise<HighWaterMark> {
  const current = await getHighWaterMark(store, everydayPublicKeyHex);
  const merged: HighWaterMark = {
    generation: Math.max(current.generation, observed.generation ?? -1),
    recoveryGeneration: Math.max(current.recoveryGeneration, observed.recoveryGeneration ?? -1)
  };
  await store.set(key(everydayPublicKeyHex), JSON.stringify(merged));
  return merged;
}

/**
 * Resets the mark after a phrase recovery.
 *
 * The recovered account restarts at generation 0 at a BRAND NEW locator
 * address, but the mark is keyed by the everyday public key -- which recovery
 * deliberately preserves -- so a user who had ever rotated a password was met
 * with "Refusing to log in with older, possibly-revoked credentials" on every
 * subsequent login, on every device that had seen the higher generation, with
 * no way to clear it (raiseHighWaterMark keeps the maximum). The recovery
 * phrase is the master authority in this protocol (§SF9); a phrase-driven
 * reset is exactly the authority it is supposed to carry, and leaving the
 * alarm permanently lit trains users to click through the one control that
 * detects a real replay.
 */
export async function resetHighWaterMark(
  store: KeyValueStore,
  everydayPublicKeyHex: string,
  generations: HighWaterMark = { generation: 0, recoveryGeneration: -1 }
): Promise<void> {
  await store.set(key(everydayPublicKeyHex), JSON.stringify(generations));
}
