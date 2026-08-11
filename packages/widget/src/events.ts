/**
 * Public event contract for `<bitlogin-auth>`. These are the CustomEvents the
 * element dispatches on itself; the detail shapes here match element.ts's
 * `dispatchEvent` calls exactly. Integrators previously had to read the demo to
 * learn them — the typed `addEventListener` overloads on BitLoginAuthElement
 * (see element.ts) now surface them in editors.
 */
import type { SignerMethod, SignerCapabilities } from "./signers/types.js";

/** `bitlogin-login` — a session was established OR silently restored on page
 *  load (the two are intentionally indistinguishable to a listener). */
export interface BitLoginLoginEventDetail {
  /** The signed-in account's public key (hex), when known. */
  publicKey?: string;
  /** How the session was established. */
  method: SignerMethod;
  /** What the active signer supports (NIP-07 extensions vary). */
  capabilities: SignerCapabilities;
}

/** `bitlogin-connection-granted` — the user shared an NWC wallet connection with
 *  an origin (Connection Vault, reveal mode). */
export interface BitLoginConnectionGrantedEventDetail {
  origin: string;
}

/** `bitlogin-signer-claimed` — the element tried to install itself as
 *  `window.nostr`; `windowNostrClaimed` says whether it won the slot. */
export interface BitLoginSignerClaimedEventDetail {
  windowNostrClaimed: boolean;
  error?: string;
}

/** Maps each `bitlogin-*` event name to its concrete event type. Events without
 *  a detail payload are plain `CustomEvent<undefined>`. */
export interface BitLoginEventMap {
  "bitlogin-login": CustomEvent<BitLoginLoginEventDetail>;
  "bitlogin-logout": CustomEvent<undefined>;
  "bitlogin-connection-granted": CustomEvent<BitLoginConnectionGrantedEventDetail>;
  "bitlogin-signer-claimed": CustomEvent<BitLoginSignerClaimedEventDetail>;
  "bitlogin-signer-released": CustomEvent<undefined>;
  "bitlogin-request-pending": CustomEvent<undefined>;
  "bitlogin-offer-pending": CustomEvent<undefined>;
}
