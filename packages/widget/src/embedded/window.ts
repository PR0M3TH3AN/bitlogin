/**
 * BitLogin's sign-in window, the part with no interface (docs/sign-in-window.md
 * §SW3): finding this origin's own embedded signer inside the page that
 * opened the window, and handing it a key that can only sign.
 *
 * The page that uses this draws the question and the Allow button, and signs
 * the user in with the ordinary widget if they aren't. This does the rest.
 *
 * It speaks only to a page of this origin. A message addressed to this
 * origin is delivered to nothing else, so a site posing as the signer hears
 * nothing; and with no signer found, there is nothing to allow.
 */
import type { HeadlessSigner } from "../headless.js";
import type { NostrEvent } from "@bitlogin/core/nostr";
import { handoffMessage, readHandoffMessage, type Asked } from "./policy.js";
import { describePermissions, heldAsLocal, knownAppName, mayHold, RESERVED_KINDS, type AppPermissions, type PermissionWords } from "./permissions.js";
import { familyDomain, inFamily, knownFamily } from "./family.js";
import { familyOf } from "./publicSuffix.js";
import type { WorldMore } from "./follows.js";
import { framesOfClient } from "./panel.js";

export { describePermissions, knownAppName, type AppPermissions, type PermissionWords };
export { declineFamily, describeAllowed, familyDeclined, familyOffer, loadAllowed, recordAllowed, removeAllowed, saveAllowed, type AllowedSite } from "./allowed.js";
export { familyDomain, familyOf, inFamily, knownFamily };
export { SIGN_LIMITS, type Asked } from "./policy.js";
export { describeAsked, type AskedWords } from "./careful.js";
export { applyChange, keepersOf, readOwnerList, resolveOwnerList, scopeOf, type GuestChange } from "./guests.js";
export { askLockDevice } from "../lockDevice.js";
export { PANEL_CLIENTS, panelClientAllowed, panelMessage, readPanelControl, readPanelHello, type PanelHello, type PanelMode, type PanelToClient } from "./panel.js";

export interface FoundSigner {
  /** The site the signer is embedded in, as the browser reported it to the signer. Show this, exactly. */
  readonly site: string;
  /**
   * What the site said it wants, if it is an application (§SW9): already
   * read and tidied. Show it, with `describePermissions`, before Allow. Null
   * for a site that declared nothing: it is asking for a note and a reaction.
   */
  readonly wants: AppPermissions | null;
  /**
   * Hand the signer the session's key, sealed inside the workers. Call it
   * only after the user pressed Allow on a page that showed `site`. `remember`
   * is whether they left it ticked. Resolves
   * true once the signer says it is unlocked.
   */
  grant(session: Pick<HeadlessSigner, "exportHandoff">, name?: string, remember?: boolean, forFamily?: boolean, withMore?: boolean): Promise<boolean>;
  /**
   * What a world asked to be let do beyond a note and a reaction, by name
   * (today only "follows": change who the person follows, one at a time).
   * Say it on the page in BitLogin's own words, and give the user a way to
   * allow the site without it. It is handed over only where `grant` is
   * called with `withMore`. Empty for an application, and never with a
   * family: it is for one site, by its own address.
   */
  readonly more: readonly WorldMore[];
  /**
   * What the site was already let do, by name, when the window opened. It
   * is kept whichever way the user allows the site again; `more` minus this
   * is what is new, and what the question is about.
   */
  readonly has: readonly WorldMore[];
  /**
   * Something the site put to the person (§SW20): a careful kind to sign, or the use of a wallet. Null when there
   * is nothing waiting. Where there is, this is what the page is for: show it, and bring back `answer`.
   */
  readonly ask: Asked | null;
  /** The account the site is signed in as, where it put something to the person: the answer must be that account's. */
  readonly askedAs: string | null;
  /**
   * What the person answered: the event, signed by this origin's own session, or the wallet connection, or
   * nothing (they said no). Resolves true once the signer has passed it on, or heard the no.
   */
  answer(result: { event: NostrEvent } | { wallet: string } | { paid: { invoice: string; preimage?: string } } | { saved: { name: string; size: number; private: boolean; url?: string } } | { file: { name: string; type: string; bytes: Uint8Array; url?: string } } | { tipped: { sats: number; preimage?: string } } | { bought: { receipt: NostrEvent; delivery?: string } } | { listed: NostrEvent } | null): Promise<boolean>;
  /**
   * Hand the site's signer the person's receipts for that site's own listings (docs/paying.md), so it can answer
   * `have` with no question. Only once it is signed in. They replace what it held.
   */
  hold(receipts: NostrEvent[]): void;
  /** Whether BitLogin knows this address. A remembered site is kept thirty days if it does, seven if not (§SW11). */
  readonly known: boolean;
  /**
   * The family of sites this one is in, `https://*.domain`, where one may be
   * offered (docs/site-family.md SF3), or "". Never for an application. The
   * embedded signer works it out again, and refuses a hand-off for another.
   */
  readonly family: string;
  /** Whether BitLogin knows that family: then it is kept thirty days, and otherwise seven. */
  readonly knownFamily: boolean;
  /**
   * The world asked for its family before its first sign-in (site-family.md SF4a), and it is one BitLogin knows: offer
   * it here even with no earlier site of it allowed, unless the lock is on or it was turned down lately.
   */
  readonly familyAsked: boolean;
  /**
   * The site asked for more than a note and a reaction, and may not have it
   * at this address: so `wants` is null, and what Allow gives is the plain
   * grant. Say so on the page, or the user is shown a smaller question than
   * the one the site asked with no word of it.
   */
  readonly turnedDown: boolean;
  /**
   * `wants` includes kinds reserved to a named address, held here only
   * because this BitLogin and the site are both local copies. Say so.
   */
  readonly local: boolean;
}

