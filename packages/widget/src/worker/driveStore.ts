/**
 * Where a person's file index is kept (docs/files.md): in this browser
 * first, then on the account's relays, one record per folder, sealed to the
 * account's own key. The same rule as the ecash wallet: nothing new lives
 * only in memory, a record no relay takes is sent again later, and with no
 * relay answering the drive opens from the browser's copy and says so.
 *
 * The files themselves are on Blossom servers. This holds their names, the
 * folders, which server holds what, and the key of every private file.
 *
 * Runs in the crypto worker, with a full session.
 */
import type { NostrSigner } from "@bitlogin/core/account";
import { countAcknowledgements, verifyNostrEvent, type NostrEvent, type NostrFilter, type RelayPublishOutcome } from "@bitlogin/core/nostr";
import type { KeyValueStore } from "@bitlogin/core/storage";
import { cleanFolder, cleanServer, DRIVE_LIMITS, type DriveFolder } from "../drive/tree.js";

export interface DriveRelays {
  queryQuorum(filter: NostrFilter, timeoutMs?: number): Promise<{ outcomes: { events: NostrEvent[] }[]; respondedCount: number }>;
  publishAll(event: NostrEvent, timeoutMs?: number): Promise<RelayPublishOutcome[]>;
  relayUrls: string[];
}

/** NIP-78 application data: a record of BitLogin's own, replaced whole each time its folder changes. */
export const DRIVE_KIND = 30078;
export const DRIVE_D = "bitlogin-drive:";
export const SERVER_LIST_KIND = 10063;
export const BLOSSOM_AUTH_KIND = 24242;

export interface DriveSettings {
  /** The most a paid server may be paid for one file without asking, in sats. 0: always ask. */
  autoPaySats: number;
}

export interface DriveState {
  folders: DriveFolder[];
  settings: DriveSettings;
  /** No relay answered: this is the browser's own copy. */
  offline: boolean;
  /** Something here is not on any relay yet. It is sent again when the drive is next opened. */
  unsaved: boolean;
}

interface LocalCopy {
  folders: Map<string, { folder: DriveFolder; saved: boolean }>;
  /** Folders removed here whose removal no relay has taken yet. */
  removed: Map<string, number>;
  settings: DriveSettings & { at: number; saved: boolean };
}

const LOCAL = "bitlogin:drive:v1:";
const NO_SETTINGS = { autoPaySats: 0, at: 0, saved: true };
const cleanSettings = (input: unknown): DriveSettings => {
  const n = (input as { autoPaySats?: unknown } | null)?.autoPaySats;
  return { autoPaySats: typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= 100_000 ? n : 0 };
};

/**
 * The browser's copy: a list of what there is, and one sealed entry per folder, so that no one entry grows past what
 * can be sealed however many files a person keeps.
 */
async function readLocal(store: KeyValueStore, signer: NostrSigner): Promise<LocalCopy> {
  const me = signer.getPublicKey();
  const copy: LocalCopy = { folders: new Map(), removed: new Map(), settings: { ...NO_SETTINGS } };
  const open = async (key: string): Promise<unknown> => {
    try {
      const sealed = await store.get(key);
      return sealed ? JSON.parse(signer.nip44Decrypt(me, sealed)) : null;
    } catch {
      return null;
    }
  };
  const head = (await open(LOCAL + me)) as { folders?: unknown; removed?: unknown; settings?: unknown } | null;
  if (!head) return copy;
  for (const id of Array.isArray(head.folders) ? head.folders.slice(0, DRIVE_LIMITS.folders + 1) : []) {
    if (typeof id !== "string") continue;
    const entry = (await open(`${LOCAL}${me}:${id}`)) as { folder?: unknown; saved?: unknown } | null;
    const folder = cleanFolder(entry?.folder);
    if (folder) copy.folders.set(folder.id, { folder, saved: entry?.saved === true });
  }
  for (const item of Array.isArray(head.removed) ? head.removed : []) {
    if (Array.isArray(item) && typeof item[0] === "string" && typeof item[1] === "number") copy.removed.set(item[0], item[1]);
  }
  const s = head.settings as { at?: unknown; saved?: unknown } | null;
  copy.settings = { ...cleanSettings(s), at: typeof s?.at === "number" ? s.at : 0, saved: s?.saved !== false };
  return copy;
}

async function writeLocal(store: KeyValueStore, signer: NostrSigner, copy: LocalCopy, changed: readonly string[], gone: readonly string[] = []): Promise<void> {
  const me = signer.getPublicKey();
  const seal = (value: unknown) => signer.nip44Encrypt(me, JSON.stringify(value));
  for (const id of changed) {
    const entry = copy.folders.get(id);
    if (entry) await store.set(`${LOCAL}${me}:${id}`, seal(entry));
  }
  for (const id of gone) await store.delete(`${LOCAL}${me}:${id}`).catch(() => {});
  await store.set(LOCAL + me, seal({ folders: [...copy.folders.keys()], removed: [...copy.removed], settings: copy.settings }));
}

