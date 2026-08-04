/** Page-level record of the widget session, backing window.bitlogin.activeMethod()
 * and activeSession() (docs/login-methods.md §LM3).
 *
 * window.nostr ownership (isActiveSigner) and session state are DIFFERENT
 * questions with different answers: during a NIP-07 session the extension owns
 * the slot -- correctly -- yet the user very much signed in through BitLogin.
 * Hosts that used isActiveSigner() as a session check got `false` there. This
 * registry answers the session question directly, for every method.
 *
 * Public data only (method, public key, npub); never key material. Owner-scoped
 * so one element's teardown cannot clear a session another element established.
 */
import type { SignerMethod } from "./signers/types.js";

export interface ActiveSessionInfo {
  method: SignerMethod;
  publicKey: string;
  npub: string;
}

let current: { owner: object; info: ActiveSessionInfo } | null = null;

export function setActiveSession(owner: object, info: ActiveSessionInfo): void {
  current = { owner, info };
}

export function clearActiveSession(owner: object): void {
  if (current?.owner === owner) current = null;
}

export function getActiveSession(): ActiveSessionInfo | null {
  return current ? { ...current.info } : null;
}
