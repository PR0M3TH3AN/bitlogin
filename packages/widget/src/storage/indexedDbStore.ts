/** IndexedDB-backed KeyValueStore (§21) — usable from the main thread or a Web Worker. */
import type { KeyValueStore } from "@bitlogin/core/storage";

const DB_NAME = "bitlogin";
const STORE_NAME = "kv";
const KEY_STORE_NAME = "device-keys";
const DB_VERSION = 2;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(KEY_STORE_NAME)) {
        db.createObjectStore(KEY_STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export class IndexedDbKeyValueStore implements KeyValueStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb();
    return this.dbPromise;
  }

  async get(key: string): Promise<string | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as string | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  async set(key: string, value: string): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async delete(key: string): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Returns a non-extractable AES-GCM key kept by the browser's IndexedDB
   * implementation. The key is deliberately separate from the string-only KV
   * API so callers cannot accidentally serialize it as application data.
   */
  async getOrCreateDeviceKey(key: string): Promise<CryptoKey> {
    const db = await this.db();
    const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
      const request = db.transaction(KEY_STORE_NAME, "readonly").objectStore(KEY_STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
      request.onerror = () => reject(request.error);
    });
    if (existing) return existing;

    const created = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(KEY_STORE_NAME, "readwrite");
        // add(), rather than put(), means a concurrent page keeps the key it
        // won the race to create instead of orphaning its encrypted session.
        tx.objectStore(KEY_STORE_NAME).add(created, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      return created;
    } catch {
      const raced = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const request = db.transaction(KEY_STORE_NAME, "readonly").objectStore(KEY_STORE_NAME).get(key);
        request.onsuccess = () => resolve(request.result as CryptoKey | undefined);
        request.onerror = () => reject(request.error);
      });
      if (raced) return raced;
      throw new Error("Unable to create the browser-bound session key.");
    }
  }

  async deleteDeviceKey(key: string): Promise<void> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(KEY_STORE_NAME, "readwrite");
      tx.objectStore(KEY_STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
