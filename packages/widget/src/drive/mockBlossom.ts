/**
 * A Blossom server for tests: it stores blobs in memory by their hash, and
 * checks every permission note the way a real one must (BUD-11). It can be
 * made to want paying (BUD-07), to refuse large files, or to hand back the
 * wrong bytes. TEST SUPPORT ONLY: nothing that ships imports this.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { verifyNostrEvent, type NostrEvent } from "@bitlogin/core/nostr";

export interface MockBlossom {
  url: string;
  blobs: Map<string, { bytes: Buffer; type: string; owner: string }>;
  /** Want this invoice paid before taking an upload. The proof it accepts is `proof`. */
  price: { invoice: string; proof: string } | null;
  /** Refuse anything larger than this, in bytes. */
  maxBytes: number;
  /** Hand back other bytes than were stored. */
  lie: boolean;
  /** Refuse every upload from anyone, as a members-only server does. */
  closed: boolean;
  /** Take pictures and video only, as many public servers do. */
  mediaOnly: boolean;
  requests: string[];
  close(): Promise<void>;
}

export async function startMockBlossom(): Promise<MockBlossom> {
  const self: MockBlossom = { url: "", blobs: new Map(), price: null, maxBytes: 10_000_000, lie: false, closed: false, mediaOnly: false, requests: [], close: () =>
      new Promise((resolve) => {
        // Every connection cut first: one a page holds open would otherwise hold close() forever.
        server.closeAllConnections();
        server.close(() => resolve());
      }) };

  /** The note in the `Authorization` header, if it is one this server must accept for this request. Else why not. */
  const authorised = (req: IncomingMessage, verb: string, sha256: string): { pubkey: string } | { error: string } => {
    const header = req.headers.authorization ?? "";
    if (!header.startsWith("Nostr ")) return { error: "no authorization" };
    let event: NostrEvent;
    try {
      event = JSON.parse(Buffer.from(header.slice(6), "base64url").toString("utf8")) as NostrEvent;
    } catch {
      return { error: "unreadable token" };
    }
    const now = Math.floor(Date.now() / 1000);
    const tag = (name: string) => event.tags.filter((t) => t[0] === name).map((t) => t[1]);
    if (!verifyNostrEvent(event) || event.kind !== 24242) return { error: "not an authorization event" };
    if (event.created_at > now) return { error: "created in the future" };
    if (!(Number(tag("expiration")[0]) > now)) return { error: "expired" };
    if (tag("t")[0] !== verb) return { error: "wrong verb" };
    if (tag("server").length && !tag("server").includes(new URL(self.url).hostname)) return { error: "for another server" };
    if (!tag("x").includes(sha256)) return { error: "for another blob" };
    return { pubkey: event.pubkey };
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,HEAD,PUT,DELETE,OPTIONS", "access-control-expose-headers": "X-Reason, X-Lightning, X-Cashu" };
      const say = (status: number, headers: Record<string, string> = {}, body: string | Buffer = "") => res.writeHead(status, { ...cors, ...headers }).end(req.method === "HEAD" ? undefined : body);
      const path = new URL(req.url ?? "/", "http://x").pathname;
      self.requests.push(`${req.method} ${path}`);
      if (req.method === "OPTIONS") return say(204);
      const body = Buffer.concat(chunks);

      if (path === "/upload" && (req.method === "PUT" || req.method === "HEAD")) {
        const head = req.method === "HEAD";
        const sha256 = head ? String(req.headers["x-sha-256"] ?? "") : createHash("sha256").update(body).digest("hex");
        const size = head ? Number(req.headers["x-content-length"] ?? 0) : body.length;
        if (!head && req.headers["x-sha-256"] && req.headers["x-sha-256"] !== sha256) return say(409, { "x-reason": "hash does not match the body" });
        const who = authorised(req, "upload", sha256);
        if ("error" in who) return say(401, { "x-reason": who.error });
        if (self.closed) return say(403, { "x-reason": "members only" });
        const kind = String(head ? (req.headers["x-content-type"] ?? "") : (req.headers["content-type"] ?? ""));
        if (self.mediaOnly && !/^(image|video)\//u.test(kind)) return say(415, { "x-reason": `unsupported content type: ${kind}` });
        if (size > self.maxBytes) return say(413, { "x-reason": `File too large. Max allowed size is ${self.maxBytes} bytes.` });
        if (self.price && req.headers["x-lightning"] !== self.price.proof) {
          // A HEAD is for finding out only: it is never answered with a paid upload (BUD-07).
          if (!head && req.headers["x-lightning"]) return say(400, { "x-reason": "invalid payment proof" });
          return say(402, { "x-lightning": self.price.invoice, "x-reason": "payment required" });
        }
        if (head) return say(200);
        const existed = self.blobs.has(sha256);
        const type = String(req.headers["content-type"] ?? "application/octet-stream");
        if (!existed) self.blobs.set(sha256, { bytes: body, type, owner: who.pubkey });
        return say(existed ? 200 : 201, { "content-type": "application/json" }, JSON.stringify({ url: `${self.url}/${sha256}`, sha256, size: body.length, type, uploaded: Math.floor(Date.now() / 1000) }));
      }

      const match = /^\/([0-9a-f]{64})(\.[a-z0-9]+)?$/u.exec(path);
      if (!match) return say(404);
      const sha256 = match[1]!;
      const blob = self.blobs.get(sha256);
      if (req.method === "GET" || req.method === "HEAD") {
        if (!blob) return say(404, { "x-reason": "not found" });
        const bytes = self.lie ? Buffer.from("something else entirely") : blob.bytes;
        return say(200, { "content-type": blob.type, "content-length": String(bytes.length) }, bytes);
      }
      if (req.method === "DELETE") {
        const who = authorised(req, "delete", sha256);
        if ("error" in who) return say(401, { "x-reason": who.error });
        if (!blob) return say(404);
        if (blob.owner !== who.pubkey) return say(403, { "x-reason": "not yours" });
        self.blobs.delete(sha256);
        return say(204);
      }
      return say(404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  self.url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  return self;
}
