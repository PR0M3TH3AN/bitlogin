/**
 * The optional lock (docs/sign-in-window.md §SW12, spec §21.5): off unless
 * the user turns it on. Turned on, the cached session (sessionCache.ts) is
 * sealed under one more key, the lock key, and nothing can sign until that
 * key is recovered.
 *
 * The lock key is 32 random bytes, kept only in the worker's memory while
 * unlocked. At rest it exists only wrapped, in the lock record:
 *
 *   - always under a key stretched from the user's PIN with Argon2id (the
 *     account KDF), with a salt of the record's own; and
 *   - where the user added it, under a key derived from a passkey's PRF
 *     output: the device's own unlock. That passkey is a wrapping key and
 *     nothing else. It derives no account and no capsule.
 *
 * Wrong tries are counted in the record. Past the limit the record is
 * removed and the caller removes the cached session with it: the user signs
 * in again the ordinary way. The PIN is never a way into the account.
 *
 * What this is and is not: it stops someone who sits down at the browser.
 * It does not stop malware, or someone who copies the browser profile and
 * guesses a short PIN offline; a count kept in software can be put back.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import { base64urlToBytes, bytesToBase64url, deriveArgon2id, hkdfExpand, hkdfExtract, randomBytes, utf8ToBytes } from "@bitlogin/core/crypto";

const LOCK_RECORD = "bitlogin:lock:v1";
const DEVICE_INFO = "bitlogin/lock/device/v1";
const DEVICE_SALT = utf8ToBytes("bitlogin:lock:device-wrap:v1");

export const LOCK_LIMITS = {
  pinMin: 6,
  pinMax: 64,
  /** Wrong tries, with the PIN or the device, before the record is removed. */
  tries: 5,
  /** Unused for this long, an unlocked session locks itself. In seconds. */
  idleSec: 15 * 60
} as const;

interface Wrapped {
  iv: string;
  wrapped: string;
}
export interface LockRecord {
  v: 1;
  tries: number;
  pin: Wrapped & { salt: string };
  device?: Wrapped & { credentialId: string };
}

export type OpenResult =
  | { ok: true; lockKey: Uint8Array }
  /** Wrong. `left` more tries before the record is removed. */
  | { ok: false; left: number; removed: false }
  /** Wrong once too often, or no such lock: there is no record now. */
  | { ok: false; left: 0; removed: true };

const buffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
};

/** A PIN as it is stretched: NFKC, as typed otherwise. Null when it is too short or too long to be one. */
export function readPin(input: unknown): Uint8Array | null {
  if (typeof input !== "string") return null;
  const pin = input.normalize("NFKC");
  const length = [...pin].length;
  return length >= LOCK_LIMITS.pinMin && length <= LOCK_LIMITS.pinMax ? utf8ToBytes(pin) : null;
}

async function wrap(wrappingKey: Uint8Array, lockKey: Uint8Array): Promise<Wrapped> {
  // Outside any try: with no source of randomness this throws, and nothing is written.
  const iv = randomBytes(12);
  const key = await crypto.subtle.importKey("raw", buffer(wrappingKey), "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: buffer(iv) }, key, buffer(lockKey));
  return { iv: bytesToBase64url(iv), wrapped: bytesToBase64url(new Uint8Array(sealed)) };
}

async function unwrap(wrappingKey: Uint8Array, sealed: Wrapped): Promise<Uint8Array | null> {
  try {
    const key = await crypto.subtle.importKey("raw", buffer(wrappingKey), "AES-GCM", false, ["decrypt"]);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buffer(base64urlToBytes(sealed.iv)) }, key, buffer(base64urlToBytes(sealed.wrapped))));
    return plain.length === 32 ? plain : null;
  } catch {
    return null;
  }
}

const deviceKey = (prfOutput: Uint8Array): Uint8Array => hkdfExpand(hkdfExtract(DEVICE_SALT, prfOutput), DEVICE_INFO, 32);

const isWrapped = (v: unknown): v is Wrapped => !!v && typeof v === "object" && typeof (v as Wrapped).iv === "string" && typeof (v as Wrapped).wrapped === "string";

