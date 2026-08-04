import { describe, expect, it } from "vitest";
import { signNostrEvent } from "@bitlogin/core/nostr";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { detectForeignNip07Provider, Nip07Signer, type ForeignNip07Provider } from "./nip07.js";
import { SignerTimeoutError, SignerUnsupportedError } from "./types.js";

// A real key: the signer now VERIFIES what the "extension" returns, so the
// fake must produce genuinely signed events.
const EXTENSION_KEY = generatePrivateKey();
const PUBKEY = getPublicKeyHex(EXTENSION_KEY);

function fullProvider(overrides: Partial<ForeignNip07Provider> = {}): ForeignNip07Provider {
  return {
    getPublicKey: async () => PUBKEY,
    signEvent: async (event) => signNostrEvent({ ...event, pubkey: PUBKEY }, EXTENSION_KEY),
    getRelays: async () => ({}),
    nip44: {
      encrypt: async (peer, plaintext) => `nip44(${peer.slice(0, 4)},${plaintext})`,
      decrypt: async (peer, payload) => `plain44(${payload})`
    },
    nip04: {
      encrypt: async (peer, plaintext) => `nip04(${plaintext})`,
      decrypt: async (peer, payload) => `plain04(${payload})`
    },
    ...overrides
  };
}

describe("detectForeignNip07Provider", () => {
  it("returns null when window.nostr is empty", () => {
    expect(detectForeignNip07Provider({})).toBeNull();
    expect(detectForeignNip07Provider({ nostr: undefined })).toBeNull();
    expect(detectForeignNip07Provider({ nostr: null })).toBeNull();
  });

  it("never mistakes BitLogin's own provider (this or another widget instance) for an extension", () => {
    const ours = { ...fullProvider(), _bitlogin: true };
    expect(detectForeignNip07Provider({ nostr: ours })).toBeNull();
  });

  it("rejects occupants missing the two mandatory NIP-07 calls", () => {
    expect(detectForeignNip07Provider({ nostr: { getPublicKey: async () => PUBKEY } })).toBeNull();
    expect(detectForeignNip07Provider({ nostr: { signEvent: async () => ({}) } })).toBeNull();
    expect(detectForeignNip07Provider({ nostr: "not-an-object" })).toBeNull();
  });

  it("returns the same reference it was given for a real extension provider", () => {
    const extension = fullProvider();
    expect(detectForeignNip07Provider({ nostr: extension })).toBe(extension);
  });
});

describe("Nip07Signer capability probing", () => {
  it("reports full capabilities for a complete provider", () => {
    const signer = new Nip07Signer(fullProvider());
    expect(signer.method).toBe("nip07");
    expect(signer.capabilities).toEqual({ nip44: true, nip04: true, getRelays: true });
  });

  it("reports honestly when nip44 or nip04 is missing or partial", () => {
    expect(new Nip07Signer(fullProvider({ nip44: undefined })).capabilities.nip44).toBe(false);
    expect(
      new Nip07Signer(fullProvider({ nip44: { encrypt: async () => "" } })).capabilities.nip44
    ).toBe(false);
    expect(new Nip07Signer(fullProvider({ nip04: undefined })).capabilities.nip04).toBe(false);
    expect(new Nip07Signer(fullProvider({ getRelays: undefined })).capabilities.getRelays).toBe(false);
  });

  it("rejects unsupported calls with a typed error instead of a TypeError", async () => {
    const signer = new Nip07Signer(fullProvider({ nip44: undefined }));
    await expect(signer.nip44Encrypt(PUBKEY, "hi")).rejects.toBeInstanceOf(SignerUnsupportedError);
    await expect(signer.nip44Decrypt(PUBKEY, "payload")).rejects.toBeInstanceOf(SignerUnsupportedError);
  });
});

