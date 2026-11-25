/**
 * This browser's lane for each mint keyset (docs/ecash-seed-counter.md, rules 1 to 3), kept by the worker. Sealed to
 * the account's own key, as the wallet's copy is: nothing new is kept in the clear. Only ever forward: a lane once kept
 * is not changed, and its counter is never set lower here, whatever the page asks.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanState, type LaneState } from "../ecash/seedLanes.js";

const KEYSET = /^[0-9a-f]{16}$|^[0-9a-f]{66}$/u;
const keyFor = (me: string, keysetId: unknown): string => {
  if (typeof keysetId !== "string" || !KEYSET.test(keysetId)) throw new Error("That is not a keyset id.");
  return `bitlogin:ecash-lane:v1:${me}:${keysetId}`;
};

export async function readLane(deps: { signer: NostrSigner; store: KeyValueStore }, keysetId: unknown): Promise<LaneState | null> {
  const me = deps.signer.getPublicKey();
  const sealed = await deps.store.get(keyFor(me, keysetId));
  if (!sealed) return null;
  try {
    return cleanState(JSON.parse(deps.signer.nip44Decrypt(me, sealed)));
  } catch {
    return null;
  }
}

/** Keep a lane's state, forward only. Returns what is kept after: the one asked for, or the one already there. */
export async function keepLane(deps: { signer: NostrSigner; store: KeyValueStore }, keysetId: unknown, state: unknown): Promise<LaneState | null> {
  const me = deps.signer.getPublicKey();
  const key = keyFor(me, keysetId);
  const asked = cleanState(state);
  if (!asked) throw new Error("That is not a lane.");
  const kept = await readLane(deps, keysetId);
  if (kept && (kept.lane !== asked.lane || asked.next <= kept.next)) return kept;
  await deps.store.set(key, deps.signer.nip44Encrypt(me, JSON.stringify(asked)));
  return asked;
}
