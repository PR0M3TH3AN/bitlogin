/**
 * Local "stay signed in" cache (§21) -- lets a page reload restore the active
 * identity without re-running Argon2id + a relay quorum read (both
 * deliberately expensive, exactly the wrong tradeoff for something that
 * should happen on every navigation). Scoped by IndexedDB's own per-origin
 * isolation, same boundary a NIP-07 extension's own storage already relies
 * on -- one site's cached session is never visible to another.
 *
 * This trades "nothing persists locally" for "the everyday private key sits
 * decrypted in this browser's IndexedDB until logout" -- the same tradeoff
 * every NIP-07 extension and crypto wallet already makes for the same
 * reason. Only the everyday key is cached; the recovery phrase and the
 * login name/password are never retained anywhere.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent } from "@bitlogin/core/nostr";
import { bytesToHex, hexToBytes } from "@bitlogin/core/crypto";

const SESSION_KEY = "bitlogin:session:v1";

export interface CachedSessionData {
  everydayPrivateKey: Uint8Array;
  accountId: string;
  recoveryPublicKey: string;
  activeCredentialEvent: NostrEvent;
  activeRecoveryEvent: NostrEvent;
}

interface StoredSession {
  everydayPrivateKeyHex: string;
  accountId: string;
  recoveryPublicKey: string;
  activeCredentialEvent: NostrEvent;
  activeRecoveryEvent: NostrEvent;
}

export async function saveCachedSession(store: KeyValueStore, data: CachedSessionData): Promise<void> {
  const stored: StoredSession = {
    everydayPrivateKeyHex: bytesToHex(data.everydayPrivateKey),
    accountId: data.accountId,
    recoveryPublicKey: data.recoveryPublicKey,
    activeCredentialEvent: data.activeCredentialEvent,
    activeRecoveryEvent: data.activeRecoveryEvent
  };
  // Best-effort: a full disk or a browser blocking IndexedDB (some private-
  // browsing modes) shouldn't break the login/register/rotate call that
  // triggered this -- it just means the next page load asks for credentials
  // again, exactly like today.
  try {
    await store.set(SESSION_KEY, JSON.stringify(stored));
  } catch {
    // ignore
  }
}

export async function loadCachedSession(store: KeyValueStore): Promise<CachedSessionData | null> {
  let raw: string | undefined;
  try {
    raw = await store.get(SESSION_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
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
      everydayPrivateKey: hexToBytes(parsed.everydayPrivateKeyHex),
      accountId: parsed.accountId,
      recoveryPublicKey: parsed.recoveryPublicKey,
      activeCredentialEvent: parsed.activeCredentialEvent,
      activeRecoveryEvent: parsed.activeRecoveryEvent
    };
  } catch {
    // Corrupt or unrecognized cache entry -- treat as "no session," not an error.
    return null;
  }
}

export async function clearCachedSession(store: KeyValueStore): Promise<void> {
  try {
    await store.delete(SESSION_KEY);
  } catch {
    // ignore
  }
}
