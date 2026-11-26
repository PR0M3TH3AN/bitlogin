/**
 * VR way (NSWP docs/backlog/everything-in-vr.md; names given by the orchestrator, 2026-11-25): the visitor may choose,
 * at the pairing, to have their wallet and files drawn in VR by the world's kit. Built behind `VR_WAY`, off. Each
 * failing before it was built.
 */
import { describe, expect, it } from "vitest";
import { CONFIRM_LIMITS, createConfirmGate, createVrFetchGuard, VR_CHOICES, VR_PARTS, VR_WAY, vrAllowedFor } from "./vrWay.js";

describe("VR way", () => {
  it("is built behind a switch that is off, with the words given for the choice", () => {
    expect(VR_WAY).toBe(false);
    expect(VR_PARTS).toEqual(["wallet", "files"]);
    expect(VR_CHOICES.inside.label).toBe("Use BitLogin inside VR");
    expect(VR_CHOICES.inside.line).toBe("Convenient. A world you're in could show you anything and act on your wallet and files, within your limits.");
    expect(VR_CHOICES.out.label).toBe("Step out to BitLogin each time");
    expect(VR_CHOICES.out.line).toBe("Safer. Your wallet and files open on BitLogin's own page.");
  });

  it("is offered only for a family, or a site BitLogin knows", () => {
    expect(vrAllowedFor("https://w1.bitblocks.network", "https://*.bitblocks.network")).toBe(true);
    expect(vrAllowedFor("https://portal.bitblocks.network", undefined)).toBe(true);
    expect(vrAllowedFor("https://stranger.example", undefined)).toBe(false);
  });
});