export interface FindSignerOptions {
  /** How long to keep asking before giving up, in milliseconds. A signer may still be loading. */
  timeoutMs?: number;
  /**
   * Look in the frames of the page that shows this one (the sign-in panel,
   * §SW19), not in the page that opened it (the window).
   */
  inClient?: boolean;
  /** Take only a signer that reports this site. The panel is told which world it is for, and shows no other. */
  world?: string;
}

/**
 * Look for this origin's embedded signer in the page that opened this
 * window, or, for the panel, in the frames of the page that shows it.
 * Resolves with it, or with null when there is no such page, or none
 * answers: then there is nothing to allow.
 */
export function findEmbeddedSigner(opts: FindSignerOptions = {}): Promise<FoundSigner | null> {
  if (typeof window === "undefined") return Promise.resolve(null);
  const opener = opts.inClient ? null : (window.opener as Window | null);
  if (opts.inClient ? window.parent === window : !opener) return Promise.resolve(null);
  /** Where a signer may be: the opener's frames, or the client's and theirs. Read again on each try: a world may still be loading. */
  const candidates = (): Window[] => (opts.inClient ? framesOfClient(window) : Array.from({ length: opener!.frames.length }, (_, i) => opener!.frames[i]!));
  const me = location.origin;
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return new Promise((resolve) => {
    let frame: Window | null = null;
    let settled = false;
    let onDone: ((ok: boolean) => void) | null = null;
    /** Say hello to every frame of the opener. Only one of this origin's own can hear it. */
    const call = () => {
      if (frame) return;
      try {
        for (const candidate of candidates()) candidate.postMessage(handoffMessage({ t: "hello", nonce }), me);
      } catch {
        /* the page that opened this has gone, or cut its link: nothing is found */
      }
    };
    const again = setInterval(call, 350);
    const giveUp = setTimeout(() => {
      clearInterval(again);
      if (!settled) {
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve(null);
      }
    }, opts.timeoutMs ?? 6000);
    const onMessage = (e: MessageEvent) => {
      // Only this origin's own pages are listened to.
      if (e.origin !== me || !e.source || e.source === window) return;
      const msg = readHandoffMessage(e.data);
      if (!msg || msg.nonce !== nonce) return;
      if (msg.t === "done" && frame && e.source === frame) return void onDone?.(msg.ok);
      if (msg.t !== "frame" || frame) return;
      // The panel was told which world it is for: a signer in any other frame is not the one that asked.
      if (opts.world && msg.world !== opts.world) return;
      frame = e.source as Window;
      clearInterval(again);
      clearTimeout(giveUp);
      settled = true;
      const { world, recipient } = msg;
      // Checked again here, on the page that shows it: a set this site may not hold is no request at all.
      const wants = msg.wants && mayHold(world, msg.wants) ? msg.wants : null;
      const turnedDown = msg.turnedDown === true || (!!msg.wants && !wants);
      const has = wants ? [] : (msg.has ?? []);
      // What is asked now and was not had before: the question is about these.
      const more = wants ? [] : (msg.more ?? []).filter((name) => !has.includes(name));
      // More than a note and a reaction is for this one site: no family is offered beside it. An application may have
      // its family offered beside its own set only where it asked, for a family BitLogin knows (SF5a).
      const own = familyOf(world);
      const family = wants ? (msg.family === true && !!own && knownFamily(own) ? own : "") : more.length || has.length ? "" : own;
      resolve({
        site: world,
        wants,
        known: knownAppName(world) !== null,
        family,
        knownFamily: family ? knownFamily(family) : false,
        // Worked out again on this page: its own family, by the browser's address for it, and one BitLogin knows.
        familyAsked: msg.family === true && !!family && knownFamily(family),
        turnedDown,
        more,
        has,
        local: !!wants && heldAsLocal(world) && [...wants.sign, ...wants.read].some((kind) => RESERVED_KINDS.includes(kind)),
        ask: msg.ask ?? null,
        askedAs: msg.ask ? (msg.pubkey ?? null) : null,
        async answer(result) {
          const answered = new Promise<boolean>((done) => {
            onDone = done;
            setTimeout(() => done(false), 8000);
          });
          frame!.postMessage(handoffMessage({ t: "answer", nonce, world, ...(result ?? {}) }), me);
          const ok = await answered;
          window.removeEventListener("message", onMessage);
          return ok;
        },
        hold(receipts) {
          // To the signer and to nothing else: addressed to this origin.
          frame!.postMessage(handoffMessage({ t: "held", nonce, world, receipts }), me);
        },
        async grant(session, name, remember, forFamily, withMore) {
          // What is sealed is exactly what this page was given to show: the set, for the site the browser named,
          // and its family only where the user chose that, with "remember" left on.
          const asFamily = forFamily === true && remember === true && !!family;
          const sealed = await session.exportHandoff(recipient, wants ? { site: world, permissions: wants } : undefined, world, remember === true, asFamily ? family : undefined, asFamily ? undefined : withMore === true && more.length ? [...has, ...more] : has.length ? has : undefined);
          const answered = new Promise<boolean>((done) => {
            onDone = done;
            setTimeout(() => done(false), 8000);
          });
          // To the signer and to nothing else: addressed to this origin.
          frame!.postMessage(handoffMessage({ t: "grant", nonce, world, sealed, ...(name ? { name } : {}) }), me);
          const ok = await answered;
          window.removeEventListener("message", onMessage);
          return ok;
        }
      });
    };
    window.addEventListener("message", onMessage);
    call();
  });
}
