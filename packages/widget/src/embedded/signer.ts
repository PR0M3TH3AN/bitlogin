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
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { isListAsked } from "./guests.js";
import { bestReceipt, localService, readReceipt, receiptGood, UNLOCK_SERVICES, type Receipt, type UnlockService } from "../pay/listing.js";
import { createHeadlessSigner, type HeadlessSigner } from "../headless.js";
import { knownFamily } from "./family.js";
import { deviceLabel, PAIRING_PAUSED, pairUrl } from "./pair.js";
import { FROM_PHONE } from "./deviceGrant.js";
import { familyOf } from "./publicSuffix.js";
import { APP_LIMITS, buyingOpenAt, isLocalAddress, knownAppName, limitClass, mayHold, prepareForApp, type AppPermissions } from "./permissions.js";
import type { Profile } from "./profile.js";
import {
  ASK_LIMITS,
  ASK_WAIT_MS,
  cleanOrigin,
  cleanWalletUri,
  heldReceipts,
  prepareAsked,
  type Asked,
  createSignGate,
  handoffMessage,
  passAllowed,
  prepareForGuest,
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

/** A world owner changing who may come in: ten changes a minute and sixty an hour for one world, each asked on BitLogin's page. */
const GUEST_LIMITS = { burst: 10, perMs: 60_000, hourly: 60 } as const;

export function startEmbeddedSigner(options: EmbeddedSignerOptions = {}): EmbeddedSignerHandle {
  if (typeof window === "undefined" || window.parent === window) return { embedded: false, stop() {} };
  const me = location.origin;
  /** The site this page is embedded in: the browser's word for it. */
  let site = cleanOrigin((location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins?.[0] ?? "");
  let headless: HeadlessSigner | null = null;
  let pubkey: string | null = null;
  /**
   * Way 2: this headset holds a key of its own, D, never the account's. `pubkey` is the account; D signs passes, with
   * the account's grant beside them, and everything else is the phone's.
   */
  let deviceGrant: NostrEvent | null = null;
  let devicePub: string | null = null;
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
  /** The world asked for its own family, one BitLogin knows (site-family.md SF4a): the window offers it. */
  let familyAsked = false;
  /** An application's counts, apart from a world's (§SW9.6). Only the public and the sensitive are kept across
   *  page loads: they are what a reload could be used to get round. */
  let gates = { quiet: createSignGate(APP_LIMITS.quiet), public: createSignGate(APP_LIMITS.public), sensitive: createSignGate(APP_LIMITS.sensitive), read: createSignGate(APP_LIMITS.read) };
  const appGates = (signedPublic: number[] = [], signedSensitive: number[] = []) => ({
    quiet: createSignGate(APP_LIMITS.quiet),
    public: createSignGate(APP_LIMITS.public, signedPublic),
    sensitive: createSignGate(APP_LIMITS.sensitive, signedSensitive),
    read: createSignGate(APP_LIMITS.read)
  });
  /**
   * What the site has put to the person, and is waiting on (§SW20): one thing at a time. This page signs none of
   * it and shows none of it. BitLogin's panel or window shows it, and brings back the answer.
   */
  let pending: { id: string; ask: Asked; timer: ReturnType<typeof setTimeout> } | null = null;
  /** Counted apart: asking for a wallet does not use up a question about a profile, nor the other way round. */
  const askGates: Record<Asked["what"], SignGate> = { sign: createSignGate(ASK_LIMITS), wallet: createSignGate(ASK_LIMITS), pay: createSignGate(ASK_LIMITS), tip: createSignGate(ASK_LIMITS), buy: createSignGate(ASK_LIMITS), guests: createSignGate(GUEST_LIMITS), save: createSignGate(ASK_LIMITS), pick: createSignGate(ASK_LIMITS) };
  /** The question is over, unanswered: the site is told "refused", like every other no. */
  const dropPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    const { id } = pending;
    pending = null;
    if (site) window.parent.postMessage(signerMessage({ t: "refused", id }), site);
  };
  /** The hand-off in flight: the window that asked, and the word it gave. */
  let asking: { nonce: string; from: MessageEventSource } | null = null;
  /** The last window or panel of BitLogin's that said hello: the one that may hand over the person's receipts. */
  let lastWindow: { nonce: string; from: MessageEventSource } | null = null;

  /**
   * The person's receipts for this site's own listings (docs/paying.md), as BitLogin's page handed them over: what
   * `have` is answered from. This page can reach no selling service, so it holds only what it was given, and
   * believes each only as far as its signature goes. Kept across page loads where the site is,
   * through the worker, beside its grant.
   */
  const local = isLocalAddress(me) ? localService(document.documentElement.dataset.unlockService) : null;
  const services: readonly UnlockService[] = local ? [...UNLOCK_SERVICES, local] : UNLOCK_SERVICES;
  let held: NostrEvent[] = [];
  /** Kept by the worker, beside the site's grant, and only where the site itself is kept: never for one visit. */
  const keepHeld = () => {
    if (remembered && pubkey && site) void headless?.holdReceipts(site, held).catch(() => {});
  };
  const takeUpHeld = async () => {
    held = [];
    if (!pubkey || !site || !headless) return;
    held = heldReceipts(await headless.heldReceipts(site).catch(() => []), pubkey, services);
  };
  /** Let go here. What the worker kept goes when the site is forgotten, with its grant. */
  const forgetHeld = () => {
    held = [];
  };
  const heldFor = (listing: string): Receipt | null =>
    pubkey ? bestReceipt(held.map((event) => readReceipt(event, services)).filter((r): r is Receipt => !!r), { buyer: pubkey, listing, now: Date.now() / 1000 }) : null;

  // Never restore(): this origin's own session is not the asking site's to use.
  const load = async (): Promise<HeadlessSigner> => (headless ??= await createHeadlessSigner(options));
  /** No longer unlocked, with nothing forgotten: the grant is gone already (taken back), or is to be kept (too
   *  long unchecked, and no relay answered). */
  const drop = () => {
    dropPending();
    const was = headless;
    headless = null;
    pubkey = null;
    name = null;
    profile = null;
    until = 0;
    remembered = false;
    app = null;
    held = [];
    deviceGrant = null;
    devicePub = null;
    was?.destroy();
  };
  /**
   * Ask the user's relays whether this site was taken back (docs/take-back.md). The worker asks at most once a
   * day, and says what it found. Taken back, or too long unchecked with no relay answering: this stops signing,
   * and the site is told only that it is locked.
   */
  const checkTakenBack = async (): Promise<void> => {
    const was = headless;
    if (!was || !pubkey || !remembered || !site) return;
    const found = await was.checkTakenBack(site).catch(() => "ok" as const);
    if (found === "ok" || headless !== was) return;
    drop();
    say(state());
  };
  /**
   * A headset being signed in from a phone (docs/pair-a-headset.md): which ask it answers, and the next look at how
   * it stands. One at a time: a new one, a lock or a cancel ends it.
   */
  let pairing: { id: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  const pairGate = createSignGate(ASK_LIMITS);
  const stopPairing = () => {
    if (!pairing) return;
    if (pairing.timer) clearTimeout(pairing.timer);
    pairing = null;
    void headless?.pairCancel().catch(() => {});
  };
  /** Lock: the site is forgotten, and the key goes with the worker that held it. */
  const lock = () => {
    stopPairing();
    dropPending();
    const was = headless;
    const forSite = site;
    headless = null;
    pubkey = null;
    name = null;
    profile = null;
    until = 0;
    remembered = false;
    app = null;
    more = [];
    guest = false;
    deviceGrant = null;
    devicePub = null;
    forgetHeld();
    if (was) void (forSite ? was.forgetSignerGrant(forSite) : Promise.resolve()).catch(() => {}).finally(() => was.destroy());
  };
  /**
   * Take up what was kept for this site, once, as soon as it is known which
   * site this is. Everything a site asks waits for it, so a page loaded
   * again is answered "unlocked" from the first question.
   */
  let remembering: Promise<void> | null = null;
  /** This signer is a guest account (docs/guest-accounts.md): its bag with no press, nothing more than a site's else. */
  let guest = false;
  /** Take up what is kept, or (`makeGuest`) the family's guest account where nobody is signed in here. */
  const takeUp = async (makeGuest = false): Promise<void> => {
    if (!site) return;
    const kept = await (await load()).restoreSignerGrant(site, familyOf(site) || undefined, makeGuest);
    if (!kept) return;
    guest = kept.guest === true;
    deviceGrant = kept.deviceGrant ?? null;
    devicePub = kept.devicePubkey ?? null;
    pubkey = kept.pubkey;
    name = kept.name ?? null;
    profile = kept.profile ?? null;
    until = kept.until;
    // A guest isn't a grant kept for the site: nothing was allowed, so nothing is "remembered".
    remembered = !guest;
    app = kept.permissions ?? null;
    more = app ? [] : (kept.more ?? []);
    if (app) gates = appGates(kept.signed, kept.signedSensitive);
    else gate = createSignGate(SIGN_LIMITS, kept.signed);
    // Too long unchecked: the answer waits for the check. Otherwise the check is made behind the answer.
    if (kept.check === "overdue") await checkTakenBack();
    else if (kept.check === "due") void checkTakenBack();
    passGate = createSignGate(passLimits, kept.signedPass);
    await takeUpHeld();
  };
  const remember = (): Promise<void> =>
    (remembering ??= (async () => {
      try {
        await takeUp();
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
      ...(pubkey && guest ? { guest: true as const } : {}),
      // The name in their own signed profile, where they have one; else the name the sign-in address knew them by.
      ...(pubkey && (profile?.name || name) ? { name: profile?.name || name! } : {}),
      ...(pubkey && profile?.picture ? { picture: profile.picture } : {}),
      ...(pubkey && profile?.about ? { about: profile.about } : {}),
      // An application is told what it was approved for, so it can tell that from what it now wants.
      ...(pubkey && app ? { permissions: app } : {}),
      // A world is told what more it was let do, so it asks for nothing that isn't there.
      ...(pubkey && !app && more.length ? { more } : {}),
      // What can be asked for here at all, said locked or unlocked. Not to an application: it is held to its set.
      ...(!app ? { offers: [...WORLD_MORE] } : {}),
      ...(pubkey && deviceGrant ? { device: true as const } : {})
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
    // Buying is not yet open at every address BitLogin runs at (permissions.ts). Where it isn't, `buy` is not a
    // request this signer knows, and gets no answer.
    if (ask.t === "buy" && !buyingOpenAt(me)) return;
    await remember();
    if (ask.t === "state") return say(state(ask.id));
    if (ask.t === "lock") {
      lock();
      return say(state(ask.id));
    }
    if (ask.t === "wantFamily") {
      // Only its own family, as the browser's address for it says, and one BitLogin knows. It approves nothing.
      familyAsked = !!ask.family && ask.family === familyOf(site) && knownFamily(ask.family);
      // And its guest account, where nobody is signed in here: made at once, with nothing pressed. An account wins.
      if (ask.guest && familyAsked && !pubkey) await takeUp(true).catch(() => {});
      return say({ ...(state(ask.id) as Extract<SignerReply, { t: "state" }>), familyTaken: familyAsked, ...(ask.guest ? { guestTaken: familyAsked && guest && !!pubkey } : {}) });
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
    if (ask.t === "pairCancel") {
      if (pairing?.id === ask.id) stopPairing();
      return say(state(ask.id));
    }
    if (ask.t === "pair") {
      if (PAIRING_PAUSED) return say({ t: "pairing-expired", id: ask.id, why: "paused" });
      // Only where nobody is signed in here, or it is the guest: an account is never written over from a phone.
      if ((pubkey && !guest) || !pairGate.take(Date.now())) return say({ t: "refused", id: ask.id });
      stopPairing();
      const id = ask.id;
      try {
        const signer = await load();
        const begun = await signer.pairBegin(site, deviceLabel(navigator.userAgent));
        const shown: SignerReply = { t: "pairing", id, code: begun.code, url: pairUrl(me, begun.code), expires: begun.expires };
        pairing = { id, timer: null };
        say(shown);
        let number: number | undefined;
        const look = async (): Promise<void> => {
          if (pairing?.id !== id || headless !== signer) return;
          const now = await signer.pairPoll().catch(() => ({ status: "expired" as const, number: undefined, got: undefined }));
          if (pairing?.id !== id || headless !== signer) return;
          if (now.status === "found" && now.number !== undefined && now.number !== number) {
            number = now.number;
            say({ ...shown, number } as SignerReply);
          }
          if (now.status === "paired" && now.got) {
            pairing = null;
            try {
              await takeHandoff(signer, now.got);
            } catch {
              // Sealed for another site or family: nothing of it is taken up, and the worker that opened it goes.
              drop();
              say(state());
              return say({ t: "pairing-expired", id, why: "refused" });
            }
            say(state());
            return say({ t: "paired", id });
          }
          if (now.status === "ended" || now.status === "expired" || now.status === "paired") {
            pairing = null;
            return say(now.status === "ended" ? { t: "pairing-expired", id, why: "refused" } : { t: "pairing-expired", id });
          }
          pairing.timer = setTimeout(() => void look(), 700);
        };
        pairing.timer = setTimeout(() => void look(), 700);
      } catch {
        pairing = null;
        say({ t: "refused", id });
      }
      return;
    }
    // Everything else is asked of an unlocked signer. Every way it can fail says the same thing: refused.
    const refuse = () => say({ t: "refused", id: ask.id });
    if (pubkey && Date.now() / 1000 >= until) lock();
    if (!headless || !pubkey) return refuse();
    // Way 2: a headset holding its own key makes passes and nothing else, and says so in words a world can show.
    if (deviceGrant && ask.t !== "pass") return say({ t: "refused", id: ask.id, words: FROM_PHONE });

    if (ask.t === "have") {
      // Answered from what BitLogin's page handed over: the person's receipts for this site's own listings, and
      // no others. No question is put, and nothing is fetched. One that has run out is not one.
      const receipt = heldFor(ask.listing);
      return say(receipt ? { t: "receipt", id: ask.id, receipt: receipt.event } : { t: "none", id: ask.id });
    }

    if (ask.t === "propose" || ask.t === "wallet" || ask.t === "pay" || ask.t === "tip" || ask.t === "buy" || ask.t === "guests" || ask.t === "file-save" || ask.t === "file-pick") {
      // Put to the person on a page of BitLogin's own. An application the user approved may ask too (BitPortal's own
      // room is one, and should behave as a world does): asking widens nothing it may do on its own say, because
      // every answer is a press on BitLogin's page, and what is signed there is signed by BitLogin's own session.
      // Not a wallet: an application asks for one through the widget, at its own address.
      const asked: Asked | null = app && ask.t === "wallet" ? null : ask.t === "wallet" ? { what: "wallet" } : ask.t === "pay" ? { what: "pay", invoice: ask.invoice } : ask.t === "tip" ? { what: "tip", sats: ask.sats, ...(ask.to ? { to: ask.to } : {}) } : ask.t === "buy" ? { what: "buy", listing: ask.listing } : ask.t === "guests" ? (app ? null : { what: "guests", world: ask.world, list: (ask.list as never) ?? null, change: ask.change, key: ask.key, none: ask.none }) : ask.t === "file-pick" ? { what: "pick" } : ask.t === "file-save" ? { what: "save", name: ask.name, type: ask.type, bytes: ask.bytes, private: ask.private } : ((event) => (event ? { what: "sign", event } : null))(prepareAsked(ask.event, site, Date.now() / 1000));
      if (!asked || !askGates[asked.what].take(Date.now())) return refuse();
      // One question at a time: a new one ends the one before it.
      dropPending();
      const id = ask.id;
      pending = { id, ask: asked, timer: setTimeout(() => pending?.id === id && dropPending(), ASK_WAIT_MS) };
      return say({ t: "asking", id });
    }

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
      // For an application only where the set it was approved for signs the pass's kind (passAllowed).
      if (!passAllowed(app) || ask.session === pubkey || !passGate.take(Date.now())) return refuse();
      try {
        const pass = await headless.roomPass(ask.session);
        // Signed by the account, or (Way 2) by the headset's own key, with the account's grant for it beside it.
        if (pass.pubkey !== (deviceGrant ? devicePub : pubkey)) return refuse();
        say({ t: "signed", id: ask.id, event: pass, ...(deviceGrant ? { device: deviceGrant } : {}) });
        void headless.touchSignerGrant(site, gate.times(), undefined, passGate.times()).catch(() => {});
      } catch {
        refuse();
      }
      return;
    }

    // "sign".
    const now = Date.now();
    const prepared = app ? prepareForApp(app, ask.event, site, now / 1000) : guest ? prepareForGuest(ask.event, site, now / 1000) : prepareForSite(ask.event, site, now / 1000);
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

  /**
   * Take up a hand-off BitLogin's own page sealed for this site: from the window's Allow, or from a phone that signed
   * this headset in (docs/pair-a-headset.md). The same checks, the same grant, whichever way it came.
   */
  const takeHandoff = async (signer: HeadlessSigner, got: Awaited<ReturnType<HeadlessSigner["acceptHandoff"]>>, fromName?: string): Promise<void> => {
    // A hand-off sealed for an application names the site it was approved for. For another site it is refused.
    if ((got.app && got.app.site !== site) || (got.site && got.site !== site)) throw new Error("for another site");
    // A hand-off for a family is for this site's own family, as this page works it out, and no other.
    if (got.family && got.family !== familyOf(site)) throw new Error("for another family");
    profile = got.profile ?? null;
    // Signed in as an account by BitLogin's own page: no longer the guest, here.
    guest = false;
    deviceGrant = got.deviceGrant ?? null;
    devicePub = got.devicePubkey ?? null;
    app = got.app?.permissions ?? null;
    more = app || got.family ? [] : (got.more ?? []);
    gates = appGates();
    pubkey = got.pubkey;
    name = fromName ?? null;
    gate = createSignGate();
    passGate = createSignGate(passLimits);
    dropPending();
    // Another account's receipts are not this one's: what was held is let go until BitLogin's page hands over more.
    forgetHeld();
    // A site the user left "remember" ticked for is kept, so they are not asked again when its page is next
    // loaded: thirty days for one BitLogin knows, seven for any other. A site they unticked it for is allowed
    // for this visit: it lasts as long as the page does, and nothing is written down. So does one that can't
    // be kept (a browser that gives an embedded page no storage), and every site while the lock is on.
    // A family is kept by the family's own name: thirty days for one BitLogin knows, seven for any other.
    // An application allowed with its family too (SF5a) is kept as itself: by its own address.
    const known = got.family && !got.app ? knownFamily(got.family) : knownAppName(site) !== null;
    // A site let read private messages is asked again after seven days, however well BitLogin knows it: what
    // was read can't be unread, so the say is not left standing for a month.
    const longest = known && !more.includes("messages") ? SIGN_LIMITS.grantSec : SIGN_LIMITS.unknownGrantSec;
    until = Math.floor(Date.now() / 1000) + (got.remember ? longest : SIGN_LIMITS.visitSec);
    // Way 2: never past the account's grant for the headset's own key.
    if (deviceGrant) until = Math.min(until, Number(deviceGrant.tags.find((t) => t[0] === "expiration")?.[1]) || 0);
    remembered = got.remember === true && (await signer.keepSignerGrant({ site, until, ...(name ? { name } : {}) }).catch(() => false));
    if (!remembered) until = Math.min(until, Math.floor(Date.now() / 1000) + SIGN_LIMITS.visitSec);
    // What an account before this one held here is written over: nothing of theirs is left for this one.
    keepHeld();
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
      lastWindow = asking;
        back({ t: "frame", nonce: msg.nonce, world: site, recipient, ...(wanted ? { wants: wanted } : {}), ...(turnedDown ? { turnedDown: true } : {}), ...(!wanted && wantedMore.length ? { more: wantedMore } : {}), ...(!wanted && pubkey && !app && more.length ? { has: more } : {}), ...(familyAsked && !wantedMore.length ? { family: true as const } : {}), ...(pubkey && pending ? { ask: pending.ask, pubkey } : {}) });
      } catch {
        /* no worker: the window finds no signer, and offers nothing */
      }
      return;
    }
    if (msg.t === "answer") {
      // Only from the window that said hello, with the word it gave, and for the site this is really in.
      if (!asking || asking.nonce !== msg.nonce || asking.from !== e.source || msg.world !== site) return;
      const was = pending;
      if (!was || !pubkey) return back({ t: "done", nonce: msg.nonce, ok: false });
      clearTimeout(was.timer);
      pending = null;
      let reply: SignerReply = { t: "refused", id: was.id };
      if (was.ask.what === "wallet" && cleanWalletUri(msg.wallet)) reply = { t: "wallet", id: was.id, uri: cleanWalletUri(msg.wallet) };
      // Paid: only where it is the invoice this site asked to have paid. The site learns that, and nothing of the wallet.
      if (was.ask.what === "pay" && msg.paid?.invoice === was.ask.invoice) reply = { t: "paid", id: was.id, ...(msg.paid.preimage ? { preimage: msg.paid.preimage } : {}) };
      // A tip: only for the amount this site asked. Whom it went to was BitLogin's page's to find, and is not said.
      if (was.ask.what === "tip" && msg.tipped?.sats === was.ask.sats) reply = { t: "paid", id: was.id, ...(msg.tipped.preimage ? { preimage: msg.tipped.preimage } : {}) };
      // Bought: only with a receipt a known service signed, for this listing and this account, that has not run out.
      if (was.ask.what === "buy" && msg.bought) {
        const receipt = readReceipt(msg.bought.receipt, services);
        if (receiptGood(receipt, { buyer: pubkey, listing: was.ask.listing, now: Date.now() / 1000 })) {
          reply = { t: "bought", id: was.id, receipt: receipt!.event, ...(msg.bought.delivery ? { delivery: msg.bought.delivery } : {}) };
          held = heldReceipts([receipt!.event, ...held.filter((event) => event.id !== receipt!.event.id)], pubkey, services);
          keepHeld();
        }
      }
      // A world's list: passed on only if it is exactly the list the world handed over, with the one change, signed by
      // this account, for that world. What the page built is checked here again, as a proposed profile is.
      if (was.ask.what === "guests" && msg.listed && isListAsked(msg.listed, { pubkey, world: was.ask.world, change: was.ask.change, key: was.ask.key, list: was.ask.list, now: Date.now() / 1000 })) reply = { t: "signed", id: was.id, event: msg.listed };
      // A file saved, or the one file the person chose: passed on as BitLogin's own page gave it.
      if (was.ask.what === "save" && msg.saved) reply = { t: "file-saved", id: was.id, ...msg.saved };
      if (was.ask.what === "pick" && msg.file) reply = { t: "file", id: was.id, ...msg.file };
      if (was.ask.what === "sign" && msg.event) {
        // BitLogin's own page signed it, with the person's say. It is passed on only if it is exactly what was
        // put to them: signed by the account this site is signed in as, the same kind, words and tags, and now.
        const signed = msg.event;
        const asked = was.ask.event;
        const sameAsAsked = verifyNostrEvent(signed) && signed.pubkey === pubkey && signed.kind === asked.kind && signed.content === asked.content && JSON.stringify(signed.tags) === JSON.stringify(asked.tags) && Math.abs(signed.created_at - Date.now() / 1000) < 600;
        if (sameAsAsked) reply = { t: "signed", id: was.id, event: signed };
      }
      say(reply);
      return back({ t: "done", nonce: msg.nonce, ok: reply.t !== "refused" || (!msg.event && !msg.wallet && !msg.paid && !msg.saved && !msg.file && !msg.tipped && !msg.bought && !msg.listed) });
    }
    if (msg.t === "held") {
      // From the window or panel that last said hello, for the site this is really in, and only once signed in.
      if (!lastWindow || lastWindow.nonce !== msg.nonce || lastWindow.from !== e.source || msg.world !== site || !pubkey) return;
      held = heldReceipts(msg.receipts, pubkey, services);
      keepHeld();
      return;
    }
    if (msg.t !== "grant") return;
    // Only from the window that said hello, with the word it gave, and for the site this is really in.
    if (!asking || asking.nonce !== msg.nonce || asking.from !== e.source || msg.world !== site) return;
    asking = null;
    try {
      const signer = await load();
      await takeHandoff(signer, await signer.acceptHandoff(msg.sealed), msg.name);
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
