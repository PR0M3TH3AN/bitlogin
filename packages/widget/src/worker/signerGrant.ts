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
import type { NostrEvent } from "@bitlogin/core/nostr";
import { getPublicKeyHex } from "@bitlogin/core/crypto";
import { deviceGrantHolds } from "../embedded/deviceGrant.js";
import { APP_LIMITS, knownAppName, mayHold, readPermissions, type AppPermissions } from "../embedded/permissions.js";
import { knownFamily, readFamily } from "../embedded/family.js";
import { readProfile, type Profile } from "../embedded/profile.js";
import { cleanRelays } from "../embedded/takeBack.js";
import { cleanMore, type WorldMore } from "../embedded/follows.js";

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
  /**
   * The asking site's origin, as the browser reported it: or a family of
   * sites, `https://*.domain` (docs/site-family.md), where the user allowed
   * every site under one domain at once. A family's grant holds no
   * application's permissions.
   */
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
  /** What a world was let do beyond a note and a reaction, by name (follows.ts). Never in a family's grant or an application's. */
  more?: WorldMore[];
  /** When it was allowed, in seconds (docs/take-back.md). Absent in a grant kept before this was recorded. */
  at?: number;
  /**
   * The family an application's own grant was allowed with, in the same press (docs/site-family.md SF5a): so a sign-out
   * at the application signs out of the family too. Only a family; never more than that is read from it.
   */
  memberOf?: string;
  /** The device a phone paired, by its random id (docs/pair-a-headset.md): a take-back may name it alone. */
  device?: string;
  /**
   * Way 2: the key kept is the headset's own, and this is the account's grant for it (kind 27305). Checked again on
   * every load: for this key, under this name (site or family), in date. A grant that isn't ends what is kept.
   */
  deviceGrant?: NostrEvent;
  /** VR way, chosen at the pairing. */
  vr?: true;
  /** The user's own write relays, where a signer looks for their take-back record. */
  relays?: string[];
  /** When their relays were last asked, and answered, whether this site was taken back. In seconds. */
  checkedAt?: number;
  /** The date of the newest take-back record seen: an older one served later is not believed. */
  seenAt?: number;
}

/** When a grant was made: what it says, or, for one kept before that was recorded, the start of its life. */
export const grantedAt = (grant: SignerGrant): number => grant.at ?? grant.until - keepSecFor(grant.site);

/** How long a site, or a family, may be kept from now, in seconds: by its address, never by anything it says of itself. */
export const keepSecFor = (site: string): number => ((readFamily(site) ? knownFamily(site) : knownAppName(site) !== null) ? GRANT_LIMITS.keepSec : GRANT_LIMITS.unknownKeepSec);

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

/** A site, as a hand-off or an application's set names one: exactly an http(s) origin. "" for anything else, a family included. */
export function grantSite(input: unknown): string {
  if (typeof input !== "string" || input.length > 300 || input.includes("*")) return "";
  try {
    const u = new URL(input);
    return (u.protocol === "https:" || u.protocol === "http:") && u.origin === input ? u.origin : "";
  } catch {
    return "";
  }
}

/** What a record may be kept under: a site, or a family of sites. */
export const grantKey = (input: unknown): string => readFamily(input) || grantSite(input);

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
  const site = grantKey(grant.site);
  if (!site || grant.everydayPrivateKey.length !== 32 || typeof store.getOrCreateDeviceKey !== "function") return false;
  // A family is allowed a note, a reaction and a room pass: an application's set is approved at its own address.
  if (readFamily(site) && grant.permissions) return false;
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
      ...(!grant.permissions && !readFamily(site) && cleanMore(grant.more).length ? { more: cleanMore(grant.more) } : {}),
      ...(typeof grant.at === "number" ? { at: Math.floor(grant.at) } : {}),
      ...(!readFamily(site) && readFamily(grant.memberOf) ? { memberOf: readFamily(grant.memberOf) } : {}),
      ...(typeof grant.device === "string" && /^[0-9a-f]{32}$/u.test(grant.device) ? { device: grant.device } : {}),
      ...(grant.deviceGrant ? { deviceGrant: grant.deviceGrant } : {}),
      ...(grant.vr === true && !grant.deviceGrant && !grant.permissions ? { vr: true } : {}),
      ...(cleanRelays(grant.relays).length ? { relays: cleanRelays(grant.relays) } : {}),
      ...(typeof grant.checkedAt === "number" ? { checkedAt: Math.floor(grant.checkedAt) } : {}),
      ...(typeof grant.seenAt === "number" ? { seenAt: Math.floor(grant.seenAt) } : {}),
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

