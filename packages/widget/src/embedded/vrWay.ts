/**
 * VR way (NSWP docs/backlog/everything-in-vr.md; the owner: "the only thing that should force us out of VR is the
 * initial phone pairing and the browsers immersive VR site to site limitation"; names given by the orchestrator,
 * 2026-11-25). At the pairing, the visitor chooses for the world's family: BitLogin inside VR, where the world's kit
 * draws their wallet and files from what the signer frame hands it, or a step out to BitLogin's own page each time.
 *
 * Inside VR means the account's key is in that world's signer frame (as an Allow gives it): a world's device key can't
 * open the wallet or the files. A world the visitor is in could show them anything, and act on their wallet and files
 * within their limits: the words say so, and every move of money or a file is a `confirm` the frame makes, answered by
 * the kit's press, once, after the press guard and within a minute.
 *
 * The frame may reach over https only the person's own mints and file servers (the owner's "Yes, allow it"), and only
 * in a session whose grant has VR way on.
 *
 * Built behind `VR_WAY`, off.
 */
import { knownFamily, readFamily } from "./family.js";
import { knownAppName } from "./permissions.js";

/** Off until it is released on the owner's word. */
export const VR_WAY = false;
/** What VR way draws in a world. Purchases and the careful asks are to follow. */
export const VR_PARTS = ["wallet", "files"] as const;
export type VrPart = (typeof VR_PARTS)[number];

/** The two presses at the pairing, of equal weight and with no default, as the owner chose them. */
export const VR_CHOICES = {
  inside: { label: "Use BitLogin inside VR", line: "Convenient. A world you're in could show you anything and act on your wallet and files, within your limits." },
  out: { label: "Step out to BitLogin each time", line: "Safer. Your wallet and files open on BitLogin's own page." }
} as const;

/** VR way is offered for a family, or a site BitLogin knows: one storage partition, so one wallet copy and one lane. */
export function vrAllowedFor(site: string, family: string | undefined): boolean {
  if (family) return !!readFamily(family) && knownFamily(family);
  return knownAppName(site) !== null;
}

/** What the guard is told: whether VR way is on, whether a session is signed in, and the person's own addresses. */
export interface VrReach {
  vr: boolean;
  signedIn: boolean;
  mints: readonly string[];
  servers: readonly string[];
}

/**
 * The signer frame's guard on https: only the person's own mints and file servers, by exact origin, and only while
 * VR way is on in a signed-in session. Everything else is refused before it is asked.
 */
export function createVrFetchGuard(selfOrigin = "") {
  let reach: VrReach | null = null;
  let origins = new Set<string>();
  const originOf = (value: unknown): string => {
    try {
      const u = new URL(String(value));
      return u.protocol === "https:" && !u.port && !u.username && !u.password ? u.origin : "";
    } catch {
      return "";
    }
  };
  const allows = (url: unknown): boolean => {
    if (!reach || !reach.vr || !reach.signedIn) return false;
    const origin = originOf(url);
    return !!origin && origins.has(origin);
  };
  return {
    set(next: VrReach | null) {
      reach = next;
      origins = new Set([...(next?.mints ?? []), ...(next?.servers ?? [])].map(originOf).filter(Boolean));
    },
    allows,
    /** A fetch that asks only what `allows`, and BitLogin's own address (its own files, never a third party). */
    wrap(inner: typeof fetch): typeof fetch {
      return ((input: RequestInfo | URL, init?: RequestInit) => {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
        let own = false;
        try {
          own = !!selfOrigin && new URL(raw, selfOrigin).origin === selfOrigin;
        } catch {
          own = false;
        }
        if (!own && !allows(raw)) return Promise.reject(new TypeError("That address isn't one of your mints or file servers."));
        return inner(input, init);
      }) as typeof fetch;
    }
  };
}

/** A confirm is answered after the press guard, and within a minute. */
export const CONFIRM_LIMITS = { guardMs: 900, expiryMs: 60_000 } as const;

/**
 * The confirms the frame puts to the kit: each with an id the frame made, answered once. Too soon after it was put,
 * late, for another id, or a no: nothing is done.
 */
export function createConfirmGate<T>() {
  const open = new Map<string, { what: T; at: number }>();
  return {
    issue(what: T, now = Date.now()): string {
      for (const [id, c] of open) if (now - c.at > CONFIRM_LIMITS.expiryMs) open.delete(id);
      const id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      open.set(id, { what, at: now });
      return id;
    },
    answer(id: unknown, yes: unknown, now = Date.now()): T | null {
      if (typeof id !== "string") return null;
      const c = open.get(id);
      if (!c) return null;
      const soon = now - c.at < CONFIRM_LIMITS.guardMs;
      const late = now - c.at > CONFIRM_LIMITS.expiryMs;
      // A press too soon is not taken, and the confirm stays: a person's later press still counts.
      if (soon) return null;
      open.delete(id);
      return yes === true && !late ? c.what : null;
    }
  };
}
