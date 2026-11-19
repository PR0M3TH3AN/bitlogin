import { describe, expect, it } from "vitest";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { randomBytes } from "@bitlogin/core/crypto";
import { LOCK_LIMITS, openLockWithDevice, openLockWithPin, readLock, readPin, removeLockDevice, setLockDevice, setLockPin } from "./lock.js";
import { cachedSessionState, loadCachedSession, saveCachedSession } from "./sessionCache.js";
import { SIGNER_ONLY_ACTIONS } from "./handoff.js";
import { lockCreateOptions, lockGetOptions, LOCK_PRF_SALT } from "../lockDevice.js";
import { PASSKEY_PRF_SALT } from "../passkey.js";

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

/** A passkey's id as the lock keeps it: base64url. Made from plain words here, so that nothing in this file looks like a secret to a scanner. It is not one. */
const CREDENTIAL_ID = Buffer.from("credential-id").toString("base64url");
const RECORD = "bitlogin:lock:v1";
const SESSION = "bitlogin:session:v1";
const session = {
  everydayPrivateKey: new Uint8Array(32).fill(7),
  accountId: "account",
  recoveryPublicKey: "a".repeat(64),
  activeCredentialEvent: { id: "credential" } as never,
  activeRecoveryEvent: { id: "recovery" } as never
};

