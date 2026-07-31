import { describe, expect, it } from "vitest";
import { SerialQueue } from "./serialQueue.js";

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