describe("the signer frame's guard on what it reaches over https", () => {
  const guard = createVrFetchGuard();
  const own = { vr: true, signedIn: true, mints: ["https://mint.example"], servers: ["https://files.example"] };

  it("lets through only the person's own mints and file servers, in a session with VR way on", () => {
    guard.set(own);
    expect(guard.allows("https://mint.example/v1/keys")).toBe(true);
    expect(guard.allows("https://files.example/abc")).toBe(true);
    // Any other https host, a look-alike, another scheme, or a port: refused.
    expect(guard.allows("https://evil.example/v1/keys")).toBe(false);
    expect(guard.allows("https://mint.example.evil.example/v1/keys")).toBe(false);
    expect(guard.allows("http://mint.example/v1/keys")).toBe(false);
    expect(guard.allows("https://mint.example:8443/v1/keys")).toBe(false);
    expect(guard.allows("not a url")).toBe(false);
  });

  it("lets a person's own local mint through only where BitLogin itself runs at a local address", () => {
    const live = createVrFetchGuard("https://bitlogin.network");
    live.set({ ...own, mints: ["http://127.0.0.1:3338"] });
    expect(live.allows("http://127.0.0.1:3338/v1/info")).toBe(false);
    const dev = createVrFetchGuard("http://localhost:8080");
    dev.set({ ...own, mints: ["http://127.0.0.1:3338"] });
    expect(dev.allows("http://127.0.0.1:3338/v1/info")).toBe(true);
    expect(dev.allows("http://127.0.0.1:9999/v1/info")).toBe(false);
    expect(dev.allows("http://evil.example/")).toBe(false);
  });

  it("refuses everything when VR way is off, and with no session", () => {
    guard.set({ ...own, vr: false });
    expect(guard.allows("https://mint.example/v1/keys")).toBe(false);
    guard.set({ ...own, signedIn: false });
    expect(guard.allows("https://mint.example/v1/keys")).toBe(false);
    guard.set(null);
    expect(guard.allows("https://files.example/abc")).toBe(false);
  });

  it("wraps fetch so a refused address is never asked", async () => {
    let asked = 0;
    const fetchLike = async () => {
      asked++;
      return new Response("ok");
    };
    const g = createVrFetchGuard("https://bitlogin.network");
    const guarded = g.wrap(fetchLike as typeof fetch);
    // BitLogin's own address is always its own, VR way or not; nothing else is, with no session.
    await guarded("/vendor/bitlogin/bitlogin-ecash.js");
    await guarded("https://bitlogin.network/signer/index.html");
    await expect(guarded("https://mint.example/v1/info")).rejects.toThrow();
    g.set(own);
    await guarded("https://mint.example/v1/info");
    await expect(guarded("https://evil.example/")).rejects.toThrow(/isn't one of your mints or file servers/u);
    g.set(null);
    await expect(guarded("https://mint.example/v1/info")).rejects.toThrow();
    expect(asked).toBe(3);
  });
});

describe("a confirm the kit draws", () => {
  it("is answered once, for its own id, after the press guard and within the minute", () => {
    expect(CONFIRM_LIMITS).toEqual({ guardMs: 900, expiryMs: 60_000 });
    const gate = createConfirmGate();
    const id = gate.issue({ what: "pay", sats: 21 }, 1000);
    expect(id).toMatch(/^[0-9a-f]{24}$/u);
    // Too soon, another id, or late: a no.
    expect(gate.answer(id, true, 1500)).toBe(null);
    const second = gate.issue({ what: "pay", sats: 5 }, 2000);
    expect(gate.answer("ab".repeat(12), true, 4000)).toBe(null);
    expect(gate.answer(second, true, 2000 + 61_000)).toBe(null);
    // In time, once.
    const third = gate.issue({ what: "pay", sats: 8 }, 10_000);
    expect(gate.answer(third, true, 11_000)).toEqual({ what: "pay", sats: 8 });
    expect(gate.answer(third, true, 11_500)).toBe(null);
    // A no is a no, and ends it.
    const fourth = gate.issue({ what: "save" }, 20_000);
    expect(gate.answer(fourth, false, 21_000)).toBe(null);
    expect(gate.answer(fourth, true, 21_500)).toBe(null);
  });
});

describe("VR way turned off from BitLogin's page: the take-back's vr scope", () => {
  it("ends VR way for that site or family, and leaves the sign-in standing", async () => {
    const { isTakenBack, isVrTakenBack, mergeTakenBack, NOTHING_TAKEN_BACK, readTakenBack, takeBack, writeTakenBack } = await import("./takeBack.js");
    const family = "https://*.bitblocks.network";
    const record = takeBack(NOTHING_TAKEN_BACK, { site: family, vr: true }, 500);
    expect(isVrTakenBack(record, family, 400)).toBe(true);
    expect(isVrTakenBack(record, "https://w1.bitblocks.network", 400)).toBe(true);
    expect(isVrTakenBack(record, family, 501)).toBe(false);
    expect(isTakenBack(record, family, 400)).toBe(false);
    const read = readTakenBack(JSON.parse(writeTakenBack(record)))!;
    expect(isVrTakenBack(mergeTakenBack(read, NOTHING_TAKEN_BACK, 600), family, 400)).toBe(true);
  });
});

describe("VR way in the hand-off and the worker", () => {
  it("is sealed only with the account's own key, for a family or a site BitLogin knows, never for an application", async () => {
    const { generatePrivateKey, getPublicKeyHex } = await import("@bitlogin/core/crypto");
    const { openAppHandoff, sealHandoff } = await import("../worker/handoff.js");
    const recipient = generatePrivateKey();
    const to = getPublicKeyHex(recipient);
    const seal = (also: Record<string, unknown>) => sealHandoff(generatePrivateKey(), to, generatePrivateKey(), undefined, also);
    expect(openAppHandoff(seal({ site: "https://w1.bitblocks.network", remember: true, family: "https://*.bitblocks.network", vr: true }), recipient).vr).toBe(true);
    expect(openAppHandoff(seal({ site: "https://w1.bitblocks.network", remember: true }), recipient).vr).toBeUndefined();
    // A site BitLogin doesn't know, or anything but `true`: refused whole.
    expect(() => seal({ site: "https://stranger.example", remember: true, vr: true })).toThrow();
    expect(() => seal({ site: "https://w1.bitblocks.network", remember: true, family: "https://*.bitblocks.network", vr: "yes" })).toThrow();
  });

  it("opens to a signer frame only the wallet's and files' own actions, never their settings or the account's", async () => {
    const { readFileSync } = await import("node:fs");
    const { SIGNER_ONLY_ACTIONS, VR_ACTIONS } = await import("../worker/handoff.js");
    expect([...VR_ACTIONS].sort()).toEqual(["blossomAuth", "blossomServers", "driveLoad", "drivePeek", "driveSave", "ecashLoad", "ecashPeek", "ecashRoll", "paySettingsLoad", "vrNotice", "vrOff"]);
    for (const never of ["ecashSetMints", "blossomSetServers", "paySettingsSave", "exportIdentity", "changePassword", "vaultRevealNwc", "takeBack", "handoffExport", "buildRecoveryExport", "pairAnswer"]) expect(VR_ACTIONS.has(never), never).toBe(false);
    for (const a of VR_ACTIONS) expect(SIGNER_ONLY_ACTIONS.has(a), a).toBe(false);
    const worker = readFileSync(new URL("../worker/cryptoWorker.ts", import.meta.url), "utf8");
    expect(worker).toContain("if (session.signerOnly && !SIGNER_ONLY_ACTIONS.has(action) && !(session.vr && VR_ACTIONS.has(action))) {");
    expect(worker).toContain("let vrWayHere = VR_WAY;");
    expect(worker).toContain("if (p.vrWay === true && isLocalAddress(selfOrigin())) vrWayHere = true;");
    // Chosen on the phone with the account's own key: never a device key with it.
    expect(worker).toContain("const own = deviceKeysHere && !vr ? generatePrivateKey() : null;");
  });
});

describe("every other way under connect-src (the review of 63684d9)", () => {
  it("refuses XMLHttpRequest, EventSource, WebSocket, WebTransport and sendBeacon outright in the frame", async () => {
    const { refuseOtherWays } = await import("./vrWay.js");
    const target: Record<string, unknown> & { navigator: { sendBeacon: (url: string) => boolean } } = {
      XMLHttpRequest: class {},
      EventSource: class {},
      WebSocket: class {},
      WebTransport: class {},
      navigator: { sendBeacon: () => true }
    };
    refuseOtherWays(target);
    for (const name of ["XMLHttpRequest", "EventSource", "WebSocket", "WebTransport"]) {
      expect(() => new (target[name] as new (url: string) => unknown)("https://mint.example/"), name).toThrow(/isn't used by BitLogin's signer/u);
    }
    expect(target.navigator.sendBeacon("https://mint.example/")).toBe(false);
    // And it stays so: it can't be set again.
    expect(() => {
      target.XMLHttpRequest = class {};
    }).toThrow();
    expect(() => new (target.XMLHttpRequest as new () => unknown)()).toThrow(/isn't used by BitLogin's signer/u);
  });

  it("guards the worker's own fetch: its own address, and over https nothing else", async () => {
    const { guardWorkerFetch } = await import("./vrWay.js");
    const asked: string[] = [];
    const f = guardWorkerFetch((async (input: RequestInfo | URL) => {
      asked.push(String(input));
      return new Response("ok");
    }) as typeof fetch, "https://bitlogin.network");
    await f("https://bitlogin.network/relays.json");
    await expect(f("https://mint.example/v1/info")).rejects.toThrow(/no other address over https/u);
    await expect(f("https://relay.example/")).rejects.toThrow();
    expect(asked).toEqual(["https://bitlogin.network/relays.json"]);
    const { readFileSync } = await import("node:fs");
    const worker = readFileSync(new URL("../worker/cryptoWorker.ts", import.meta.url), "utf8");
    expect(worker).toContain('if (typeof globalThis.fetch === "function") globalThis.fetch = guardWorkerFetch(globalThis.fetch.bind(globalThis), selfOrigin());');
    const frame = readFileSync(new URL("./vrSigner.ts", import.meta.url), "utf8");
    expect(frame.indexOf("refuseOtherWays(globalThis")).toBeGreaterThan(frame.indexOf("globalThis.fetch = guard.wrap("));
  });
});
