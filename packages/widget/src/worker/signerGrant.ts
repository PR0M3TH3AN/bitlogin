/**
 * What the embedded signer remembers for a site (docs/sign-in-window.md
 * §SW11): that the user allowed it, so they are not asked again on every
 * page load.
 *
 * It is the same trade as the session cache (sessionCache.ts), made
 * narrower. A record holds the everyday key, AES-GCM encrypted with a
 * non-extractable CryptoKey kept by IndexedDB, for ONE asking site, until a
 * date. What is restored from it is a signer-only session: it can sign and
 * nothing else. It holds no vault root, no capsule events and no recovery
 * material, and it is kept under names of its own, so it is never read as a
 * full session and a full session is never written as one of these.
 *
 * Where it lives: the embedded signer's own storage, which a browser walls
 * off by the site it is embedded in. The asking site cannot read it.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import { APP_LIMITS, knownAppName, mayHold, readPermissions, type AppPermissions } from "../embedded/permissions.js";
import { readProfile, type Profile } from "../embedded/profile.js";

const GRANT_PREFIX = "bitlogin:signer-grant:v1:";
const GRANT_DEVICE_KEY = "bitlogin:signer-grant-device-key:v1";

export const GRANT_LIMITS = {
  /** The longest a site BitLogin knows is remembered, in seconds: thirty days from Allow. */
  keepSec: 30 * 24 * 3600,
  /** The longest for a site it does not know: seven days. */
  unknownKeepSec: 7 * 24 * 3600,
  /** How many recent room passes are remembered, to count them across page loads. */
  passKept: 10,
  /** How many recent signatures are remembered, to count them across page loads. */
  signedKept: 60
} as const;

export interface SignerGrant {
  /** The asking site's origin, as the browser reported it. */
  site: string;
  everydayPrivateKey: Uint8Array;
  /** When it stops, in seconds. */
  until: number;
  /** The name the sign-in address knew them by when they allowed it, or none. */
  name?: string;
  /** Their own signed profile, as it was when they allowed the site (§SW16). */
  profile?: Profile;
  /** When the last signatures for this site were made, in milliseconds: so reloading a page is not a way round the count. */
  signed: number[];
  /** What an application was approved for (§SW9). Absent for a site that declared nothing: a note and a reaction. */
  permissions?: AppPermissions;
  /** For an application: when its last sensitive signatures were made, counted apart (§SW9.6). */
  signedSensitive?: number[];
  /** When the last room passes for this site were made, counted apart from notes (§SW16). */
  signedPass?: number[];
}

/** How long a site may be kept from now, in seconds: by its address, never by anything it says of itself. */
export const keepSecFor = (site: string): number => (knownAppName(site) !== null ? GRANT_LIMITS.keepSec : GRANT_LIMITS.unknownKeepSec);

interface DeviceKeyStore {
  getOrCreateDeviceKey(key: string): Promise<CryptoKey>;
}
type GrantStore = KeyValueStore & Partial<DeviceKeyStore>;

interface Sealed {
  v: 1;
  iv: string;
  ciphertext: string;
}

const HEX64 = /^[0-9a-f]{64}$/u;

/** A site as a record may be kept for: exactly an http(s) origin. "" for anything else. */
export function grantSite(input: unknown): string {
  if (typeof input !== "string" || input.length > 300) return "";
  try {
    const u = new URL(input);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === input ? u.origin : "";
  } catch {
    return "";
  }
}

