/**
 * A person's files, as the file browser uses them (docs/files.md): the
 * index (tree.ts), the servers (blossom.ts) and where the index is kept
 * (worker/driveStore.ts), brought together. Runs on a page of BitLogin's own.
 */
import { BlossomError, checkUpload, deleteBlob, downloadBlob, openFile, sealFile, sha256Hex, uploadBlob, type BlossomSigner, type UploadCheck } from "./blossom.js";
import { cleanServer, createDrive, DRIVE_LIMITS, DriveError, ROOT, type Drive, type DriveFile, type DriveFolder } from "./tree.js";
import type { DriveSave, DriveState, RankedServer } from "../worker/driveStore.js";

export interface FilesStore {
  load(): Promise<DriveState>;
  save(changes: DriveSave): Promise<DriveState>;
  auth: BlossomSigner;
  servers(): Promise<{ mine: string[]; ranked: RankedServer[] }>;
  setServers(servers: string[]): Promise<string[]>;
}

/** Paying a server that asks (BUD-07), from the person's own ecash wallet. */
export interface FilesPayer {
  /** What paying this invoice would cost at most, in sats, and a handle to pay it with. Null where it can't be paid at all. */
  quote(invoice: string): Promise<{ sats: number; pay(): Promise<string | null> } | null>;
}

export interface FilesOptions {
  payer?: FilesPayer;
  /** Asked where a server's price is over what the person said may be paid without asking. */
  confirmPay?: (sats: number, server: string) => Promise<boolean>;
}

