/**
 * Signer hand-off (docs/sign-in-window.md): moving the everyday key from one
 * BitLogin crypto worker to another on the SAME origin, without it ever
 * being in a page's own memory.
 *
 * Why it exists: a browser walls off a site's storage when that site is
 * embedded in another. A signer embedded in someone else's page therefore
 * starts with nothing, however signed in the user is at the origin itself.
 * A window of the origin (which has the session) hands the embedded frame
 * (which has not) the one thing it needs to sign.
 *
 * What moves is the everyday private key and nothing else: no vault root, no
 * capsule events, no recovery material. The receiving worker holds it as a
 * signer-only session, in memory, and never caches it (cryptoWorker.ts).
 *
 * It is sealed with NIP-44 between two throwaway keys, one made in each
 * worker. The pages in between carry a public key one way and ciphertext
 * the other. This is not what makes the hand-off safe against the embedding
 * page: that is the browser delivering the message only to a frame of this
 * origin, which is the caller's job to arrange. It is what keeps the key out
 * of the DOM thread on both sides (spec §22.4).
 */
import { NostrSigner } from "@bitlogin/core/account";
import { getPublicKeyHex } from "@bitlogin/core/crypto";
import { mayHold, readPermissions, type AppPermissions } from "../embedded/permissions.js";
import { readProfile, type Profile } from "../embedded/profile.js";
import { cleanRelays } from "../embedded/takeBack.js";
import { inFamily, readFamily } from "../embedded/family.js";
import { grantSite } from "./signerGrant.js";
import { cleanMore, type WorldMore } from "../embedded/follows.js";

/**
 * What an application was approved for (docs/sign-in-window.md §SW9): the
 * site, and the permission set the user saw in the window. It travels inside
 * the seal, from one of BitLogin's workers to the other, so nothing between
 * them can widen it.
 */
export interface HandoffApp {
  site: string;
  permissions: AppPermissions;
}

export const HANDOFF_PURPOSE = "bitlogin:signer-handoff:v1";

/**
 * Everything a session that arrived by a hand-off may be asked. Not on the
 * list, and so refused: reading anything encrypted, exporting the key, the
 * vault, changing the account, and handing the key on again.
 */
export const SIGNER_ONLY_ACTIONS: ReadonlySet<string> = new Set([
  "configure",
  "getPublicKey",
  "signEvent",
  "getSessionStatus",
  "logout",
  "handoffBegin",
  "handoffAccept",
  // What an approved application may ask beyond signing (§SW9.5). Each is refused unless the session carries a
  // permission set, and then held to it (cryptoWorker.ts).
  "appEncrypt",
  "appDecrypt",
  "appDecryptEvent",
  // A room pass for the site the hand-off was sealed for, built whole in the worker (§SW16).
  "roomPass",
  // What a world keeps for its visitor (NSWP-12): written, found and opened for the site the session serves.
  "worldSave",
  "worldFind",
  "worldOpen",
  // One person followed or unfollowed, for a world the user let do that (NSWP-14; embedded/follows.ts).
  "worldFollow",
  // Asking the user's relays whether this site was taken back (docs/take-back.md). It reads one record and the
  // user's relay list, and can only end the grant or leave it be.
  "signerCheck",
  // Remembering a site, so the user is not asked on every page load (signerGrant.ts).
  "signerKeep",
  "signerRestore",
  "signerTouch",
  "signerForget"
]);

export interface SealedHandoff {
  /** The throwaway public key the sending worker sealed with. */
  senderPublicKey: string;
  /** NIP-44 ciphertext. */
  payload: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/.{2}/g) ?? [], (pair) => Number.parseInt(pair, 16));
}

