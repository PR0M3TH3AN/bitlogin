import { describe, expect, it } from "vitest";
import { cleanFileName, cleanFolder, cleanServer, createDrive, DriveError, ROOT, sizeWords, type DriveFile } from "./tree.js";

const A = "https://a.example";
const B = "https://b.example";
const blob = (n: number, extra: Partial<DriveFile> = {}) => ({ name: `f${n}.txt`, sha256: String(n).padStart(64, "0"), size: 1000 * n, type: "text/plain", servers: [A], ...extra });
let clock = 1000;
const fresh = () => createDrive([], () => clock++);

describe("a person's files and folders (docs/files.md)", () => {
  it("keeps names a person can read and a file system can't be tricked by", () => {
    expect(cleanFileName("  Holiday   photos \n 2026 ")).toBe("Holiday photos 2026");
    expect(cleanFileName("a/b\\c")).toBe("a b c");
    expect(cleanFileName("..")).toBe("");
    expect(cleanFileName(`evil${String.fromCodePoint(0x202e)}txt.exe`)).toBe("evil txt.exe");
    expect([...cleanFileName("x".repeat(500))].length).toBe(120);
    expect(cleanFileName(7)).toBe("");
    expect(cleanServer("https://cdn.example.com/path?x=1")).toBe("https://cdn.example.com");
    for (const bad of ["http://cdn.example.com", "https://u:p@cdn.example.com", "ftp://x", "", 3]) expect(cleanServer(bad)).toBe("");
  });

  it("makes folders, adds files, and never lets two things here share a name", () => {
    const drive = fresh();
    const docs = drive.createFolder(ROOT, "Documents");
    expect(drive.createFolder(ROOT, "Documents").name).toBe("Documents (2)");
    const first = drive.addFile(docs.id, blob(1, { name: "report.pdf" }));
    const second = drive.addFile(docs.id, blob(2, { name: "report.pdf" }));
    expect([first.name, second.name]).toEqual(["report.pdf", "report (2).pdf"]);
    expect(drive.path(docs.id).map((f) => f.name)).toEqual(["Files", "Documents"]);
    expect(() => drive.createFolder(ROOT, " / ")).toThrow(DriveError);
    expect(() => drive.addFile("0000000000000000", blob(3))).toThrow(/no longer there/u);
  });

  it("moves and renames, and won't put a folder inside itself", () => {
    const drive = fresh();
    const a = drive.createFolder(ROOT, "A");
    const b = drive.createFolder(a.id, "B");
    const file = drive.addFile(a.id, blob(1));
    drive.moveFile(file.id, b.id);
    expect(drive.folder(a.id).files).toEqual([]);
    expect(drive.folder(b.id).files.map((f) => f.name)).toEqual(["f1.txt"]);
    drive.renameFile(file.id, "notes.txt");
    expect(drive.find(file.id).file.name).toBe("notes.txt");
    expect(() => drive.moveFolder(a.id, b.id)).toThrow(/into itself/u);
    expect(() => drive.moveFolder(ROOT, a.id)).toThrow();
    drive.moveFolder(b.id, ROOT);
    expect(drive.path(b.id).map((f) => f.name)).toEqual(["Files", "B"]);
    drive.renameFolder(b.id, "Bee");
    expect(drive.folder(b.id).name).toBe("Bee");
  });

  it("copies without uploading again, and deletes the bytes only when no name is left for them", () => {
    const drive = fresh();
    const a = drive.createFolder(ROOT, "A");
    const b = drive.createFolder(ROOT, "B");
    const file = drive.addFile(a.id, blob(5, { key: "ab".repeat(32) }));
    const copy = drive.copyFile(file.id, b.id);
    expect(copy).toMatchObject({ sha256: file.sha256, key: file.key, name: "f5.txt" });
    expect(copy.id).not.toBe(file.id);
    // One blob, two names: counted once on its server.
    expect(drive.usage()).toEqual([{ server: A, bytes: 5000, files: 1 }]);
    // The first name goes: the bytes stay, because the copy still names them.
    expect(drive.deleteFile(file.id)).toBeNull();
    // The last name goes: now the bytes can be deleted from the server too.
    expect(drive.deleteFile(copy.id)).toMatchObject({ sha256: file.sha256, servers: [A] });
    expect(drive.usage()).toEqual([]);
  });

  it("removes a folder with everything in it, and says which bytes nothing names any more", () => {
    const drive = fresh();
    const a = drive.createFolder(ROOT, "A");
    const inner = drive.createFolder(a.id, "Inner");
    const keep = drive.createFolder(ROOT, "Keep");
    drive.addFile(a.id, blob(1));
    const shared = drive.addFile(inner.id, blob(2));
    drive.addFile(inner.id, blob(3, { servers: [A, B] }));
    drive.copyFile(shared.id, keep.id);
    drive.takeChanges();
    const gone = drive.deleteFolder(a.id);
    expect(gone.map((f) => f.sha256.slice(-1)).sort()).toEqual(["1", "3"]);
    expect(drive.folders().map((f) => f.name).sort()).toEqual(["Files", "Keep"]);
    expect(drive.takeChanges().remove.sort()).toEqual([a.id, inner.id].sort());
    expect(() => drive.deleteFolder(ROOT)).toThrow();
  });

  it("keeps one folder for each site, found by its address whatever it is called", () => {
    const drive = fresh();
    const gallery = drive.worldFolder("https://gallery.bitblocks.network");
    expect(drive.path(gallery.id).map((f) => f.name)).toEqual(["Files", "Worlds", "gallery.bitblocks.network"]);
    drive.renameFolder(gallery.id, "My gallery things");
    expect(drive.worldFolder("https://gallery.bitblocks.network").id).toBe(gallery.id);
    expect(drive.worldFolder("https://other.example").id).not.toBe(gallery.id);
    expect(drive.children(drive.children(ROOT)[0]!.id).length).toBe(2);
  });

  it("says which folders changed, once", () => {
    const drive = fresh();
    const a = drive.createFolder(ROOT, "A");
    drive.addFile(a.id, blob(1));
    const changes = drive.takeChanges();
    expect(changes.save.map((f) => f.name)).toEqual(["A"]);
    expect(drive.takeChanges()).toEqual({ save: [], remove: [] });
    // A later change is newer than the one before, whatever the clock says.
    const before = drive.folder(a.id).at;
    clock = 5;
    drive.addFile(a.id, blob(2));
    expect(drive.folder(a.id).at).toBeGreaterThan(before);
  });

  it("holds 200 files in a folder and no more, and reads a folder's record whole or not at all", () => {
    const drive = fresh();
    const a = drive.createFolder(ROOT, "A");
    for (let i = 1; i <= 200; i++) drive.addFile(a.id, blob(i));
    expect(() => drive.addFile(a.id, blob(201))).toThrow(/200 files/u);
    const record = JSON.parse(JSON.stringify(drive.folder(a.id)));
    expect(cleanFolder(record)!.files.length).toBe(200);
    expect(JSON.stringify(record).length).toBeLessThan(60_000);
    expect(cleanFolder({ ...record, files: [{ ...record.files[0], sha256: "nope" }] })).toBeNull();
    expect(cleanFolder({ ...record, files: [{ ...record.files[0], servers: ["http://plain.example"] }] })).toBeNull();
    expect(cleanFolder({ ...record, parent: "../etc" })).toBeNull();
    // A folder whose parent is gone is shown at the top, never lost.
    const orphan = createDrive([{ id: "aaaaaaaaaaaaaaaa", name: "Lost", parent: "bbbbbbbbbbbbbbbb", files: [], at: 1 }]);
    expect(orphan.children(ROOT).map((f) => f.name)).toEqual(["Lost"]);
  });

  it("says a size the way a person reads one", () => {
    expect([0, 999, 1000, 15_300, 2_400_000, 3_000_000_000].map(sizeWords)).toEqual(["0 B", "999 B", "1.0 kB", "15.3 kB", "2.4 MB", "3.0 GB"]);
  });
});
