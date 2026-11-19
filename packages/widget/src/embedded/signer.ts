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
 * It starts locked in every site, and stays locked until BitLogin's own
 * window (embedded/window.ts), where the user pressed Allow, hands it a key
 * that can only sign. It never restores what this browser keeps for this
 * origin, even where a browser would let it: a site that shares a
 * registrable domain with the sign-in address is treated like any other.
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

  // Never restore(): what this browser keeps for this origin is not the asking site's to use.
  const load = async (): Promise<HeadlessSigner> => (headless ??= await createHeadlessSigner());
  /** Lock: the key goes with the worker that held it. Nothing was stored, so there is nothing to clear. */
  const lock = () => {
    headless?.destroy();
    headless = null;
    pubkey = null;
    name = null;
    until = 0;
  };
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
      const got = await (await load()).acceptHandoff(msg.sealed);
      pubkey = got.pubkey;
      name = msg.name ?? null;
      until = Math.floor(Date.now() / 1000) + SIGN_LIMITS.grantSec;
      gate = createSignGate();
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
  // Said to whoever embeds this: it is here. It says nothing else, and the site's address isn't known yet in every browser.
  window.parent.postMessage(signerMessage({ t: "ready" }), "*");
  return {
    embedded: true,
    stop() {
      window.removeEventListener("message", onMessage);
      lock();
    }
  };
}
