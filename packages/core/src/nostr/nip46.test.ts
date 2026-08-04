import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockRelay } from "../test-support/mockRelay.js";
import { RelayConnection } from "./relay.js";
import { signNostrEvent, type NostrEvent } from "./event.js";
import { KIND_NOSTR_CONNECT } from "./kinds.js";
import {
  buildNostrconnectUri,
  listenForNostrconnect,
  Nip46Client,
  Nip46ErrorResponse,
  Nip46RequestTimeoutError,
  parseBunkerUri,
  sanitizeAuthUrl
} from "./nip46.js";
import { getConversationKey, nip44Decrypt, nip44Encrypt } from "../crypto/nip44.js";
import { generatePrivateKey, getPublicKeyHex } from "../crypto/secp256k1.js";
import { randomBytes } from "../crypto/random.js";
import { bytesToHex } from "../crypto/encoding.js";

const SIGNER_HEX = "ab".repeat(32);

describe("parseBunkerUri", () => {
  it("parses signer pubkey, relays, and secret", () => {
    const parsed = parseBunkerUri(
      `bunker://${SIGNER_HEX}?relay=wss://one.example&relay=wss://two.example&secret=tok3n`
    );
    expect(parsed.signerPubkey).toBe(SIGNER_HEX);
    expect(parsed.relayUrls).toEqual(["wss://one.example", "wss://two.example"]);
    expect(parsed.secret).toBe("tok3n");
  });

  it("accepts an uppercase pubkey and omitted secret", () => {
    const parsed = parseBunkerUri(`bunker://${SIGNER_HEX.toUpperCase()}?relay=wss://one.example`);
    expect(parsed.signerPubkey).toBe(SIGNER_HEX);
    expect(parsed.secret).toBeUndefined();
  });

  it("rejects wrong schemes, bad pubkeys, and relay-less URIs", () => {
    expect(() => parseBunkerUri(`nostrconnect://${SIGNER_HEX}?relay=wss://x.example`)).toThrow(
      /bunker:\/\//
    );
    expect(() => parseBunkerUri("bunker://nothex?relay=wss://x.example")).toThrow(/public key/);
    expect(() => parseBunkerUri(`bunker://${SIGNER_HEX}`)).toThrow(/no relays/);
    expect(() => parseBunkerUri("not a uri at all")).toThrow(/valid URI/);
  });
});

describe("buildNostrconnectUri", () => {
  it("round-trips through URL parsing with relays, secret, and name", () => {
    const uri = buildNostrconnectUri({
      clientPubkey: SIGNER_HEX,
      relayUrls: ["wss://one.example", "wss://two.example"],
      secret: "s3cret",
      name: "BitLogin"
    });
    expect(uri.startsWith(`nostrconnect://${SIGNER_HEX}?`)).toBe(true);
    const url = new URL(uri);
    expect(url.searchParams.getAll("relay")).toEqual(["wss://one.example", "wss://two.example"]);
    expect(url.searchParams.get("secret")).toBe("s3cret");
    expect(url.searchParams.get("name")).toBe("BitLogin");
  });
});

describe("sanitizeAuthUrl", () => {
  it("passes https and loopback-http, normalized", () => {
    expect(sanitizeAuthUrl("https://approve.example/req?id=1")).toBe("https://approve.example/req?id=1");
    expect(sanitizeAuthUrl("  https://approve.example ")).toBe("https://approve.example/");
    expect(sanitizeAuthUrl("http://localhost:8080/ok")).toBe("http://localhost:8080/ok");
    expect(sanitizeAuthUrl("http://127.0.0.1/ok")).toBe("http://127.0.0.1/ok");
  });

  it("rejects every active or non-https scheme and garbage", () => {
    // eslint-disable-next-line no-script-url -- hostile input under test
    for (const hostile of [
      "javascript:alert(document.domain)",
      "data:text/html,<script>alert(1)</script>",
      "blob:https://x.example/abc",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "http://evil.example/not-loopback",
      "nostr:nevent1...",
      "//protocol-relative.example",
      "not a url"
    ]) {
      expect(sanitizeAuthUrl(hostile)).toBeNull();
    }
  });
});

/**
 * A minimal in-test remote signer: listens for kind-24133 requests addressed
 * to its pubkey, decrypts them per client, and answers per `handle`.
 */
class FakeBunker {
  readonly signerKey = generatePrivateKey();
  readonly signerPubkey = getPublicKeyHex(this.signerKey);
  readonly userKey = generatePrivateKey();
  readonly userPubkey = getPublicKeyHex(this.userKey);
  readonly seen: Array<{ method: string; params: string[] }> = [];
  private conn: RelayConnection;
  private sub: { close: () => void } | null = null;
  /** Per-request interception; return the responses to send (in order). */
  handle: (request: { id: string; method: string; params: string[] }) => Array<{
    id: string;
    result?: string;
    error?: string;
  }>;

