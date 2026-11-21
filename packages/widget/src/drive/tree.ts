/**
 * A person's files and folders (docs/files.md): what the file browser
 * shows, and what moving, copying and deleting do. Nothing here touches a
 * key, a relay or a server.
 *
 * Blossom, where the files themselves are kept, knows nothing of names or
 * folders: a server holds a blob under the hash of its bytes, and anyone who
 * knows the hash can fetch it. So the names, the folders, which server holds
 * what, and the key of every private file are kept here, in an index sealed
 * to the account. One record per folder.
 */

export const ROOT = "root";
/** How many files one folder may hold, so that its record stays small enough for any relay to take. */
export const DRIVE_LIMITS = { filesPerFolder: 200, folders: 300, nameChars: 120, servers: 5, fileBytes: 50 * 1024 * 1024 } as const;

export interface DriveFile {
  id: string;
  name: string;
  /** The hash of the bytes a server holds: for a private file, of the sealed bytes. */
  sha256: string;
  /** How many bytes a server holds. */
  size: number;
  /** What the file is, as its owner sees it. A private file is `application/octet-stream` to its server. */
  type: string;
  /** The servers that hold it, by address. */
  servers: string[];
  /** A private file's key (AES-256-GCM), in hex. Absent for a public file. */
  key?: string;
  /** When it was added, in seconds. */
  at: number;
}

export interface DriveFolder {
  id: string;
  name: string;
  /** The folder it is in. "" for the root itself. */
  parent: string;
  /** The site whose folder this is, where BitLogin made it for one. */
  world?: string;
  files: DriveFile[];
  /** When it last changed, in seconds. */
  at: number;
}

const HEX64 = /^[0-9a-f]{64}$/u;
const ID = /^[0-9a-f]{16}$/u;
const newId = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

/** A name as it may be kept and shown: one line, nothing invisible, no slashes, not "." or "..", and not too long. "" for none. */
export function cleanFileName(input: unknown): string {
  if (typeof input !== "string") return "";
  const hidden = (c: number): boolean => c < 32 || (c >= 127 && c <= 159) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff;
  const tidy = Array.from(input, (ch) => (hidden(ch.codePointAt(0) ?? 0) || ch === "/" || ch === "\\" ? " " : ch)).join("").split(" ").filter(Boolean).join(" ");
  const cut = [...tidy].slice(0, DRIVE_LIMITS.nameChars).join("");
  return cut === "." || cut === ".." ? "" : cut;
}

/** A server's address as it is kept: https (http only on this machine, for a server under test), the origin alone. */
export function cleanServer(input: unknown): string {
  if (typeof input !== "string" || input.length > 200) return "";
  try {
    const u = new URL(input.trim());
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return "";
    if (u.username || u.password) return "";
    return u.origin;
  } catch {
    return "";
  }
}

const cleanType = (input: unknown): string => (typeof input === "string" && /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,60}$/iu.test(input) ? input.toLowerCase() : "application/octet-stream");

export function cleanFile(input: unknown): DriveFile | null {
  if (!input || typeof input !== "object") return null;
  const f = input as Record<string, unknown>;
  const name = cleanFileName(f.name);
  const servers = [...new Set((Array.isArray(f.servers) ? f.servers : []).map(cleanServer).filter(Boolean))].slice(0, DRIVE_LIMITS.servers);
  if (typeof f.id !== "string" || !ID.test(f.id) || !name || typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) return null;
  if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0 || servers.length === 0) return null;
  if (f.key !== undefined && (typeof f.key !== "string" || !HEX64.test(f.key))) return null;
  return { id: f.id, name, sha256: f.sha256, size: f.size, type: cleanType(f.type), servers, ...(f.key ? { key: f.key as string } : {}), at: typeof f.at === "number" && Number.isFinite(f.at) ? Math.floor(f.at) : 0 };
}

/** A folder's record, read whole or not at all: one file that does not read means the record is not this drive's. */
export function cleanFolder(input: unknown): DriveFolder | null {
  if (!input || typeof input !== "object") return null;
  const f = input as Record<string, unknown>;
  const isRoot = f.id === ROOT;
  if (typeof f.id !== "string" || (!isRoot && !ID.test(f.id))) return null;
  const name = isRoot ? "Files" : cleanFileName(f.name);
  const parent = isRoot ? "" : typeof f.parent === "string" && (f.parent === ROOT || ID.test(f.parent)) ? f.parent : "";
  if (!name || (!isRoot && !parent) || !Array.isArray(f.files) || f.files.length > DRIVE_LIMITS.filesPerFolder) return null;
  const files: DriveFile[] = [];
  for (const item of f.files) {
    const file = cleanFile(item);
    if (!file) return null;
    files.push(file);
  }
  let world = "";
  if (typeof f.world === "string") {
    try {
      const u = new URL(f.world);
      if ((u.protocol === "https:" || u.protocol === "http:") && u.origin === f.world) world = u.origin;
    } catch {
      world = "";
    }
  }
  return { id: f.id, name, parent, ...(world ? { world } : {}), files, at: typeof f.at === "number" && Number.isFinite(f.at) ? Math.floor(f.at) : 0 };
}

