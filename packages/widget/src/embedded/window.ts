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
import { handoffMessage, readHandoffMessage } from "./policy.js";
import { describePermissions, knownAppName, mayHold, type AppPermissions, type PermissionWords } from "./permissions.js";

export { describePermissions, knownAppName, type AppPermissions, type PermissionWords };
export { describeAllowed, loadAllowed, recordAllowed, removeAllowed, saveAllowed, type AllowedSite } from "./allowed.js";
export { SIGN_LIMITS } from "./policy.js";
export { askLockDevice } from "../lockDevice.js";

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
   * is whether they ticked it; a known site is remembered either way. Resolves
   * true once the signer says it is unlocked.
   */
  grant(session: Pick<HeadlessSigner, "exportHandoff">, name?: string, remember?: boolean): Promise<boolean>;
  /** Whether BitLogin knows this address. A known site is remembered for thirty days; any other only if the user
   *  ticks "remember" (§SW11). */
  readonly known: boolean;
}

export interface FindSignerOptions {
  /** How long to keep asking before giving up, in milliseconds. A signer may still be loading. */
  timeoutMs?: number;
}

/**
 * Look for this origin's embedded signer in the page that opened this
 * window. Resolves with it, or with null when there is no opener, or none
 * answers: then there is nothing to allow.
 */
export function findEmbeddedSigner(opts: FindSignerOptions = {}): Promise<FoundSigner | null> {
  const opener = typeof window === "undefined" ? null : (window.opener as Window | null);
  if (!opener) return Promise.resolve(null);
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
        const frames = opener.frames;
        for (let i = 0; i < frames.length; i++) frames[i]!.postMessage(handoffMessage({ t: "hello", nonce }), me);
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
      frame = e.source as Window;
      clearInterval(again);
      clearTimeout(giveUp);
      settled = true;
      const { world, recipient } = msg;
      // Checked again here, on the page that shows it: a set this site may not hold is no request at all.
      const wants = msg.wants && mayHold(world, msg.wants) ? msg.wants : null;
      resolve({
        site: world,
        wants,
        known: knownAppName(world) !== null,
        async grant(session, name, remember) {
          // What is sealed is exactly what this page was given to show: the set, for the site the browser named.
          const sealed = await session.exportHandoff(recipient, wants ? { site: world, permissions: wants } : undefined, world, remember === true);
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
