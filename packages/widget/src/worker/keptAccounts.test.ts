import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { generatePrivateKey, getPublicKeyHex } from "@bitlogin/core/crypto";
import { encodeNpub } from "@bitlogin/core/nostr";
import { describe as describeKept, forget, keep, KEPT_ACCOUNTS_KEY, KEPT_LIMITS, loadKept, readKept, saveKept } from "./keptAccounts.js";
import { cachedSessionState, clearSessionSlot, keptSlot, loadCachedSession, saveCachedSession, type CachedSessionData } from "./sessionCache.js";
import { SIGNER_ONLY_ACTIONS } from "./handoff.js";

const A = getPublicKeyHex(generatePrivateKey());
const B = getPublicKeyHex(generatePrivateKey());

describe("the list of accounts kept on a device (docs/account-switching.md)", () => {
  it("keeps the one most lately used first, and each once", () => {
    let list = keep([], A, 100, { name: "Ada" }).list;
    list = keep(list, B, 200).list;
    expect(list.map((e) => e.pubkey)).toEqual([B, A]);
    list = keep(list, A, 300).list;
    expect(list.map((e) => e.pubkey)).toEqual([A, B]);
    // What it was called is kept where nothing new is said.
    expect(list[0]).toMatchObject({ pubkey: A, npub: encodeNpub(A), name: "Ada", at: 300 });
    expect(forget(list, A).map((e) => e.pubkey)).toEqual([B]);
  });

  it("holds eight at most, and says which fell off so their slots can go", () => {
    let list: ReturnType<typeof readKept> = [];
    const keys = Array.from({ length: KEPT_LIMITS.accounts + 2 }, () => getPublicKeyHex(generatePrivateKey()));
    let dropped: string[] = [];
    keys.forEach((key, i) => {
      const next = keep(list, key, 100 + i);
      list = next.list;
      dropped = [...dropped, ...next.dropped];
    });
    expect(list).toHaveLength(KEPT_LIMITS.accounts);
    expect(dropped).toEqual([keys[0], keys[1]]);
  });

  it("calls an account what its own profile does, tidied, and never trusts a stored npub", () => {
    const list = describeKept(keep([], A, 100).list, A, { name: "Ada\u202e Lovelace ", picture: "http://no.example/x.png", about: "Line one\nline two" });
    expect(list[0]).toMatchObject({ name: "Ada Lovelace", about: "Line one line two" });
    expect(list[0]!.picture).toBeUndefined();
    const raw = JSON.stringify([{ pubkey: A, npub: encodeNpub(B), name: "Ada", at: 5 }, { pubkey: "nope", at: 9 }, { pubkey: A, at: 99 }, "junk", null]);
    expect(readKept(raw)).toEqual([{ pubkey: A, npub: encodeNpub(A), name: "Ada", at: 5 }]);
    expect(readKept("not json")).toEqual([]);
    expect(readKept(JSON.stringify({ pubkey: A }))).toEqual([]);
  });

  it("is stored as a list with no key material in it, and removed when empty", async () => {
    const values = new Map<string, string>();
    const store = { get: async (k: string) => values.get(k), set: async (k: string, v: string) => void values.set(k, v), delete: async (k: string) => void values.delete(k) } as KeyValueStore;
    await saveKept(store, keep([], A, 100, { name: "Ada" }).list);
    expect(Object.keys(JSON.parse(values.get(KEPT_ACCOUNTS_KEY)!)[0]).sort()).toEqual(["at", "name", "npub", "pubkey"]);
    expect(await loadKept(store)).toHaveLength(1);
    await saveKept(store, []);
    expect(values.has(KEPT_ACCOUNTS_KEY)).toBe(false);
  });

  it("is never something a session that arrived by a hand-off may ask about", () => {
    for (const action of ["accountsList", "accountsSwitch", "accountsAdd", "accountsRemove"]) expect(SIGNER_ONLY_ACTIONS.has(action as never), action).toBe(false);
  });
});

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
  async deleteDeviceKey(key: string): Promise<void> { this.keys.delete(key); }
}

describe("a kept account's own slot", () => {
  const event = { id: "0".repeat(64), pubkey: A, created_at: 1, kind: 1, tags: [], content: "", sig: "0".repeat(128) };
  const data = (fill: number): CachedSessionData => ({ everydayPrivateKey: new Uint8Array(32).fill(fill), accountId: `acct-${fill}`, recoveryPublicKey: "r", activeCredentialEvent: event, activeRecoveryEvent: event });

  it("is apart from the active slot and from every other account's", async () => {
    const store = new TestStore();
    await saveCachedSession(store, data(1), null);
    await saveCachedSession(store, data(1), null, keptSlot(A));
    await saveCachedSession(store, data(2), null, keptSlot(B));
    expect((await loadCachedSession(store, null))!.accountId).toBe("acct-1");
    expect((await loadCachedSession(store, null, keptSlot(B)))!.accountId).toBe("acct-2");
    // Removing a slot leaves the others, and the device key they are all under.
    await clearSessionSlot(store);
    expect(await loadCachedSession(store, null)).toBeNull();
    expect((await loadCachedSession(store, null, keptSlot(A)))!.accountId).toBe("acct-1");
    expect(store.keys.size).toBe(1);
    // Never in the clear.
    expect([...store.values.values()].join("")).not.toContain("0202020202");
  });

  it("is sealed under the lock where the lock is on, and opens with nothing else", async () => {
    const store = new TestStore();
    const lockKey = new Uint8Array(32).fill(9);
    await saveCachedSession(store, data(2), lockKey, keptSlot(B));
    expect(await cachedSessionState(store, keptSlot(B))).toBe("locked");
    expect(await loadCachedSession(store, null, keptSlot(B))).toBeNull();
    expect(await loadCachedSession(store, new Uint8Array(32).fill(8), keptSlot(B))).toBeNull();
    expect((await loadCachedSession(store, lockKey, keptSlot(B)))!.accountId).toBe("acct-2");
    expect(await cachedSessionState(store, keptSlot(A))).toBe("none");
  });
});
