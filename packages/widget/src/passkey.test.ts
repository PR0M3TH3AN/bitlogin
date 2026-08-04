import { describe, expect, it } from "vitest";
import {
  buildPasskeyCreateOptions,
  buildPasskeyGetOptions,
  deriveCredentialFromPrf,
  extractPrfOutput,
  PASSKEY_PRF_SALT,
  passkeySupported
} from "./passkey.js";

describe("deriveCredentialFromPrf — COMPATIBILITY CONTRACT", () => {
  // ── Known-answer pins. A failure here is NEVER "update the expected
  // value": the same passkey must derive the same account forever, so a
  // change orphans every passkey account in existence. Treat exactly like
  // a knownAnswer.test.ts failure (see docs/TODO.md standing rule).
  it("derives the frozen v1 vectors", () => {
    const sevens = new Uint8Array(32).fill(7);
    expect(deriveCredentialFromPrf(sevens)).toEqual({
      loginName: "pk-99b383c32c6b",
      password: "f4rddm8bDeP8PJB4UldrqF-L13-M-VnEoZIO9P3pD_k"
    });
    const counting = new Uint8Array(32);
    for (let i = 0; i < 32; i++) counting[i] = i;
    expect(deriveCredentialFromPrf(counting)).toEqual({
      loginName: "pk-bc67cb7f4896",
      password: "HdoORO04b-emzXVVdbBlDh82XqMYi5468cU4zLy__q0"
    });
  });

  it("the PRF evaluation salt is the frozen v1 constant", () => {
    expect(new TextDecoder().decode(PASSKEY_PRF_SALT)).toBe("bitlogin:passkey-credential:v1");
  });

  it("is deterministic and input-sensitive", () => {
    const a = new Uint8Array(32).fill(1);
    const b = new Uint8Array(32).fill(2);
    expect(deriveCredentialFromPrf(a)).toEqual(deriveCredentialFromPrf(a));
    expect(deriveCredentialFromPrf(a).loginName).not.toBe(deriveCredentialFromPrf(b).loginName);
    expect(deriveCredentialFromPrf(a).password).not.toBe(deriveCredentialFromPrf(b).password);
  });

  it("produces a valid login name shape and a full-entropy password", () => {
    const parts = deriveCredentialFromPrf(new Uint8Array(32).fill(9));
    expect(parts.loginName).toMatch(/^pk-[0-9a-f]{12}$/u);
    expect(parts.password.length).toBeGreaterThanOrEqual(43); // 32 bytes base64url
  });

  it("rejects PRF outputs that are not 32 bytes", () => {
    expect(() => deriveCredentialFromPrf(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => deriveCredentialFromPrf(new Uint8Array(0))).toThrow(/32 bytes/);
  });
});

describe("ceremony options", () => {
  it("sign-in options: discoverable, user-verified, PRF evaluated with the v1 salt", () => {
    const options = buildPasskeyGetOptions().publicKey!;
    expect(options.userVerification).toBe("required");
    expect(options.challenge).toBeInstanceOf(Uint8Array);
    const prf = (options.extensions as { prf: { eval: { first: Uint8Array } } }).prf;
    expect(prf.eval.first).toBe(PASSKEY_PRF_SALT);
    expect("allowCredentials" in options).toBe(false);
  });

  it("create options: resident key required, both alg families, opaque random user id", () => {
    const a = buildPasskeyCreateOptions("BitLogin").publicKey!;
    const b = buildPasskeyCreateOptions("BitLogin").publicKey!;
    expect(a.authenticatorSelection).toEqual({ residentKey: "required", userVerification: "required" });
    expect(a.pubKeyCredParams.map((p) => p.alg)).toEqual([-7, -257]);
    expect(a.user.id).not.toEqual(b.user.id);
    const prf = (a.extensions as { prf: { eval: { first: Uint8Array } } }).prf;
    expect(prf.eval.first).toBe(PASSKEY_PRF_SALT);
  });

  it("honors an explicit rpId in both ceremonies", () => {
    expect(buildPasskeyGetOptions("site.example").publicKey!.rpId).toBe("site.example");
    expect(buildPasskeyCreateOptions("BitLogin", "site.example").publicKey!.rp.id).toBe("site.example");
  });

  it("pins the assertion to one credential when given (audit BL-17)", () => {
    // The post-creation PRF fallback MUST scope discovery to the passkey
    // just created; an open sheet could bind an older passkey's account.
    const rawId = new Uint8Array(16).fill(3).buffer;
    const options = buildPasskeyGetOptions(undefined, rawId).publicKey!;
    expect(options.allowCredentials).toEqual([{ type: "public-key", id: rawId }]);
  });

  it("labels each created passkey distinguishably (audit follow-up)", () => {
    const a = buildPasskeyCreateOptions("BitLogin").publicKey!;
    const b = buildPasskeyCreateOptions("BitLogin").publicKey!;
    expect(a.user.name).toMatch(/^BitLogin \([0-9a-f]{4}\)$/u);
    expect(a.user.displayName).toBe(a.user.name);
    expect(a.user.name).not.toBe(b.user.name);
  });
});

describe("extractPrfOutput", () => {
  const fake = (results: unknown) =>
    ({ getClientExtensionResults: () => results }) as {
      getClientExtensionResults(): AuthenticationExtensionsClientOutputs;
    };

  it("returns the 32-byte PRF result from ArrayBuffer or view", () => {
    const bytes = new Uint8Array(32).fill(5);
    expect(extractPrfOutput(fake({ prf: { results: { first: bytes.buffer } } }))).toEqual(bytes);
    expect(extractPrfOutput(fake({ prf: { results: { first: bytes } } }))).toEqual(bytes);
  });

  it("returns null when PRF is absent or wrong-sized (unsupported authenticator)", () => {
    expect(extractPrfOutput(fake({}))).toBeNull();
    expect(extractPrfOutput(fake({ prf: {} }))).toBeNull();
    expect(extractPrfOutput(fake({ prf: { results: { first: new Uint8Array(16) } } }))).toBeNull();
  });
});

describe("passkeySupported", () => {
  it("detects the WebAuthn entry point", () => {
    expect(passkeySupported({ PublicKeyCredential: function stub() {} })).toBe(true);
    expect(passkeySupported({})).toBe(false);
  });
});