/** The lock record, or null: none, or one that does not read as one (which is then no lock at all). */
export async function readLock(store: KeyValueStore): Promise<LockRecord | null> {
  let raw: string | undefined;
  try {
    raw = await store.get(LOCK_RECORD);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Partial<LockRecord>;
    if (r.v !== 1 || typeof r.tries !== "number" || !Number.isInteger(r.tries) || r.tries < 0) return null;
    if (!isWrapped(r.pin) || typeof r.pin.salt !== "string") return null;
    if (r.device !== undefined && (!isWrapped(r.device) || typeof r.device.credentialId !== "string")) return null;
    return { v: 1, tries: r.tries, pin: r.pin, ...(r.device ? { device: r.device } : {}) };
  } catch {
    return null;
  }
}

const write = (store: KeyValueStore, record: LockRecord): Promise<void> => store.set(LOCK_RECORD, JSON.stringify(record));

export async function removeLock(store: KeyValueStore): Promise<void> {
  try {
    await store.delete(LOCK_RECORD);
  } catch {
    // ignore
  }
}

/**
 * Turn the lock on, or change its PIN: a lock key wrapped under the PIN.
 * `lockKey` is the one already in use when only the PIN is changing, so the
 * cached session need not be sealed again; a device unlock added before is
 * kept. Throws on a PIN that is not one. Returns the lock key.
 */
export async function setLockPin(store: KeyValueStore, pin: unknown, lockKey?: Uint8Array): Promise<Uint8Array> {
  const pinBytes = readPin(pin);
  if (!pinBytes) throw new Error(`A PIN is ${LOCK_LIMITS.pinMin} to ${LOCK_LIMITS.pinMax} characters.`);
  const key = lockKey ? lockKey.slice() : randomBytes(32);
  const salt = randomBytes(16);
  const stretched = await deriveArgon2id(pinBytes, salt);
  try {
    const existing = lockKey ? await readLock(store) : null;
    await write(store, { v: 1, tries: 0, pin: { salt: bytesToBase64url(salt), ...(await wrap(stretched, key)) }, ...(existing?.device ? { device: existing.device } : {}) });
  } finally {
    stretched.fill(0);
    pinBytes.fill(0);
  }
  return key;
}

/** Add, or replace, the device's own unlock: the same lock key, wrapped under a key from a passkey's PRF output. */
export async function setLockDevice(store: KeyValueStore, lockKey: Uint8Array, credentialId: string, prfOutput: Uint8Array): Promise<void> {
  const record = await readLock(store);
  if (!record) throw new Error("The lock is not on.");
  if (prfOutput.length !== 32 || !/^[A-Za-z0-9_-]{8,1400}$/u.test(credentialId)) throw new Error("That is not a device unlock.");
  const wrapping = deviceKey(prfOutput);
  try {
    await write(store, { ...record, device: { credentialId, ...(await wrap(wrapping, lockKey)) } });
  } finally {
    wrapping.fill(0);
  }
}

export async function removeLockDevice(store: KeyValueStore): Promise<void> {
  const record = await readLock(store);
  if (record?.device) await write(store, { v: 1, tries: record.tries, pin: record.pin });
}

async function open(store: KeyValueStore, attempt: (record: LockRecord) => Promise<Uint8Array | null>): Promise<OpenResult> {
  const record = await readLock(store);
  if (!record) return { ok: false, left: 0, removed: true };
  // Counted before the try is made, and written: a try that is cut short (the page closed while the PIN was
  // being stretched) is still a try.
  const tries = record.tries + 1;
  await write(store, { ...record, tries });
  const lockKey = await attempt(record);
  if (lockKey) {
    await write(store, { ...record, tries: 0 });
    return { ok: true, lockKey };
  }
  if (tries >= LOCK_LIMITS.tries) {
    await removeLock(store);
    return { ok: false, left: 0, removed: true };
  }
  return { ok: false, left: LOCK_LIMITS.tries - tries, removed: false };
}

export function openLockWithPin(store: KeyValueStore, pin: unknown): Promise<OpenResult> {
  return open(store, async (record) => {
    const pinBytes = readPin(pin);
    if (!pinBytes) return null;
    const stretched = await deriveArgon2id(pinBytes, base64urlToBytes(record.pin.salt));
    try {
      return await unwrap(stretched, record.pin);
    } finally {
      stretched.fill(0);
      pinBytes.fill(0);
    }
  });
}

export function openLockWithDevice(store: KeyValueStore, prfOutput: Uint8Array): Promise<OpenResult> {
  return open(store, async (record) => {
    if (!record.device || prfOutput.length !== 32) return null;
    const wrapping = deviceKey(prfOutput);
    try {
      return await unwrap(wrapping, record.device);
    } finally {
      wrapping.fill(0);
    }
  });
}
