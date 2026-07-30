/**
 * Local "stay signed in" cache (§21) -- lets a page reload restore the active
 * identity without re-running Argon2id + a relay quorum read (both
 * deliberately expensive, exactly the wrong tradeoff for something that
 * should happen on every navigation). Scoped by IndexedDB's own per-origin
 * isolation, same boundary a NIP-07 extension's own storage already relies
 * on -- one site's cached session is never visible to another.
 *
 * The session record is AES-GCM encrypted with a non-extractable CryptoKey
 * retained by IndexedDB. That keeps page-to-page restore seamless while
 * avoiding a raw everyday private key in application-readable storage. This
 * is protection at rest, not a substitute for CSP: active same-origin script
 * can still ask the browser to use the key and must never be untrusted.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent } from "@bitlogin/core/nostr";

const SESSION_KEY = "bitlogin:session:v1";
const SESSION_DEVICE_KEY = "bitlogin:session-device-key:v1";

export interface CachedSessionData {
  everydayPrivateKey: Uint8Array;
  accountId: string;
  recoveryPublicKey: string;
  activeCredentialEvent: NostrEvent;
  activeRecoveryEvent: NostrEvent;
  /** Connection Vault root (§CV5.2). Same sensitivity class as the everyday
   *  key, cached under the same encrypted-at-rest tradeoff. The SUDO key is
   *  deliberately never cached: re-obtaining it is the sudo ceremony. */
  connectionVaultRoot?: Uint8Array;
  /** False when the logged-in capsule definitively carried no vault root, so
   *  a restored session can tell "account predates the vault" apart from
   *  "root missing because this cache entry predates the field". */
  vaultEnabled?: boolean;
}

interface PlainSession {
  everydayPrivateKeyHex: string;
  accountId: string;
  recoveryPublicKey: string;
  activeCredentialEvent: NostrEvent;
  activeRecoveryEvent: NostrEvent;
  connectionVaultRootHex?: string;
  vaultEnabled?: boolean;
}

interface EncryptedSession {
  v: 2;
  iv: string;
  ciphertext: string;
}

interface DeviceKeyStore {
  getOrCreateDeviceKey(key: string): Promise<CryptoKey>;
  deleteDeviceKey(key: string): Promise<void>;
}

type SessionStore = KeyValueStore & Partial<DeviceKeyStore>;

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function isEncryptedSession(value: unknown): value is EncryptedSession {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as EncryptedSession).v === 2 &&
      typeof (value as EncryptedSession).iv === "string" &&
      typeof (value as EncryptedSession).ciphertext === "string"
  );
}

export async function saveCachedSession(store: SessionStore, data: CachedSessionData): Promise<void> {
  const stored: PlainSession = {
    everydayPrivateKeyHex: Array.from(data.everydayPrivateKey, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    accountId: data.accountId,
    recoveryPublicKey: data.recoveryPublicKey,
    activeCredentialEvent: data.activeCredentialEvent,
    activeRecoveryEvent: data.activeRecoveryEvent,
    ...(data.connectionVaultRoot
      ? {
          connectionVaultRootHex: Array.from(data.connectionVaultRoot, (byte) =>
            byte.toString(16).padStart(2, "0")
          ).join("")
        }
      : {}),
    ...(data.vaultEnabled !== undefined ? { vaultEnabled: data.vaultEnabled } : {})
  };
  // Best-effort: a full disk or a browser blocking IndexedDB (some private-
  // browsing modes) shouldn't break the login/register/rotate call that
  // triggered this -- it just means the next page load asks for credentials
  // again, exactly like today.
  try {
    if (typeof store.getOrCreateDeviceKey !== "function") {
      // Never retain the legacy plaintext format when secure key storage is
      // unavailable (for example, an old/private browser implementation).
      await store.delete(SESSION_KEY);
      return;
    }
    const key = await store.getOrCreateDeviceKey(SESSION_DEVICE_KEY);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(stored));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const encrypted: EncryptedSession = {
      v: 2,
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(ciphertext))
    };
    await store.set(SESSION_KEY, JSON.stringify(encrypted));
  } catch {
    // ignore
  }
}

export async function loadCachedSession(store: SessionStore): Promise<CachedSessionData | null> {
  let raw: string | undefined;
  try {
    raw = await store.get(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const encrypted = JSON.parse(raw) as unknown;
    if (!isEncryptedSession(encrypted) || typeof store.getOrCreateDeviceKey !== "function") {
      // A v1 record contains a plaintext private key. Remove it rather than
      // silently preserving the insecure cache; the user can sign in once.
      await store.delete(SESSION_KEY);
      return null;
    }
    const key = await store.getOrCreateDeviceKey(SESSION_DEVICE_KEY);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(fromBase64(encrypted.iv)) },
      key,
      toArrayBuffer(fromBase64(encrypted.ciphertext))
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<PlainSession>;
    if (
      typeof parsed.everydayPrivateKeyHex !== "string" ||
      typeof parsed.accountId !== "string" ||
      typeof parsed.recoveryPublicKey !== "string" ||
      !parsed.activeCredentialEvent ||
      !parsed.activeRecoveryEvent
    ) {
      return null;
    }
    return {
      everydayPrivateKey: Uint8Array.from(
        parsed.everydayPrivateKeyHex.match(/.{1,2}/g) || [],
        (pair) => Number.parseInt(pair, 16)
      ),
      accountId: parsed.accountId,
      recoveryPublicKey: parsed.recoveryPublicKey,
      activeCredentialEvent: parsed.activeCredentialEvent,
      activeRecoveryEvent: parsed.activeRecoveryEvent,
      ...(typeof parsed.connectionVaultRootHex === "string"
        ? {
            connectionVaultRoot: Uint8Array.from(
              parsed.connectionVaultRootHex.match(/.{1,2}/g) || [],
              (pair) => Number.parseInt(pair, 16)
            )
          }
        : {}),
      ...(typeof parsed.vaultEnabled === "boolean" ? { vaultEnabled: parsed.vaultEnabled } : {})
    };
  } catch {
    // Corrupt or unrecognized cache entry -- treat as "no session," not an error.
    return null;
  }
}

export async function clearCachedSession(store: SessionStore): Promise<void> {
  try {
    await store.delete(SESSION_KEY);
    if (typeof store.deleteDeviceKey === "function") {
      await store.deleteDeviceKey(SESSION_DEVICE_KEY);
    }
  } catch {
    // ignore
  }
}
