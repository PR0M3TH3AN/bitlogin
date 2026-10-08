import { describe, expect, it } from "vitest";
import {
  BITLOGIN_COLON_ALIASES,
  dispatchBitLoginColonEvent,
  dispatchBitLoginEvent,
  loginEventDetail
} from "./events.js";
import { identityFields } from "./identity.js";

const CAPABILITIES = { nip44: true, nip04: true, getRelays: true };

describe("identityFields", () => {
  it("returns lowercase pubkey and an identical publicKey alias", () => {
    const hex = "AB".repeat(32);
    const ids = identityFields(hex);
    expect(ids.pubkey).toBe("ab".repeat(32));
    expect(ids.publicKey).toBe(ids.pubkey);
  });
});

describe("loginEventDetail", () => {
  it("includes pubkey and the deprecated publicKey alias", () => {
    const hex = "CD".repeat(32);
    const detail = loginEventDetail(hex, "bitlogin", CAPABILITIES);
    expect(detail.pubkey).toBe("cd".repeat(32));
    expect(detail.publicKey).toBe(detail.pubkey);
    expect(detail.method).toBe("bitlogin");
    expect(detail.capabilities).toEqual(CAPABILITIES);
  });

  it("omits identity fields when the hex is unknown", () => {
    const detail = loginEventDetail(undefined, "nip07", CAPABILITIES);
    expect(detail).not.toHaveProperty("pubkey");
    expect(detail).not.toHaveProperty("publicKey");
  });
});

describe("dispatchBitLoginEvent", () => {
  it("fires the hyphen name once and the colon alias once, sharing detail", () => {
    const target = new EventTarget();
    const detail = loginEventDetail("ab".repeat(32), "bitlogin", CAPABILITIES);
    const seen: { type: string; detail: unknown; bubbles: boolean; composed: boolean }[] = [];
    for (const type of ["bitlogin-login", "bitlogin:login"] as const) {
      target.addEventListener(type, (event) => {
        const custom = event as CustomEvent;
        seen.push({
          type: custom.type,
          detail: custom.detail,
          bubbles: custom.bubbles,
          composed: custom.composed
        });
      });
    }
    dispatchBitLoginEvent(target, "bitlogin-login", detail);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ type: "bitlogin-login", bubbles: false, composed: false });
    expect(seen[1]).toMatchObject({ type: "bitlogin:login", bubbles: true, composed: true });
    expect(seen[0]!.detail).toBe(detail);
    expect(seen[1]!.detail).toBe(detail);
  });

  it("a listener on the old hyphen name fires once, not twice", () => {
    const target = new EventTarget();
    let count = 0;
    target.addEventListener("bitlogin-login", () => {
      count += 1;
    });
    dispatchBitLoginEvent(
      target,
      "bitlogin-login",
      loginEventDetail("ab".repeat(32), "bitlogin", CAPABILITIES)
    );
    expect(count).toBe(1);
  });

  it("does not notify a hyphen listener when only the colon alias fires", () => {
    const target = new EventTarget();
    let hyphenCount = 0;
    target.addEventListener("bitlogin-logout", () => {
      hyphenCount += 1;
    });
    dispatchBitLoginColonEvent(target, "bitlogin:ready", {});
    expect(hyphenCount).toBe(0);
  });

  it("keeps empty hyphen detail as null and gives colon events an object", () => {
    const target = new EventTarget();
    let hyphenDetail: unknown;
    let colonDetail: unknown;
    target.addEventListener("bitlogin-logout", (event) => {
      hyphenDetail = (event as CustomEvent).detail;
    });
    target.addEventListener("bitlogin:logout", (event) => {
      colonDetail = (event as CustomEvent).detail;
    });
    dispatchBitLoginEvent(target, "bitlogin-logout");
    expect(hyphenDetail).toBeNull();
    expect(colonDetail).toEqual({});
  });

  it("maps every hyphenated host event to a colon alias", () => {
    expect(BITLOGIN_COLON_ALIASES).toEqual({
      "bitlogin-login": "bitlogin:login",
      "bitlogin-logout": "bitlogin:logout",
      "bitlogin-connection-granted": "bitlogin:connection-granted",
      "bitlogin-signer-claimed": "bitlogin:signer-claimed",
      "bitlogin-signer-released": "bitlogin:signer-released",
      "bitlogin-request-pending": "bitlogin:request-pending",
      "bitlogin-offer-pending": "bitlogin:offer-pending"
    });
  });
});
