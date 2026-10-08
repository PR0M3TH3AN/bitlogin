/**
 * Lightweight, read-only session reader — the cheap way to ask "who, if anyone,
 * is signed in?" on a page that isn't the login/manage surface.
 *
 * Import this INSTEAD of the full widget (`bitlogin.js`) when you only need to
 * show an identity — e.g. a "Signed in as …" chip in the header on every page.
 * It opens the same per-origin IndexedDB the widget writes and returns the
 * public identity WITHOUT loading the crypto worker, wasm, or bitlogin.js. It
 * cannot sign and never touches key material; when the user actually signs or
 * manages the account, load `<bitlogin-auth>` and pay the heavy cost then.
 *
 *   ESM:        import { readCachedSession } from "@bitlogin/widget/session";
 *               const who = await readCachedSession(); // { pubkey, publicKey, npub, name? } | null
 *
 *   No build:   <script type="module" src="bitlogin-session.js"></script>
 *               const who = await window.bitlogin.readCachedSession();
 *
 * This file is deliberately dependency-free so it bundles to a few KB with no
 * shared chunk pulling in the widget.
 */
import type { PublicSessionInfo } from "./publicSession.js";

export type { PublicSessionInfo } from "./publicSession.js";

// The two constants and the parser below are duplicated from
// storage/indexedDbStore.ts and publicSession.ts ON PURPOSE. Importing their
// runtime would let rollup hoist a shared chunk, turning this "drop in one file"
// reader into two. The DB names are a stable on-disk contract (indexedDbStore.ts
// is their source of truth); the record shape is validated identically to
// publicSession.parsePublicSession, which owns the write side.
const DB_NAME = "bitlogin";
const STORE_NAME = "kv";
const PUBLIC_SESSION_KEY = "bitlogin:session-public:v1";

function parsePublicSession(raw: string | null | undefined): PublicSessionInfo | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<PublicSessionInfo>;
    if (typeof parsed.pubkey !== "string" || typeof parsed.npub !== "string") return null;
    // Duplicated from identityFields() — this file must not import runtime
    // modules or rollup will hoist a shared chunk into the 1 KB reader.
    const pubkey = parsed.pubkey.toLowerCase();
    return {
      pubkey,
      publicKey: pubkey,
      npub: parsed.npub,
      ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {})
    };
  } catch {
    return null;
  }
}

/** Opens the widget's DB read-only and reads one string key. Resolves undefined
 *  for every failure mode — DB absent, store absent (widget never ran here),
 *  IndexedDB blocked — because "can't tell" is indistinguishable from "not
 *  signed in" for this reader's purpose. Opened without a version so it never
 *  triggers an upgrade against whatever version the widget is on. */
function readRaw(key: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME);
    } catch {
      resolve(undefined);
      return;
    }
    // A brand-new DB (widget never ran on this origin) opens at version 1 with
    // no object stores; the contains() check below then returns undefined.
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.close();
        resolve(undefined);
        return;
      }
      try {
        const tx = db.transaction(STORE_NAME, "readonly");
        const getRequest = tx.objectStore(STORE_NAME).get(key);
        getRequest.onsuccess = () => resolve(getRequest.result as string | undefined);
        getRequest.onerror = () => resolve(undefined);
        tx.oncomplete = () => db.close();
        tx.onerror = () => {
          resolve(undefined);
          db.close();
        };
      } catch {
        db.close();
        resolve(undefined);
      }
    };
  });
}

/** The current signed-in identity for this origin, or null. Public data only —
 *  never key material, and it cannot sign. */
export async function readCachedSession(): Promise<PublicSessionInfo | null> {
  if (typeof indexedDB === "undefined") return null;
  return parsePublicSession(await readRaw(PUBLIC_SESSION_KEY));
}

// No-build convenience: expose on window.bitlogin for the <script> path without
// clobbering the full widget. Cast rather than augmenting the global type here;
// index.ts owns the canonical BitLoginGlobal shape (readCachedSession included),
// so whichever of the two loads, the method is present and identical.
if (typeof window !== "undefined") {
  const w = window as unknown as { bitlogin?: Record<string, unknown> };
  w.bitlogin ??= {};
  if (typeof w.bitlogin.readCachedSession !== "function") {
    w.bitlogin.readCachedSession = readCachedSession;
  }
}