/** Seal the everyday key to the receiving worker's throwaway key. */
export function sealHandoff(
  everydayPrivateKey: Uint8Array,
  recipientPublicKey: string,
  senderPrivateKey: Uint8Array,
  app?: { site: unknown; permissions: unknown },
  /** The site the hand-off is for, as the window was told by the signer, and the person's own profile. */
  also: { site?: unknown; profile?: unknown; /** The user ticked "remember" in the window. */ remember?: unknown; /** The lock is on: nothing is kept for any site. */ visitOnly?: boolean; /** When Allow was pressed, in seconds, by the sealing worker's clock. */ at?: number; /** The user's own write relays (NIP-65). */ relays?: unknown; /** The user allowed every site of this family (docs/site-family.md). */ family?: unknown; /** What the user let this world do beyond a note and a reaction, by name. */ more?: unknown } = {}
): SealedHandoff {
  if (!HEX64.test(recipientPublicKey)) throw new Error("The hand-off has no usable recipient key.");
  if (everydayPrivateKey.length !== 32) throw new Error("No identity is unlocked in this session.");
  // An application's set is read again here, in the worker that holds the key: what is sealed is what
  // readPermissions made of it, never what a page passed in.
  let sealedApp: HandoffApp | null = null;
  if (app !== undefined) {
    const site = grantSite(app.site);
    const permissions = readPermissions(app.permissions);
    if (!site || !permissions || !mayHold(site, permissions)) throw new Error("That is not a permission set an application may be given.");
    sealedApp = { site, permissions };
  }
  // The site a plain hand-off is for is sealed too, so the worker that opens it knows which site it serves.
  const forSite = also.site === undefined ? "" : grantSite(also.site);
  if (also.site !== undefined && (!forSite || (sealedApp && sealedApp.site !== forSite))) throw new Error("The hand-off names no usable site.");
  const profile = readProfile(also.profile);
  // Remembered across page loads (§SW11) only where the user left "remember" ticked in the window, and never
  // while the lock is on. How long is decided where it is kept, from the site's address (signerGrant.ts).
  const remember = !!forSite && also.visitOnly !== true && also.remember === true;
  // A family is for a site that declared nothing, remembered, and in that family. Anything else is refused whole,
  // never sealed as the narrower "this site only": the user chose the family, and would not get what they chose.
  const family = also.family === undefined ? "" : readFamily(also.family);
  if (also.family !== undefined && (!family || sealedApp || !remember || !inFamily(forSite, family))) throw new Error("That is not a family this site may be allowed as.");
  // More than a note and a reaction is for one world, by its own address: never for an application (held to its
  // set), and never for a family (sites the user has not seen). Refused whole, never sealed as less.
  const more = cleanMore(also.more);
  if (also.more !== undefined && (more.length === 0 || !forSite || sealedApp || family)) throw new Error("That is not something this site may be let do.");
  // A signer wipes the key it was given when it is destroyed. It is given a copy: the caller's is the caller's to wipe.
  const sender = new NostrSigner(senderPrivateKey.slice());
  try {
    const plaintext = JSON.stringify({ v: 1, purpose: HANDOFF_PURPOSE, key: toHex(everydayPrivateKey), ...(sealedApp ? { app: sealedApp } : {}), ...(forSite ? { site: forSite } : {}), ...(profile ? { profile } : {}), ...(remember ? { remember: true } : {}), ...(typeof also.at === "number" && Number.isFinite(also.at) ? { at: Math.floor(also.at) } : {}), ...(cleanRelays(also.relays).length ? { relays: cleanRelays(also.relays) } : {}), ...(family ? { family } : {}), ...(more.length ? { more } : {}) });
    return { senderPublicKey: sender.getPublicKey(), payload: sender.nip44Encrypt(recipientPublicKey, plaintext) };
  } finally {
    sender.destroy();
  }
}

/**
 * Open a sealed hand-off with the receiving worker's throwaway key. Returns
 * the everyday private key. Throws on anything that is not exactly a v1
 * hand-off carrying a usable key: there is no partial acceptance.
 */
export function openHandoff(sealed: SealedHandoff, recipientPrivateKey: Uint8Array): Uint8Array {
  return openAppHandoff(sealed, recipientPrivateKey).key;
}

