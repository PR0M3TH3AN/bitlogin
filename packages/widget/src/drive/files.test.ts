import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import type { NostrEvent, NostrFilter, RelayPublishOutcome } from "@bitlogin/core/nostr";
import { blossomAuth, loadDrive, saveDrive, type DriveRelays } from "../worker/driveStore.js";
import { BlossomError, openFile, sealFile, sha256Hex } from "./blossom.js";
import { createFiles, type FilesOptions, type FilesStore } from "./files.js";
import { startMockBlossom, type MockBlossom } from "./mockBlossom.js";

const text = (s: string) => new TextEncoder().encode(s);
const read = (b: Uint8Array) => new TextDecoder().decode(b);

function storeFor(signer: NostrSigner, mine: string[]) {
  const events = new Map<string, NostrEvent>();
  const relays = {
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent) {
      events.set(event.tags.find((t) => t[0] === "d")?.[1] ?? event.id, event);
      return this.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok: true, message: "" } })) as RelayPublishOutcome[];
    }
  } as DriveRelays;
  const deps = { signer, store: new InMemoryKeyValueStore(), relays };
  const store: FilesStore = {
    load: () => loadDrive(deps),
    save: (changes) => saveDrive(deps, changes),
    auth: async (verb, server, sha256) => blossomAuth(signer, { verb, server, sha256 }),
    servers: async () => ({ mine, ranked: [] }),
    setServers: async (servers) => (mine = servers)
  };
  return store;
}

