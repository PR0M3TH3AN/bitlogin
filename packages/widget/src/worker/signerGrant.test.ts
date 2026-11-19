import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { deleteSignerGrant, GRANT_LIMITS, grantSite, loadSignerGrant, saveSignerGrant } from "./signerGrant.js";

class TestStore implements KeyValueStore {
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
}

const SITE = "https://app.example";
const NOW = 1_794_000_000;
const key = new Uint8Array(32).fill(7);
const grant = (over: Partial<Parameters<typeof saveSignerGrant>[1]> = {}) => ({ site: SITE, everydayPrivateKey: key, until: NOW + 3600, name: "Alice", signed: [1, 2, 3], ...over });

describe("what the embedded signer remembers for a site", () => {
  it("comes back as it was kept, and is never in the store in the clear", async () => {
    const store = new TestStore();
    expect(await saveSignerGrant(store, grant(), NOW)).toBe(true);
    const raw = [...store.values.values()].join("");
    expect(raw).not.toContain("07070707");
    expect(raw).not.toContain("Alice");
    // Under a name of its own: never where a full session is kept.
    expect([...store.values.keys()]).toEqual([`bitlogin:signer-grant:v1:${SITE}`]);
    expect([...store.keys.keys()]).toEqual(["bitlogin:signer-grant-device-key:v1"]);
    const back = await loadSignerGrant(store, SITE, NOW + 60);
    expect(back).toMatchObject({ site: SITE, until: NOW + 3600, name: "Alice", signed: [1, 2, 3] });
    expect([...back!.everydayPrivateKey]).toEqual([...key]);
  });

  it("is for one site: another site, or another address of the same site, finds nothing", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, grant(), NOW);
    expect(await loadSignerGrant(store, "https://other.example", NOW)).toBeNull();
    expect(await loadSignerGrant(store, "https://sub.app.example", NOW)).toBeNull();
    expect(await loadSignerGrant(store, "http://app.example", NOW)).toBeNull();
    // A record moved under another site's name is still for the site named inside it.
    store.values.set("bitlogin:signer-grant:v1:https://other.example", store.values.get(`bitlogin:signer-grant:v1:${SITE}`)!);
    expect(await loadSignerGrant(store, "https://other.example", NOW)).toBeNull();
  });

  it("stops at its date, and is removed then", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, grant(), NOW);
    expect(await loadSignerGrant(store, SITE, NOW + 3599)).not.toBeNull();
    expect(await loadSignerGrant(store, SITE, NOW + 3600)).toBeNull();
    expect(store.values.size).toBe(0);
  });

  it("is never kept longer than the limit, whatever is asked", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, grant({ until: NOW + 10 * 365 * 24 * 3600 }), NOW);
    expect((await loadSignerGrant(store, SITE, NOW))!.until).toBe(NOW + GRANT_LIMITS.keepSec);
    expect(await loadSignerGrant(store, SITE, NOW + GRANT_LIMITS.keepSec + 1)).toBeNull();
  });

  it("keeps nothing that isn't a grant, or where it couldn't be kept encrypted", async () => {
    const store = new TestStore();
    expect(await saveSignerGrant(store, grant({ site: "https://app.example/path" }), NOW)).toBe(false);
    expect(await saveSignerGrant(store, grant({ site: "javascript:alert(1)" }), NOW)).toBe(false);
    expect(await saveSignerGrant(store, grant({ everydayPrivateKey: new Uint8Array(5) }), NOW)).toBe(false);
    expect(await saveSignerGrant(store, grant({ until: NOW - 1 }), NOW)).toBe(false);
    const plain: KeyValueStore = { get: async () => undefined, set: async () => {}, delete: async () => {} };
    expect(await saveSignerGrant(plain, grant(), NOW)).toBe(false);
    expect(store.values.size).toBe(0);
  });

  it("reads anything unreadable as nothing kept", async () => {
    const store = new TestStore();
    store.values.set(`bitlogin:signer-grant:v1:${SITE}`, "{not json");
    expect(await loadSignerGrant(store, SITE, NOW)).toBeNull();
    store.values.set(`bitlogin:signer-grant:v1:${SITE}`, JSON.stringify({ v: 1, iv: "AAAA", ciphertext: "AAAA" }));
    expect(await loadSignerGrant(store, SITE, NOW)).toBeNull();
  });

  it("is forgotten when asked, and only that site's", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, grant(), NOW);
    await saveSignerGrant(store, grant({ site: "https://other.example" }), NOW);
    await deleteSignerGrant(store, SITE);
    expect(await loadSignerGrant(store, SITE, NOW)).toBeNull();
    expect(await loadSignerGrant(store, "https://other.example", NOW)).not.toBeNull();
  });

  it("counts the last signatures, and no more than it needs", async () => {
    const store = new TestStore();
    await saveSignerGrant(store, grant({ signed: Array.from({ length: 200 }, (_, i) => i) }), NOW);
    const back = await loadSignerGrant(store, SITE, NOW);
    expect(back!.signed).toHaveLength(GRANT_LIMITS.signedKept);
    expect(back!.signed.at(-1)).toBe(199);
  });

  it("a site is exactly an origin", () => {
    expect(grantSite(SITE)).toBe(SITE);
    for (const not of ["https://app.example/", "https://app.example/x", "javascript:alert(1)", "", 7, null, "app.example"]) expect(grantSite(not)).toBe("");
  });

  it("keeps what an application was approved for with the grant, and its sensitive count apart", async () => {
    const store = new TestStore();
    const permissions = { name: "Example", sign: [0, 1, 27235], appData: [], proofs: ["https://api.example"], read: [], peers: [] };
    expect(await saveSignerGrant(store, grant({ permissions, signed: [1, 2, 3], signedSensitive: [4] }), NOW)).toBe(true);
    const kept = await loadSignerGrant(store, SITE, NOW);
    expect(kept?.permissions).toEqual(permissions);
    expect(kept?.signed).toEqual([1, 2, 3]);
    expect(kept?.signedSensitive).toEqual([4]);
    // Not in the store in the clear either.
    expect([...store.values.values()].join("")).not.toContain("api.example");
    // A site that declared nothing has no set, and is counted as before.
    await saveSignerGrant(store, grant(), NOW);
    const plain = await loadSignerGrant(store, SITE, NOW);
    expect(plain?.permissions).toBeUndefined();
    expect(plain?.signedSensitive).toBeUndefined();
  });

  it("ends a grant whose permission set no longer reads as one, instead of restoring part of it", async () => {
    const store = new TestStore();
    // Written as a rule-abiding set would be, then the rule tightens: here, a kind that is now never signed.
    const permissions = { sign: [1, 27302], appData: [], proofs: [], read: [], peers: [] };
    expect(await saveSignerGrant(store, grant({ permissions }), NOW)).toBe(true);
    expect(await loadSignerGrant(store, SITE, NOW)).toBeNull();
    // And it is gone, so the user is asked again and sees what is asked.
    expect(store.values.size).toBe(0);
  });
});
