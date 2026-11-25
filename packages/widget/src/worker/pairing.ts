/**
 * Signing in a headset from your phone (docs/pair-a-headset.md), over relays: both notes ephemeral (kind 27304),
 * which relays pass on to whoever is listening and keep for nobody. So each side listens live, and the headset says
 * its offer again while it waits.
 *
 * The headset: a one-time key, made here and never shown. Its offer names the code by hash, the site it is at and its
 * label; nothing in it is secret. It listens for notes to that key: the first phone's `found` (a number it shows),
 * then that phone's end or its answer, the sealed hand-off, opened once with the one-time key, which is then dropped.
 *
 * The phone: a throwaway key, so relays never link the person's own key to the headset. It finds offers by the code's
 * hash, sends `found` with a number, and then the end, or the answer.
 */
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex, wipe } from "@bitlogin/core/crypto";
import { RelayConnection, RelayPool, type NostrEvent, type NostrFilter } from "@bitlogin/core/nostr";
import { ANSWER_TTL_SEC, codeHash, makeCode, normalizeCode, PAIR_KIND, PAIR_TAG, PAIR_TTL_SEC, pairNumber, readOffer, type PairOffer } from "../embedded/pair.js";
import { openAppHandoff, type SealedHandoff } from "./handoff.js";

type Opened = ReturnType<typeof openAppHandoff>;
const now = (): number => Math.floor(Date.now() / 1000);

/** Listen live on every relay that will connect: each event once. Closed by what it returns. */
async function listen(urls: readonly string[], filter: NostrFilter, onEvent: (event: NostrEvent) => void): Promise<() => void> {
  const seen = new Set<string>();
  const connections: RelayConnection[] = [];
  const subs: { close(): void }[] = [];
  await Promise.all(
    urls.map(async (url) => {
      try {
        const connection = new RelayConnection(url);
        connections.push(connection);
        subs.push(
          await connection.subscribeLive(filter, (event) => {
            if (seen.has(event.id)) return;
            seen.add(event.id);
            onEvent(event);
          })
        );
      } catch {
        /* a relay that won't connect is left out */
      }
    })
  );
  return () => {
    for (const sub of subs) sub.close();
    for (const connection of connections) connection.close();
  };
}

const expired = (event: NostrEvent): boolean => {
  const until = Number(event.tags.find((t) => t[0] === "expiration")?.[1]);
  return !Number.isSafeInteger(until) || until <= now();
};

export type HeadsetStatus = "waiting" | "found" | "paired" | "ended" | "expired";
export interface HeadsetPairing {
  /** The code to show, as K7QF-3MPX. */
  readonly code: string;
  /** When it stops being offered, in seconds. */
  readonly expires: number;
  state(): { status: HeadsetStatus; number?: number; opened?: Opened };
  /** Stop: the one-time key is dropped, and nothing more is heard. */
  cancel(): void;
}

