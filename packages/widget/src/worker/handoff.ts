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
import { knownAppName, mayHold, readPermissions, type AppPermissions } from "../embedded/permissions.js";
import { readProfile, type Profile } from "../embedded/profile.js";
import { grantSite } from "./signerGrant.js";

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
  also: { site?: unknown; profile?: unknown; /** The user ticked "remember" in the window. */ remember?: unknown } = {}
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
  // Remembered across page loads (§SW11): a site BitLogin knows, or one the user ticked "remember" for. Decided
  // here, in the worker that holds the key, from the site's address and never from what a site says of itself.
  const remember = !!forSite && (knownAppName(forSite) !== null || also.remember === true);
  // A signer wipes the key it was given when it is destroyed. It is given a copy: the caller's is the caller's to wipe.
  const sender = new NostrSigner(senderPrivateKey.slice());
  try {
    const plaintext = JSON.stringify({ v: 1, purpose: HANDOFF_PURPOSE, key: toHex(everydayPrivateKey), ...(sealedApp ? { app: sealedApp } : {}), ...(forSite ? { site: forSite } : {}), ...(profile ? { profile } : {}), ...(remember ? { remember: true } : {}) });
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
): { key: Uint8Array; app: HandoffApp | null; /** The site it was sealed for, or null where it names none. */ site: string | null; profile: Profile | null; /** Whether it may be kept across page loads. */ remember: boolean } {
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
  let parsed: { v?: unknown; purpose?: unknown; key?: unknown; app?: unknown; site?: unknown; profile?: unknown; remember?: unknown };
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
  if (parsed.app === undefined) return { key, app: null, site: named, profile, remember };
  const a = parsed.app as { site?: unknown; permissions?: unknown } | null;
  const site = a && typeof a === "object" ? grantSite(a.site) : "";
  const permissions = a && typeof a === "object" ? readPermissions(a.permissions) : null;
  if (!site || !permissions || !mayHold(site, permissions) || (named && named !== site)) {
    key.fill(0);
    throw new Error("The hand-off carried a permission set that cannot be read.");
  }
  return { key, app: { site, permissions }, site, profile, remember };
}