export class DriveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveError";
  }
}

/**
 * The drive, in memory: every operation changes it and says which folders'
 * records must now be saved, and which blobs no file names any more.
 */
export function createDrive(folders: readonly DriveFolder[], now: () => number = () => Math.floor(Date.now() / 1000)) {
  const byId = new Map<string, DriveFolder>();
  for (const folder of folders) byId.set(folder.id, { ...folder, files: folder.files.map((file) => ({ ...file })) });
  if (!byId.has(ROOT)) byId.set(ROOT, { id: ROOT, name: "Files", parent: "", files: [], at: 0 });
  // A folder whose parent is gone is shown at the top, never lost.
  for (const folder of byId.values()) if (folder.id !== ROOT && !byId.has(folder.parent)) folder.parent = ROOT;

  const dirty = new Set<string>();
  const removed = new Set<string>();
  const touch = (folder: DriveFolder) => {
    folder.at = Math.max(now(), folder.at + 1);
    dirty.add(folder.id);
  };
  const folder = (id: string): DriveFolder => {
    const found = byId.get(id);
    if (!found) throw new DriveError("That folder is no longer there.");
    return found;
  };
  const children = (id: string): DriveFolder[] => [...byId.values()].filter((f) => f.parent === id).sort((a, b) => a.name.localeCompare(b.name));
  const find = (fileId: string): { in: DriveFolder; file: DriveFile } => {
    for (const f of byId.values()) {
      const file = f.files.find((item) => item.id === fileId);
      if (file) return { in: f, file };
    }
    throw new DriveError("That file is no longer there.");
  };
  /** A name not already taken where it is going: "report.pdf", then "report (2).pdf". */
  const freeName = (wanted: string, taken: readonly string[]): string => {
    if (!taken.includes(wanted)) return wanted;
    const dot = wanted.lastIndexOf(".");
    const [stem, ext] = dot > 0 ? [wanted.slice(0, dot), wanted.slice(dot)] : [wanted, ""];
    for (let n = 2; n < 1000; n++) if (!taken.includes(`${stem} (${n})${ext}`)) return `${stem} (${n})${ext}`;
    throw new DriveError("There are too many things with that name here.");
  };
  const namesIn = (id: string): string[] => [...children(id).map((f) => f.name), ...folder(id).files.map((f) => f.name)];
  const room = (f: DriveFolder) => {
    if (f.files.length >= DRIVE_LIMITS.filesPerFolder) throw new DriveError(`A folder holds ${DRIVE_LIMITS.filesPerFolder} files at most. Make another folder for more.`);
  };
  const isInside = (id: string, ancestor: string): boolean => {
    for (let at = id, hops = 0; at && hops < 400; at = byId.get(at)?.parent ?? "", hops++) if (at === ancestor) return true;
    return false;
  };
  /** Whether any file anywhere still names this blob. */
  const stillNamed = (sha256: string): boolean => [...byId.values()].some((f) => f.files.some((file) => file.sha256 === sha256));

  return {
    folder,
    children,
    /** The folders from the top down to this one, for the path a person sees. */
    path(id: string): DriveFolder[] {
      const out: DriveFolder[] = [];
      for (let at = id, hops = 0; at && hops < 400; at = byId.get(at)?.parent ?? "", hops++) out.unshift(folder(at));
      return out;
    },
    folders: (): DriveFolder[] => [...byId.values()],
    find,
    createFolder(parent: string, name: string, world?: string): DriveFolder {
      const clean = cleanFileName(name);
      if (!clean) throw new DriveError("Give the folder a name.");
      if (byId.size >= DRIVE_LIMITS.folders) throw new DriveError("There are too many folders. Remove one you don't need.");
      folder(parent);
      const made: DriveFolder = { id: newId(), name: freeName(clean, namesIn(parent)), parent, ...(world ? { world } : {}), files: [], at: 0 };
      byId.set(made.id, made);
      removed.delete(made.id);
      touch(made);
      return made;
    },
    /**
     * The folder BitLogin keeps for one site: made the first time that site saves anything, under "Worlds", and
     * named by its address. Found by the address it was made for, never by its name, which a person may change.
     */
    worldFolder(origin: string): DriveFolder {
      const existing = [...byId.values()].find((f) => f.world === origin);
      if (existing) return existing;
      const worlds = children(ROOT).find((f) => f.name === "Worlds" && !f.world) ?? this.createFolder(ROOT, "Worlds");
      let host = origin;
      try {
        host = new URL(origin).host;
      } catch {
        /* kept as given */
      }
      return this.createFolder(worlds.id, host, origin);
    },
    renameFolder(id: string, name: string): void {
      const f = folder(id);
      const clean = cleanFileName(name);
      if (id === ROOT || !clean) throw new DriveError("Give the folder a name.");
      f.name = freeName(clean, namesIn(f.parent).filter((taken) => taken !== f.name));
      touch(f);
    },
    moveFolder(id: string, to: string): void {
      const f = folder(id);
      folder(to);
      if (id === ROOT || isInside(to, id)) throw new DriveError("A folder can't be moved into itself.");
      if (f.parent === to) return;
      f.name = freeName(f.name, namesIn(to));
      f.parent = to;
      touch(f);
    },
    /** Remove a folder and everything in it. Returns the blobs that nothing names any more: theirs to delete from servers. */
    deleteFolder(id: string): DriveFile[] {
      if (id === ROOT) throw new DriveError("The top folder can't be removed.");
      folder(id);
      const going = [...byId.values()].filter((f) => isInside(f.id, id));
      const files = going.flatMap((f) => f.files);
      for (const f of going) {
        byId.delete(f.id);
        dirty.delete(f.id);
        removed.add(f.id);
      }
      const seen = new Set<string>();
      return files.filter((file) => !stillNamed(file.sha256) && !seen.has(file.sha256) && !!seen.add(file.sha256));
    },
    addFile(to: string, file: Omit<DriveFile, "id" | "at">): DriveFile {
      const f = folder(to);
      room(f);
      const added = cleanFile({ ...file, id: newId(), name: freeName(cleanFileName(file.name) || "file", namesIn(to)), at: now() });
      if (!added) throw new DriveError("That is not a file this drive can keep.");
      f.files.push(added);
      touch(f);
      return added;
    },
    renameFile(fileId: string, name: string): void {
      const { in: f, file } = find(fileId);
      const clean = cleanFileName(name);
      if (!clean) throw new DriveError("Give the file a name.");
      file.name = freeName(clean, namesIn(f.id).filter((taken) => taken !== file.name));
      touch(f);
    },
    moveFile(fileId: string, to: string): void {
      const { in: from, file } = find(fileId);
      const target = folder(to);
      if (from.id === to) return;
      room(target);
      file.name = freeName(file.name, namesIn(to));
      from.files = from.files.filter((item) => item.id !== fileId);
      target.files.push(file);
      touch(from);
      touch(target);
    },
    /** A second name for the same bytes: nothing is uploaded again. A private copy opens with the same key. */
    copyFile(fileId: string, to: string): DriveFile {
      const { file } = find(fileId);
      const target = folder(to);
      room(target);
      const copy: DriveFile = { ...file, servers: [...file.servers], id: newId(), name: freeName(file.name, namesIn(to)), at: now() };
      target.files.push(copy);
      touch(target);
      return copy;
    },
    /** Remove a file. Returns it if no other file names its bytes: then they can be deleted from its servers too. */
    deleteFile(fileId: string): DriveFile | null {
      const { in: f, file } = find(fileId);
      f.files = f.files.filter((item) => item.id !== fileId);
      touch(f);
      return stillNamed(file.sha256) ? null : file;
    },
    /** What each server holds for this drive: every blob counted once, however many names it has. */
    usage(): { server: string; bytes: number; files: number }[] {
      const per = new Map<string, Map<string, number>>();
      for (const f of byId.values()) for (const file of f.files) for (const server of file.servers) (per.get(server) ?? per.set(server, new Map()).get(server)!).set(file.sha256, file.size);
      return [...per].map(([server, blobs]) => ({ server, bytes: [...blobs.values()].reduce((a, b) => a + b, 0), files: blobs.size })).sort((a, b) => b.bytes - a.bytes);
    },
    /** What has changed since this was last asked: the folders to save, and the ones to remove. Asking clears it. */
    takeChanges(): { save: DriveFolder[]; remove: string[] } {
      const out = { save: [...dirty].flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])), remove: [...removed] };
      dirty.clear();
      removed.clear();
      return out;
    }
  };
}

export type Drive = ReturnType<typeof createDrive>;

/** A size as a person reads it. */
export function sizeWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1000;
    unit++;
  } while (value >= 1000 && unit < units.length - 1);
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
