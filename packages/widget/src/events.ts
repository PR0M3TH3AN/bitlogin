/**
 * Public event contract for `<bitlogin-auth>`. These are the CustomEvents the
 * element dispatches on itself; the detail shapes here match the
 * `dispatchBitLoginEvent` / colon-only helpers. Integrators previously had to
 * read the demo to learn them — the typed `addEventListener` overloads on
 * BitLoginAuthElement (see element.ts) now surface them in editors.
 *
 * Two name families exist, by design (BitBlocks API conventions D0/D2):
 * - Hyphenated names (`bitlogin-login`, …) are the original contract. They
 *   keep their historical non-bubbling, non-composed dispatch so a listener
 *   registered on the old name fires exactly once.
 * - Colon names (`bitlogin:login`, …) are additive aliases. They bubble and
 *   compose across shadow DOM, and `detail` is always an object. Each hyphen
 *   event is followed immediately by its colon equivalent, sharing the same
 *   detail object when there is one.
 */
import type { SignerMethod, SignerCapabilities } from "./signers/types.js";
import { identityFields } from "./identity.js";

/** Hyphenated (legacy) name → colon alias. Old names are never removed. */
export const BITLOGIN_COLON_ALIASES = {
  "bitlogin-login": "bitlogin:login",
  "bitlogin-logout": "bitlogin:logout",
  "bitlogin-connection-granted": "bitlogin:connection-granted",
  "bitlogin-signer-claimed": "bitlogin:signer-claimed",
  "bitlogin-signer-released": "bitlogin:signer-released",
  "bitlogin-request-pending": "bitlogin:request-pending",
  "bitlogin-offer-pending": "bitlogin:offer-pending"
} as const;

export type BitLoginHyphenEventName = keyof typeof BITLOGIN_COLON_ALIASES;
export type BitLoginColonAlias = (typeof BITLOGIN_COLON_ALIASES)[BitLoginHyphenEventName];

/** `bitlogin-login` / `bitlogin:login` — a session was established OR silently
 *  restored on page load (the two are intentionally indistinguishable to a
 *  listener). */
export interface BitLoginLoginEventDetail {
  /** Canonical identity: 64-char lowercase hex, when known. */
  pubkey?: string;
  /**
   * @deprecated Use `pubkey`. Identical value; kept so existing listeners
   * keep working.
   */
  publicKey?: string;
  /** How the session was established. */
  method: SignerMethod;
  /** What the active signer supports (NIP-07 extensions vary). */
  capabilities: SignerCapabilities;
}

/** Build the login detail with `pubkey` and the deprecated `publicKey` alias. */
export function loginEventDetail(
  hex: string | undefined,
  method: SignerMethod,
  capabilities: SignerCapabilities
): BitLoginLoginEventDetail {
  return {
    ...(hex ? identityFields(hex) : {}),
    method,
    capabilities
  };
}

/** `bitlogin-connection-granted` / `bitlogin:connection-granted` — the user
 *  shared an NWC wallet connection with an origin (Connection Vault, reveal
 *  mode). */
export interface BitLoginConnectionGrantedEventDetail {
  origin: string;
}

/** `bitlogin-signer-claimed` / `bitlogin:signer-claimed` — the element tried
 *  to install itself as `window.nostr`; `windowNostrClaimed` says whether it
 *  won the slot. */
export interface BitLoginSignerClaimedEventDetail {
  windowNostrClaimed: boolean;
  error?: string;
}

/**
 * `bitlogin:error` — a widget flow failed. Failures still render inside the
 * widget; this event is additive so a host can react without scraping the UI.
 * `code` is a stable lowercase snake_case token (BitBlocks D4); today's
 * widget surfaces a generic `widget_error` until per-class codes land.
 */
export interface BitLoginErrorEventDetail {
  code: string;
  message: string;
  retryable: boolean;
}

/** Empty object carried by colon events that have no payload. Hyphen events
 *  with no payload keep the historical `detail: null`. */
export type BitLoginEmptyDetail = Record<string, never>;

/** Maps each host event name to its concrete event type. Hyphen names without
 *  a payload stay `CustomEvent<undefined>` (runtime `detail` is `null`).
 *  Colon names always carry an object `detail`. */
export interface BitLoginEventMap {
  /** @deprecated Use `bitlogin:login`. */
  "bitlogin-login": CustomEvent<BitLoginLoginEventDetail>;
  "bitlogin:login": CustomEvent<BitLoginLoginEventDetail>;
  /** @deprecated Use `bitlogin:logout`. */
  "bitlogin-logout": CustomEvent<undefined>;
  "bitlogin:logout": CustomEvent<BitLoginEmptyDetail>;
  /** @deprecated Use `bitlogin:connection-granted`. */
  "bitlogin-connection-granted": CustomEvent<BitLoginConnectionGrantedEventDetail>;
  "bitlogin:connection-granted": CustomEvent<BitLoginConnectionGrantedEventDetail>;
  /** @deprecated Use `bitlogin:signer-claimed`. */
  "bitlogin-signer-claimed": CustomEvent<BitLoginSignerClaimedEventDetail>;
  "bitlogin:signer-claimed": CustomEvent<BitLoginSignerClaimedEventDetail>;
  /** @deprecated Use `bitlogin:signer-released`. */
  "bitlogin-signer-released": CustomEvent<undefined>;
  "bitlogin:signer-released": CustomEvent<BitLoginEmptyDetail>;
  /** @deprecated Use `bitlogin:request-pending`. */
  "bitlogin-request-pending": CustomEvent<undefined>;
  "bitlogin:request-pending": CustomEvent<BitLoginEmptyDetail>;
  /** @deprecated Use `bitlogin:offer-pending`. */
  "bitlogin-offer-pending": CustomEvent<undefined>;
  "bitlogin:offer-pending": CustomEvent<BitLoginEmptyDetail>;
  "bitlogin:ready": CustomEvent<BitLoginEmptyDetail>;
  "bitlogin:error": CustomEvent<BitLoginErrorEventDetail>;
}

const COLON_DISPATCH: CustomEventInit = { bubbles: true, composed: true };

/**
 * Dispatch a legacy hyphen event, then its colon alias. The hyphen event
 * keeps default (non-bubbling, non-composed) CustomEvent behaviour so an
 * existing listener on that name cannot fire twice. When `detail` is
 * provided, both events receive the same object.
 */
export function dispatchBitLoginEvent(target: EventTarget, hyphenName: BitLoginHyphenEventName, detail?: object): void {
  const colonName = BITLOGIN_COLON_ALIASES[hyphenName];
  if (detail === undefined) {
    target.dispatchEvent(new CustomEvent(hyphenName));
    target.dispatchEvent(new CustomEvent(colonName, { ...COLON_DISPATCH, detail: {} }));
    return;
  }
  target.dispatchEvent(new CustomEvent(hyphenName, { detail }));
  target.dispatchEvent(new CustomEvent(colonName, { ...COLON_DISPATCH, detail }));
}

/** Colon-only lifecycle events (`bitlogin:ready`, `bitlogin:error`). */
export function dispatchBitLoginColonEvent(
  target: EventTarget,
  name: "bitlogin:ready" | "bitlogin:error",
  detail: object
): void {
  target.dispatchEvent(new CustomEvent(name, { ...COLON_DISPATCH, detail }));
}
