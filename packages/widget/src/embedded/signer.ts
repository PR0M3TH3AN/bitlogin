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
 *
 * A site may also be signed in by its family's grant (docs/site-family.md),
 * where the user allowed every site under one domain. Which family a site is
 * in is worked out here, from the address the browser gave, by the Public
 * Suffix List: never by the site, and never by the window.
 */
import { createHeadlessSigner, type HeadlessSigner } from "../headless.js";
import { knownFamily } from "./family.js";
import { familyOf } from "./publicSuffix.js";
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
import { WORLD_MORE, type WorldMore } from "./follows.js";

export interface EmbeddedSignerHandle {
  /** Whether it is running embedded. False when the page was opened on its own: then it does nothing. */
  readonly embedded: boolean;
  stop(): void;
}

export interface EmbeddedSignerOptions {
  /** Relays other than BitLogin's own list. The live page names none. */
  vaultRelays?: string[];
  discoveryRelays?: string[];
}

export function startEmbeddedSigner(options: EmbeddedSignerOptions = {}): EmbeddedSignerHandle {
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
  /** The site asked for a set it may not hold at this address. The window says so, so the user is not shown the
   *  plain question with no word that more was asked. */
  let turnedDown = false;
  /** What a world was let do beyond a note and a reaction, and what it has asked to be, by name (follows.ts). */
  let more: WorldMore[] = [];
  let wantedMore: WorldMore[] = [];
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
  const load = async (): Promise<HeadlessSigner> => (headless ??= await createHeadlessSigner(options));
  /** No longer unlocked, with nothing forgotten: the grant is gone already (taken back), or is to be kept (too
   *  long unchecked, and no relay answered). */
  const drop = () => {
    const held = headless;
    headless = null;
    pubkey = null;
    name = null;
    profile = null;
    until = 0;
    remembered = false;
    app = null;
    held?.destroy();
  };
  /**
   * Ask the user's relays whether this site was taken back (docs/take-back.md). The worker asks at most once a
   * day, and says what it found. Taken back, or too long unchecked with no relay answering: this stops signing,
   * and the site is told only that it is locked.
   */
  const checkTakenBack = async (): Promise<void> => {
    const held = headless;
    if (!held || !pubkey || !remembered || !site) return;
    const found = await held.checkTakenBack(site).catch(() => "ok" as const);
    if (found === "ok" || headless !== held) return;
    drop();
    say(state());
  };
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
    more = [];
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
        const kept = await (await load()).restoreSignerGrant(site, familyOf(site) || undefined);
        if (!kept) return;
        pubkey = kept.pubkey;
        name = kept.name ?? null;
        profile = kept.profile ?? null;
        until = kept.until;
        remembered = true;
        app = kept.permissions ?? null;
        more = app ? [] : (kept.more ?? []);
        if (app) gates = appGates(kept.signed, kept.signedSensitive);
        else gate = createSignGate(SIGN_LIMITS, kept.signed);
        // Too long unchecked: the answer waits for the check. Otherwise the check is made behind the answer.
        if (kept.check === "overdue") await checkTakenBack();
        else if (kept.check === "due") void checkTakenBack();
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
      ...(pubkey && app ? { permissions: app } : {}),
      // A world is told what more it was let do, so it asks for nothing that isn't there.
      ...(pubkey && !app && more.length ? { more } : {}),
      // What can be asked for here at all, said locked or unlocked. Not to an application: it is held to its set.
      ...(!app ? { offers: [...WORLD_MORE] } : {})
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
    if (ask.t === "wantMore") {
      // Remembered for the window to show, in BitLogin's own words. It approves nothing.
      wantedMore = ask.more;
      return say(state(ask.id));
    }
    if (ask.t === "want") {
      // Remembered for the window to show. It approves nothing: only Allow, in the window, does. A set this site
      // may not hold at all (a kind reserved to another address) is not remembered, so the window never shows it.
      const taken = mayHold(site, ask.permissions);
      wanted = taken ? ask.permissions : null;
      turnedDown = !taken;
      // The site is told whether the set can be shown at all, so it need not open the window to find out.
      return say({ ...(state(ask.id) as Extract<SignerReply, { t: "state" }>), taken });
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

    if (ask.t === "save" || ask.t === "find" || ask.t === "open") {
      // What a world keeps for its visitor (NSWP-12). Not for an application. The worker does all of it, for the
      // site the hand-off was sealed for: where a save is kept, what is in it and the count are never the site's.
      if (app) return refuse();
      try {
        if (ask.t === "find") return say({ t: "found", id: ask.id, d: await headless.worldFind(ask.slot) });
        if (ask.t === "open") return say({ t: "opened", id: ask.id, ...(await headless.worldOpen(ask.event)) });
        const save = await headless.worldSave(ask.slot, ask.data);
        if (save.pubkey !== pubkey) return refuse();
        return say({ t: "signed", id: ask.id, event: save });
      } catch {
        return refuse();
      }
    }

    if (ask.t === "follow") {
      // Only a world the user let change who they follow, by name, in the window. The worker checks the list is
      // theirs, looks at their relays itself, makes the one change and counts it.
      if (app || !more.includes("follows")) return refuse();
      try {
        const list = await headless.worldFollow(ask.list, ask.add ? { add: ask.add } : { remove: ask.remove! });
        if (list.pubkey !== pubkey) return refuse();
        return say({ t: "signed", id: ask.id, event: list });
      } catch {
        return refuse();
      }
    }

    if (ask.t === "score" || ask.t === "achieve") {
      // For any world its visitor allowed, and not for an application. Built whole in the worker, for the site the
      // hand-off was sealed for.
      if (app) return refuse();
      try {
        const score = ask.t === "score" ? await headless.worldScore(ask.world, ask.board, ask.score, { ...(ask.title ? { title: ask.title } : {}), ...(ask.format ? { format: ask.format } : {}) }) : await headless.worldAchieve(ask.world, ask.achievement, ask.title);
        if (score.pubkey !== pubkey) return refuse();
        return say({ t: "signed", id: ask.id, event: score });
      } catch {
        return refuse();
      }
    }

    if (ask.t === "seal" || ask.t === "unwrap" || ask.t === "reach") {
      // Only a world the user let send and read their private messages, by name, in the window.
      if (app || !more.includes("messages")) return refuse();
      try {
        if (ask.t === "unwrap") return say({ t: "message", id: ask.id, message: await headless.worldUnwrap(ask.event) });
        if (ask.t === "reach") {
          const list = await headless.worldReach(ask.relays);
          if (list.pubkey !== pubkey) return refuse();
          return say({ t: "signed", id: ask.id, event: list });
        }
        const sealed = await headless.worldSeal(ask.to, ask.text);
        if (sealed.message.pubkey !== pubkey || sealed.seals.some((seal) => seal.pubkey !== pubkey)) return refuse();
        return say({ t: "sealed", id: ask.id, message: sealed.message, seals: sealed.seals });
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
        back({ t: "frame", nonce: msg.nonce, world: site, recipient, ...(wanted ? { wants: wanted } : {}), ...(turnedDown ? { turnedDown: true } : {}), ...(!wanted && wantedMore.length ? { more: wantedMore } : {}), ...(!wanted && pubkey && !app && more.length ? { has: more } : {}) });
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
      // A hand-off for a family is for this site's own family, as this page works it out, and no other.
      if (got.family && got.family !== familyOf(site)) throw new Error("for another family");
      profile = got.profile ?? null;
      app = got.app?.permissions ?? null;
      more = app || got.family ? [] : (got.more ?? []);
      gates = appGates();
      pubkey = got.pubkey;
      name = msg.name ?? null;
      gate = createSignGate();
      passGate = createSignGate(passLimits);
      // A site the user left "remember" ticked for is kept, so they are not asked again when its page is next
      // loaded: thirty days for one BitLogin knows, seven for any other. A site they unticked it for is allowed
      // for this visit: it lasts as long as the page does, and nothing is written down. So does one that can't
      // be kept (a browser that gives an embedded page no storage), and every site while the lock is on.
      // A family is kept by the family's own name: thirty days for one BitLogin knows, seven for any other.
      const known = got.family ? knownFamily(got.family) : knownAppName(site) !== null;
      // A site let read private messages is asked again after seven days, however well BitLogin knows it: what
      // was read can't be unread, so the say is not left standing for a month.
      const longest = known && !more.includes("messages") ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec;
      until = Math.floor(Date.now() / 1000) + (got.remember ? longest : SIGN_LIMITS.visitSec);
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
  // While the page stays open, the worker is asked hourly whether a check is due. It is, once a day.
  const watch = setInterval(() => void checkTakenBack(), 3_600_000);
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
      clearInterval(watch);
      window.removeEventListener("message", onMessage);
      lock();
    }
  };
}
