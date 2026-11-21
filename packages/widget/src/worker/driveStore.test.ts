import { describe, expect, it } from "vitest";
import { NostrSigner } from "@bitlogin/core/account";
import { generatePrivateKey } from "@bitlogin/core/crypto";
import { InMemoryKeyValueStore } from "@bitlogin/core/storage";
import { verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import { blossomAuth, DRIVE_KIND, loadDrive, rankServers, saveDrive, type DriveRelays } from "./driveStore.js";
import { createDrive, ROOT } from "../drive/tree.js";

const A = "https://a.example";
const blob = (n: number, extra: Record<string, unknown> = {}) => ({ name: `f${n}.txt`, sha256: String(n).padStart(64, "0"), size: 1000 * n, type: "text/plain", servers: [A], ...extra });

/** Relays that keep the newest record for each `d`, and can be switched off. */
function fakeRelays() {
  const events = new Map<string, NostrEvent>();
  const self = {
    up: true,
    events,
    relayUrls: ["wss://a.example", "wss://b.example"],
    async queryQuorum(filter: NostrFilter) {
      if (!self.up) return { outcomes: [], respondedCount: 0 };
      return { outcomes: [{ events: [...events.values()].filter((e) => (filter.kinds ?? []).includes(e.kind)) }], respondedCount: 2 };
    },
    async publishAll(event: NostrEvent): Promise<RelayPublishOutcome[]> {
      const ok = self.up;
      if (ok) {
        const d = event.tags.find((t) => t[0] === "d")?.[1] ?? event.id;
        const held = events.get(d);
        if (!held || held.created_at <= event.created_at) events.set(d, event);
      }
      return self.relayUrls.map((relayUrl) => ({ relayUrl, result: { ok, message: "" } })) as RelayPublishOutcome[];
    }
  };
  return self as typeof self & DriveRelays;
}
const setup = () => ({ signer: new NostrSigner(generatePrivateKey()), store: new InMemoryKeyValueStore(), relays: fakeRelays() });
const names = (state: { folders: { name: string }[] }) => state.folders.map((f) => f.name).sort();

describe("where a person's file index is kept (docs/files.md)", () => {
  it("keeps folders on relays, sealed, one record each, and another device reads them", async () => {
    const deps = setup();
    expect(await loadDrive(deps)).toEqual({ folders: [], settings: { autoPaySats: 0 }, offline: false, unsaved: false });
    const drive = createDrive([]);
    const docs = drive.createFolder(ROOT, "Documents");
    drive.addFile(docs.id, blob(1, { key: "ab".repeat(32) }));
    drive.addFile(ROOT, blob(2));
    const saved = await saveDrive(deps, drive.takeChanges());
    expect(saved.unsaved).toBe(false);
    expect(names(saved)).toEqual(["Documents", "Files"]);
    const held = [...deps.relays.events.values()];
    expect(held.every((e) => e.kind === DRIVE_KIND)).toBe(true);
    expect(held.length).toBe(2);
    // Nothing a relay holds says a name, a server, a hash or a key.
    for (const event of held) expect(event.content).not.toMatch(/Documents|f1\.txt|a\.example|abab|0000000001/u);
    const elsewhere = await loadDrive({ ...deps, store: new InMemoryKeyValueStore() });
    expect(names(elsewhere)).toEqual(["Documents", "Files"]);
    expect(elsewhere.folders.find((f) => f.name === "Documents")!.files[0]).toMatchObject({ name: "f1.txt", key: "ab".repeat(32) });
    // Someone else's key opens none of it.
    expect((await loadDrive({ ...setup(), relays: deps.relays })).folders).toEqual([]);
  });

  it("loses nothing when relays are down, and sends it when they are back", async () => {
    const deps = setup();
    deps.relays.up = false;
    const drive = createDrive([]);
    const a = drive.createFolder(ROOT, "A");
    drive.addFile(a.id, blob(1));
    const offline = await saveDrive(deps, drive.takeChanges());
    expect(offline.unsaved).toBe(true);
    expect(deps.relays.events.size).toBe(0);
    // Closed and opened again, still with no relay: the drive opens from this browser, and says so.
    const still = await loadDrive(deps);
    expect(still).toMatchObject({ offline: true, unsaved: true });
    expect(still.folders.find((f) => f.name === "A")!.files.length).toBe(1);
    expect([...(deps.store as any).map.values()].join("")).not.toMatch(/f1\.txt|a\.example/u);
    deps.relays.up = true;
    const back = await loadDrive(deps);
    expect(back).toMatchObject({ offline: false, unsaved: false });
    expect(deps.relays.events.size).toBe(1);
    expect(names(await loadDrive({ ...deps, store: new InMemoryKeyValueStore() }))).toEqual(["A"]);
  });

  it("takes the newer record for a folder, and a removal made on another device", async () => {
    const deps = setup();
    const here = createDrive([], () => 1000);
    const a = here.createFolder(ROOT, "A");
    const b = here.createFolder(ROOT, "B");
    await saveDrive({ ...deps, now: 1000 }, here.takeChanges());
    // Another device, the same account: renames A, removes B.
    const otherStore = new InMemoryKeyValueStore();
    const there = createDrive((await loadDrive({ ...deps, store: otherStore })).folders, () => 2000);
    there.renameFolder(a.id, "Archive");
    there.deleteFolder(b.id);
    await saveDrive({ ...deps, store: otherStore, now: 2000 }, there.takeChanges());
    const seen = await loadDrive(deps);
    expect(names(seen)).toEqual(["Archive"]);
    expect(seen.unsaved).toBe(false);
    // And it does not come back when this device next saves something else.
    const again = createDrive(seen.folders, () => 3000);
    again.createFolder(ROOT, "C");
    await saveDrive({ ...deps, now: 3000 }, again.takeChanges());
    expect(names(await loadDrive({ ...deps, store: new InMemoryKeyValueStore() }))).toEqual(["Archive", "C"]);
  });

  it("keeps the most a server may be paid without asking, and refuses what is not a folder", async () => {
    const deps = setup();
    expect((await saveDrive(deps, { settings: { autoPaySats: 50 } })).settings).toEqual({ autoPaySats: 50 });
    expect((await loadDrive({ ...deps, store: new InMemoryKeyValueStore() })).settings).toEqual({ autoPaySats: 50 });
    expect((await saveDrive(deps, { settings: { autoPaySats: -4 } })).settings).toEqual({ autoPaySats: 0 });
    await expect(saveDrive(deps, { save: [{ id: "nope", name: "x", parent: ROOT, files: [] }] })).rejects.toThrow();
  });

  it("signs a permission note for one file at one server, and nothing wider", () => {
    const signer = new NostrSigner(generatePrivateKey());
    const sha256 = "ab".repeat(32);
    const token = blossomAuth(signer, { verb: "upload", server: "https://CDN.Example.com/x", sha256 }, 10_000);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    const event = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    expect(verifyNostrEvent(event)).toBe(true);
    expect(event).toMatchObject({ kind: 24242, pubkey: signer.getPublicKey(), created_at: 9970 });
    expect(event.tags).toEqual([["t", "upload"], ["expiration", "10300"], ["server", "cdn.example.com"], ["x", sha256]]);
    // Never without the file it is for, never for a server that is not one, never to list.
    expect(() => blossomAuth(signer, { verb: "upload", server: "https://cdn.example.com" })).toThrow(/one file/u);
    expect(() => blossomAuth(signer, { verb: "delete", server: "http://plain.example", sha256 })).toThrow();
    expect(() => blossomAuth(signer, { verb: "list", server: "https://cdn.example.com", sha256 })).toThrow();
  });

  it("ranks servers by who uses them, one voice each, the user's follows first", () => {
    const list = (pubkey: string, created_at: number, ...servers: string[]) => ({ kind: 10063, pubkey, created_at, tags: servers.map((s) => ["server", s]) });
    const events = [
      list("a", 1, "https://big.example"), list("b", 1, "https://big.example/"), list("c", 1, "https://big.example", "https://mid.example"),
      list("d", 1, "https://mid.example"), list("friend", 1, "https://small.example"), list("e", 1, "https://lonely.example"),
      // An older list from the same account is not a second voice.
      list("a", 0, "https://old.example"), list("b", 0, "https://old.example"),
      list("f", 1, "http://plain.example"), list("g", 1, "http://plain.example")
    ];
    expect(rankServers(events, new Set(["friend"]))).toEqual([
      { server: "https://small.example", by: 1, byFollowed: 1 },
      { server: "https://big.example", by: 3, byFollowed: 0 },
      { server: "https://mid.example", by: 2, byFollowed: 0 }
    ]);
  });
});
