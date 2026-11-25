/**
 * Signing in a headset from your phone (docs/pair-a-headset.md), over stand-in relays that keep no ephemeral note,
 * as real ones don't: the headset's offer, found by the phone; the number to match; the hand-off, opened once by the
 * one-time key. Failing before it was built.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../../../core/src/test-support/mockRelay.js";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { sealHandoff } from "../worker/handoff.js";
import { phonePairing, startHeadsetPairing } from "../worker/pairing.js";

const SITE = "https://portal.bitblocks.network";
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const until = async (ok: () => boolean, ms = 8000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await sleep(50);
  return ok();
};

describe("pairing a headset from a phone", () => {
  let relays: MockRelay[] = [];
  let urls: string[] = [];
  beforeEach(async () => {
    relays = await Promise.all([MockRelay.start(), MockRelay.start()]);
    // As real relays: an ephemeral note is passed on to whoever is listening, and kept by none.
    for (const r of relays) r.keepsEphemeral = false;
    urls = relays.map((r) => r.url);
  });
  afterEach(async () => {
    await Promise.all(relays.map((r) => r.close()));
  });

  it("finds the offer by its code, matches the number, and opens the hand-off once", async () => {
    const headset = await startHeadsetPairing({ relayUrls: urls, site: SITE, device: "Meta Quest Browser", republishMs: 300 });
    try {
      expect(headset.state().status).toBe("waiting");
      const phone = phonePairing({ relayUrls: urls });
      // Found only because the headset says it again while it waits: no relay kept the first.
      const offers = await phone.find(headset.code.toLowerCase().replace("-", " "), { waitMs: 2500, settleMs: 600 });
      expect(offers).toHaveLength(1);
      expect(offers[0]).toMatchObject({ site: SITE, device: "Meta Quest Browser" });
      // The number the headset shows is the one the phone sent.
      const number = await phone.found(offers[0]!);
      expect(await until(() => headset.state().status === "found")).toBe(true);
      expect(headset.state().number).toBe(number);
      // The hand-off, sealed to the headset's one-time key, with the device id.
      const everyday = generatePrivateKey();
      const device = "0123456789abcdef0123456789abcdef";
      await phone.answer(offers[0]!, sealHandoff(everyday, offers[0]!.key, generatePrivateKey(), undefined, { site: SITE, remember: true, device }));
      expect(await until(() => headset.state().status === "paired")).toBe(true);
      const opened = headset.state().opened!;
      expect(getPublicKeyHex(opened.key)).toBe(getPublicKeyHex(everyday));
      expect(opened).toMatchObject({ site: SITE, remember: true, device });
      // Once: a second answer opens nothing, the one-time key being gone.
      await phone.answer(offers[0]!, sealHandoff(generatePrivateKey(), offers[0]!.key, generatePrivateKey(), undefined, { site: SITE, remember: true }));
      await sleep(600);
      expect(getPublicKeyHex(headset.state().opened!.key)).toBe(getPublicKeyHex(everyday));
    } finally {
      headset.cancel();
    }
  }, 30_000);

  it("ends on a wrong tap, on both sides, and takes nothing after", async () => {
    const headset = await startHeadsetPairing({ relayUrls: urls, site: SITE, device: "a browser", republishMs: 300 });
    try {
      const phone = phonePairing({ relayUrls: urls });
      const [offer] = await phone.find(headset.code, { waitMs: 2500, settleMs: 600 });
      await phone.found(offer!);
      expect(await until(() => headset.state().status === "found")).toBe(true);
      await phone.end(offer!);
      expect(await until(() => headset.state().status === "ended")).toBe(true);
      await phone.answer(offer!, sealHandoff(generatePrivateKey(), offer!.key, generatePrivateKey(), undefined, { site: SITE, remember: true }));
      await sleep(600);
      expect(headset.state()).toMatchObject({ status: "ended" });
      expect(headset.state().opened).toBeUndefined();
    } finally {
      headset.cancel();
    }
  }, 30_000);

  it("hears only the phone that found it first", async () => {
    const headset = await startHeadsetPairing({ relayUrls: urls, site: SITE, device: "a browser", republishMs: 300 });
    try {
      const phone = phonePairing({ relayUrls: urls });
      const [offer] = await phone.find(headset.code, { waitMs: 2500, settleMs: 600 });
      const number = await phone.found(offer!);
      expect(await until(() => headset.state().status === "found")).toBe(true);
      // Another phone, someone else's: its number, its end and its answer are not heard.
      const other = phonePairing({ relayUrls: urls });
      await other.found(offer!);
      await other.end(offer!);
      await other.answer(offer!, sealHandoff(generatePrivateKey(), offer!.key, generatePrivateKey(), undefined, { site: SITE, remember: true }));
      await sleep(800);
      expect(headset.state()).toMatchObject({ status: "found", number });
    } finally {
      headset.cancel();
    }
  }, 30_000);

  it("finds two offers where two devices show one code, so the phone refuses both", async () => {
    const one = await startHeadsetPairing({ relayUrls: urls, site: SITE, device: "a browser", republishMs: 300 });
    // Someone who saw the code publishes an offer of their own with it.
    const copy = await startHeadsetPairing({ relayUrls: urls, site: "https://evil.example", device: "a browser", republishMs: 300, code: one.code });
    try {
      const offers = await phonePairing({ relayUrls: urls }).find(one.code, { waitMs: 2500, settleMs: 600 });
      expect(offers.length).toBe(2);
    } finally {
      one.cancel();
      copy.cancel();
    }
  }, 30_000);

  it("is offered no more once its five minutes are up", async () => {
    const headset = await startHeadsetPairing({ relayUrls: urls, site: SITE, device: "a browser", republishMs: 300, ttlSec: 1 });
    try {
      expect(await until(() => headset.state().status === "expired", 4000)).toBe(true);
      expect(await phonePairing({ relayUrls: urls }).find(headset.code, { waitMs: 1500, settleMs: 300 })).toEqual([]);
    } finally {
      headset.cancel();
    }
  }, 30_000);
});
