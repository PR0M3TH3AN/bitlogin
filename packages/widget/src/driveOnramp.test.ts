import { describe, expect, it, vi } from "vitest";
import {
  buildGoogleAuthUrl,
  buildGoogleTokenMessage,
  currentRedirectUri,
  findDriveCredential,
  newGoogleOnrampState,
  parseGoogleCallbackFragment,
  parseGoogleOnrampConfig,
  storeDriveCredential,
  validateGoogleTokenMessage
} from "./driveOnramp.js";

const CLIENT = { clientId: "abc123.apps.googleusercontent.com" };

describe("config and auth URL", () => {
  it("parses a client id and ignores blanks", () => {
    expect(parseGoogleOnrampConfig(" abc.apps.googleusercontent.com ")).toEqual({
      clientId: "abc.apps.googleusercontent.com"
    });
    expect(parseGoogleOnrampConfig(null)).toBeUndefined();
    expect(parseGoogleOnrampConfig("   ")).toBeUndefined();
  });

  it("builds an implicit-grant URL with the app-data scope only", () => {
    const url = new URL(buildGoogleAuthUrl(CLIENT, "https://site.example/login.html", "st4te"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe("https://site.example/login.html");
    expect(url.searchParams.get("response_type")).toBe("token");
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/drive.appdata");
    expect(url.searchParams.get("state")).toBe("st4te");
  });

  it("derives the redirect URI from the page, stripping query and fragment", () => {
    expect(currentRedirectUri({ origin: "https://site.example", pathname: "/account.html" })).toBe(
      "https://site.example/account.html"
    );
  });

  it("mints distinct states", () => {
    expect(newGoogleOnrampState()).not.toBe(newGoogleOnrampState());
  });
});

describe("callback fragment and relay message", () => {
  it("parses a token callback and round-trips through the relay message", () => {
    const parsed = parseGoogleCallbackFragment("#state=st4te&access_token=ya29.token&token_type=Bearer");
    expect(parsed).toEqual({ state: "st4te", accessToken: "ya29.token" });
    expect(buildGoogleTokenMessage(parsed!)).toEqual({
      type: "bitlogin:onramp:google-token",
      state: "st4te",
      accessToken: "ya29.token"
    });
  });

  it("parses an error callback", () => {
    expect(parseGoogleCallbackFragment("#error=access_denied&state=st4te")).toEqual({
      state: "st4te",
      error: "access_denied"
    });
  });

  it("returns null for ordinary fragments and callbacks without state", () => {
    expect(parseGoogleCallbackFragment("")).toBeNull();
    expect(parseGoogleCallbackFragment("#section-2")).toBeNull();
    expect(parseGoogleCallbackFragment("#access_token=tok")).toBeNull();
  });

  it("validates the relay message against origin and state", () => {
    const good = {
      origin: "https://site.example",
      data: { type: "bitlogin:onramp:google-token", state: "st4te", accessToken: "tok" }
    };
    const expected = { origin: "https://site.example", state: "st4te" };
    expect(validateGoogleTokenMessage(good, expected)).toEqual({ accessToken: "tok" });
    expect(
      validateGoogleTokenMessage({ ...good, origin: "https://evil.example" }, expected)
    ).toBeNull();
    expect(
      validateGoogleTokenMessage(
        { origin: good.origin, data: { ...good.data, state: "other" } },
        expected
      )
    ).toBeNull();
    expect(
      validateGoogleTokenMessage(
        { origin: good.origin, data: { type: "bitlogin:onramp:google-token", state: "st4te", error: "access_denied" } },
        expected
      )
    ).toEqual({ error: "access_denied" });
  });
});

describe("Drive credential I/O", () => {
  const CRED = { loginName: "sunny-otter", password: "corr-ect-hor-se" };

  function jsonResponse(status: number, body?: unknown): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body)
    } as unknown as Response;
  }

  it("finds and reads a returning user's credential", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { files: [{ id: "f1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { v: 1, ...CRED }));
    expect(await findDriveCredential("tok", fetchImpl as unknown as typeof fetch)).toEqual(CRED);
    const [listUrl, listInit] = fetchImpl.mock.calls[0]!;
    expect(String(listUrl)).toContain("https://www.googleapis.com/drive/v3/files?");
    expect(String(listUrl)).toContain("appDataFolder");
    expect((listInit as RequestInit).headers).toEqual({ authorization: "Bearer tok" });
    expect(String(fetchImpl.mock.calls[1]![0])).toContain("/files/f1?alt=media");
  });

  it("resolves null for a first-time user", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonResponse(200, { files: [] }));
    expect(await findDriveCredential("tok", fetchImpl as unknown as typeof fetch)).toBeNull();
  });

  it("rejects on auth failure and on malformed stored data", async () => {
    const unauthorized = vi.fn().mockResolvedValueOnce(jsonResponse(401));
    await expect(findDriveCredential("tok", unauthorized as unknown as typeof fetch)).rejects.toThrow(
      /did not accept/
    );
    const malformed = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { files: [{ id: "f1" }] }))
      .mockResolvedValueOnce(jsonResponse(200, { v: 1, loginName: "x" }));
    await expect(findDriveCredential("tok", malformed as unknown as typeof fetch)).rejects.toThrow(
      /incomplete/
    );
  });

  it("stores a new credential as multipart app-data upload", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await storeDriveCredential("tok", CRED, fetchImpl as unknown as typeof fetch);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart");
    const request = init as RequestInit;
    expect(request.method).toBe("POST");
    const body = String(request.body);
    expect(body).toContain('"appDataFolder"');
    expect(body).toContain('"bitlogin-credential-v1.json"');
    expect(body).toContain('"sunny-otter"');
    expect((request.headers as Record<string, string>)["content-type"]).toMatch(
      /^multipart\/related; boundary=/u
    );
  });

  it("throws a phrase-preserving error when the upload fails", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500));
    await expect(
      storeDriveCredential("tok", CRED, fetchImpl as unknown as typeof fetch)
    ).rejects.toThrow(/recovery phrase/);
  });
});
