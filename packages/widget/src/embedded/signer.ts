/**
 * BitLogin's embedded signer (docs/sign-in-window.md §SW2, §SW5): the whole
 * of a page with no interface, embedded unseen in a site that asks.
 *
 *   <script type="module">
 *     import { startEmbeddedSigner } from "./vendor/bitlogin/bitlogin-signer.js";
 *     startEmbeddedSigner();
 *   </script>
 *
 * A site asks it to sign. It answers with the signed event, or with a refusal
 * that says nothing. It never hands out a key, and nothing is typed into it.
 *
 * It is locked in a site until BitLogin's own window (embedded/window.ts),
 * where the user pressed Allow, hands it a key that can only sign. It then
 * remembers that site, so they are not asked again each time its page is
 * loaded: for thirty days, or until they sign out of the site (§SW11).
 *
 * It never restores this origin's own session, even where a browser would
 * let it: what it takes up is only what it kept for the site it is in, and
 * a site that shares a registrable domain with the sign-in address is
 * treated like any other.
 *
 * Who is asking is what the browser says, never what the site says.
 */
import { createHeadlessSigner, type HeadlessSigner } from "../headless.js";
import {
  cleanOrigin,
  createSignGate,
  handoffMessage,
  prepareForSite,
  readHandoffMessage,
  readSignerRequest,
  SIGN_LIMITS,
  signerMessage,
  type HandoffMessage,
  type SignGate,
  type SignerReply
} from "./policy.js";

export interface EmbeddedSignerHandle {
  /** Whether it is running embedded. False when the page was opened on its own: then it does nothing. */
  readonly embedded: boolean;
  stop(): void;
}

