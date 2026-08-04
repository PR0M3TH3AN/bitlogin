import { describe, expect, it } from "vitest";
import { Nip46Signer } from "./nip46.js";
import type { WorkerClient } from "../worker/workerClient.js";

const USER = "ab".repeat(32);

function fakeWorker(calls: Array<{ action: string; payload: unknown }>): WorkerClient {
  const record =
    (action: string, result: unknown) =>
    (payload: unknown): Promise<unknown> => {
      calls.push({ action, payload });
      return Promise.resolve(result);
    };
  return {
    nip46SignEvent: record("nip46SignEvent", { id: "e".repeat(64), pubkey: USER, sig: "f".repeat(128), kind: 1, tags: [], content: "x", created_at: 1 }),
    nip46Nip44Encrypt: record("nip46Nip44Encrypt", { ciphertext: "c44" }),
    nip46Nip44Decrypt: record("nip46Nip44Decrypt", { plaintext: "p44" }),
    nip46Nip04Encrypt: record("nip46Nip04Encrypt", { ciphertext: "c04" }),
    nip46Nip04Decrypt: record("nip46Nip04Decrypt", { plaintext: "p04" })
  } as unknown as WorkerClient;
}

describe("Nip46Signer", () => {
  it("answers getPublicKey locally with the connect-time identity", async () => {
    const signer = new Nip46Signer(fakeWorker([]), USER);
    expect(signer.method).toBe("nip46");
    expect(await signer.getPublicKey()).toBe(USER);
  });

  it("reports the full RPC capability surface", () => {
    const signer = new Nip46Signer(fakeWorker([]), USER);
    expect(signer.capabilities).toEqual({ nip44: true, nip04: true, getRelays: false });
  });

  it("delegates signing and encryption to the worker-held client, mapping fields", async () => {
    const calls: Array<{ action: string; payload: unknown }> = [];
    const signer = new Nip46Signer(fakeWorker(calls), USER);

    await signer.signEvent({ kind: 1, content: "hello", tags: [["t", "x"]], created_at: 123 });
    expect(calls[0]).toEqual({
      action: "nip46SignEvent",
      payload: { kind: 1, content: "hello", tags: [["t", "x"]], created_at: 123 }
    });

    expect(await signer.nip44Encrypt("cd".repeat(32), "hi")).toBe("c44");
    expect(await signer.nip44Decrypt("cd".repeat(32), "payload")).toBe("p44");
    expect(await signer.nip04Encrypt("cd".repeat(32), "hi")).toBe("c04");
    expect(await signer.nip04Decrypt("cd".repeat(32), "payload")).toBe("p04");
    expect(calls.map((c) => c.action)).toEqual([
      "nip46SignEvent",
      "nip46Nip44Encrypt",
      "nip46Nip44Decrypt",
      "nip46Nip04Encrypt",
      "nip46Nip04Decrypt"
    ]);
    expect(calls[1]!.payload).toEqual({ peerPublicKey: "cd".repeat(32), plaintext: "hi" });
  });
});
