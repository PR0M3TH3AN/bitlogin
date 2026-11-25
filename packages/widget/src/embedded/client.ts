/**
 * For an application that signs in with BitLogin's window
 * (docs/sign-in-window.md §SW8, §SW9). This is the application's side: it
 * holds no key and no secret, and runs in the application's own page.
 *
 *   import { createBitLoginClient } from "./vendor/bitlogin/bitlogin-client.js";
 *
 *   const bitlogin = createBitLoginClient({
 *     at: "https://bitlogin.network",
 *     permissions: { name: "My app", sign: [1, 7, 27235] }
 *   });
 *   await bitlogin.ready();
 *   button.onclick = () => bitlogin.signIn();          // from a press: it opens a window
 *   const signed = await bitlogin.signEvent({ kind: 1, content: "hello", tags: [] });
 *
 * It embeds the sign-in address's signer, unseen, tells it what the
 * application wants, and opens the sign-in address's window when asked to.
 * After the user has allowed the application there, signing happens in the
 * background with no prompt, until they sign out of it or thirty days pass.
 *
 * Everything the signer hands back is checked here: that it came from the
 * frame this made, at the address it was made for, and that a signed event
 * really is signed, by the same person, and says what was asked.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { readPermissions, type AppPermissions } from "./permissions.js";
import { ASK_WAIT_MS, ASKED_KINDS, cleanOrigin, PROTOCOL_VERSION, SIGNER_PROTOCOL, SITE_TAG } from "./policy.js";
import { cleanInvoice } from "../ecash/nip60.js";
import { cleanSats } from "../pay/lightning.js";
import { cleanCoordinate, localService, readReceipt as readReceiptOf, receiptGood, UNLOCK_SERVICES } from "../pay/listing.js";
import { buyingOpenAt, isLocalAddress } from "./permissions.js";

export interface BitLoginClientOptions {
  /** The sign-in address: an origin, such as "https://bitlogin.network". */
  at: string;
  /** What the application wants to be allowed (§SW9.2). The user sees all of it in the window. */
  permissions: unknown;
  /** Where the unseen frame is put. The page's body by default. */
  mount?: HTMLElement;
  /** How long one request may take, in milliseconds. */
  timeoutMs?: number;
  /**
   * For trying a local copy of BitLogin against a local selling service only: `http://127.0.0.1:<port>|<its key>`.
   * Ignored unless `at` is an address on this machine or a private network.
   */
  localUnlockService?: string;
  /**
   * The family of sites this application is one of, written as BitLogin writes a family:
   * `https://*.bitblocks.network` (docs/site-family.md SF5a). Asked for before the first sign-in, as a world asks;
   * BitLogin takes it only where it is this page's own family, by the browser's address for it, and one it knows.
   * Where taken, BitLogin's window offers, beside this application's own set, to keep the person signed in at every
   * site of the family: for a note and a reaction there, never this application's kinds. Read `familyTaken`.
   */
  family?: string;
  /**
   * With `family`: where nobody is signed in on this browser, be the family's guest account at once, with nothing
   * pressed (docs/guest-accounts.md): an account BitLogin makes and keeps in this browser, the same in every site of
   * the family, not yet secured. It may sign a note, a reaction and its bag, and nothing of this application's set.
   * Read `guest` in the state.
   */
  guest?: boolean;
}

export interface BitLoginClientState {
  /** Whether the application may act as someone now: they allowed it, for everything it wants. */
  signedIn: boolean;
  pubkey?: string;
  /** The name the sign-in address knew them by, if any. */
  name?: string;
  /** When what they allowed stops, in seconds. */
  until?: number;
  /** True when they allowed this site before, but for less than it now wants: they have to be asked again. */
  needsMore?: boolean;
  /**
   * False when BitLogin will not show this permission set to a user at this
   * address (it names a kind reserved to another address, say): signing in
   * would give a note and a reaction and nothing the application asked
   * for. Known once `ready()` has resolved; absent from a signer too old
   * to say. Fall back, or say so, before opening the window.
   */
  canAsk?: boolean;
  /**
   * Whether BitLogin will offer the family asked for in `family` beside this application's set. False where it won't
   * (not this page's family, or one it doesn't know), and false where the signer is too old to say: then nothing is
   * offered. Absent where no family was asked for. Known once `ready()` has resolved.
   */
  familyTaken?: boolean;
  /**
   * True while this browser is signed in here as the family's guest account (with `pubkey`): not yet secured, and
   * not signed in to this application's set (`signedIn` stays false). Absent otherwise.
   */
  guest?: boolean;
}