export function startEmbeddedSigner(): EmbeddedSignerHandle {
  if (typeof window === "undefined" || window.parent === window) return { embedded: false, stop() {} };
  const me = location.origin;
  /** The site this page is embedded in: the browser's word for it. */
  let site = cleanOrigin((location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0] ?? "");
  let headless: HeadlessSigner | null = null;
  let pubkey: string | null = null;
  let name: string | null = null;
  /** When what the user allowed stops, in seconds. */
  let until = 0;
  let gate: SignGate = createSignGate();
  /** The hand-off in flight: the window that asked, and the word it gave. */
  let asking: { nonce: string; from: MessageEventSource } | null = null;

  // Never restore(): this origin's own session is not the asking site's to use.
  const load = async (): Promise<HeadlessSigner> => (headless ??= await createHeadlessSigner());
  /** Lock: the site is forgotten, and the key goes with the worker that held it. */
  const lock = () => {
    const held = headless;
    const forSite = site;
    headless = null;
    pubkey = null;
    name = null;
    until = 0;
    if (held) void (forSite ? held.forgetSignerGrant(forSite) : Promise.resolve()).catch(() => {}).finally(() => held.destroy());
  };
  /**
   * Take up what was kept for this site, once, as soon as it is known which
   * site this is. Everything a site asks waits for it, so a page loaded
   * again is answered "unlocked" from the first question.
   */
  let remembering: Promise<void> | null = null;
  const remember = (): Promise<void> =>
    (remembering ??= (async () => {
      if (!site) return;
      try {
        const kept = await (await load()).restoreSignerGrant(site);
        if (!kept) return;
        pubkey = kept.pubkey;
        name = kept.name ?? null;
        until = kept.until;
        gate = createSignGate(SIGN_LIMITS, kept.signed);
      } catch {
        /* nothing kept, or no storage here: the user is asked, as before */
      }
    })());
  const say = (reply: SignerReply) => {
    if (site) window.parent.postMessage(signerMessage(reply), site);
  };
  const state = (id?: string): SignerReply => {
    if (pubkey && Date.now() / 1000 >= until) lock();
    return { t: "state", ...(id ? { id } : {}), unlocked: !!pubkey, ...(pubkey ? { pubkey, until } : {}), ...(pubkey && name ? { name } : {}) };
  };

  const fromSite = async (e: MessageEvent) => {
    const from = cleanOrigin(e.origin);
    if (!from) return;
    // The first page to speak from outside is the one this is embedded in. Nothing else is listened to after.
    site ||= from;
    if (from !== site) return;
    const ask = readSignerRequest(e.data);
    if (!ask) return;
    await remember();
    if (ask.t === "state") return say(state(ask.id));
    if (ask.t === "lock") {
      lock();
      return say(state(ask.id));
    }
    // "sign". Every way this can fail says the same thing: refused.
    const refuse = () => say({ t: "refused", id: ask.id });
    if (pubkey && Date.now() / 1000 >= until) lock();
    if (!headless || !pubkey) return refuse();
    const prepared = prepareForSite(ask.event, site, Date.now() / 1000);
    if (!prepared || !gate.take(Date.now())) return refuse();
    try {
      const signed = await headless.signEvent(prepared);
      if (signed.pubkey !== pubkey) return refuse();
      say({ t: "signed", id: ask.id, event: signed });
      // Counted where loading the page again can't lose the count.
      void headless.touchSignerGrant(site, gate.times()).catch(() => {});
    } catch {
      refuse();
    }
  };

  const fromWindow = async (e: MessageEvent) => {
    const msg = readHandoffMessage(e.data);
    if (!msg || !e.source) return;
    const back = (m: HandoffMessage) => (e.source as Window).postMessage(handoffMessage(m), me);
    if (msg.t === "hello") {
      // Not yet known which site this is in (it hasn't spoken): the window is left to ask again.
      if (!site) return;
      await remember();
      try {
        const recipient = await (await load()).beginHandoff();
        asking = { nonce: msg.nonce, from: e.source };
        back({ t: "frame", nonce: msg.nonce, world: site, recipient });
      } catch {
        /* no worker: the window finds no signer, and offers nothing */
      }
      return;
    }
    if (msg.t !== "grant") return;
    // Only from the window that said hello, with the word it gave, and for the site this is really in.
    if (!asking || asking.nonce !== msg.nonce || asking.from !== e.source || msg.world !== site) return;
    asking = null;
    try {
      const signer = await load();
      const got = await signer.acceptHandoff(msg.sealed);
      pubkey = got.pubkey;
      name = msg.name ?? null;
      until = Math.floor(Date.now() / 1000) + SIGN_LIMITS.grantSec;
      gate = createSignGate();
      // Remembered for this site, so the user is not asked again when its page is next loaded. Where it can't be
      // kept (a browser that gives an embedded page no storage), it lasts as long as the page does.
      await signer.keepSignerGrant({ site, until, ...(name ? { name } : {}) }).catch(() => false);
      back({ t: "done", nonce: msg.nonce, ok: true });
    } catch {
      lock();
      back({ t: "done", nonce: msg.nonce, ok: false });
    }
    say(state());
  };

  const onMessage = (e: MessageEvent) => {
    if (e.source === window.parent) return void fromSite(e);
    // Anything else must be a page of this origin. The browser vouches for where a message came from.
    if (e.origin === me && e.source !== window) void fromWindow(e);
  };
  window.addEventListener("message", onMessage);
  // Said to the page that embeds this, where the browser says which page that is: it is here. Nothing is ever sent
  // to an address this doesn't know. Where the browser doesn't say (no ancestorOrigins), nothing is said: the site
  // asks "state" once the frame has loaded, and the answer goes to the address that question came from.
  if (site) {
    window.parent.postMessage(signerMessage({ t: "ready" }), site);
    // And if this site was allowed before, it is told so without having to ask.
    void remember().then(() => {
      if (pubkey) say(state());
    });
  }
  return {
    embedded: true,
    stop() {
      window.removeEventListener("message", onMessage);
      lock();
    }
  };
}
