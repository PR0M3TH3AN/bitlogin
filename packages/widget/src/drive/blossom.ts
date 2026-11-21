/**
 * Talking to a Blossom server (docs/files.md), as its documents say
 * (BUD-01, 02, 06, 07, 11, 12): a blob is stored under the SHA-256 of its
 * bytes, fetched by that hash, and uploaded or deleted with a short-lived
 * permission note. And sealing a private file before it leaves this page:
 * a Blossom server will hand any blob to anyone who knows its hash, so a
 * private file is one whose bytes mean nothing without its key.
 *
 * This runs on a page of BitLogin's own. The permission notes are signed by
 * the worker, one file and one server at a time.
 */

export type BlossomVerb = "upload" | "delete" | "get";
/** Asks the worker for a permission note: the `Authorization` header's token. */
export type BlossomSigner = (verb: BlossomVerb, server: string, sha256: string) => Promise<string>;

export class BlossomError extends Error {
  constructor(
    readonly code: "refused" | "too-large" | "payment" | "not-found" | "network" | "mismatch" | "quota",
    message: string,
    /** What the server said, where it said anything. For a person to read: never acted on. */
    readonly reason = ""
  ) {
    super(message);
    this.name = "BlossomError";
  }
}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string): Uint8Array => Uint8Array.from(hex.match(/.{2}/gu) ?? [], (pair) => Number.parseInt(pair, 16));
/** A view WebCrypto and fetch will take, whatever buffer the bytes came in. */
const buf = (bytes: Uint8Array): ArrayBuffer => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", buf(bytes))));
}

/**
 * Seal a private file: AES-256-GCM under a key made for this file alone.
 * What is uploaded is the 12-byte nonce and then the sealed bytes. The key
 * is kept in the index, which is sealed to the account.
 */
export async function sealFile(bytes: Uint8Array): Promise<{ sealed: Uint8Array; key: string }> {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", buf(raw), "AES-GCM", false, ["encrypt"]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: buf(iv) }, key, buf(bytes)));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv, 0);
  out.set(sealed, 12);
  return { sealed: out, key: toHex(raw) };
}

export async function openFile(sealed: Uint8Array, keyHex: string): Promise<Uint8Array> {
  if (sealed.length < 28 || !/^[0-9a-f]{64}$/u.test(keyHex)) throw new BlossomError("mismatch", "That file can't be opened: it is not what was saved.");
  const key = await crypto.subtle.importKey("raw", buf(fromHex(keyHex)), "AES-GCM", false, ["decrypt"]);
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(sealed.slice(0, 12)) }, key, buf(sealed.slice(12))));
  } catch {
    // The tag did not match: the server handed back other bytes, or they were changed on the way.
    throw new BlossomError("mismatch", "That file can't be opened: what the server holds is not what was saved.");
  }
}

const reasonOf = (response: Response): string => (response.headers.get("X-Reason") ?? "").slice(0, 200);
const authHeader = (token: string) => ({ Authorization: `Nostr ${token}` });

/** What a server says about taking a file, before any byte is sent (BUD-06). */
export interface UploadCheck {
  /** "free": it would take it. "paid": it wants paying first. "closed": not from this account. "unknown": it didn't say. */
  state: "free" | "paid" | "closed" | "too-large" | "unknown";
  /** A Lightning invoice, where it asked for one and the browser could read it. */
  invoice?: string;
  reason: string;
}

async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, cache: "no-store", credentials: "omit", redirect: "follow", referrerPolicy: "no-referrer" });
  } catch {
    throw new BlossomError("network", "The file server couldn't be reached.");
  }
}

export async function checkUpload(server: string, blob: { sha256: string; size: number; type: string }, sign: BlossomSigner): Promise<UploadCheck> {
  let response: Response;
  try {
    response = await request(`${server}/upload`, {
      method: "HEAD",
      headers: { "X-SHA-256": blob.sha256, "X-Content-Length": String(blob.size), "X-Content-Type": blob.type, ...authHeader(await sign("upload", server, blob.sha256)) }
    });
  } catch {
    return { state: "unknown", reason: "" };
  }
  const reason = reasonOf(response);
  if (response.ok) return { state: "free", reason };
  if (response.status === 402) return { state: "paid", reason, ...(invoiceIn(response) ? { invoice: invoiceIn(response) } : {}) };
  if (response.status === 413) return { state: "too-large", reason };
  if (response.status === 401 || response.status === 403) return { state: "closed", reason };
  return { state: "unknown", reason };
}