describe("the optional lock (§SW12)", () => {
  it("takes a PIN of six to sixty-four characters, and nothing else", () => {
    expect(readPin("123456")).not.toBeNull();
    expect(readPin("correct horse")).not.toBeNull();
    expect(readPin("12345")).toBeNull();
    expect(readPin("x".repeat(65))).toBeNull();
    expect(readPin(123456)).toBeNull();
    // Counted in characters, and the same PIN however it was typed.
    expect(readPin("\u{1F511}".repeat(6))).not.toBeNull();
    expect(readPin("１２３４５６")).toEqual(readPin("123456"));
  });

  it("opens with the PIN it was made with, and keeps nothing of the PIN or the key in the clear", async () => {
    const store = new TestStore();
    const lockKey = await setLockPin(store, "246810");
    expect(lockKey).toHaveLength(32);
    const raw = store.values.get(RECORD)!;
    expect(raw).not.toContain("246810");
    expect(raw).not.toContain(Buffer.from(lockKey).toString("base64url"));
    const opened = await openLockWithPin(store, "246810");
    expect(opened).toMatchObject({ ok: true });
    expect(opened.ok && opened.lockKey).toEqual(lockKey);
    await expect(setLockPin(new TestStore(), "123")).rejects.toThrow(/PIN/u);
  }, 60_000);

  it("counts wrong tries, forgives them on a right one, and removes itself after the last", async () => {
    const store = new TestStore();
    await setLockPin(store, "246810");
    expect(await openLockWithPin(store, "000000")).toEqual({ ok: false, left: LOCK_LIMITS.tries - 1, removed: false });
    // Something that is no PIN at all is a try too.
    expect(await openLockWithPin(store, "1")).toEqual({ ok: false, left: LOCK_LIMITS.tries - 2, removed: false });
    expect((await readLock(store))?.tries).toBe(2);
    expect(await openLockWithPin(store, "246810")).toMatchObject({ ok: true });
    expect((await readLock(store))?.tries).toBe(0);
    for (let i = 1; i < LOCK_LIMITS.tries; i++) expect(await openLockWithPin(store, "000000")).toMatchObject({ ok: false, removed: false, left: LOCK_LIMITS.tries - i });
    expect(await openLockWithPin(store, "000000")).toEqual({ ok: false, left: 0, removed: true });
    expect(store.values.has(RECORD)).toBe(false);
    // Gone is gone: the right PIN opens nothing now.
    expect(await openLockWithPin(store, "246810")).toEqual({ ok: false, left: 0, removed: true });
  }, 120_000);

  it("counts a try before it is made, so one cut short is still a try", async () => {
    const store = new TestStore();
    await setLockPin(store, "246810");
    const seen: number[] = [];
    const set = store.set.bind(store);
    store.set = async (key, value) => {
      if (key === RECORD) seen.push((JSON.parse(value) as { tries: number }).tries);
      await set(key, value);
    };
    await openLockWithPin(store, "000000");
    expect(seen[0]).toBe(1);
  }, 60_000);

  it("opens with the device where one was added, with the same key, and the PIN still works", async () => {
    const store = new TestStore();
    const lockKey = await setLockPin(store, "246810");
    const prf = randomBytes(32);
    await setLockDevice(store, lockKey, CREDENTIAL_ID, prf);
    expect((await readLock(store))?.device?.credentialId).toBe(CREDENTIAL_ID);
    const byDevice = await openLockWithDevice(store, prf);
    expect(byDevice.ok && byDevice.lockKey).toEqual(lockKey);
    expect(await openLockWithDevice(store, randomBytes(32))).toMatchObject({ ok: false, left: LOCK_LIMITS.tries - 1 });
    expect(await openLockWithPin(store, "246810")).toMatchObject({ ok: true });
    // Changing the PIN keeps the key and the device's unlock. The old PIN opens nothing.
    const same = await setLockPin(store, "135791", lockKey);
    expect(same).toEqual(lockKey);
    expect(await openLockWithPin(store, "246810")).toMatchObject({ ok: false });
    expect(await openLockWithDevice(store, prf)).toMatchObject({ ok: true });
    await removeLockDevice(store);
    expect(await openLockWithDevice(store, prf)).toMatchObject({ ok: false });
    await expect(setLockDevice(new TestStore(), lockKey, CREDENTIAL_ID, prf)).rejects.toThrow(/not on/u);
    await expect(setLockDevice(store, lockKey, "no", prf)).rejects.toThrow(/device unlock/u);
  }, 120_000);

  it("is no lock at all when the record does not read as one", async () => {
    const store = new TestStore();
    for (const bad of ["not json", "{}", JSON.stringify({ v: 1, tries: -1, pin: { salt: "a", iv: "a", wrapped: "a" } }), JSON.stringify({ v: 1, tries: 0, pin: { iv: "a", wrapped: "a" } }), JSON.stringify({ v: 2, tries: 0 })]) {
      store.values.set(RECORD, bad);
      expect(await readLock(store), bad).toBeNull();
    }
  });

  it("seals the cached session a second time, and leaves it be without the key", async () => {
    const store = new TestStore();
    const lockKey = randomBytes(32);
    await saveCachedSession(store, session, lockKey);
    const raw = store.values.get(SESSION)!;
    expect(raw).toContain('"v":3');
    expect(await cachedSessionState(store)).toBe("locked");
    // Locked is not "no session", and not a record to throw away.
    expect(await loadCachedSession(store)).toBeNull();
    expect(await loadCachedSession(store, randomBytes(32))).toBeNull();
    expect(store.values.get(SESSION)).toBe(raw);
    expect((await loadCachedSession(store, lockKey))?.everydayPrivateKey).toEqual(session.everydayPrivateKey);
    // The lock key alone is not enough: the record under it still needs this browser's own key.
    store.keys.clear();
    expect(await loadCachedSession(store, lockKey)).toBeNull();
    // Without a lock key it is the ordinary record.
    await saveCachedSession(store, session);
    expect(await cachedSessionState(store)).toBe("open");
    expect(await cachedSessionState(new TestStore())).toBe("none");
  });

  it("is never something a handed-over key may be asked", () => {
    for (const action of ["lockStatus", "lockEnable", "lockSetDevice", "lockRemoveDevice", "lockDisable", "lockNow", "lockOpen"]) {
      expect(SIGNER_ONLY_ACTIONS.has(action), action).toBe(false);
    }
  });

  it("asks the device for exactly its own passkey, with a salt that is not the passkey account's", () => {
    expect(Buffer.from(LOCK_PRF_SALT).toString()).not.toBe(Buffer.from(PASSKEY_PRF_SALT).toString());
    const get = lockGetOptions(CREDENTIAL_ID).publicKey!;
    expect(get.userVerification).toBe("required");
    expect(get.allowCredentials).toHaveLength(1);
    expect(Buffer.from(get.allowCredentials![0]!.id as ArrayBuffer).toString()).toBe("credential-id");
    const create = lockCreateOptions().publicKey!;
    expect(create.authenticatorSelection).toEqual({ residentKey: "discouraged", userVerification: "required" });
  });
});