const toBase64 = (bytes: Uint8Array): string => btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
const fromBase64 = (value: string): Uint8Array => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const buffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};
const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Keep a site's grant. Returns false, having kept nothing, where it can't be kept encrypted or isn't a grant. */
export async function saveSignerGrant(store: GrantStore, grant: SignerGrant, nowSeconds: number): Promise<boolean> {
  const site = grantSite(grant.site);
  if (!site || grant.everydayPrivateKey.length !== 32 || typeof store.getOrCreateDeviceKey !== "function") return false;
  // Never longer than the limit, whatever was asked.
  const until = Math.min(Math.floor(grant.until), Math.floor(nowSeconds) + keepSecFor(site));
  if (!(until > nowSeconds)) return false;
  // Outside the try on purpose: with no source of randomness this throws, and nothing is kept. There is no
  // "carry on with something weaker" (crypto/random.ts, and the rule that guards it).
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const key = await store.getOrCreateDeviceKey(GRANT_DEVICE_KEY);
    const plain = JSON.stringify({
      site,
      key: toHex(grant.everydayPrivateKey),
      until,
      ...(grant.name ? { name: grant.name.slice(0, 48) } : {}),
      ...(readProfile(grant.profile) ? { profile: readProfile(grant.profile) } : {}),
      // An application's public signatures are counted up to its own hourly limit, so more of them are kept.
      signed: grant.signed.filter((t) => Number.isFinite(t)).slice(-(grant.permissions ? APP_LIMITS.public.hourly : GRANT_LIMITS.signedKept)),
      ...(grant.permissions ? { permissions: grant.permissions } : {}),
      ...(grant.signedPass?.length ? { signedPass: grant.signedPass.filter((t) => Number.isFinite(t)).slice(-GRANT_LIMITS.passKept) } : {}),
      ...(grant.permissions && grant.signedSensitive
        ? { signedSensitive: grant.signedSensitive.filter((t) => Number.isFinite(t)).slice(-APP_LIMITS.sensitive.hourly) }
        : {})
    });
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plain));
    const sealed: Sealed = { v: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(ciphertext)) };
    await store.set(GRANT_PREFIX + site, JSON.stringify(sealed));
    return true;
  } catch {
    return false;
  }
}

/** A site's grant, or null: none kept, kept for another site, unreadable, or past its date (then it is removed). */
export async function loadSignerGrant(store: GrantStore, siteInput: string, nowSeconds: number): Promise<SignerGrant | null> {
  const site = grantSite(siteInput);
  if (!site || typeof store.getOrCreateDeviceKey !== "function") return null;
  try {
    const raw = await store.get(GRANT_PREFIX + site);
    if (!raw) return null;
    const sealed = JSON.parse(raw) as Partial<Sealed>;
    if (sealed.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") return null;
    const key = await store.getOrCreateDeviceKey(GRANT_DEVICE_KEY);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(fromBase64(sealed.iv)) }, key, buffer(fromBase64(sealed.ciphertext)));
    const p = JSON.parse(new TextDecoder().decode(plain)) as { site?: unknown; key?: unknown; until?: unknown; name?: unknown; profile?: unknown; signed?: unknown; permissions?: unknown; signedSensitive?: unknown; signedPass?: unknown };
    const profile = readProfile(p.profile);
    // A set that no longer reads as one (a rule tightened since it was kept) ends the grant: the user is asked
    // again, and sees what is asked. It is never restored as a narrower or a wider one.
    const permissions = p.permissions === undefined ? undefined : readPermissions(p.permissions);
    if (permissions === null || (permissions && !mayHold(site, permissions))) {
      await store.delete(GRANT_PREFIX + site);
      return null;
    }
    const times = (v: unknown, keep: number): number[] => (Array.isArray(v) ? v.filter((t): t is number => typeof t === "number" && Number.isFinite(t)).slice(-keep) : []);
    // A record is for the site named inside it, whatever name it was filed under.
    if (p.site !== site || typeof p.key !== "string" || !HEX64.test(p.key) || typeof p.until !== "number") return null;
    if (!(p.until > nowSeconds) || p.until > nowSeconds + GRANT_LIMITS.keepSec) {
      await store.delete(GRANT_PREFIX + site);
      return null;
    }
    return {
      site,
      everydayPrivateKey: Uint8Array.from(p.key.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16)),
      until: p.until,
      ...(typeof p.name === "string" && p.name ? { name: p.name.slice(0, 48) } : {}),
      ...(profile ? { profile } : {}),
      signed: times(p.signed, permissions ? APP_LIMITS.public.hourly : GRANT_LIMITS.signedKept),
      ...(times(p.signedPass, GRANT_LIMITS.passKept).length ? { signedPass: times(p.signedPass, GRANT_LIMITS.passKept) } : {}),
      ...(permissions ? { permissions, signedSensitive: times(p.signedSensitive, APP_LIMITS.sensitive.hourly) } : {})
    };
  } catch {
    // Unreadable is "nothing kept", never an error: the user is simply asked again.
    return null;
  }
}

/** Forget a site. */
export async function deleteSignerGrant(store: GrantStore, siteInput: string): Promise<void> {
  const site = grantSite(siteInput);
  if (!site) return;
  try {
    await store.delete(GRANT_PREFIX + site);
  } catch {
    // ignore
  }
}