describe("a person's files on Blossom servers (docs/files.md)", () => {
  let one: MockBlossom;
  let two: MockBlossom;
  beforeAll(async () => {
    one = await startMockBlossom();
    two = await startMockBlossom();
  });
  afterAll(async () => {
    await one.close();
    await two.close();
  });
  beforeEach(() => {
    for (const server of [one, two]) Object.assign(server, { price: null, maxBytes: 10_000_000, lie: false, closed: false, mediaOnly: false });
    one.blobs.clear();
    two.blobs.clear();
  });
  const open = async (servers = [one.url], options: FilesOptions = {}) => {
    const signer = new NostrSigner(generatePrivateKey());
    const store = storeFor(signer, servers);
    const files = createFiles(store, options);
    await files.open();
    return { files, store, signer };
  };

  it("seals a private file so its server holds nothing readable, and opens it again", async () => {
    const { sealed, key } = await sealFile(text("my diary"));
    expect(read(sealed)).not.toContain("diary");
    expect(read(await openFile(sealed, key))).toBe("my diary");
    // Another key, or one changed byte, opens nothing.
    await expect(openFile(sealed, "00".repeat(32))).rejects.toBeInstanceOf(BlossomError);
    sealed[20] = (sealed[20] ?? 0) ^ 1;
    await expect(openFile(sealed, key)).rejects.toMatchObject({ code: "mismatch" });
    // The same file sealed twice is two different blobs: a server can't tell two people keep the same thing.
    expect(await sha256Hex((await sealFile(text("x"))).sealed)).not.toBe(await sha256Hex((await sealFile(text("x"))).sealed));
  });

  it("saves a public file as it is and a private one sealed, and reads both back", async () => {
    const { files } = await open();
    const pub = await files.put(files.ROOT, { name: "hello.txt", type: "text/plain", bytes: text("hello world") }, { private: false });
    const priv = await files.put(files.ROOT, { name: "diary.txt", type: "text/plain", bytes: text("my diary") }, { private: true });
    // The public one is on the server as it was written, under the hash of its bytes, and has a link.
    expect(read(one.blobs.get(pub.sha256)!.bytes)).toBe("hello world");
    expect(files.link(pub.id)).toBe(`${one.url}/${pub.sha256}`);
    // The private one is there too, and says nothing: not its words, not what kind of file it is. And it has no link.
    const held = one.blobs.get(priv.sha256)!;
    expect(read(held.bytes)).not.toContain("diary");
    expect(held.type).toBe("application/octet-stream");
    expect(files.link(priv.id)).toBeNull();
    expect(read((await files.get(priv.id)).bytes)).toBe("my diary");
    expect(await files.get(pub.id)).toMatchObject({ name: "hello.txt", type: "text/plain" });
    expect(files.usage()).toEqual([{ server: one.url, bytes: pub.size + priv.size, files: 2 }]);
  });

  it("is still there on another device, private key and all", async () => {
    const { files, store } = await open();
    const docs = await files.newFolder(files.ROOT, "Documents");
    const priv = await files.put(docs.id, { name: "diary.txt", type: "text/plain", bytes: text("my diary") }, { private: true });
    const again = createFiles(store);
    await again.open();
    const found = again.drive().children(again.ROOT)[0]!;
    expect(found.name).toBe("Documents");
    expect(read((await again.get(found.files[0]!.id)).bytes)).toBe("my diary");
    expect(found.files[0]!.id).toBe(priv.id);
  });

  it("moves, copies and deletes like a file browser, and deletes the bytes only with the last name", async () => {
    const { files } = await open();
    const a = await files.newFolder(files.ROOT, "A");
    const b = await files.newFolder(files.ROOT, "B");
    const file = await files.put(a.id, { name: "photo.jpg", type: "image/jpeg", bytes: text("jpeg bytes") }, { private: false });
    await files.move({ file: file.id }, b.id);
    expect(files.drive().folder(b.id).files.map((f) => f.name)).toEqual(["photo.jpg"]);
    const copy = await files.copy(file.id, a.id);
    // Copying uploaded nothing: one blob, two names.
    expect(one.blobs.size).toBe(1);
    await files.rename({ file: copy.id }, "photo copy.jpg");
    await files.remove({ file: file.id });
    expect(one.blobs.size).toBe(1);
    await files.remove({ file: copy.id });
    expect(one.blobs.size).toBe(0);
    // A folder goes with everything in it.
    await files.put(a.id, { name: "x.txt", type: "text/plain", bytes: text("x") }, { private: true });
    await files.remove({ folder: a.id });
    expect(one.blobs.size).toBe(0);
    expect(files.drive().children(files.ROOT).map((f) => f.name)).toEqual(["B"]);
  });

  it("keeps a second copy on a second server, and reads from it when the first has lost the file", async () => {
    const { files } = await open([one.url, two.url]);
    const file = await files.put(files.ROOT, { name: "keep.txt", type: "text/plain", bytes: text("keep me") }, { private: true });
    expect(file.servers).toEqual([one.url, two.url]);
    one.blobs.clear();
    expect(read((await files.get(file.id)).bytes)).toBe("keep me");
    // A server that hands back other bytes is not believed: the hash says so, and the next server is asked.
    one.lie = true;
    one.blobs.set(file.sha256, { bytes: Buffer.from("x"), type: "x/y", owner: "" });
    expect(read((await files.get(file.id)).bytes)).toBe("keep me");
    two.blobs.clear();
    await expect(files.get(file.id)).rejects.toBeInstanceOf(BlossomError);
  });

  it("says when a server is full, closed or too small, in the server's own words, and keeps no entry for a file that was not saved", async () => {
    const { files } = await open();
    one.maxBytes = 5;
    const tooBig = await files.put(files.ROOT, { name: "big.bin", type: "application/octet-stream", bytes: text("more than five bytes") }, { private: false }).catch((err) => err);
    expect(tooBig).toMatchObject({ code: "too-large", reason: "File too large. Max allowed size is 5 bytes." });
    one.maxBytes = 10_000_000;
    one.closed = true;
    await expect(files.put(files.ROOT, { name: "a.txt", type: "text/plain", bytes: text("a") }, { private: false })).rejects.toMatchObject({ code: "refused" });
    expect(files.drive().folder(files.ROOT).files).toEqual([]);
    expect(await files.check(one.url)).toMatchObject({ state: "closed", reason: "members only" });
    one.closed = false;
    expect(await files.check(one.url)).toMatchObject({ state: "free" });
    expect(await files.check("http://127.0.0.1:9")).toMatchObject({ state: "unreachable" });
    await expect(createFiles(storeFor(new NostrSigner(generatePrivateKey()), [])).put("root", { name: "a", type: "", bytes: text("a") }, { private: false })).rejects.toThrow(/Choose a file server/u);
  });

  it("keeps a private file on a server that takes any file, where the first takes pictures and video only", async () => {
    // As it is in the wild: several of the most used servers take media and refuse everything else.
    const { files } = await open([one.url, two.url]);
    one.mediaOnly = true;
    expect(await files.check(one.url)).toMatchObject({ state: "media-only", reason: "unsupported content type: application/octet-stream" });
    // A public picture goes to both.
    const picture = await files.put(files.ROOT, { name: "cat.png", type: "image/png", bytes: text("png bytes") }, { private: false });
    expect(picture.servers).toEqual([one.url, two.url]);
    // A private file is sealed, so the first server can't tell it is a picture, and won't have it: the second keeps it.
    const secret = await files.put(files.ROOT, { name: "cat.png", type: "image/png", bytes: text("png bytes") }, { private: true });
    expect(secret.servers).toEqual([two.url]);
    expect(read((await files.get(secret.id)).bytes)).toBe("png bytes");
    // With only such a server, a private file can't be kept, and the person is told why.
    const { files: only } = await open([one.url]);
    await expect(only.put(only.ROOT, { name: "notes.txt", type: "text/plain", bytes: text("notes") }, { private: true })).rejects.toMatchObject({ code: "kind" });
    expect(only.drive().folder(only.ROOT).files).toEqual([]);
  });

  it("pays a server that asks, without asking the person, only up to what they allowed", async () => {
    const paid: string[] = [];
    const asked: number[] = [];
    let answer = false;
    const payer = { quote: async (invoice: string) => ({ sats: 21, pay: async () => (paid.push(invoice), "proof-of-payment") }) };
    const { files } = await open([one.url], { payer, confirmPay: async (sats) => (asked.push(sats), answer) });
    one.price = { invoice: "lnbc210n1mockinvoice", proof: "proof-of-payment" };
    expect(await files.check(one.url)).toMatchObject({ state: "paid", invoice: "lnbc210n1mockinvoice" });
    // Nothing allowed yet, and the person says no: nothing is paid, nothing uploaded, nothing kept.
    await expect(files.put(files.ROOT, { name: "a.txt", type: "text/plain", bytes: text("a") }, { private: false })).rejects.toMatchObject({ code: "payment" });
    expect([paid, asked, one.blobs.size]).toEqual([[], [21], 0]);
    // The person says yes this once.
    answer = true;
    await files.put(files.ROOT, { name: "a.txt", type: "text/plain", bytes: text("a") }, { private: false });
    expect([paid.length, asked, one.blobs.size]).toEqual([1, [21, 21], 1]);
    // Up to 20 sats without asking: 21 still asks. Up to 50: paid without a word.
    await files.setAutoPay(20);
    await files.put(files.ROOT, { name: "b.txt", type: "text/plain", bytes: text("b") }, { private: false });
    expect(asked.length).toBe(3);
    await files.setAutoPay(50);
    await files.put(files.ROOT, { name: "c.txt", type: "text/plain", bytes: text("c") }, { private: false });
    expect([paid.length, asked.length, one.blobs.size]).toEqual([3, 3, 3]);
    // With no wallet to pay from, a paid server takes nothing.
    const { files: broke } = await open([one.url]);
    await expect(broke.put(broke.ROOT, { name: "d.txt", type: "text/plain", bytes: text("d") }, { private: false })).rejects.toMatchObject({ code: "payment" });
  });

  it("gives a permission note that works for one file at one server and nothing else", async () => {
    const { files, store, signer } = await open([one.url]);
    const file = await files.put(files.ROOT, { name: "mine.txt", type: "text/plain", bytes: text("mine") }, { private: false });
    // A stranger's note deletes nothing of this person's.
    const stranger = new NostrSigner(generatePrivateKey());
    const tryDelete = (token: string, server = one.url, sha = file.sha256) => fetch(`${server}/${sha}`, { method: "DELETE", headers: { Authorization: `Nostr ${token}` } }).then((r) => r.status);
    expect(await tryDelete(blossomAuth(stranger, { verb: "delete", server: one.url, sha256: file.sha256 }))).toBe(403);
    // The owner's note for the other server, for another file, or to upload, does not delete this one here.
    // (A note names its server by domain alone, as BUD-11 says, so this one is made for another domain.)
    expect(await tryDelete(blossomAuth(signer, { verb: "delete", server: "https://other-server.example", sha256: file.sha256 }))).toBe(401);
    expect(await tryDelete(await store.auth("delete", one.url, "cd".repeat(32)))).toBe(401);
    expect(await tryDelete(await store.auth("upload", one.url, file.sha256))).toBe(401);
    expect(one.blobs.has(file.sha256)).toBe(true);
    expect(await tryDelete(await store.auth("delete", one.url, file.sha256))).toBe(204);
  });

  it("makes a site's folder the first time, and saves there unless told otherwise", async () => {
    const { files } = await open();
    const folder = await files.worldFolder("https://gallery.bitblocks.network");
    expect(files.drive().path(folder.id).map((f) => f.name)).toEqual(["Files", "Worlds", "gallery.bitblocks.network"]);
    await files.put(folder.id, { name: "sculpture.glb", type: "model/gltf-binary", bytes: text("glb") }, { private: true });
    expect((await files.worldFolder("https://gallery.bitblocks.network")).files.map((f) => f.name)).toEqual(["sculpture.glb"]);
  });
});
