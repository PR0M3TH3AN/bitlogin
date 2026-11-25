import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerClient } from "./workerClient.js";
import { errorResponse } from "./protocol.js";

/** Minimal stand-in for a real Worker: records posted messages but never
 *  answers, so a call stays pending until the client tears it down -- exactly
 *  the state an unmounted <bitlogin-auth> leaves behind. */
class FakeWorker {
  static instances: FakeWorker[] = [];
  listeners: Record<string, ((event: unknown) => void)[]> = {};
  posted: unknown[] = [];
  terminated = false;
  constructor(_url: URL, _opts?: unknown) {
    FakeWorker.instances.push(this);
  }
  addEventListener(type: string, cb: (event: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  postMessage(msg: unknown): void {
    this.posted.push(msg);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe("WorkerClient teardown", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  });
  afterEach(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it("rejects an in-flight call with the teardown reason instead of hanging", async () => {
    const client = new WorkerClient();
    const pending = client.getPublicKey();
    client.terminate("widget was unmounted");
    await expect(pending).rejects.toThrow("widget was unmounted");
    expect(FakeWorker.instances[0]?.terminated).toBe(true);
  });

  it("rejects calls made after teardown immediately, with the same reason", async () => {
    const client = new WorkerClient();
    client.terminate("widget was unmounted");
    await expect(client.getPublicKey()).rejects.toThrow("widget was unmounted");
  });

  it("falls back to a clear default reason when terminate() is given none", async () => {
    const client = new WorkerClient();
    const pending = client.signEvent({ kind: 1, content: "hi", tags: [] } as never);
    client.terminate();
    await expect(pending).rejects.toThrow(/torn down|reload the page/i);
  });
});

describe("an error from the worker", () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    (globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
  });
  afterEach(() => {
    delete (globalThis as unknown as { Worker?: unknown }).Worker;
  });

  it("reaches the caller with its code, as the worker sends it (fault 3)", async () => {
    const client = new WorkerClient();
    const pending = client.ecashReserve("00ad268c4d1f5826", [1]);
    const worker = FakeWorker.instances[0]!;
    const asked = worker.posted.at(-1) as { id: string; action: string };
    expect(asked.action).toBe("ecashReserve");
    // What the worker posts for a refusal with a code: the wallet tells "no lane" from a mint's error by it.
    const answer = errorResponse(asked.id, Object.assign(new Error("No lane is drawn for this keyset in this browser yet."), { code: "no-lane" }));
    for (const listener of worker.listeners.message ?? []) listener({ data: answer });
    await expect(pending).rejects.toMatchObject({ code: "no-lane", message: "No lane is drawn for this keyset in this browser yet." });
  });
});