export interface UnsignedEvent {
  kind: number;
  content: string;
  tags: string[][];
  created_at?: number;
}

export interface BitLoginClient {
  /** Resolves once the signer has loaded and said whether this site is already allowed. */
  ready(): Promise<BitLoginClientState>;
  state(): BitLoginClientState;
  /** Called whenever the state changes. Returns a function that stops it. */
  onChange(listener: (state: BitLoginClientState) => void): () => void;
  /**
   * Open the sign-in window. Call it from the user's own press, or the
   * browser blocks the window. Resolves true once they allowed the
   * application, false if they closed the window or said no.
   */
  signIn(): Promise<boolean>;
  /**
   * Open the sign-in window at its account chooser, so the user can carry
   * on here as another of the accounts kept on their device, or sign in as
   * one that is not. Call it from the user's own press. Resolves once the
   * window has closed: true if someone is signed in here then (the same
   * account or another: read `state()`), false if nobody is. The
   * application never sees the list of accounts, only the one chosen.
   */
  switchAccount(): Promise<boolean>;
  /** Sign out of this application: the signer forgets this site. */
  signOut(): Promise<void>;
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  nip44: { encrypt(peer: string, plaintext: string): Promise<string>; decrypt(peer: string, ciphertext: string): Promise<string> };
  nip04: { encrypt(peer: string, plaintext: string): Promise<string>; decrypt(peer: string, ciphertext: string): Promise<string> };
  /** The content of a whole signed event of a kind the application may read. */
  decryptEvent(event: NostrEvent): Promise<string>;
  /**
   * Put a careful kind to the user: a profile (0), a deletion (5) or a relay
   * list (10002) (§SW20). The application can't have these signed on its own
   * say. BitLogin's own page shows what it says, in words, and signs it only
   * on a press there. Call it from the user's own press. Resolves with the
   * signed event, checked to be exactly what was asked, or null: they said
   * no, nobody answered, or the application isn't signed in.
   */
  propose(event: UnsignedEvent, options?: AskOptions): Promise<NostrEvent | null>;
  /**
   * Ask to be paid: a Lightning invoice, paid from the user's own ecash
   * wallet if they press Pay on BitLogin's page (docs/ecash.md). The
   * application never sees the wallet. Call it from the user's own press.
   * Resolves with the proof of payment where the mint gave one (check it
   * against the invoice, or go by your own word from whoever made the
   * invoice), or null if it was not paid.
   */
  pay(invoice: string, options?: AskOptions): Promise<{ preimage?: string } | null>;
  /**
   * Ask for a tip to be sent (docs/paying.md): this many sats to a person,
   * by their key, or with no `to`, to this application's own address (the
   * `tip` in its `/.well-known/nswp.json`). The application names no
   * invoice: BitLogin's page finds the lightning address, shows who it is
   * for, and pays at a press. Resolves as `pay` does, or null.
   */
  tip(tip: { to?: string; sats: number }, options?: AskOptions): Promise<{ preimage?: string } | null>;
  /**
   * Ask to buy what a listing sells, by its coordinate. BitLogin's page
   * runs the purchase and keeps the receipt with the account. Resolves with
   * the receipt, checked here to be a known service's, for this listing and
   * this account, and with what the purchase delivers where it delivers
   * something; or null. Something already held is answered with its
   * receipt, and nothing is charged.
   */
  buy(listing: string, options?: AskOptions): Promise<{ receipt: NostrEvent; delivery?: string } | null>;
  /**
   * Whether the user holds a receipt for a listing of this application's
   * own. No question is put. Null where they hold none, or none this
   * application may be told of. Whether it was taken back since is the
   * selling service's to say: ask it.
   */
  have(listing: string): Promise<NostrEvent | null>;
  /** Remove the frame and stop listening. */
  destroy(): void;
}

export interface AskOptions {
  /**
   * Called once, when BitLogin has taken the question and its page must be
   * shown. Return true if the host showed it itself (a client that keeps the
   * screen, asking its shell for BitLogin's panel). Return false, or leave
   * this out, and the sign-in window is opened, as `signIn()` opens it.
   */
  show?: () => boolean | Promise<boolean>;
}

export class BitLoginRefused extends Error {
  constructor(what: string) {
    // The signer never says why (§SW5): locked, not allowed, over a limit and malformed all look the same.
    super(`BitLogin refused to ${what}. The application may not be allowed to, or the user may have signed out.`);
    this.name = "BitLoginRefused";
  }
}

