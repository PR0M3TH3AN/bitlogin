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