/** A site's grant, or a family's, or null: none kept, kept for another site, unreadable, or past its date (then it is removed). */
export async function loadSignerGrant(store: GrantStore, siteInput: string, nowSeconds: number): Promise<SignerGrant | null> {
  const site = grantKey(siteInput);
  if (!site || typeof store.getOrCreateDeviceKey !== "function") return null;
  try {
    const raw = await store.get(GRANT_PREFIX + site);
    if (!raw) return null;
    const sealed = JSON.parse(raw) as Partial<Sealed>;
    if (sealed.v !== 1 || typeof sealed.iv !== "string" || typeof sealed.ciphertext !== "string") return null;
    const key = await store.getOrCreateDeviceKey(GRANT_DEVICE_KEY);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(fromBase64(sealed.iv)) }, key, buffer(fromBase64(sealed.ciphertext)));
    const p = JSON.parse(new TextDecoder().decode(plain)) as { site?: unknown; key?: unknown; until?: unknown; name?: unknown; profile?: unknown; signed?: unknown; permissions?: unknown; signedSensitive?: unknown; signedPass?: unknown; more?: unknown; at?: unknown; relays?: unknown; checkedAt?: unknown; seenAt?: unknown; memberOf?: unknown; device?: unknown; deviceGrant?: unknown; vr?: unknown };
    const when = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined);
    const profile = readProfile(p.profile);
    // A set that no longer reads as one (a rule tightened since it was kept) ends the grant: the user is asked
    // again, and sees what is asked. It is never restored as a narrower or a wider one.
    const permissions = p.permissions === undefined ? undefined : readPermissions(p.permissions);
    if (permissions === null || (permissions && (readFamily(site) || !mayHold(site, permissions)))) {
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
    const keyBytes = Uint8Array.from(p.key.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
    // Way 2: kept with a grant only while the grant is still one, for this key and this name.
    let deviceGrant: NostrEvent | undefined;
    if (p.deviceGrant !== undefined) {
      if (!deviceGrantHolds(p.deviceGrant, getPublicKeyHex(keyBytes), site, nowSeconds)) {
        keyBytes.fill(0);
        await store.delete(GRANT_PREFIX + site);
        return null;
      }
      deviceGrant = p.deviceGrant as NostrEvent;
    }
    return {
      site,
      ...(deviceGrant ? { deviceGrant } : {}),
      ...(p.vr === true && !deviceGrant && p.permissions === undefined ? { vr: true as const } : {}),
      everydayPrivateKey: Uint8Array.from(p.key.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16)),
      until: p.until,
      ...(typeof p.name === "string" && p.name ? { name: p.name.slice(0, 48) } : {}),
      ...(profile ? { profile } : {}),
      signed: times(p.signed, permissions ? APP_LIMITS.public.hourly : GRANT_LIMITS.signedKept),
      ...(times(p.signedPass, GRANT_LIMITS.passKept).length ? { signedPass: times(p.signedPass, GRANT_LIMITS.passKept) } : {}),
      ...(!permissions && !readFamily(site) && cleanMore(p.more).length ? { more: cleanMore(p.more) } : {}),
      ...(when(p.at) ? { at: when(p.at)! } : {}),
      ...(!readFamily(site) && readFamily(p.memberOf) ? { memberOf: readFamily(p.memberOf) } : {}),
      ...(typeof p.device === "string" && /^[0-9a-f]{32}$/u.test(p.device) ? { device: p.device } : {}),
      ...(cleanRelays(p.relays).length ? { relays: cleanRelays(p.relays) } : {}),
      ...(when(p.checkedAt) ? { checkedAt: when(p.checkedAt)! } : {}),
      ...(when(p.seenAt) ? { seenAt: when(p.seenAt)! } : {}),
      ...(permissions ? { permissions, signedSensitive: times(p.signedSensitive, APP_LIMITS.sensitive.hourly) } : {})
    };
  } catch {
    // Unreadable is "nothing kept", never an error: the user is simply asked again.
    return null;
  }
}

/**
 * What one hand-off is kept as (docs/site-family.md SF5a): for an application allowed with its family, two grants,
 * its own set at its own address (and the family it was allowed with, so a sign-out there ends both) and the
 * family's, with no set at all; for a world allowed with its family, the family's alone; otherwise the site's own.
 * An application's kinds never reach the family: the family's record carries none, and saveSignerGrant refuses one.
 */
export function grantsToKeep(session: { site: string; app: { site: string; permissions: AppPermissions } | null; family: string | null; more: readonly WorldMore[] }): { site: string; permissions?: AppPermissions; memberOf?: string; more?: WorldMore[] }[] {
  if (session.app && session.family) return [{ site: session.site, permissions: session.app.permissions, memberOf: session.family }, { site: session.family }];
  if (session.family) return [{ site: session.family }];
  if (session.app) return [{ site: session.site, permissions: session.app.permissions }];
  return [{ site: session.site, ...(session.more.length ? { more: cleanMore(session.more) } : {}) }];
}

/** Forget a site, or a family. */
export async function deleteSignerGrant(store: GrantStore, siteInput: string): Promise<void> {
  const site = grantKey(siteInput);
  if (!site) return;
  try {
    await store.delete(GRANT_PREFIX + site);
  } catch {
    // ignore
  }
}
