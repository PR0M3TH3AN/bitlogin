/** Signer backends behind the widget's provider facade (docs/login-methods.md §LM3).
 *
 * A Signer is one way of producing signatures and encryption for the identity the user
 * chose at sign-in. The derived BitLogin account path stays worker-backed and is not
 * wrapped in this interface today (the element talks to WorkerClient directly, as it
 * always has); alternative methods -- NIP-07 now, NIP-46 later -- implement this
 * interface, and the element routes its public API through whichever is active.
 */
import type { NostrEvent } from "@bitlogin/core/nostr";
import type { UnsignedEventForSigning } from "../provider.js";

export type SignerMethod = "bitlogin" | "nip07";

/** What the active signer actually supports. NIP-07 extensions vary -- some lack nip44,
 * older ones lack nip04 -- and the facade reports honestly instead of throwing a
 * TypeError off an undefined property (§LM4). Surfaced to the host in the
 * bitlogin-login event detail. */
export interface SignerCapabilities {
  nip44: boolean;
  nip04: boolean;
  getRelays: boolean;
}

export interface Signer {
  readonly method: SignerMethod;
  readonly capabilities: SignerCapabilities;
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEventForSigning): Promise<NostrEvent>;
  nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip44Decrypt(peerPublicKey: string, payload: string): Promise<string>;
  nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string>;
  nip04Decrypt(peerPublicKey: string, payload: string): Promise<string>;
}

/** A call the active signer's backend doesn't implement. Deliberately a typed, stable
 * name so hosts can distinguish "this extension can't do nip44" from a real failure. */
export class SignerUnsupportedError extends Error {
  constructor(call: string, method: SignerMethod) {
    super(`The active signer (${method}) does not support ${call}.`);
    this.name = "SignerUnsupportedError";
  }
}

/** No silent hangs (§LM3): every facade call on an external signer has a deadline.
 * Timing out is retryable -- the extension may just be waiting on a user prompt that
 * got lost, or a remote signer may be asleep. */
export class SignerTimeoutError extends Error {
  constructor(call: string, timeoutMs: number) {
    super(
      `The signer did not answer ${call} within ${Math.round(timeoutMs / 1000)}s. It may be waiting for your approval in another window, or unavailable -- check your signer and try again.`
    );
    this.name = "SignerTimeoutError";
  }
}
