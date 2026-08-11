import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import {
  PUBLIC_SESSION_KEY,
  clearPublicSession,
  loadPublicSession,
  parsePublicSession,
  savePublicSession
} from "./publicSession.js";

class TestStore implements KeyValueStore {
  values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

const info = { pubkey: "a".repeat(64), npub: "npub1example", name: "Ada" };

describe("public session record", () => {
  it("round-trips the public identity", async () => {
    const store = new TestStore();
    await savePublicSession(store, info);
    await expect(loadPublicSession(store)).resolves.toEqual(info);
  });

  it("stores only public data -- never key material", async () => {
    const store = new TestStore();
    await savePublicSession(store, info);
    const raw = store.values.get(PUBLIC_SESSION_KEY) || "";
    // Sanity: the record is the pubkey/npub/name and nothing that looks like a
    // 32-byte hex private key field.
    expect(raw).toContain(info.pubkey);
    expect(raw).not.toMatch(/privatekey|nsec|everyday/i);
  });

  it("omits name when the widget doesn't know one", async () => {
    const store = new TestStore();
    await savePublicSession(store, { pubkey: info.pubkey, npub: info.npub });
    const loaded = await loadPublicSession(store);
    expect(loaded).toEqual({ pubkey: info.pubkey, npub: info.npub });
    expect(loaded).not.toHaveProperty("name");
  });

  it("returns null when nothing is stored", async () => {
    await expect(loadPublicSession(new TestStore())).resolves.toBeNull();
  });

  it("clear removes the record so 'signed in' can't outlive logout", async () => {
    const store = new TestStore();
    await savePublicSession(store, info);
    await clearPublicSession(store);
    expect(store.values.has(PUBLIC_SESSION_KEY)).toBe(false);
    await expect(loadPublicSession(store)).resolves.toBeNull();
  });

  describe("parsePublicSession", () => {
    it("accepts a well-formed record", () => {
      expect(parsePublicSession(JSON.stringify(info))).toEqual(info);
    });

    it("treats corrupt or partial records as no session, not an error", () => {
      expect(parsePublicSession(null)).toBeNull();
      expect(parsePublicSession("")).toBeNull();
      expect(parsePublicSession("not json")).toBeNull();
      expect(parsePublicSession("{}")).toBeNull();
      expect(parsePublicSession(JSON.stringify({ pubkey: "a".repeat(64) }))).toBeNull();
      expect(parsePublicSession(JSON.stringify({ npub: "npub1x" }))).toBeNull();
    });

    it("drops an empty name rather than surfacing a blank identity", () => {
      const parsed = parsePublicSession(JSON.stringify({ ...info, name: "" }));
      expect(parsed).toEqual({ pubkey: info.pubkey, npub: info.npub });
    });
  });
});
