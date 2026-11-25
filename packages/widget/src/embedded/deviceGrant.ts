/**
 * Way 2 of signing in a headset (NSWP docs/plans/headset-device-keys.md; the owner's "Yes, build the core", names
 * given by the orchestrator, 2026-11-25): the headset holds a key of its own, D, never the account's. The phone signs a
 * **device grant** (kind 27305) with the account's key, "until then, this device key may make passes for me, at this
 * site or family". It is carried with what D signs, never sent to a relay. A device is signed out by the account's
 * **list of devices signed out** (kind 37312, `d` = `nswp-devices-out`), which is kept on relays and read by worlds
 * and by the headset's own signer.
 *
 * Built behind `DEVICE_KEYS`, off: until the kit checks a grant, a pass signed by D would make its owner a guest in
 * worlds. It is turned on in a release of its own, on the owner's word.
 */
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";
import { inFamily, readFamily } from "./family.js";
import { cleanOrigin } from "./policy.js";

/** Off until the kit's grant check is live, and then only on the owner's word. */
export const DEVICE_KEYS = false;
export const DEVICE_GRANT_KIND = 27305;
export const DEVICES_OUT_KIND = 37312;
export const DEVICES_OUT_D = "nswp-devices-out";
/** A grant lasts thirty days at most, as BitLogin's own grants. */
export const DEVICE_GRANT_MAX_SEC = 30 * 86400;
/** What a device session answers for anything it may not do: the plain words a world can show. */
export const FROM_PHONE = "Do this from your phone.";
/** How many devices the list keeps: the newest. Any older has run out by its thirty days anyway. */
const DEVICES_OUT_KEPT = 200;

const HEX64 = /^[0-9a-f]{64}$/u;
const only = (tags: readonly string[][], name: string): string | null => {
  const found = tags.filter((t) => Array.isArray(t) && t[0] === name);
  return found.length === 1 && typeof found[0]![1] === "string" ? found[0]![1] : null;
};

/** The grant the phone signs, to be signed by the account's key. */
export function deviceGrantTemplate(o: { device: string; origin: string; expires: number; label?: string }): { kind: number; created_at: number; tags: string[][]; content: string } {
  return {
    kind: DEVICE_GRANT_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [["nswp:device", o.device], ["nswp:origin", o.origin], ["expiration", String(Math.floor(o.expires))], ...(o.label ? [["nswp:label", o.label.slice(0, 48)]] : [])],
    content: ""
  };
}

export type GrantCheck = { ok: true; identity: string; origin: string; expires: number } | { ok: false; why: string };

/**
 * Whether a grant lets `device` make passes at `site`: a validly signed 27305, by `identity` where it is named and
 * never by the device itself; for this device; for this site, or a family it is in; in date, for thirty days at most.
 */
export function checkDeviceGrant(event: unknown, at: { device: string; site: string; now: number; identity?: string }): GrantCheck {
  const e = event as NostrEvent | null;
  if (!e || typeof e !== "object" || e.kind !== DEVICE_GRANT_KIND || !Array.isArray(e.tags)) return { ok: false, why: "not a device grant" };
  if (!verifyNostrEvent(e)) return { ok: false, why: "not signed" };
  if (at.identity && e.pubkey !== at.identity) return { ok: false, why: "another account's" };
  const device = only(e.tags, "nswp:device");
  const origin = only(e.tags, "nswp:origin");
  const expires = Number(only(e.tags, "expiration"));
  if (!device || !HEX64.test(device) || device !== at.device || device === e.pubkey) return { ok: false, why: "another device's" };
  const family = origin ? readFamily(origin) : "";
  const site = cleanOrigin(at.site);
  if (!origin || !site || !(origin === site || (family && family === origin && inFamily(site, family)))) return { ok: false, why: "another site's" };
  if (!Number.isSafeInteger(expires) || expires <= at.now || expires - e.created_at > DEVICE_GRANT_MAX_SEC || e.created_at > at.now + 120) return { ok: false, why: "out of date" };
  return { ok: true, identity: e.pubkey, origin, expires };
}

export interface DeviceOut {
  device: string;
  /** Grants made before this, in seconds, are ended. */
  before: number;
}

/** The devices a list signs out, where it is the account's own, validly signed. */
export function readDevicesOut(event: unknown, identity: string): DeviceOut[] {
  const e = event as NostrEvent | null;
  if (!e || e.kind !== DEVICES_OUT_KIND || e.pubkey !== identity || !Array.isArray(e.tags) || only(e.tags, "d") !== DEVICES_OUT_D || !verifyNostrEvent(e)) return [];
  return e.tags
    .filter((t) => t[0] === "nswp:device" && typeof t[1] === "string" && HEX64.test(t[1]) && Number.isSafeInteger(Number(t[2])))
    .map((t) => ({ device: t[1]!, before: Number(t[2]) }));
}

/** The list again, with devices added: the later `before` for a device named twice, the newest kept. */
export function devicesOutTemplate(was: readonly DeviceOut[], add: readonly DeviceOut[]): { kind: number; created_at: number; tags: string[][]; content: string } {
  const by = new Map<string, number>();
  for (const d of [...was, ...add]) if (HEX64.test(d.device) && Number.isSafeInteger(d.before)) by.set(d.device, Math.max(by.get(d.device) ?? 0, d.before));
  const kept = [...by].sort((a, b) => b[1] - a[1]).slice(0, DEVICES_OUT_KEPT);
  return { kind: DEVICES_OUT_KIND, created_at: Math.floor(Date.now() / 1000), tags: [["d", DEVICES_OUT_D], ...kept.map(([device, before]) => ["nswp:device", device, String(before)])], content: "" };
}

/** Whether a grant made at `grantedAt` for `device` is ended by the list. */
export const isDeviceOut = (list: readonly DeviceOut[], device: string, grantedAt: number): boolean => list.some((d) => d.device === device && d.before >= grantedAt);

/**
 * Whether a kept grant still holds for what it is kept under: this device, this name (a site, or a family as
 * `https://*.domain`), validly signed, in date. For the headset's own store, checked again at every load.
 */
export function deviceGrantHolds(event: unknown, device: string, keptAs: string, nowSeconds: number): boolean {
  const e = event as NostrEvent | null;
  if (!e || e.kind !== DEVICE_GRANT_KIND || !Array.isArray(e.tags) || !verifyNostrEvent(e)) return false;
  const expires = Number(only(e.tags, "expiration"));
  return only(e.tags, "nswp:device") === device && device !== e.pubkey && only(e.tags, "nswp:origin") === keptAs && Number.isSafeInteger(expires) && expires > nowSeconds && expires - e.created_at <= DEVICE_GRANT_MAX_SEC;
}