const accepted = (outcomes: RelayPublishOutcome[], of: number): boolean => countAcknowledgements(outcomes) >= Math.min(2, of);

function record(signer: NostrSigner, d: string, body: unknown, at: number): NostrEvent {
  const me = signer.getPublicKey();
  return signer.signEvent({ kind: DRIVE_KIND, created_at: Math.floor(at), tags: [["d", DRIVE_D + d]], content: signer.nip44Encrypt(me, JSON.stringify(body)) });
}

const state = (copy: LocalCopy, offline: boolean): DriveState => ({
  folders: [...copy.folders.values()].map((entry) => entry.folder),
  settings: { autoPaySats: copy.settings.autoPaySats },
  offline,
  unsaved: [...copy.folders.values()].some((entry) => !entry.saved) || copy.removed.size > 0 || !copy.settings.saved
});

/** Send what no relay has yet: folders changed here, removals, the settings. What a relay takes is marked saved. */
async function flush(deps: { signer: NostrSigner; store: KeyValueStore; relays: DriveRelays; now?: number }, copy: LocalCopy): Promise<void> {
  const { signer, store, relays } = deps;
  const now = deps.now ?? Date.now() / 1000;
  const changed: string[] = [];
  for (const [id, entry] of copy.folders) {
    if (entry.saved) continue;
    const took = accepted(await relays.publishAll(record(signer, id, { v: 1, folder: entry.folder }, Math.max(now, entry.folder.at)), 6000).catch(() => []), relays.relayUrls.length);
    if (!took) continue;
    entry.saved = true;
    changed.push(id);
  }
  for (const [id, at] of [...copy.removed]) {
    // A removal is a record too: it says the folder is gone, and when, so another device does not bring it back.
    const took = accepted(await relays.publishAll(record(signer, id, { v: 1, deleted: true, at }, Math.max(now, at)), 6000).catch(() => []), relays.relayUrls.length);
    if (took) copy.removed.delete(id);
  }
  if (!copy.settings.saved) {
    const took = accepted(await relays.publishAll(record(signer, "settings", { v: 1, settings: { autoPaySats: copy.settings.autoPaySats }, at: copy.settings.at }, Math.max(now, copy.settings.at)), 6000).catch(() => []), relays.relayUrls.length);
    if (took) copy.settings.saved = true;
  }
  await writeLocal(store, signer, copy, changed);
}

/**
 * Open the drive: what relays hold, joined with what this browser holds.
 * For each folder the newer record wins. With no relay answering, the
 * browser's copy alone, and it says so. Never "empty" because relays were silent.
 */
/** The browser's own copy, and nothing asked of relays: to show at once, marked as being checked. It writes nothing. */
export async function peekDrive(deps: { signer: NostrSigner; store: KeyValueStore }): Promise<DriveState> {
  return state(await readLocal(deps.store, deps.signer), true);
}

export async function loadDrive(deps: { signer: NostrSigner; store: KeyValueStore; relays: DriveRelays; now?: number }): Promise<DriveState> {
  const { signer, store, relays } = deps;
  const me = signer.getPublicKey();
  const local = await readLocal(store, signer);
  const found = await relays.queryQuorum({ kinds: [DRIVE_KIND], authors: [me], limit: 500 }, 6000).catch(() => null);
  if (!found || found.respondedCount === 0) return state(local, true);

  // The newest record for each folder, among what relays hold.
  const newest = new Map<string, NostrEvent>();
  for (const event of found.outcomes.flatMap((o) => o.events)) {
    if (event.kind !== DRIVE_KIND || event.pubkey !== me || !verifyNostrEvent(event)) continue;
    const d = event.tags.find((tag) => tag[0] === "d")?.[1];
    if (typeof d !== "string" || !d.startsWith(DRIVE_D)) continue;
    const id = d.slice(DRIVE_D.length);
    if (!newest.has(id) || newest.get(id)!.created_at < event.created_at) newest.set(id, event);
  }
  const changed: string[] = [];
  const gone: string[] = [];
  for (const [id, event] of newest) {
    let body: { folder?: unknown; deleted?: unknown; at?: unknown; settings?: unknown };
    try {
      body = JSON.parse(signer.nip44Decrypt(me, event.content)) as typeof body;
    } catch {
      continue;
    }
    if (id === "settings") {
      const at = typeof body.at === "number" ? body.at : event.created_at;
      if (local.settings.saved || at > local.settings.at) local.settings = { ...cleanSettings(body.settings), at, saved: true };
      continue;
    }
    const mine = local.folders.get(id);
    if (body.deleted === true) {
      const at = typeof body.at === "number" ? body.at : event.created_at;
      // Removed on another device, and not changed here since: gone here too.
      if (mine && (mine.saved || mine.folder.at <= at)) {
        local.folders.delete(id);
        gone.push(id);
      }
      local.removed.delete(id);
      continue;
    }
    const folder = cleanFolder(body.folder);
    if (!folder || folder.id !== id || local.removed.has(id)) continue;
    // A folder changed here and not yet sent is kept, unless the relays' is newer still.
    if (mine && !mine.saved && mine.folder.at >= folder.at) continue;
    if (mine && mine.saved && mine.folder.at >= folder.at) continue;
    local.folders.set(id, { folder, saved: true });
    changed.push(id);
  }
  // What this browser has that no relay does is sent again, whether it was never taken or a relay has since lost it.
  for (const [id, entry] of local.folders) if (!newest.has(id)) entry.saved = false;
  await writeLocal(store, signer, local, changed, gone);
  await flush(deps, local);
  return state(local, false);
}