/**
 * The same, with what the hand-off says an application was approved for.
 * `app` is null for a hand-off that carries none: the session it makes can
 * sign a note and a reaction and nothing else. A hand-off that carries a set
 * which does not read as one is refused whole.
 */
export function openAppHandoff(
  sealed: SealedHandoff,
  recipientPrivateKey: Uint8Array
): { key: Uint8Array; app: HandoffApp | null; /** The site it was sealed for, or null where it names none. */ site: string | null; profile: Profile | null; /** Whether it may be kept across page loads. */ remember: boolean; /** When it was allowed, in seconds, or null where it does not say. */ at: number | null; /** The user's own write relays, cleaned. */ relays: string[]; /** The family of sites it is kept for, or null for this site alone. */ family: string | null; /** What this world was let do beyond a note and a reaction. */ more: WorldMore[] } {
  if (!sealed || !HEX64.test(sealed.senderPublicKey) || typeof sealed.payload !== "string") {
    throw new Error("That is not a signer hand-off.");
  }
  const recipient = new NostrSigner(recipientPrivateKey.slice());
  let plaintext: string;
  try {
    plaintext = recipient.nip44Decrypt(sealed.senderPublicKey, sealed.payload);
  } catch {
    throw new Error("The hand-off could not be opened.");
  } finally {
    recipient.destroy();
  }
  let parsed: { v?: unknown; purpose?: unknown; key?: unknown; app?: unknown; site?: unknown; profile?: unknown; remember?: unknown; at?: unknown; relays?: unknown; family?: unknown; more?: unknown };
  try {
    parsed = JSON.parse(plaintext) as typeof parsed;
  } catch {
    throw new Error("The hand-off could not be read.");
  }
  if (parsed.v !== 1 || parsed.purpose !== HANDOFF_PURPOSE || typeof parsed.key !== "string" || !HEX64.test(parsed.key)) {
    throw new Error("That is not a signer hand-off.");
  }
  const key = fromHex(parsed.key);
  try {
    // A key that is not a valid scalar has no public key: refuse it here, not at the first signature.
    getPublicKeyHex(key);
  } catch {
    key.fill(0);
    throw new Error("The hand-off carried an unusable key.");
  }
  // A site that does not read as one is refused whole, like a set that does not.
  const named = parsed.site === undefined ? null : grantSite(parsed.site);
  if (named === "") {
    key.fill(0);
    throw new Error("The hand-off names no usable site.");
  }
  const profile = readProfile(parsed.profile);
  const remember = parsed.remember === true && !!named;
  const at = typeof parsed.at === "number" && Number.isFinite(parsed.at) && parsed.at > 0 ? Math.floor(parsed.at) : null;
  const relays = cleanRelays(parsed.relays);
  // A family that does not read as one, is not remembered, is for an application, or does not hold the site: refused whole.
  const family = parsed.family === undefined ? null : readFamily(parsed.family);
  if (family === "" || (family && (parsed.app !== undefined || !remember || !inFamily(named, family)))) {
    key.fill(0);
    throw new Error("The hand-off names a family it cannot be kept for.");
  }
  // More than a note and a reaction: for one world, named, and never with a family or an application.
  const more = cleanMore(parsed.more);
  if (parsed.more !== undefined && (more.length === 0 || !named || family || parsed.app !== undefined)) {
    key.fill(0);
    throw new Error("The hand-off carries something this site may not be let do.");
  }
  if (parsed.app === undefined) return { key, app: null, site: named, profile, remember, at, relays, family, more };
  const a = parsed.app as { site?: unknown; permissions?: unknown } | null;
  const site = a && typeof a === "object" ? grantSite(a.site) : "";
  const permissions = a && typeof a === "object" ? readPermissions(a.permissions) : null;
  if (!site || !permissions || !mayHold(site, permissions) || (named && named !== site)) {
    key.fill(0);
    throw new Error("The hand-off carried a permission set that cannot be read.");
  }
  return { key, app: { site, permissions }, site, profile, remember, at, relays, family: null, more: [] };
}