  constructor(relayUrl: string, private connectSecret = "") {
    this.conn = new RelayConnection(relayUrl);
    this.handle = (request) => {
      this.seen.push({ method: request.method, params: request.params });
      if (request.method === "connect") {
        if (this.connectSecret && request.params[1] !== this.connectSecret) {
          return [{ id: request.id, error: "invalid secret" }];
        }
        return [{ id: request.id, result: "ack" }];
      }
      if (request.method === "get_public_key") return [{ id: request.id, result: this.userPubkey }];
      if (request.method === "sign_event") {
        const unsigned = JSON.parse(request.params[0]!) as {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        };
        const signed = signNostrEvent(
          {
            pubkey: this.userPubkey,
            created_at: unsigned.created_at,
            kind: unsigned.kind,
            tags: unsigned.tags,
            content: unsigned.content
          },
          this.userKey
        );
        return [{ id: request.id, result: JSON.stringify(signed) }];
      }
      if (request.method === "nip44_encrypt") {
        return [{ id: request.id, result: `cipher(${request.params[1]})` }];
      }
      return [{ id: request.id, error: `unsupported method ${request.method}` }];
    };
  }

  async start(): Promise<void> {
    this.sub = await this.conn.subscribeLive(
      { kinds: [KIND_NOSTR_CONNECT], "#p": [this.signerPubkey] },
      (event) => void this.onRequest(event)
    );
  }

  async respond(clientPubkey: string, payload: { id: string; result?: string; error?: string }): Promise<void> {
    const conversationKey = getConversationKey(this.signerKey, clientPubkey);
    const event = signNostrEvent(
      {
        pubkey: this.signerPubkey,
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_NOSTR_CONNECT,
        tags: [["p", clientPubkey]],
        content: nip44Encrypt(conversationKey, JSON.stringify(payload))
      },
      this.signerKey
    );
    await this.conn.publish(event);
  }

  private async onRequest(event: NostrEvent): Promise<void> {
    const conversationKey = getConversationKey(this.signerKey, event.pubkey);
    const request = JSON.parse(nip44Decrypt(conversationKey, event.content)) as {
      id: string;
      method: string;
      params: string[];
    };
    for (const response of this.handle(request)) {
      await this.respond(event.pubkey, response);
    }
  }

  close(): void {
    this.sub?.close();
    this.conn.close();
  }
}

