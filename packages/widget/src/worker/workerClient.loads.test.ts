import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkerClient } from "./workerClient.js";

/** A stand-in worker: it keeps what it was asked, and answers only when told to. */
class FakeWorker {
  static last: FakeWorker;
  asked: { id: string; action: string }[] = [];
  private listener: ((event: { data: unknown }) => void) | null = null;
  constructor() {
    FakeWorker.last = this;
  }
  addEventListener(type: string, fn: (event: { data: unknown }) => void) {
    if (type === "message") this.listener = fn;
  }
  postMessage(request: { id: string; action: string }) {
    this.asked.push(request);
  }
  answer(index: number, result: unknown) {
    this.listener?.({ data: { id: this.asked[index]!.id, ok: true, result } });
  }
  terminate() {}
}

describe("WorkerClient's loads", () => {
  beforeEach(() => {
    (globalThis as { Worker?: unknown }).Worker = FakeWorker;
  });
  afterEach(() => {
    delete (globalThis as { Worker?: unknown }).Worker;
  });

  it("shares a load asked again while the first is still on its way, and asks anew once it is answered", async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.last;
    const first = client.driveLoad();
    void client.drivePeek(); // a look changes nothing, so the load already going is still right
    const second = client.driveLoad();
    expect(worker.asked.filter((r) => r.action === "driveLoad")).toHaveLength(1);
    worker.answer(0, { folders: "one" });
    expect(await first).toEqual({ folders: "one" });
    expect(await second).toEqual({ folders: "one" });
    void client.driveLoad();
    expect(worker.asked.filter((r) => r.action === "driveLoad")).toHaveLength(2);
  });

  it("never hands a load asked after a change the answer from before it", async () => {
    const client = new WorkerClient();
    const worker = FakeWorker.last;
    void client.driveLoad();
    void client.driveSave({} as never);
    void client.driveLoad();
    expect(worker.asked.map((r) => r.action)).toEqual(["driveLoad", "driveSave", "driveLoad"]);
  });
});