/** The Lightning invoice a "payment required" answer carries (BUD-07), where the browser lets this page read it. */
function invoiceIn(response: Response): string {
  const value = (response.headers.get("X-Lightning") ?? "").trim().toLowerCase();
  return value.length <= 2000 && /^ln(bc|tb|tbs|bcrt)[0-9a-z]+$/u.test(value) ? value : "";
}

/**
 * Upload a blob (BUD-02). Where the server wants paying first (BUD-07), `pay`
 * is asked with its Lightning invoice and answers with the proof of payment,
 * or null to stop: then nothing is uploaded.
 */
export async function uploadBlob(server: string, bytes: Uint8Array, type: string, sha256: string, sign: BlossomSigner, pay?: (invoice: string) => Promise<string | null>): Promise<{ url: string }> {
  const send = async (proof?: string): Promise<Response> =>
    request(`${server}/upload`, {
      method: "PUT",
      headers: { "Content-Type": type, "X-SHA-256": sha256, ...authHeader(await sign("upload", server, sha256)), ...(proof ? { "X-Lightning": proof } : {}) },
      body: buf(bytes)
    });
  let response = await send();
  if (response.status === 402) {
    const invoice = invoiceIn(response);
    if (!invoice) throw new BlossomError("payment", "That server wants paying in a way BitLogin can't read here. Choose another server.", reasonOf(response));
    const proof = pay ? await pay(invoice) : null;
    if (!proof) throw new BlossomError("payment", "That server wants paying first, and it wasn't paid. Nothing was uploaded.", reasonOf(response));
    response = await send(proof);
  }
  if (response.status === 413) throw new BlossomError("too-large", "That file is larger than the server takes.", reasonOf(response));
  if (response.status === 429) throw new BlossomError("quota", "That server won't take more from you just now: a limit was reached.", reasonOf(response));
  if (response.status === 402) throw new BlossomError("payment", "The server did not accept the payment.", reasonOf(response));
  if (!response.ok) throw new BlossomError("refused", "The server would not take the file.", reasonOf(response));
  let descriptor: { sha256?: unknown; url?: unknown };
  try {
    descriptor = (await response.json()) as typeof descriptor;
  } catch {
    throw new BlossomError("mismatch", "The server's answer could not be read.");
  }
  // The server must store exactly the bytes it was sent (BUD-02). One that says otherwise is not trusted with them.
  if (descriptor.sha256 !== sha256) throw new BlossomError("mismatch", "The server stored something other than what was sent.");
  return { url: typeof descriptor.url === "string" && descriptor.url.startsWith(`${server}/`) ? descriptor.url : `${server}/${sha256}` };
}

/** Fetch a blob by its hash (BUD-01), and check it is the blob: a server is believed only as far as the hash goes. */
export async function downloadBlob(server: string, sha256: string, sign?: BlossomSigner): Promise<Uint8Array> {
  let response = await request(`${server}/${sha256}`, { method: "GET" });
  if ((response.status === 401 || response.status === 403) && sign) response = await request(`${server}/${sha256}`, { method: "GET", headers: authHeader(await sign("get", server, sha256)) });
  if (response.status === 404) throw new BlossomError("not-found", "That server no longer has the file.");
  if (response.status === 402) throw new BlossomError("payment", "That server wants paying to hand the file back.", reasonOf(response));
  if (!response.ok) throw new BlossomError("refused", "The server would not hand the file over.", reasonOf(response));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if ((await sha256Hex(bytes)) !== sha256) throw new BlossomError("mismatch", "The server handed back something other than the file.");
  return bytes;
}

/** Ask a server to delete a blob (BUD-12). True if it is gone from there. */
export async function deleteBlob(server: string, sha256: string, sign: BlossomSigner): Promise<boolean> {
  try {
    const response = await request(`${server}/${sha256}`, { method: "DELETE", headers: authHeader(await sign("delete", server, sha256)) });
    return response.ok || response.status === 404;
  } catch {
    return false;
  }
}
