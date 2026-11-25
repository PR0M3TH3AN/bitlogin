/**
 * Way 2 (NSWP docs/plans/headset-device-keys.md, the owner's "Yes, build the core"): a headset's own key, D. The phone
 * signs a device grant (27305) with the account's key; the headset holds only D. Each failing before it was built.
 */
import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import {
  DEVICE_GRANT_KIND,
  DEVICE_GRANT_MAX_SEC,
  DEVICE_KEYS,
  DEVICES_OUT_D,
  DEVICES_OUT_KIND,
  FROM_PHONE,
  checkDeviceGrant,
  deviceGrantTemplate,
  devicesOutTemplate,
  isDeviceOut,
  readDevicesOut
} from "./deviceGrant.js";

const SITE = "https://w1.bitblocks.network";
const FAMILY = "https://*.bitblocks.network";
const now = 1_800_000_000;
const identity = new NostrSigner(generatePrivateKey());
const D = generatePrivateKey();
const device = getPublicKeyHex(D);
const grant = (o: Partial<{ device: string; origin: string; expires: number; created: number; label: string }> = {}, by = identity) =>
  by.signEvent({ ...deviceGrantTemplate({ device: o.device ?? device, origin: o.origin ?? SITE, expires: o.expires ?? now + 3600, label: o.label ?? "Meta Quest Browser" }), created_at: o.created ?? now });

describe("a device grant (kind 27305)", () => {
  it("is built behind a switch that is off, with the names given", () => {
    expect(DEVICE_KEYS).toBe(false);
    expect(DEVICE_GRANT_KIND).toBe(27305);
    expect(DEVICES_OUT_KIND).toBe(37312);
    expect(DEVICES_OUT_D).toBe("nswp-devices-out");
    expect(DEVICE_GRANT_MAX_SEC).toBe(30 * 86400);
    expect(FROM_PHONE).toBe("Do this from your phone.");
  });

  it("names the device, the site or family, an expiry and a label, and says nothing else", () => {
    const g = grant();
    expect(g.kind).toBe(27305);
    expect(g.content).toBe("");
    expect(g.tags).toEqual([["nswp:device", device], ["nswp:origin", SITE], ["expiration", String(now + 3600)], ["nswp:label", "Meta Quest Browser"]]);
  });

  it("is believed only for its device, at its site or in its family, in date, for 30 days at most, signed by the identity", () => {
    const ok = (g: unknown, o: Partial<{ device: string; site: string; identity: string }> = {}) =>
      checkDeviceGrant(g, { device: o.device ?? device, site: o.site ?? SITE, now: now + 10, ...(o.identity ? { identity: o.identity } : {}) });
    expect(ok(grant())).toEqual({ ok: true, identity: identity.getPublicKey(), origin: SITE, expires: now + 3600 });
    expect(ok(grant({ origin: FAMILY }))).toMatchObject({ ok: true, origin: FAMILY });
    // Another device, another site, a family the site isn't in, run out, too long, a forged signature, another identity.
    expect(ok(grant(), { device: getPublicKeyHex(generatePrivateKey()) }).ok).toBe(false);
    expect(ok(grant(), { site: "https://other.example" }).ok).toBe(false);
    expect(ok(grant({ origin: "https://*.other.example" })).ok).toBe(false);
    expect(ok(grant({ expires: now + 5 })).ok).toBe(false);
    expect(ok(grant({ expires: now + DEVICE_GRANT_MAX_SEC + 60 })).ok).toBe(false);
    expect(ok({ ...grant(), sig: "00".repeat(64) }).ok).toBe(false);
    expect(ok(grant(), { identity: getPublicKeyHex(generatePrivateKey()) }).ok).toBe(false);
    // The device key may never be the identity's own.
    expect(ok(grant({ device: identity.getPublicKey() }), { device: identity.getPublicKey() }).ok).toBe(false);
    expect(ok({ kind: 1 }).ok).toBe(false);
  });
});