export interface DriveSave {
  /** Folders as they now are. */
  save?: unknown[];
  /** Folders removed, by id. */
  remove?: unknown[];
  settings?: unknown;
}

/** Keep changed folders: in this browser first, then on relays. */
export async function saveDrive(deps: { signer: NostrSigner; store: KeyValueStore; relays: DriveRelays; now?: number }, changes: DriveSave): Promise<DriveState> {
  const { signer, store } = deps;
  const now = deps.now ?? Date.now() / 1000;
  const folders = (changes.save ?? []).map(cleanFolder);
  if (folders.some((folder) => !folder)) throw new Error("That is not a folder this drive can keep.");
  const local = await readLocal(store, signer);
  const changed: string[] = [];
  const gone: string[] = [];
  for (const folder of folders as DriveFolder[]) {
    local.folders.set(folder.id, { folder, saved: false });
    local.removed.delete(folder.id);
    changed.push(folder.id);
  }
  for (const id of changes.remove ?? []) {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/u.test(id)) continue;
    local.folders.delete(id);
    local.removed.set(id, Math.floor(now));
    gone.push(id);
  }
  if (local.folders.size > DRIVE_LIMITS.folders + 1) throw new Error("There are too many folders.");
  if (changes.settings !== undefined) local.settings = { ...cleanSettings(changes.settings), at: Math.floor(now), saved: false };
  // First, here. From this line on, a crash or a dead relay loses nothing.
  await writeLocal(store, signer, local, changed, gone);
  await flush(deps, local);
  return state(local, false);
}

/**
 * A permission note for one thing at one Blossom server (BUD-11): to upload
 * or delete one named blob, or to fetch one. Always tied to the server and,
 * where there is one, the blob: a note that names neither could be used
 * anywhere, for anything, until it ran out. Good for five minutes.
 */
export function blossomAuth(signer: NostrSigner, input: { verb: unknown; server: unknown; sha256?: unknown }, now: number = Date.now() / 1000): string {
  const server = cleanServer(input.server);
  const verb = input.verb;
  if (!server || (verb !== "upload" && verb !== "delete" && verb !== "get")) throw new Error("That is not something a file server is asked.");
  const sha256 = typeof input.sha256 === "string" && /^[0-9a-f]{64}$/u.test(input.sha256) ? input.sha256 : "";
  if (!sha256) throw new Error("A permission note names the one file it is for.");
  const event = signer.signEvent({
    kind: BLOSSOM_AUTH_KIND,
    // In the past, as a server requires, by a margin wider than two clocks usually differ.
    created_at: Math.floor(now) - 30,
    tags: [["t", verb], ["expiration", String(Math.floor(now) + 300)], ["server", new URL(server).hostname.toLowerCase()], ["x", sha256]],
    content: verb === "upload" ? "Upload a file" : verb === "delete" ? "Delete a file" : "Fetch a file"
  });
  const bytes = new TextEncoder().encode(JSON.stringify(event));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

/** The servers named in a server list note (BUD-03), most trusted first. */
export const serversIn = (event: { tags: string[][] }): string[] => [...new Set(event.tags.filter((tag) => tag[0] === "server").map((tag) => cleanServer(tag[1])).filter(Boolean))];

export interface RankedServer {
  server: string;
  /** How many accounts list it as a server they use. */
  by: number;
  /** How many of those the user follows. */
  byFollowed: number;
}

/** Which servers people use (BUD-03 lists), one voice per account, the user's own follows first. */
export function rankServers(events: readonly { kind: number; pubkey: string; created_at: number; tags: string[][] }[], follows: ReadonlySet<string>, limit = 12): RankedServer[] {
  const newest = new Map<string, (typeof events)[number]>();
  for (const event of events) if (event.kind === SERVER_LIST_KIND && (!newest.has(event.pubkey) || newest.get(event.pubkey)!.created_at < event.created_at)) newest.set(event.pubkey, event);
  const voices = new Map<string, Set<string>>();
  for (const event of newest.values()) for (const server of serversIn(event).filter((s) => s.startsWith("https://")).slice(0, 6)) (voices.get(server) ?? voices.set(server, new Set()).get(server)!).add(event.pubkey);
  return [...voices]
    .map(([server, who]) => ({ server, by: who.size, byFollowed: [...who].filter((pubkey) => follows.has(pubkey)).length }))
    .filter((pick) => pick.by >= 2 || pick.byFollowed >= 1)
    .sort((a, b) => b.byFollowed - a.byFollowed || b.by - a.by || a.server.localeCompare(b.server))
    .slice(0, limit);
}
