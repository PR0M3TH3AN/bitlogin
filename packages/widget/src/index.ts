/** Entry point: any static site includes this file and drops in <bitlogin-auth>. */
import { BitLoginAuthElement } from "./element.js";
import { getActiveSession, type ActiveSessionInfo } from "./globalSession.js";
import type { SignerMethod } from "./signers/types.js";

if (!customElements.get("bitlogin-auth")) {
  customElements.define("bitlogin-auth", BitLoginAuthElement);
}

export interface BitLoginGlobal {
  readonly version: string;
  /**
   * True when BitLogin currently occupies window.nostr. Only one provider can hold that
   * global at a time (a browser extension like Alby or nos2x may also implement it, or
   * install itself later and overwrite BitLogin's). This check survives that overwrite —
   * unlike checking `window.nostr._bitlogin` directly — since it's read fresh each call.
   */
  isActiveSigner(): boolean;
  /**
   * Releases window.nostr back to undefined, but only if BitLogin currently occupies it —
   * a no-op otherwise, so it's always safe to call speculatively. Lets a host page that
   * offers several signing methods (an extension, a NIP-46 bunker, BitLogin) hand the slot
   * back when a user switches away from BitLogin, without needing a reference to a specific
   * <bitlogin-auth> element or a page reload. The element itself also exposes an
   * instance-scoped `releaseSigner()`/`claimSigner()` pair for finer control when a page
   * holds several widget instances. Returns whether it actually released anything.
   */
  releaseSigner(): boolean;
  /**
   * How the current widget session was established -- 'bitlogin' (password
   * account), 'nip07' (extension), 'nip46' (remote signer) -- or null when
   * nobody is signed in. THE session check for hosts. Deliberately distinct
   * from isActiveSigner(): during a NIP-07 session the extension rightly owns
   * window.nostr, so isActiveSigner() is false while activeMethod() is
   * 'nip07'. With several <bitlogin-auth> elements, reflects the most recent
   * sign-in.
   */
  activeMethod(): SignerMethod | null;
  /** The current session's public identity ({ method, publicKey, npub }), or
   *  null. Public data only -- never key material. */
  activeSession(): ActiveSessionInfo | null;
}

declare global {
  interface Window {
    bitlogin?: BitLoginGlobal;
  }
}

// Installed once per page regardless of whether <bitlogin-auth> has been used yet, so a
// host site can feature-detect BitLogin's presence and active-signer status independently
// of window.nostr's current occupant (§26.2, §26.4 — "active signer" support for sites that
// offer multiple signing methods: BitLogin, a NIP-07 extension, or a NIP-46 remote signer).
//
// This assignment is deliberately unconditional (not `if (!window.bitlogin)`): browsers
// auto-expose any element with a matching `id` or `name` attribute as a same-named global
// (e.g. `<div id="bitlogin">` becomes `window.bitlogin`). A guard would silently see that
// element instead of ever installing this object on any page that happens to use that id —
// including our own demo before it was renamed. A direct assignment creates a real own
// property that takes priority over that fallback, on any page.
window.bitlogin = {
  version: "0.1.0",
  isActiveSigner(): boolean {
    return (window as unknown as { nostr?: { _bitlogin?: boolean } }).nostr?._bitlogin === true;
  },
  releaseSigner(): boolean {
    const w = window as unknown as { nostr?: { _bitlogin?: boolean } };
    if (w.nostr?._bitlogin === true) {
      delete (w as { nostr?: unknown }).nostr;
      window.dispatchEvent(new CustomEvent("bitlogin-signer-released"));
      return true;
    }
    return false;
  },
  activeMethod(): SignerMethod | null {
    return getActiveSession()?.method ?? null;
  },
  activeSession(): ActiveSessionInfo | null {
    return getActiveSession();
  }
};

export { BitLoginAuthElement } from "./element.js";
export { WorkerClient } from "./worker/workerClient.js";
export { createNip07Provider } from "./provider.js";
export type { BitLoginConfig } from "./config.js";
