/**
 * VR way's notice on the phone (names given by the orchestrator, 2026-11-25; the owner's "yes notification on phone is
 * good"): for every payment made in VR, the account tells itself, as a NIP-17 message to itself, sealed and wrapped,
 * on its own DM relays. Any Nostr app on the phone that notifies for messages shows it, like a bank's notice. It is no
 * limit and blocks nothing. It says the amount, as BitLogin read it, and the site, as the browser named it: nothing
 * of the mint, the invoice, the token or a receipt.
 *
 * BitLogin's own list, "Payments made in VR", doesn't depend on it arriving: it is read from the wallet's own history,
 * where a payment made in VR carries `["nswp:vr", "<site>"]` inside its encrypted content.
 */
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { computeEventId, type NostrEvent } from "@bitlogin/core/nostr";

/** The off line, after every notice: it opens BitLogin's list, which acts on nothing without a press. */
export const VR_OFF_LINE = "To turn off BitLogin inside VR: https://bitlogin.network/sites/#vr-off";
export const VR_HISTORY_TAG = "nswp:vr";
export const VR_PAYMENTS_HEADING = "Payments made in VR";

const hostOf = (site: string): string => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};
/** The notice's words, as given: the amount and the site, then the off line. */
export function vrNoticeText(what: { paid: number } | { token: number } | { bought: { title: string; sats: number } }, site: string): string {
  const at = hostOf(site);
  const line =
    "paid" in what
      ? `You paid ${what.paid} sats in ${at}.`
      : "token" in what
        ? `You sent ${what.token} sats as a token in ${at}.`
        : `You bought ${what.bought.title.replace(/\s+/gu, " ").slice(0, 80)} for ${what.bought.sats} sats in ${at}.`;
  return `${line} ${VR_OFF_LINE}`;
}

/** What signs and seals as the account: the session's own signer. */
export interface NoticeKey {
  getPublicKey(): string;
  signEvent(event: { kind: number; created_at: number; tags: string[][]; content: string }): NostrEvent;
  nip44Encrypt(peer: string, text: string): string;
}

/**
 * The notice as NIP-17 to the account itself: a kind 14 rumor, unsigned, sealed (13) by the account, and wrapped
 * (1059) by a key made for this one wrap, its time a little in the past as NIP-59 asks. Only the account opens it.
 */
export function selfNotice(key: NoticeKey, text: string, nowSeconds: number): NostrEvent {
  const me = key.getPublicKey();
  const now = Math.floor(nowSeconds);
  const rumorBase = { kind: 14, pubkey: me, created_at: now, tags: [["p", me]], content: text };
  const rumor = { ...rumorBase, id: computeEventId(rumorBase) };
  const seal = key.signEvent({ kind: 13, created_at: now, tags: [], content: key.nip44Encrypt(me, JSON.stringify(rumor)) });
  const throwaway = new NostrSigner(generatePrivateKey());
  try {
    const back = Math.floor(crypto.getRandomValues(new Uint32Array(1))[0]! % (2 * 86400));
    return throwaway.signEvent({ kind: 1059, created_at: now - back, tags: [["p", me]], content: throwaway.nip44Encrypt(me, JSON.stringify(seal)) });
  } finally {
    throwaway.destroy?.();
  }
}
