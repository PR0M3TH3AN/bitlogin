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
import { APP_LIMITS, knownAppName, limitClass, mayHold, prepareForApp, type AppPermissions } from "./permissions.js";
import type { Profile } from "./profile.js";
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
  /** Their own signed profile, as BitLogin's worker read it out of the sealed hand-off or the kept grant (§SW16). */
  let profile: Profile | null = null;
  /** When what the user allowed stops, in seconds. */
  let until = 0;
  /** Whether this site is kept across page loads, or allowed for this visit only (§SW11). */
  let remembered = false;
  let gate: SignGate = createSignGate();
  /** Room passes, counted apart from notes (§SW16). */
  const passLimits = { burst: SIGN_LIMITS.passBurst, perMs: SIGN_LIMITS.perMs, hourly: SIGN_LIMITS.passHourly };
  let passGate: SignGate = createSignGate(passLimits);
  /** What an application was approved for (§SW9), as BitLogin's worker read it out of the sealed hand-off or the
   *  grant kept from one. Null for a site that declared nothing: a note and a reaction, as §SW5 has it. */
  let app: AppPermissions | null = null;
  /** What the site has said it wants, for the window to show the next time it is opened. Approves nothing. */
  let wanted: AppPermissions | null = null;
  /** An application's counts, apart from a world's (§SW9.6). Only the public and the sensitive are kept across
   *  page loads: they are what a reload could be used to get round. */
  let gates = { quiet: createSignGate(APP_LIMITS.quiet), public: createSignGate(APP_LIMITS.public), sensitive: createSignGate(APP_LIMITS.sensitive), read: createSignGate(APP_LIMITS.read) };
  const appGates = (signedPublic: number[] = [], signedSensitive: number[] = []) => ({
    quiet: createSignGate(APP_LIMITS.quiet),
    public: createSignGate(APP_LIMITS.public, signedPublic),
    sensitive: createSignGate(APP_LIMITS.sensitive, signedSensitive),
    read: createSignGate(APP_LIMITS.read)
  });
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
    profile = null;
    until = 0;
    remembered = false;
    app = null;
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
        profile = kept.profile ?? null;
        until = kept.until;
        remembered = true;
        app = kept.permissions ?? null;
        if (app) gates = appGates(kept.signed, kept.signedSensitive);
        else gate = createSignGate(SIGN_LIMITS, kept.signed);
        passGate = createSignGate(passLimits, kept.signedPass);
      } catch {
        /* nothing kept, or no storage here: the user is asked, as before */
      }
    })());
  const say = (reply: SignerReply) => {
    if (site) window.parent.postMessage(signerMessage(reply), site);
  };
  const state = (id?: string): SignerReply => {
    if (pubkey && Date.now() / 1000 >= until) lock();
    return {
      t: "state",
      ...(id ? { id } : {}),
      unlocked: !!pubkey,
      ...(pubkey ? { pubkey, until, remembered } : {}),
      // The name in their own signed profile, where they have one; else the name the sign-in address knew them by.
      ...(pubkey && (profile?.name || name) ? { name: profile?.name || name! } : {}),
      ...(pubkey && profile?.picture ? { picture: profile.picture } : {}),
      ...(pubkey && profile?.about ? { about: profile.about } : {}),
      // An application is told what it was approved for, so it can tell that from what it now wants.
      ...(pubkey && app ? { permissions: app } : {})
    };
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
    if (ask.t === "want") {
      // Remembered for the window to show. It approves nothing: only Allow, in the window, does. A set this site
      // may not hold at all (a kind reserved to another address) is not remembered, so the window never shows it.
      wanted = mayHold(site, ask.permissions) ? ask.permissions : null;
      return say(state(ask.id));
    }
    // Everything else is asked of an unlocked signer. Every way it can fail says the same thing: refused.
    const refuse = () => say({ t: "refused", id: ask.id });
    if (pubkey && Date.now() / 1000 >= until) lock();
    if (!headless || !pubkey) return refuse();

    if (ask.t === "encrypt" || ask.t === "decrypt" || ask.t === "read") {
      // Only an application the user approved may ask, and BitLogin's worker holds it to what they approved.
      if (!app || (ask.t !== "encrypt" && !gates.read.take(Date.now()))) return refuse();
      try {
        const text =
          ask.t === "read"
            ? await headless.appDecryptEvent(ask.event)
            : ask.t === "encrypt"
              ? await headless.appEncrypt(ask.peer, ask.text, ask.scheme)
              : await headless.appDecrypt(ask.peer, ask.text, ask.scheme);
        return say({ t: "text", id: ask.id, text });
      } catch {
        return refuse();
      }
    }

    if (ask.t === "pass") {
      // Not for an application: it is held to the set the user read. Counted apart from notes, so that signing
      // in does not use up a post. The worker builds all of it, for the site the hand-off was sealed for.
      if (app || ask.session === pubkey || !passGate.take(Date.now())) return refuse();
      try {
        const pass = await headless.roomPass(ask.session);
        if (pass.pubkey !== pubkey) return refuse();
        say({ t: "signed", id: ask.id, event: pass });
        void headless.touchSignerGrant(site, gate.times(), undefined, passGate.times()).catch(() => {});
      } catch {
        refuse();
      }
      return;
    }

    // "sign".
    const now = Date.now();
    const prepared = app ? prepareForApp(app, ask.event, site, now / 1000) : prepareForSite(ask.event, site, now / 1000);
    if (!prepared) return refuse();
    const counted = app ? limitClass(prepared.kind) : null;
    if (!(counted ? gates[counted] : gate).take(now)) return refuse();
    try {
      const signed = await headless.signEvent(prepared);
      if (signed.pubkey !== pubkey) return refuse();
      say({ t: "signed", id: ask.id, event: signed });
      // Counted where loading the page again can't lose the count. What an application signs on timers is not
      // written down each time: that count starts again with the page, and is generous either way.
      if (!counted) void headless.touchSignerGrant(site, gate.times()).catch(() => {});
      else if (counted !== "quiet") void headless.touchSignerGrant(site, gates.public.times(), gates.sensitive.times()).catch(() => {});
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
        back({ t: "frame", nonce: msg.nonce, world: site, recipient, ...(wanted ? { wants: wanted } : {}) });
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
      // A hand-off sealed for an application names the site it was approved for. For another site it is refused.
      if ((got.app && got.app.site !== site) || (got.site && got.site !== site)) throw new Error("for another site");
      profile = got.profile ?? null;
      app = got.app?.permissions ?? null;
      gates = appGates();
      pubkey = got.pubkey;
      name = msg.name ?? null;
      gate = createSignGate();
      passGate = createSignGate(passLimits);
      // A site the user left "remember" ticked for is kept, so they are not asked again when its page is next
      // loaded: thirty days for one BitLogin knows, seven for any other. A site they unticked it for is allowed
      // for this visit: it lasts as long as the page does, and nothing is written down. So does one that can't
      // be kept (a browser that gives an embedded page no storage), and every site while the lock is on.
      until = Math.floor(Date.now() / 1000) + (got.remember ? (knownAppName(site) !== null ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec) : SIGN_LIMITS.visitSec);
      remembered = got.remember === true && (await signer.keepSignerGrant({ site, until, ...(name ? { name } : {}) }).catch(() => false));
      if (!remembered) until = Math.min(until, Math.floor(Date.now() / 1000) + SIGN_LIMITS.visitSec);
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