export async function startHeadsetPairing(opts: {
  relayUrls: readonly string[];
  site: string;
  device: string;
  /** How often the offer is said again while it waits. */
  republishMs?: number;
  /** How long the code lasts, in seconds: five minutes, unless a test says less. */
  ttlSec?: number;
  /** For tests only: a code to use, as someone who saw another's would. */
  code?: string;
}): Promise<HeadsetPairing> {
  const key = generatePrivateKey();
  const me = getPublicKeyHex(key);
  const signer = new NostrSigner(key.slice());
  const code = normalizeCode(opts.code) || makeCode();
  const hash = codeHash(code);
  const expires = now() + Math.min(opts.ttlSec ?? PAIR_TTL_SEC, PAIR_TTL_SEC);
  const pool = new RelayPool([...opts.relayUrls]);
  let status: HeadsetStatus = "waiting";
  let number: number | undefined;
  let opened: Opened | undefined;
  /** The phone that found it first: the only one heard after. */
  let phone: string | null = null;
  let stopListening: () => void = () => {};
  let timer: ReturnType<typeof setInterval> | null = null;
  let ending: ReturnType<typeof setTimeout> | null = null;

  const stop = (to: HeadsetStatus) => {
    if (status === "paired" || status === "ended" || status === "expired") return;
    status = to;
    if (timer) clearInterval(timer);
    if (ending) clearTimeout(ending);
    stopListening();
    pool.closeAll();
    signer.destroy?.();
    wipe(key);
  };
  const offer = () => {
    if (status !== "waiting" && status !== "found") return;
    const event = signer.signEvent({
      kind: PAIR_KIND,
      created_at: now(),
      tags: [[PAIR_TAG, hash], ["nswp:origin", opts.site], ["expiration", String(expires)]],
      content: JSON.stringify({ device: opts.device })
    });
    void pool.publishAll(event, 4000).catch(() => []);
  };

  stopListening = await listen(opts.relayUrls, { kinds: [PAIR_KIND], "#p": [me], since: now() - 10 }, (event) => {
    if ((status !== "waiting" && status !== "found") || expired(event)) return;
    // The answer: a sealed hand-off, as the window's Allow sends, from the phone that found this.
    let sealed: SealedHandoff | null = null;
    try {
      const parsed = JSON.parse(event.content) as Partial<SealedHandoff>;
      if (typeof parsed.senderPublicKey === "string" && typeof parsed.payload === "string") sealed = parsed as SealedHandoff;
    } catch {
      sealed = null;
    }
    if (sealed) {
      if (status !== "found" || event.pubkey !== phone) return;
      try {
        opened = openAppHandoff(sealed, key);
      } catch {
        return;
      }
      stop("paired");
      return;
    }
    let said: { found?: unknown; end?: unknown };
    try {
      said = JSON.parse(signer.nip44Decrypt(event.pubkey, event.content)) as { found?: unknown; end?: unknown };
    } catch {
      return;
    }
    if (status === "waiting" && Number.isSafeInteger(said.found) && (said.found as number) >= 10 && (said.found as number) <= 99) {
      phone = event.pubkey;
      number = said.found as number;
      status = "found";
      return;
    }
    if (said.end === true && event.pubkey === phone) stop("ended");
  });
  offer();
  timer = setInterval(offer, opts.republishMs ?? 2000);
  ending = setTimeout(() => stop("expired"), Math.max(0, expires - now()) * 1000);

  return {
    code,
    expires,
    state: () => ({ status, ...(number !== undefined ? { number } : {}), ...(opened ? { opened } : {}) }),
    cancel: () => stop("ended")
  };
}

export interface PhonePairing {
  /** The offers showing this code, in date: one, or more where another device copied it (refuse them all), or none. */
  find(code: string, opts?: { waitMs?: number; settleMs?: number }): Promise<PairOffer[]>;
  /** Tell the headset a number to show, and say it here: the person taps the same. */
  found(offer: PairOffer): Promise<number>;
  /** A wrong tap, or "Not this one": the headset stops. */
  end(offer: PairOffer): Promise<void>;
  /** The sealed hand-off, to the headset's one-time key. */
  answer(offer: PairOffer, sealed: SealedHandoff): Promise<void>;
}

export function phonePairing(opts: { relayUrls: readonly string[] }): PhonePairing {
  // A throwaway key for this pairing alone: relays never see the person's own key beside the headset's.
  const signer = new NostrSigner(generatePrivateKey());
  const note = async (offer: PairOffer, content: string) => {
    const pool = new RelayPool([...opts.relayUrls]);
    try {
      const event = signer.signEvent({ kind: PAIR_KIND, created_at: now(), tags: [["p", offer.key], ["e", offer.id], ["expiration", String(now() + ANSWER_TTL_SEC)]], content });
      await pool.publishAll(event, 6000);
    } finally {
      pool.closeAll();
    }
  };
  return {
    async find(input, { waitMs = 6000, settleMs = 2000 } = {}) {
      const hash = codeHash(input);
      if (!hash) return [];
      const offers = new Map<string, PairOffer>();
      return new Promise<PairOffer[]>((done) => {
        let finish: ReturnType<typeof setTimeout> | null = null;
        let stop: () => void = () => {};
        const end = () => {
          stop();
          done([...offers.values()]);
        };
        const overall = setTimeout(end, waitMs);
        void listen(opts.relayUrls, { kinds: [PAIR_KIND], since: now() - PAIR_TTL_SEC }, (event) => {
          const offer = readOffer(event, now());
          if (!offer || offer.hash !== hash) return;
          offers.set(offer.key, offer);
          // Once one is found, a moment more for any other device showing the same code.
          if (!finish) {
            finish = setTimeout(() => {
              clearTimeout(overall);
              end();
            }, settleMs);
          }
        }).then((close) => (stop = close));
      });
    },
    async found(offer) {
      const n = pairNumber();
      await note(offer, signer.nip44Encrypt(offer.key, JSON.stringify({ found: n })));
      return n;
    },
    async end(offer) {
      await note(offer, signer.nip44Encrypt(offer.key, JSON.stringify({ end: true })));
    },
    async answer(offer, sealed) {
      await note(offer, JSON.stringify(sealed));
    }
  };
}