describe("Nip46Client against a fake bunker", () => {
  let relay: MockRelay;
  let bunker: FakeBunker;
  let client: Nip46Client;

  beforeEach(async () => {
    relay = await MockRelay.start();
  });

  afterEach(async () => {
    client?.close();
    bunker?.close();
    await relay.close();
  });

  function makeClient(secret?: string, timeoutMs = 5000): Nip46Client {
    client = new Nip46Client({
      clientSecretKey: generatePrivateKey(),
      pointer: { signerPubkey: bunker.signerPubkey, relayUrls: [relay.url], secret },
      requestTimeoutMs: timeoutMs
    });
    return client;
  }

  it("connects with the secret, fetches the user pubkey, and signs a verifying event", async () => {
    bunker = new FakeBunker(relay.url, "tok3n");
    await bunker.start();
    const c = makeClient("tok3n");
    await c.connect();
    expect(await c.getUserPublicKey()).toBe(bunker.userPubkey);

    const signed = await c.signEvent({
      kind: 1,
      content: "hello",
      tags: [],
      created_at: 1_700_000_000
    });
    expect(signed.pubkey).toBe(bunker.userPubkey);
    expect(signed.content).toBe("hello");
    // The user's pubkey travels with subsequent sign requests once known.
    const signParams = bunker.seen.find((r) => r.method === "sign_event")!.params;
    expect(JSON.parse(signParams[0]!).pubkey).toBe(bunker.userPubkey);
  });

  it("rejects a wrong connect secret with the signer's error", async () => {
    bunker = new FakeBunker(relay.url, "tok3n");
    await bunker.start();
    const c = makeClient("wrong");
    await expect(c.connect()).rejects.toBeInstanceOf(Nip46ErrorResponse);
  });

  it("surfaces auth_url once and still resolves the eventual answer", async () => {
    bunker = new FakeBunker(relay.url);
    const inner = bunker.handle.bind(bunker);
    bunker.handle = (request) => {
      if (request.method === "get_public_key") {
        return [
          { id: request.id, result: "auth_url", error: "https://approve.example/req" },
          // Same id, later: the real answer after "approval".
          ...inner(request)
        ];
      }
      return inner(request);
    };
    await bunker.start();

    const authUrls: string[] = [];
    client = new Nip46Client({
      clientSecretKey: generatePrivateKey(),
      pointer: { signerPubkey: bunker.signerPubkey, relayUrls: [relay.url] },
      onAuthUrl: (url) => authUrls.push(url),
      requestTimeoutMs: 5000
    });
    expect(await client.getUserPublicKey()).toBe(bunker.userPubkey);
    expect(authUrls).toEqual(["https://approve.example/req"]);
  });

  it("drops a hostile-scheme auth_url without consuming the surfacing slot", async () => {
    bunker = new FakeBunker(relay.url);
    const inner = bunker.handle.bind(bunker);
    bunker.handle = (request) => {
      if (request.method === "get_public_key") {
        return [
          // eslint-disable-next-line no-script-url -- hostile input under test
          { id: request.id, result: "auth_url", error: "javascript:alert(document.domain)" },
          { id: request.id, result: "auth_url", error: "https://approve.example/real" },
          ...inner(request)
        ];
      }
      return inner(request);
    };
    await bunker.start();

    const authUrls: string[] = [];
    client = new Nip46Client({
      clientSecretKey: generatePrivateKey(),
      pointer: { signerPubkey: bunker.signerPubkey, relayUrls: [relay.url] },
      onAuthUrl: (url) => authUrls.push(url),
      requestTimeoutMs: 5000
    });
    expect(await client.getUserPublicKey()).toBe(bunker.userPubkey);
    // The javascript: URL never surfaced; the later https one did.
    expect(authUrls).toEqual(["https://approve.example/real"]);
  });

  it("rejects a signed event whose fields differ from the request", async () => {
    bunker = new FakeBunker(relay.url);
    const inner = bunker.handle.bind(bunker);
    bunker.handle = (request) => {
      if (request.method === "sign_event") {
        const unsigned = JSON.parse(request.params[0]!) as {
          kind: number;
          content: string;
          tags: string[][];
          created_at: number;
        };
        const signed = signNostrEvent(
          { ...unsigned, pubkey: bunker.userPubkey, content: "tampered" },
          bunker.userKey
        );
        return [{ id: request.id, result: JSON.stringify(signed) }];
      }
      return inner(request);
    };
    await bunker.start();
    const c = makeClient();
    await c.connect();
    await c.getUserPublicKey();
    await expect(
      c.signEvent({ kind: 1, content: "original", tags: [], created_at: 1_700_000_000 })
    ).rejects.toThrow(/different event/);
  });

  it("times out with a typed error when the signer never answers", async () => {
    bunker = new FakeBunker(relay.url);
    bunker.handle = () => []; // listens, never replies
    await bunker.start();
    const c = makeClient(undefined, 300);
    await expect(c.connect()).rejects.toBeInstanceOf(Nip46RequestTimeoutError);
  });

  it("rejects a signed event from the wrong identity", async () => {
    bunker = new FakeBunker(relay.url);
    const impostorKey = generatePrivateKey();
    bunker.handle = (request) => {
      bunker.seen.push({ method: request.method, params: request.params });
      if (request.method === "connect") return [{ id: request.id, result: "ack" }];
      if (request.method === "get_public_key") return [{ id: request.id, result: bunker.userPubkey }];
      const unsigned = JSON.parse(request.params[0]!) as { kind: number; content: string; tags: string[][]; created_at: number };
      const signed = signNostrEvent(
        {
          pubkey: getPublicKeyHex(impostorKey),
          created_at: unsigned.created_at,
          kind: unsigned.kind,
          tags: unsigned.tags,
          content: unsigned.content
        },
        impostorKey
      );
      return [{ id: request.id, result: JSON.stringify(signed) }];
    };
    await bunker.start();
    const c = makeClient();
    await c.connect();
    await c.getUserPublicKey();
    await expect(
      c.signEvent({ kind: 1, content: "x", tags: [], created_at: 1_700_000_000 })
    ).rejects.toThrow(/different identity/);
  });

  it("passes nip44 encryption RPCs through", async () => {
    bunker = new FakeBunker(relay.url);
    await bunker.start();
    const c = makeClient();
    await c.connect();
    expect(await c.nip44Encrypt("cd".repeat(32), "hi")).toBe("cipher(hi)");
  });
});

describe("listenForNostrconnect", () => {
  let relay: MockRelay;

  beforeEach(async () => {
    relay = await MockRelay.start();
  });

  afterEach(async () => {
    await relay.close();
  });

  it("resolves the signer pubkey when the secret is echoed, ignoring wrong secrets", async () => {
    const clientSecretKey = generatePrivateKey();
    const clientPubkey = getPublicKeyHex(clientSecretKey);
    const secret = bytesToHex(randomBytes(8));

    const wait = listenForNostrconnect({
      clientSecretKey,
      relayUrls: [relay.url],
      secret,
      timeoutMs: 5000
    });

    const impostor = new FakeBunker(relay.url);
    await impostor.respond(clientPubkey, { id: "x", result: "not-the-secret" });
    const genuine = new FakeBunker(relay.url);
    await genuine.respond(clientPubkey, { id: "y", result: secret });

    const { signerPubkey } = await wait;
    expect(signerPubkey).toBe(genuine.signerPubkey);
    impostor.close();
    genuine.close();
  });

  it("times out when no signer connects", async () => {
    await expect(
      listenForNostrconnect({
        clientSecretKey: generatePrivateKey(),
        relayUrls: [relay.url],
        secret: "s",
        timeoutMs: 300
      })
    ).rejects.toThrow(/No signer connected/);
  });
});