const covers = (granted: AppPermissions | undefined, wanted: AppPermissions): boolean =>
  !!granted &&
  wanted.sign.every((k) => granted.sign.includes(k)) &&
  wanted.read.every((k) => granted.read.includes(k)) &&
  wanted.appData.every((p) => granted.appData.includes(p) || granted.appData.includes("*")) &&
  wanted.proofs.every((o) => granted.proofs.includes(o)) &&
  wanted.peers.every((k) => granted.peers.includes(k));

/** How long an older signer's silence about a family is waited for before it counts as "not offered". */
const FAMILY_WAIT_MS = 3000;

export function createBitLoginClient(options: BitLoginClientOptions): BitLoginClient {
  const at = cleanOrigin(options.at);
  if (!at) throw new Error("`at` must be the sign-in address's origin, such as https://bitlogin.network");
  const wanted = readPermissions(options.permissions);
  if (!wanted) throw new Error("`permissions` is not a permission set BitLogin will show a user. See docs/sign-in-window.md §SW9.2.");
  const timeoutMs = options.timeoutMs ?? 20_000;
  // A local copy of BitLogin, tried against a local selling service, may be told which. The real address never is.
  const tried = isLocalAddress(at) ? localService(options.localUnlockService) : null;
  const readReceipt = (event: unknown) => readReceiptOf(event, tried ? [...UNLOCK_SERVICES, tried] : UNLOCK_SERVICES);

  const frame = document.createElement("iframe");
  frame.src = `${at}/signer/`;
  frame.title = "BitLogin signer";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Out of sight, not `display: none`: some browsers do not load or run a frame that is not laid out.
  frame.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0;pointer-events:none";

  let current: BitLoginClientState = { signedIn: false };
  let raw: { unlocked: boolean; pubkey?: string } = { unlocked: false };
  /** Whether the signer said this set may be shown here. Undefined until it has, or where it is too old to. */
  let canAsk: boolean | undefined;
  /** Whether the signer took the family asked for. Undefined where none was asked. */
  let familyTaken: boolean | undefined;
  const family = typeof options.family === "string" ? options.family : undefined;
  const asGuest = family !== undefined && options.guest === true;
  const listeners = new Set<(state: BitLoginClientState) => void>();
  const waiting = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let stopped = false;

  const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

  const take = (d: Record<string, unknown>) => {
    const unlocked = d.unlocked === true && typeof d.pubkey === "string";
    if (typeof d.taken === "boolean") canAsk = d.taken;
    if (family !== undefined && typeof d.familyTaken === "boolean") familyTaken = d.familyTaken;
    const granted = unlocked ? (readPermissions(d.permissions) ?? undefined) : undefined;
    const enough = unlocked && covers(granted, wanted);
    raw = { unlocked, ...(unlocked ? { pubkey: d.pubkey as string } : {}) };
    const next: BitLoginClientState = {
      signedIn: enough,
      ...(enough ? { pubkey: d.pubkey as string } : {}),
      ...(enough && typeof d.name === "string" ? { name: d.name } : {}),
      ...(enough && typeof d.until === "number" ? { until: d.until } : {}),
      ...(unlocked && !enough ? { needsMore: true } : {}),
      ...(canAsk !== undefined ? { canAsk } : {}),
      ...(familyTaken !== undefined ? { familyTaken } : {}),
      // A guest is who they are here, for what a guest may do: not this application's set.
      ...(unlocked && d.guest === true ? { guest: true, pubkey: d.pubkey as string } : {})
    };
    const changed = JSON.stringify(next) !== JSON.stringify(current);
    current = next;
    if (changed) for (const listener of listeners) listener(current);
  };

  const onMessage = (e: MessageEvent) => {
    // Only the frame this made, at the address it was made for.
    if (e.source !== frame.contentWindow || e.origin !== at) return;
    const d = e.data as Record<string, unknown> | null;
    if (!d || typeof d !== "object" || d.nswp !== SIGNER_PROTOCOL || d.v !== PROTOCOL_VERSION) return;
    if (d.t === "ready") return void frameIsUp();
    if (d.t === "state") take(d);
    if (typeof d.id !== "string") return;
    const pending = waiting.get(d.id);
    if (!pending) return;
    waiting.delete(d.id);
    clearTimeout(pending.timer);
    pending.resolve(d);
  };

  const post = (message: Record<string, unknown>) => frame.contentWindow?.postMessage({ nswp: SIGNER_PROTOCOL, v: PROTOCOL_VERSION, ...message }, at);

  const request = (message: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(new Error("This BitLogin client was destroyed."));
      const id = newId();
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("BitLogin's signer did not answer."));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
      void frameUp.then(() => post({ ...message, id }));
    });

  /**
   * Nothing is said to the frame until the signer's own page is in it. Before
   * that the frame holds an empty page of another origin, and a message
   * addressed to the sign-in address is dropped without a word. A caller who
   * asks `ready()` straight away would wait for an answer that cannot come.
   */
  let frameIsUp: () => void = () => {};
  const frameUp = new Promise<void>((resolve) => {
    frameIsUp = resolve;
  });

  let introduced: Promise<BitLoginClientState> | null = null;
  /** Say what the application wants, and learn whether this site is already allowed. */
  const introduce = (): Promise<BitLoginClientState> =>
    (introduced ??= (async () => {
      await frameUp;
      // The family first, on its own, as a world asks for it. A signer too old to know the question says nothing:
      // after a short wait that is "not offered", and the application's own question goes on as before.
      if (family !== undefined) {
        const answered = await Promise.race([request({ t: "want", family, ...(asGuest ? { guest: true } : {}) }).then(() => true, () => false), new Promise<boolean>((done) => setTimeout(() => done(false), FAMILY_WAIT_MS))]);
        if (!answered || familyTaken === undefined) familyTaken = false;
      }
      await request({ t: "want", permissions: wanted });
      return current;
    })().catch((error: unknown) => {
      introduced = null;
      throw error;
    }));

  window.addEventListener("message", onMessage);
  // The signer says "ready" where the browser tells it which page embeds it. Where it does not, it says nothing
  // until asked, and the frame having loaded is the sign that it can be.
  frame.addEventListener("load", () => frameIsUp());
  (options.mount ?? document.body).append(frame);
  void introduce().catch(() => {});

  const text = async (message: Record<string, unknown>, what: string): Promise<string> => {
    const reply = await request(message);
    if (reply.t !== "text" || typeof reply.text !== "string") throw new BitLoginRefused(what);
    return reply.text;
  };
  const crypt = (scheme: "nip44" | "nip04") => ({
    encrypt: (peer: string, plaintext: string) => text({ t: "encrypt", peer, text: plaintext, scheme }, "encrypt that"),
    decrypt: (peer: string, ciphertext: string) => text({ t: "decrypt", peer, text: ciphertext, scheme }, "decrypt that")
  });

  return {
    ready: () => introduce(),
    state: () => current,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async signIn() {
      await introduce();
      // Without `noopener`: the window finds this page's frame through its link back to this page.
      const opened = window.open(`${at}/connect/`, "bitlogin-connect", "popup,width=480,height=760");
      if (!opened) return false;
      return new Promise<boolean>((resolve) => {
        const stop = onChangeOnce((state) => {
          if (!state.signedIn) return false;
          clearInterval(watch);
          resolve(true);
          return true;
        });
        const watch = setInterval(() => {
          if (!opened.closed) return;
          clearInterval(watch);
          // The window is gone. Ask once more: Allow closes it a moment before the signer says so.
          void request({ t: "state" })
            .catch(() => undefined)
            .then(() => {
              stop();
              resolve(current.signedIn);
            });
        }, 400);
      });
    },
    async switchAccount() {
      await introduce();
      const opened = window.open(`${at}/connect/#switch`, "bitlogin-connect", "popup,width=480,height=760");
      if (!opened) return false;
      return new Promise<boolean>((resolve) => {
        const watch = setInterval(() => {
          if (!opened.closed) return;
          clearInterval(watch);
          void request({ t: "state" })
            .catch(() => undefined)
            .then(() => resolve(current.signedIn));
        }, 400);
      });
    },
    async signOut() {
      await request({ t: "lock" });
    },
    async propose(event, options) {
      if (!ASKED_KINDS.includes(event.kind)) return null;
      const reply = await askThePerson({ t: "propose", event: { kind: event.kind, content: event.content, tags: event.tags } }, options);
      const signed = reply?.event;
      if (reply?.t !== "signed" || !verifyNostrEvent(signed)) return null;
      // Believed only as far as its signature goes, and only if it is what was asked: BitLogin's mark aside.
      const unmarked = (tags: string[][]) => JSON.stringify(tags.filter((tag) => tag[0] !== SITE_TAG));
      if (signed.pubkey !== raw.pubkey || signed.kind !== event.kind || signed.content !== event.content || unmarked(signed.tags) !== unmarked(event.tags)) return null;
      return signed;
    },
    async pay(invoice, options) {
      const clean = cleanInvoice(invoice);
      if (!clean) return null;
      const reply = await askThePerson({ t: "pay", invoice: clean }, options);
      if (reply?.t !== "paid") return null;
      return typeof reply.preimage === "string" && /^[0-9a-f]{64}$/u.test(reply.preimage) ? { preimage: reply.preimage } : {};
    },
    async tip(tip, options) {
      const sats = cleanSats(tip.sats);
      if (!sats || (tip.to !== undefined && !/^[0-9a-f]{64}$/u.test(tip.to))) return null;
      const reply = await askThePerson({ t: "tip", sats, ...(tip.to ? { to: tip.to } : {}) }, options);
      if (reply?.t !== "paid") return null;
      return typeof reply.preimage === "string" && /^[0-9a-f]{64}$/u.test(reply.preimage) ? { preimage: reply.preimage } : {};
    },
    async buy(listing, options) {
      const coordinate = cleanCoordinate(listing);
      // Not yet open at every sign-in address (permissions.ts): there, nothing is asked and nothing is bought.
      if (!coordinate || !buyingOpenAt(at)) return null;
      const reply = await askThePerson({ t: "buy", listing: coordinate }, options);
      // Believed only as far as the receipt goes: a known service signed it, for this listing and this account.
      const receipt = reply?.t === "bought" ? readReceipt(reply.receipt) : null;
      if (!receiptGood(receipt, { buyer: raw.pubkey ?? "", listing: coordinate, now: Date.now() / 1000 })) return null;
      return { receipt: receipt!.event, ...(typeof reply!.delivery === "string" ? { delivery: reply!.delivery as string } : {}) };
    },
    async have(listing) {
      const coordinate = cleanCoordinate(listing);
      if (!coordinate) return null;
      const reply = await request({ t: "have", listing: coordinate }).catch(() => null);
      const receipt = reply?.t === "receipt" ? readReceipt(reply.receipt) : null;
      return receiptGood(receipt, { buyer: raw.pubkey ?? "", listing: coordinate, now: Date.now() / 1000 }) ? receipt!.event : null;
    },
    async getPublicKey() {
      if (!current.signedIn || !current.pubkey) throw new BitLoginRefused("say who is signed in");
      return current.pubkey;
    },
    async signEvent(event) {
      const reply = await request({ t: "sign", event });
      const signed = reply.event;
      // A signer is believed only as far as its signature goes.
      if (reply.t !== "signed" || !verifyNostrEvent(signed)) throw new BitLoginRefused("sign that");
      if (signed.pubkey !== raw.pubkey || signed.kind !== event.kind || signed.content !== event.content) throw new BitLoginRefused("sign that");
      return signed;
    },
    nip44: crypt("nip44"),
    nip04: crypt("nip04"),
    decryptEvent: (event) => text({ t: "read", event }, "read that"),
    destroy() {
      stopped = true;
      window.removeEventListener("message", onMessage);
      for (const pending of waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("This BitLogin client was destroyed."));
      }
      waiting.clear();
      listeners.clear();
      frame.remove();
    }
  };

  /**
   * Put something to the person (§SW20): send it, and once the signer says
   * "asking", have BitLogin's page shown and wait for the answer under the
   * same id. Null for every way it can end without one.
   */
  async function askThePerson(message: Record<string, unknown>, options?: AskOptions): Promise<Record<string, unknown> | null> {
    if (!raw.unlocked) return null;
    await introduce();
    const id = newId();
    const answer = (waitMs: number) =>
      new Promise<Record<string, unknown> | null>((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(id);
          resolve(null);
        }, waitMs);
        waiting.set(id, { resolve, reject: () => resolve(null), timer });
      });
    const first = answer(8000);
    post({ ...message, id });
    if ((await first)?.t !== "asking") return null;
    // The answer comes later, under the same id, once they have answered on BitLogin's page.
    const second = answer(ASK_WAIT_MS + 10_000);
    let shown = false;
    try {
      shown = (await options?.show?.()) === true;
    } catch {
      shown = false;
    }
    // Without `noopener`, as for signing in: the window finds this page's frame through its link back to this page.
    if (!shown && !window.open(`${at}/connect/`, "bitlogin-connect", "popup,width=480,height=760")) {
      const pending = waiting.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        waiting.delete(id);
      }
      return null;
    }
    return second;
  }

  /** Listen until `listener` returns true. */
  function onChangeOnce(listener: (state: BitLoginClientState) => boolean): () => void {
    const wrapped = (state: BitLoginClientState) => {
      if (listener(state)) listeners.delete(wrapped);
    };
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  }
}
