import { describe, expect, it } from "vitest";
import { LaneQueue, SerialQueue } from "./serialQueue.js";

describe("SerialQueue", () => {
  it("does not let logout be overwritten by an earlier async login", async () => {
    const queue = new SerialQueue();
    let releaseLogin!: () => void;
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    let state = "logged-out";

    const login = queue.run(async () => {
      await loginGate;
      state = "logged-in";
    });
    const logout = queue.run(async () => {
      state = "logged-out";
    });

    await Promise.resolve();
    expect(state).toBe("logged-out");
    releaseLogin();
    await Promise.all([login, logout]);
    expect(state).toBe("logged-out");
  });

  it("continues after a failed request", async () => {
    const queue = new SerialQueue();
    await expect(queue.run(async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(queue.run(async () => "next")).resolves.toBe("next");
  });
});

describe("LaneQueue", () => {
  const gate = () => {
    let open!: () => void;
    const shut = new Promise<void>((resolve) => (open = resolve));
    return { shut, open };
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("runs different stores side by side, and one store's work in order", async () => {
    const queue = new LaneQueue();
    const wallet = gate();
    const seen: string[] = [];
    const slow = queue.run("ecash", async () => (await wallet.shut, seen.push("wallet read")));
    const files = queue.run("drive", async () => seen.push("folders read"));
    const walletNext = queue.run("ecash", async () => seen.push("wallet spend"));
    await files;
    await tick();
    expect(seen).toEqual(["folders read"]);
    wallet.open();
    await Promise.all([slow, walletNext]);
    expect(seen).toEqual(["folders read", "wallet read", "wallet spend"]);
  });

  it("runs work outside every line alone: after what came before, and before what comes after", async () => {
    const queue = new LaneQueue();
    const wallet = gate();
    const seen: string[] = [];
    const read = queue.run("ecash", async () => (await wallet.shut, seen.push("wallet read")));
    const logout = queue.run(null, async () => seen.push("logout"));
    const after = queue.run("drive", async () => seen.push("folders read"));
    await tick();
    expect(seen).toEqual([]);
    wallet.open();
    await Promise.all([read, logout, after]);
    expect(seen).toEqual(["wallet read", "logout", "folders read"]);
  });

  it("goes on after a failure, in a line and alone", async () => {
    const queue = new LaneQueue();
    await expect(queue.run("ecash", async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(queue.run("ecash", async () => "ok")).resolves.toBe("ok");
    await expect(queue.run(null, async () => Promise.reject(new Error("failed")))).rejects.toThrow("failed");
    await expect(queue.run("drive", async () => "ok")).resolves.toBe("ok");
  });
});
