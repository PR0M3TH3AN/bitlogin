import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { clearCachedSession, loadCachedSession, saveCachedSession } from "./sessionCache.js";

class TestSessionStore implements KeyValueStore {
  values = new Map<string, string>();
  keys = new Map<string, CryptoKey>();

  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  async getOrCreateDeviceKey(key: string): Promise<CryptoKey> {
    let value = this.keys.get(key);
    if (!value) {
      value = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      this.keys.set(key, value);
    }
    return value;
  }
  async deleteDeviceKey(key: string): Promise<void> { this.keys.delete(key); }
}

const session = {
  everydayPrivateKey: new Uint8Array(32).fill(7),
  accountId: "account",
  recoveryPublicKey: "a".repeat(64),
  activeCredentialEvent: { id: "credential" } as never,
  activeRecoveryEvent: { id: "recovery" } as never
};

describe("encrypted session cache", () => {
  it("restores seamlessly without storing the everyday private key in plaintext", async () => {
    const store = new TestSessionStore();
    await saveCachedSession(store, session);

    const raw = store.values.get("bitlogin:session:v1") || "";
    expect(raw).toContain('"v":2');
    expect(raw).not.toContain("07070707");

    const restored = await loadCachedSession(store);
    expect(restored?.everydayPrivateKey).toEqual(session.everydayPrivateKey);
    expect(restored?.accountId).toBe(session.accountId);
  });

  it("deletes a legacy plaintext session instead of restoring it", async () => {
    const store = new TestSessionStore();
    store.values.set("bitlogin:session:v1", JSON.stringify({
      everydayPrivateKeyHex: "07".repeat(32), accountId: "account", recoveryPublicKey: "a".repeat(64),
      activeCredentialEvent: { id: "credential" }, activeRecoveryEvent: { id: "recovery" }
    }));

    await expect(loadCachedSession(store)).resolves.toBeNull();
    expect(store.values.has("bitlogin:session:v1")).toBe(false);
  });

  it("clears both encrypted data and its browser-bound key on logout", async () => {
    const store = new TestSessionStore();
    await saveCachedSession(store, session);
    await clearCachedSession(store);
    expect(store.values.has("bitlogin:session:v1")).toBe(false);
    expect(store.keys.has("bitlogin:session-device-key:v1")).toBe(false);
  });
});
