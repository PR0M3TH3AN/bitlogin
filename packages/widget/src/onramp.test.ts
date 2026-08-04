import { describe, expect, it, vi } from "vitest";
import {
  buildOnrampAuthUrl,
  newOnrampState,
  onrampProviderLabel,
  parseOnrampConfig,
  storeOnrampCredential,
  validateOnrampMessage,
  type OnrampConfig
} from "./onramp.js";

const CONFIG: OnrampConfig = {
  url: "https://onramp.example/bitlogin",
  origin: "https://onramp.example",
  name: "AcmeSigner",
  providers: ["google", "github"]
};

describe("parseOnrampConfig", () => {
  it("returns undefined when unconfigured, without warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(parseOnrampConfig({ url: null, name: null, providers: null })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("parses a full configuration and derives the origin", () => {
    const config = parseOnrampConfig({
      url: "https://onramp.example/bitlogin",
      name: " AcmeSigner ",
      providers: "Google, github ,"
    })!;
    expect(config.origin).toBe("https://onramp.example");
    expect(config.name).toBe("AcmeSigner");
    expect(config.providers).toEqual(["google", "github"]);
  });

  it("rejects non-https URLs (except loopback), empty providers, and a missing name -- loudly", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      parseOnrampConfig({ url: "http://onramp.example/x", name: "A", providers: "google" })
    ).toBeUndefined();
    expect(
      parseOnrampConfig({ url: "https://onramp.example/x", name: "A", providers: " , " })
    ).toBeUndefined();
    expect(
      parseOnrampConfig({ url: "https://onramp.example/x", name: "  ", providers: "google" })
    ).toBeUndefined();
    expect(parseOnrampConfig({ url: "not a url", name: "A", providers: "google" })).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(4);
    expect(
      parseOnrampConfig({ url: "http://localhost:8787/x", name: "Dev", providers: "google" })
    ).toBeDefined();
    warn.mockRestore();
  });
});

describe("auth URL and state", () => {
  it("appends provider, state, and page origin to the configured URL", () => {
    const url = new URL(buildOnrampAuthUrl(CONFIG, "google", "abc123", "https://site.example"));
    expect(url.origin).toBe("https://onramp.example");
    expect(url.pathname).toBe("/bitlogin");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("state")).toBe("abc123");
    expect(url.searchParams.get("origin")).toBe("https://site.example");
  });

  it("mints distinct high-entropy states", () => {
    const a = newOnrampState();
    const b = newOnrampState();
    expect(a).toMatch(/^[0-9a-f]{32}$/u);
    expect(a).not.toBe(b);
  });

  it("labels known providers and capitalizes unknown ones", () => {
    expect(onrampProviderLabel("google")).toBe("Google");
    expect(onrampProviderLabel("github")).toBe("GitHub");
    expect(onrampProviderLabel("keycloak")).toBe("Keycloak");
  });
});

describe("validateOnrampMessage", () => {
  const expected = { origin: CONFIG.origin, state: "state1" };
  const unlockMsg = {
    type: "bitlogin:onramp:unlock",
    state: "state1",
    unlock: { loginName: "user1", password: "pw-pw-pw-pw" }
  };

  it("accepts a well-formed unlock from the exact origin and state", () => {
    expect(validateOnrampMessage({ origin: CONFIG.origin, data: unlockMsg }, expected)).toEqual({
      kind: "unlock",
      loginName: "user1",
      password: "pw-pw-pw-pw"
    });
  });

  it("accepts a well-formed register branch", () => {
    const result = validateOnrampMessage(
      {
        origin: CONFIG.origin,
        data: {
          type: "bitlogin:onramp:unlock",
          state: "state1",
          register: { registrationToken: "tok", suggestedLoginName: "sunny-otter" }
        }
      },
      expected
    );
    expect(result).toEqual({ kind: "register", registrationToken: "tok", suggestedLoginName: "sunny-otter" });
  });

  it("rejects wrong origin, wrong state, wrong type, both branches, and malformed shapes", () => {
    expect(
      validateOnrampMessage({ origin: "https://evil.example", data: unlockMsg }, expected)
    ).toBeNull();
    expect(
      validateOnrampMessage({ origin: CONFIG.origin, data: { ...unlockMsg, state: "other" } }, expected)
    ).toBeNull();
    expect(
      validateOnrampMessage({ origin: CONFIG.origin, data: { ...unlockMsg, type: "hello" } }, expected)
    ).toBeNull();
    expect(
      validateOnrampMessage(
        {
          origin: CONFIG.origin,
          data: { ...unlockMsg, register: { registrationToken: "tok" } }
        },
        expected
      )
    ).toBeNull();
    expect(
      validateOnrampMessage(
        {
          origin: CONFIG.origin,
          data: { type: "bitlogin:onramp:unlock", state: "state1", unlock: { loginName: "u" } }
        },
        expected
      )
    ).toBeNull();
    expect(validateOnrampMessage({ origin: CONFIG.origin, data: null }, expected)).toBeNull();
    expect(validateOnrampMessage({ origin: CONFIG.origin, data: "string" }, expected)).toBeNull();
  });
});

describe("storeOnrampCredential", () => {
  const payload = { registrationToken: "tok", loginName: "user1", password: "pw" };

  it("POSTs the credential to the configured URL only, and resolves on ok", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    await storeOnrampCredential(CONFIG, payload, fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(CONFIG.url);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      type: "bitlogin:onramp:store",
      ...payload
    });
  });

  it("throws a phrase-preserving error when the service refuses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    await expect(
      storeOnrampCredential(CONFIG, payload, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/recovery phrase/);
  });
});
