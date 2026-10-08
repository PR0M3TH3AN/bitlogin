import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { clearActiveSession, getActiveSession, setActiveSession } from "./globalSession.js";

const HEX = "ab".repeat(32);
const INFO = { method: "nip07" as const, publicKey: HEX, npub: "npub1example" };
const STORED = { method: "nip07" as const, pubkey: HEX, publicKey: HEX, npub: "npub1example" };

describe("global session registry", () => {
  beforeEach(() => {
    // Reset by clearing with whatever owner is current -- the module keeps a
    // single slot, so clearing under a fresh owner after set covers it.
    setActiveSession(globalThis, INFO);
    clearActiveSession(globalThis);
  });

  it("returns null when nobody is signed in", () => {
    expect(getActiveSession()).toBeNull();
  });

  it("records and returns the session, as a copy, with pubkey === publicKey", () => {
    const owner = {};
    setActiveSession(owner, INFO);
    const first = getActiveSession()!;
    expect(first).toEqual(STORED);
    expect(first.pubkey).toBe(first.publicKey);
    first.publicKey = "tampered";
    expect(getActiveSession()!.publicKey).toBe(HEX);
    expect(getActiveSession()!.pubkey).toBe(HEX);
  });

  it("lowercases the identity hex", () => {
    const owner = {};
    setActiveSession(owner, { ...INFO, publicKey: "AB".repeat(32) });
    expect(getActiveSession()!.pubkey).toBe(HEX);
    expect(getActiveSession()!.publicKey).toBe(HEX);
  });

  it("only the owning element can clear its session", () => {
    const elementA = {};
    const elementB = {};
    setActiveSession(elementA, INFO);
    clearActiveSession(elementB); // a different element tearing down
    expect(getActiveSession()).toEqual(STORED);
    clearActiveSession(elementA);
    expect(getActiveSession()).toBeNull();
  });

  it("the most recent sign-in wins across elements", () => {
    const elementA = {};
    const elementB = {};
    setActiveSession(elementA, INFO);
    setActiveSession(elementB, { ...INFO, method: "nip46" });
    expect(getActiveSession()!.method).toBe("nip46");
    // A's later logout must not clear B's session.
    clearActiveSession(elementA);
    expect(getActiveSession()!.method).toBe("nip46");
  });
});

describe("element wiring", () => {
  const widgetSource = readFileSync(new URL("./element.ts", import.meta.url), "utf8");
  const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  it("every login dispatch records the session; every teardown clears it", () => {
    // dispatchLogin is the single sign-in dispatch point, so one setActiveSession
    // there covers password, extension, and remote-signer sessions alike.
    const dispatchBody = widgetSource.slice(
      widgetSource.indexOf("private dispatchLogin"),
      widgetSource.indexOf("private noteSignerClaim")
    );
    expect(dispatchBody).toContain("setActiveSession(this");
    expect(dispatchBody).toContain("loginEventDetail");
    expect(dispatchBody).toContain('dispatchBitLoginEvent');
    // Both logout branches and DOM removal clear it.
    const clearCount = widgetSource.split("clearActiveSession(this)").length - 1;
    expect(clearCount).toBe(3);
  });

  it("does not dispatch hyphenated host events except through dispatchBitLoginEvent", () => {
    expect(widgetSource).not.toMatch(/new CustomEvent\("bitlogin-/);
    expect(indexSource).not.toMatch(/new CustomEvent\("bitlogin-/);
    expect(widgetSource).toContain("dispatchBitLoginEvent(");
    expect(indexSource).toContain('dispatchBitLoginEvent(window, "bitlogin-signer-released")');
  });
});
