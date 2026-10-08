/**
 * Cleartext, public-only session identity — the companion to the AES-GCM
 * secret session in `worker/sessionCache.ts`.
 *
 * It holds ONLY data that is already public: the account's Nostr public key
 * (x-only hex), its npub, and an optional display name. None of it is secret —
 * the same pubkey appears on every event the user signs and on every relay —
 * so it is stored unencrypted, on purpose. That lets a read-only page answer
 * "who, if anyone, is signed in?" WITHOUT loading the crypto worker, wasm, or
 * the full widget (see `session.ts` for the lightweight reader).
 *
 * The everyday private key is NOT here and never will be: it stays in the
 * encrypted record in `sessionCache.ts`, exactly as protected as before. This
 * record is written and cleared in lockstep with that one (crypto worker), so
 * "signed in" here can never outlive the real session.
 */
import type { KeyValueStore } from "@bitlogin/core/storage";
import { identityFields } from "./identity.js";

/** IndexedDB key for the cleartext public-session record (sibling of
 *  `bitlogin:session:v1`, which stays encrypted). */
export const PUBLIC_SESSION_KEY = "bitlogin:session-public:v1";

export interface PublicSessionInfo {
  /** Canonical identity: 64-char lowercase hex. */
  pubkey: string;
  /**
   * @deprecated Use `pubkey`. Identical value; not persisted on disk.
   */
  publicKey: string;
  /** NIP-19 npub encoding of the same key. */
  npub: string;
  /** Display name, when the widget knows one. Absent otherwise. */
  name?: string;
}

/** Validates and narrows a raw stored string. Returns null for anything that
 *  isn't a well-formed record, so a corrupt entry reads as "no session," never
 *  an error. Shared by the store reader and the standalone reader so both agree
 *  on the shape. */
export function parsePublicSession(raw: string | null | undefined): PublicSessionInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PublicSessionInfo>;
    if (typeof parsed.pubkey !== "string" || typeof parsed.npub !== "string") return null;
    return {
      ...identityFields(parsed.pubkey),
      npub: parsed.npub,
      ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {})
    };
  } catch {
    return null;
  }
}

/** On-disk shape. The deprecated `publicKey` alias is filled in on read only. */
type PersistedPublicSession = {
  pubkey: string;
  npub: string;
  name?: string;
};

/** Best-effort write, mirroring `saveCachedSession`: a full disk or a browser
 *  blocking IndexedDB must never break the login/rotate call that triggered it. */
export async function savePublicSession(store: KeyValueStore, info: PersistedPublicSession): Promise<void> {
  try {
    const record: PersistedPublicSession = {
      pubkey: info.pubkey,
      npub: info.npub,
      ...(info.name ? { name: info.name } : {})
    };
    await store.set(PUBLIC_SESSION_KEY, JSON.stringify(record));
  } catch {
    // ignore
  }
}

export async function loadPublicSession(store: KeyValueStore): Promise<PublicSessionInfo | null> {
  try {
    return parsePublicSession(await store.get(PUBLIC_SESSION_KEY));
  } catch {
    return null;
  }
}

export async function clearPublicSession(store: KeyValueStore): Promise<void> {
  try {
    await store.delete(PUBLIC_SESSION_KEY);
  } catch {
    // ignore
  }
}