describe("the list of devices signed out (kind 37312)", () => {
  it("names each device and when, is replaceable by its d, and is joined onto the newest list, never shrunk", () => {
    const older = identity.signEvent({ ...devicesOutTemplate([], [{ device: "aa".repeat(32), before: now }]), created_at: now });
    expect(older.kind).toBe(37312);
    expect(older.tags).toContainEqual(["d", "nswp-devices-out"]);
    expect(older.tags).toContainEqual(["nswp:device", "aa".repeat(32), String(now)]);
    const read = readDevicesOut(older, identity.getPublicKey());
    expect(read).toEqual([{ device: "aa".repeat(32), before: now }]);
    const newer = identity.signEvent({ ...devicesOutTemplate(read, [{ device, before: now + 50 }]), created_at: now + 50 });
    const both = readDevicesOut(newer, identity.getPublicKey());
    expect(both).toHaveLength(2);
    expect(isDeviceOut(both, device, now + 40)).toBe(true);
    // A grant made after the sign-out is not ended by it; another device is not.
    expect(isDeviceOut(both, device, now + 60)).toBe(false);
    expect(isDeviceOut(both, "bb".repeat(32), now)).toBe(false);
    // A list by someone else is no list.
    expect(readDevicesOut(newer, getPublicKeyHex(generatePrivateKey()))).toEqual([]);
  });
});

describe("a headset holding its own key, in the worker", () => {
  it("asks for passes and its grant's own keeping and checks, and nothing else: refused in words, before anything is done", async () => {
    const { readFileSync } = await import("node:fs");
    const { DEVICE_ACTIONS, SIGNER_ONLY_ACTIONS } = await import("../worker/handoff.js");
    expect([...DEVICE_ACTIONS].sort()).toEqual(["configure", "getPublicKey", "getSessionStatus", "handoffAccept", "handoffBegin", "logout", "roomPass", "signerCheck", "signerForget", "signerKeep", "signerRestore", "signerTouch"]);
    // Never a raw signature, a note, a save, a message, a score, the bag or anything of the wallet.
    for (const never of ["signEvent", "worldSave", "worldFind", "worldOpen", "worldScore", "worldAchieve", "worldFollow", "worldSeal", "worldUnwrap", "worldReach", "appEncrypt", "appDecrypt", "appDecryptEvent", "signerHold", "signerHeld", "pairBegin"]) expect(DEVICE_ACTIONS.has(never), never).toBe(false);
    for (const action of DEVICE_ACTIONS) if (action !== "configure") expect(SIGNER_ONLY_ACTIONS.has(action), action).toBe(true);
    const worker = readFileSync(new URL("../worker/cryptoWorker.ts", import.meta.url), "utf8");
    const handle = worker.slice(worker.indexOf("async function handle("));
    const gate = handle.indexOf("if (session.deviceGrant && !DEVICE_ACTIONS.has(action)) throw Object.assign(new Error(FROM_PHONE), { code: \"from-phone\" });");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(handle.indexOf("switch (action)"));
    // The switch: off, and turned on by configure only where BitLogin itself runs at a local address.
    expect(worker).toContain("let deviceKeysHere = DEVICE_KEYS;");
    expect(worker).toContain("if (p.deviceKeys === true && isLocalAddress(selfOrigin())) deviceKeysHere = true;");
    // The headset's own check reads the account's public list, and ends where it names its key.
    const check = worker.slice(worker.indexOf('case "signerCheck": {'));
    expect(check.indexOf("isDeviceOut(readDevicesOut(newest, identity), me, at)")).toBeGreaterThan(-1);
  });

  it("is refused in words by the signer page for anything but a pass", async () => {
    const { readFileSync } = await import("node:fs");
    const signer = readFileSync(new URL("./signer.ts", import.meta.url), "utf8");
    expect(signer).toContain('if (deviceGrant && ask.t !== "pass") return say({ t: "refused", id: ask.id, words: FROM_PHONE });');
    expect(signer).toContain("if (pass.pubkey !== (deviceGrant ? devicePub : pubkey)) return refuse();");
  });
});
