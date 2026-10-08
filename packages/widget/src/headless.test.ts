import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHeadlessSigner } from "./headless.js";

const PK = "ab".repeat(32);

/** A crypto-worker stand-in that answers the protocol with canned results, so
 *  the headless signer's wiring can be tested without the real worker/wasm. */
class ScriptedWorker {
  static last: ScriptedWorker | null = null;
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  terminated = false;
  responses: Record<string, unknown> = {
    configure: {},
    restoreSession: { restored: true, everydayPublicKey: PK, accountId: "acct" },
    getSessionStatus: { unlocked: true, everydayPublicKey: PK },
    signEvent: { id: "e".repeat(64), pubkey: PK, kind: 1, content: "hi", tags: [], created_at: 1, sig: "s".repeat(128) },
    nip44Encrypt: { ciphertext: "CIPHER" },
    nip44Decrypt: { plaintext: "PLAIN" },
    logout: {}
  };
  constructor(_url: URL, _opts?: unknown) {
    ScriptedWorker.last = this;
  }
  addEventListener(type: string, cb: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  postMessage(msg: unknown): void {
    const { id, action } = msg as { id: string; action: string };
    const result = this.responses[action];
    queueMicrotask(() => {
      for (const cb of this.listeners.message ?? []) cb({ data: { id, ok: true, result } });
    });
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe("createHeadlessSigner", () => {
  beforeEach(() => {
    (globalThis as unknown as { Worker: unknown }).Worker = ScriptedWorker;
  });
  afterEach(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it("restores a cached session and exposes the identity", async () => {
    const signer = await createHeadlessSigner();
    await expect(signer.restore()).resolves.toEqual({ pubkey: PK, publicKey: PK });
    await expect(signer.getPublicKey()).resolves.toBe(PK);
    await expect(signer.isUnlocked()).resolves.toBe(true);
  });

  it("signs an event once a session is present", async () => {
    const signer = await createHeadlessSigner();
    await signer.restore();
    const signed = await signer.signEvent({ kind: 1, content: "hi", tags: [] });
    expect(signed.pubkey).toBe(PK);
    expect(signed.sig).toHaveLength(128);
  });

  it("encrypts/decrypts via nip44 after restore", async () => {
    const signer = await createHeadlessSigner();
    await signer.restore();
    await expect(signer.nip44Encrypt("cd".repeat(32), "secret")).resolves.toBe("CIPHER");
    await expect(signer.nip44Decrypt("cd".repeat(32), "CIPHER")).resolves.toBe("PLAIN");
  });

  it("falls back to getSessionStatus when getPublicKey is called before restore", async () => {
    const signer = await createHeadlessSigner();
    // No restore() — getPublicKey should consult getSessionStatus and succeed.
    await expect(signer.getPublicKey()).resolves.toBe(PK);
  });

  it("returns null from restore and rejects signing when no session is cached", async () => {
    const signer = await createHeadlessSigner();
    ScriptedWorker.last!.responses.restoreSession = { restored: false };
    ScriptedWorker.last!.responses.getSessionStatus = { unlocked: false };
    await expect(signer.restore()).resolves.toBeNull();
    await expect(signer.getPublicKey()).rejects.toThrow(/no session/i);
    await expect(signer.signEvent({ kind: 1, content: "x", tags: [] })).rejects.toThrow(/no session/i);
  });

  it("destroy() terminates the worker", async () => {
    const signer = await createHeadlessSigner();
    signer.destroy();
    expect(ScriptedWorker.last?.terminated).toBe(true);
  });
});
