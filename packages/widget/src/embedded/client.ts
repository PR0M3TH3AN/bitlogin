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
import { cleanOrigin, PROTOCOL_VERSION, SIGNER_PROTOCOL } from "./policy.js";

export interface BitLoginClientOptions {
  /** The sign-in address: an origin, such as "https://bitlogin.network". */
  at: string;
  /** What the application wants to be allowed (§SW9.2). The user sees all of it in the window. */
  permissions: unknown;
  /** Where the unseen frame is put. The page's body by default. */
  mount?: HTMLElement;
  /** How long one request may take, in milliseconds. */
  timeoutMs?: number;
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
  /** Sign out of this application: the signer forgets this site. */
  signOut(): Promise<void>;
  getPublicKey(): Promise<string>;
  signEvent(event: UnsignedEvent): Promise<NostrEvent>;
  nip44: { encrypt(peer: string, plaintext: string): Promise<string>; decrypt(peer: string, ciphertext: string): Promise<string> };
  nip04: { encrypt(peer: string, plaintext: string): Promise<string>; decrypt(peer: string, ciphertext: string): Promise<string> };
  /** The content of a whole signed event of a kind the application may read. */
  decryptEvent(event: NostrEvent): Promise<string>;
  /** Remove the frame and stop listening. */
  destroy(): void;
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

export function createBitLoginClient(options: BitLoginClientOptions): BitLoginClient {
  const at = cleanOrigin(options.at);
  if (!at) throw new Error("`at` must be the sign-in address's origin, such as https://bitlogin.network");
  const wanted = readPermissions(options.permissions);
  if (!wanted) throw new Error("`permissions` is not a permission set BitLogin will show a user. See docs/sign-in-window.md §SW9.2.");
  const timeoutMs = options.timeoutMs ?? 20_000;

  const frame = document.createElement("iframe");
  frame.src = `${at}/signer/`;
  frame.title = "BitLogin signer";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Out of sight, not `display: none`: some browsers do not load or run a frame that is not laid out.
  frame.style.cssText = "position:absolute;width:1px;height:1px;left:-9999px;top:0;border:0;opacity:0;pointer-events:none";

  let current: BitLoginClientState = { signedIn: false };
  let raw: { unlocked: boolean; pubkey?: string } = { unlocked: false };
  const listeners = new Set<(state: BitLoginClientState) => void>();
  const waiting = new Map<string, { resolve(value: Record<string, unknown>): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  let stopped = false;

  const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

  const take = (d: Record<string, unknown>) => {
    const unlocked = d.unlocked === true && typeof d.pubkey === "string";
    const granted = unlocked ? (readPermissions(d.permissions) ?? undefined) : undefined;
    const enough = unlocked && covers(granted, wanted);
    raw = { unlocked, ...(unlocked ? { pubkey: d.pubkey as string } : {}) };
    const next: BitLoginClientState = {
      signedIn: enough,
      ...(enough ? { pubkey: d.pubkey as string } : {}),
      ...(enough && typeof d.name === "string" ? { name: d.name } : {}),
      ...(enough && typeof d.until === "number" ? { until: d.until } : {}),
      ...(unlocked && !enough ? { needsMore: true } : {})
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
    async signOut() {
      await request({ t: "lock" });
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

  /** Listen until `listener` returns true. */
  function onChangeOnce(listener: (state: BitLoginClientState) => boolean): () => void {
    const wrapped = (state: BitLoginClientState) => {
      if (listener(state)) listeners.delete(wrapped);
    };
    listeners.add(wrapped);
    return () => listeners.delete(wrapped);
  }
}