export function createFiles(store: FilesStore, options: FilesOptions = {}) {
  let state: DriveState = { folders: [], settings: { autoPaySats: 0 }, offline: false, unsaved: false };
  let drive: Drive = createDrive([]);
  let servers: string[] = [];
  let ranked: RankedServer[] = [];

  const persist = async (): Promise<void> => {
    const changes = drive.takeChanges();
    if (changes.save.length === 0 && changes.remove.length === 0) return;
    state = await store.save({ save: changes.save, remove: changes.remove });
  };
  /** Pay a server's invoice, within what the person allowed, or ask them. The proof of payment, or null. */
  const pay = (server: string) => async (invoice: string): Promise<string | null> => {
    const quoted = await options.payer?.quote(invoice).catch(() => null);
    if (!quoted) return null;
    const within = quoted.sats <= state.settings.autoPaySats;
    if (!within && !(await options.confirmPay?.(quoted.sats, server))) return null;
    return quoted.pay();
  };
  /** Delete bytes nothing names any more from every server that holds them. Best effort: a server may refuse. */
  const forget = async (blobs: readonly DriveFile[]): Promise<void> => {
    await Promise.all(blobs.flatMap((blob) => blob.servers.map((server) => deleteBlob(server, blob.sha256, store.auth))));
  };

  return {
    async open(): Promise<DriveState> {
      state = await store.load();
      drive = createDrive(state.folders);
      const found = await store.servers().catch(() => ({ mine: [] as string[], ranked: [] as RankedServer[] }));
      servers = found.mine;
      ranked = found.ranked;
      return state;
    },
    state: (): DriveState => state,
    drive: (): Drive => drive,
    servers: (): string[] => [...servers],
    ranked: (): RankedServer[] => ranked.filter((pick) => !servers.includes(pick.server)),

    /** Whether a server would take a file from this account, and whether it wants paying: asked with a small pretend file. */
    async check(server: string): Promise<UploadCheck> {
      const clean = cleanServer(server);
      if (!clean) return { state: "unknown", reason: "" };
      return checkUpload(clean, { sha256: await sha256Hex(new TextEncoder().encode(`bitlogin-check:${clean}`)), size: 1024, type: "application/octet-stream" }, store.auth);
    },
    /** Use these servers, most trusted first: published as the account's server list (BUD-03). */
    async setServers(next: string[]): Promise<string[]> {
      const clean = [...new Set(next.map(cleanServer).filter(Boolean))].slice(0, DRIVE_LIMITS.servers);
      if (clean.length === 0) throw new DriveError("Choose at least one file server.");
      servers = await store.setServers(clean);
      return servers;
    },
    async setAutoPay(sats: number): Promise<void> {
      state = await store.save({ settings: { autoPaySats: sats } });
    },

    /** Save a file into a folder: sealed first if private, uploaded to the first server, and to a second where there is one. */
    async put(folderId: string, file: { name: string; type: string; bytes: Uint8Array }, how: { private: boolean }): Promise<DriveFile> {
      if (servers.length === 0) throw new DriveError("Choose a file server first.");
      if (file.bytes.length > DRIVE_LIMITS.fileBytes) throw new DriveError("That file is larger than 50 MB, which is the most this can save.");
      drive.folder(folderId);
      const sealed = how.private ? await sealFile(file.bytes) : null;
      const body = sealed ? sealed.sealed : file.bytes;
      const sha256 = await sha256Hex(body);
      // To a server a private file is bytes of no kind: its type would say what it is.
      const sentAs = sealed ? "application/octet-stream" : file.type || "application/octet-stream";
      const held: string[] = [];
      let last: unknown = null;
      for (const server of servers) {
        if (held.length >= 2) break;
        try {
          await uploadBlob(server, body, sentAs, sha256, store.auth, pay(server));
          held.push(server);
        } catch (err) {
          last = err;
          // The first server is the one that must have it. A second copy is a kindness.
          if (held.length === 0 && server === servers[servers.length - 1]) throw err;
        }
      }
      if (held.length === 0) throw last instanceof Error ? last : new BlossomError("refused", "No server would take the file.");
      const added = drive.addFile(folderId, { name: file.name, sha256, size: body.length, type: file.type || "application/octet-stream", servers: held, ...(sealed ? { key: sealed.key } : {}) });
      await persist();
      return added;
    },
    /** A file's bytes, as its owner saved them: fetched from whichever of its servers still has it, checked, and opened. */
    async get(fileId: string): Promise<{ name: string; type: string; bytes: Uint8Array }> {
      const { file } = drive.find(fileId);
      let last: unknown = null;
      for (const server of file.servers) {
        try {
          const body = await downloadBlob(server, file.sha256, store.auth);
          return { name: file.name, type: file.type, bytes: file.key ? await openFile(body, file.key) : body };
        } catch (err) {
          last = err;
        }
      }
      throw last instanceof Error ? last : new BlossomError("not-found", "No server has that file any more.");
    },
    /** Where anyone can fetch a public file. Null for a private one: its bytes mean nothing without its key. */
    link(fileId: string): string | null {
      const { file } = drive.find(fileId);
      return file.key ? null : `${file.servers[0]}/${file.sha256}`;
    },
    async newFolder(parent: string, name: string): Promise<DriveFolder> {
      const made = drive.createFolder(parent, name);
      await persist();
      return made;
    },
    async worldFolder(origin: string): Promise<DriveFolder> {
      const found = drive.worldFolder(origin);
      await persist();
      return found;
    },
    async rename(target: { file: string } | { folder: string }, name: string): Promise<void> {
      "file" in target ? drive.renameFile(target.file, name) : drive.renameFolder(target.folder, name);
      await persist();
    },
    async move(target: { file: string } | { folder: string }, to: string): Promise<void> {
      "file" in target ? drive.moveFile(target.file, to) : drive.moveFolder(target.folder, to);
      await persist();
    },
    async copy(fileId: string, to: string): Promise<DriveFile> {
      const copy = drive.copyFile(fileId, to);
      await persist();
      return copy;
    },
    /** Remove a file or a folder. The index first, so it is gone for the person; then the bytes, from their servers. */
    async remove(target: { file: string } | { folder: string }): Promise<void> {
      const blobs = "file" in target ? [drive.deleteFile(target.file)].filter((blob): blob is DriveFile => !!blob) : drive.deleteFolder(target.folder);
      await persist();
      await forget(blobs);
    },
    usage: () => drive.usage(),
    ROOT
  };
}

export type Files = ReturnType<typeof createFiles>;