describe("Nip07Signer delegation", () => {
  it("returns the extension's public key, lowercased", async () => {
    const signer = new Nip07Signer(fullProvider({ getPublicKey: async () => PUBKEY.toUpperCase() }));
    expect(await signer.getPublicKey()).toBe(PUBKEY);
  });

  it("rejects a malformed public key instead of passing it downstream", async () => {
    const signer = new Nip07Signer(fullProvider({ getPublicKey: async () => "npub1notrawhex" }));
    await expect(signer.getPublicKey()).rejects.toThrow(/invalid public key/);
  });

  it("normalizes the unsigned event: fills created_at and tags, preserves them when given", async () => {
    let seen: { kind: number; tags: string[][]; content: string; created_at: number } | null = null;
    const signer = new Nip07Signer(
      fullProvider({
        signEvent: async (event) => {
          seen = event;
          return signNostrEvent({ ...event, pubkey: PUBKEY }, EXTENSION_KEY);
        }
      })
    );
    await signer.signEvent({ kind: 1, content: "hello" });
    expect(seen!.tags).toEqual([]);
    expect(typeof seen!.created_at).toBe("number");

    await signer.signEvent({ kind: 1, content: "hello", tags: [["t", "x"]], created_at: 1234 });
    expect(seen!.tags).toEqual([["t", "x"]]);
    expect(seen!.created_at).toBe(1234);
  });

  it("rejects a returned event whose fields differ from the request", async () => {
    const signer = new Nip07Signer(
      fullProvider({
        signEvent: async (event) =>
          signNostrEvent({ ...event, pubkey: PUBKEY, content: "tampered" }, EXTENSION_KEY)
      })
    );
    await expect(signer.signEvent({ kind: 1, content: "original" })).rejects.toThrow(
      /different event/
    );
  });

  it("rejects an event signed by a different identity than the session's", async () => {
    const otherKey = generatePrivateKey();
    const signer = new Nip07Signer(
      fullProvider({
        signEvent: async (event) =>
          signNostrEvent({ ...event, pubkey: getPublicKeyHex(otherKey) }, otherKey)
      })
    );
    await signer.getPublicKey(); // pins the session identity
    await expect(signer.signEvent({ kind: 1, content: "x" })).rejects.toThrow(
      /different identity/
    );
  });

  it("passes nip44/nip04 calls through and surfaces the extension's own rejections", async () => {
    const signer = new Nip07Signer(fullProvider());
    expect(await signer.nip44Encrypt(PUBKEY, "hi")).toBe(`nip44(${PUBKEY.slice(0, 4)},hi)`);
    expect(await signer.nip04Decrypt(PUBKEY, "x")).toBe("plain04(x)");

    const declining = new Nip07Signer(
      fullProvider({ signEvent: async () => Promise.reject(new Error("User rejected")) })
    );
    await expect(declining.signEvent({ kind: 1, content: "" })).rejects.toThrow("User rejected");
  });
});

describe("Nip07Signer deadlines (no silent hangs)", () => {
  const never = () => new Promise<never>(() => {});

  it("times out getPublicKey with a typed, retryable error", async () => {
    const signer = new Nip07Signer(fullProvider({ getPublicKey: never }), { timeoutMs: 20 });
    await expect(signer.getPublicKey()).rejects.toBeInstanceOf(SignerTimeoutError);
  });

  it("times out signEvent and encryption calls too", async () => {
    const signer = new Nip07Signer(
      fullProvider({
        signEvent: never,
        nip44: { encrypt: never, decrypt: never }
      }),
      { timeoutMs: 20 }
    );
    await expect(signer.signEvent({ kind: 1, content: "" })).rejects.toBeInstanceOf(SignerTimeoutError);
    await expect(signer.nip44Encrypt(PUBKEY, "hi")).rejects.toBeInstanceOf(SignerTimeoutError);
  });

  it("does not time out a call that answers in time", async () => {
    const signer = new Nip07Signer(fullProvider(), { timeoutMs: 1000 });
    expect(await signer.getPublicKey()).toBe(PUBKEY);
  });
});
