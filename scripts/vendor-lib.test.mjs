import { describe, expect, it } from "vitest";
import { checkAgainst, chooseFiles, isBitLoginFile, makeManifest, relativeImports, sha256 } from "./vendor-lib.mjs";

const b = (text) => Buffer.from(text);
const built = {
  "bitlogin.js": b('import { a } from "./bitlogin-shared-A.js";'),
  // As the real build has it: the worker's name is made at run time, where no scan can see it.
  "bitlogin-shared-W.js": b('const e = ["cryptoWorker", ".js"].join(""), i = new URL(e, import.meta.url); new Worker(i, { type: "module" });'),
  "bitlogin-headless.js": b('import "./bitlogin-shared-A.js"; import("./bitlogin-shared-B.js");'),
  "bitlogin-session.js": b("export const x = 1;"),
  "bitlogin-window.js": b('import "./bitlogin-shared-C.js";'),
  "bitlogin-shared-A.js": b("export const a = 1;"),
  "bitlogin-shared-B.js": b('import"./bitlogin-shared-A.js";'),
  "bitlogin-shared-C.js": b(""),
  "cryptoWorker.js": b('import { a } from "./bitlogin-shared-A.js"; import "./bitlogin-shared-K.js";'),
  "bitlogin-shared-K.js": b("")
};
const source = { repository: "https://github.com/PR0M3TH3AN/bitlogin.git", commit: "a".repeat(40), commitDate: "2026-11-20T00:00:00Z", dirty: false, provenance: "attributed", toolchain: { node: "v22" } };

describe("vendoring BitLogin into an app", () => {
  it("reads every relative file a built file loads, in each form a build writes", () => {
    expect(relativeImports('import{x}from"./a.js";import("./b.js");new URL("./c.js",import.meta.url);import "./d.js"').sort()).toEqual(["a.js", "b.js", "c.js", "d.js"]);
    expect(relativeImports('import x from "nostr-tools"; import "../up.js"; fetch("./not-an-import.js")')).toEqual([]);
  });

  it("takes every file for 'all', and only what the widget loads for 'widget'", () => {
    expect(chooseFiles(built, "all")).toEqual(Object.keys(built).sort());
    // The worker, and what only the worker loads, are always there: the widget names the worker at run time.
    expect(chooseFiles(built, "widget")).toEqual(["bitlogin-headless.js", "bitlogin-session.js", "bitlogin-shared-A.js", "bitlogin-shared-B.js", "bitlogin-shared-K.js", "bitlogin.js", "cryptoWorker.js"]);
  });

  it("refuses a set with a hole in it, and a set it does not know", () => {
    expect(() => chooseFiles({ "bitlogin.js": b('import "./gone.js"'), "bitlogin-headless.js": b(""), "bitlogin-session.js": b(""), "cryptoWorker.js": b("") }, "widget")).toThrow(/gone\.js/u);
    expect(() => chooseFiles({ "bitlogin.js": b(""), "bitlogin-headless.js": b(""), "bitlogin-session.js": b("") }, "widget")).toThrow(/cryptoWorker\.js/u);
    expect(() => chooseFiles(built, "everything")).toThrow(/unknown set/u);
  });

  it("touches only BitLogin's own files in an app's folder", () => {
    for (const name of ["bitlogin.js", "bitlogin-shared-D-JqvHzL.js", "bitlogin-signer.js", "cryptoWorker.js"]) expect(isBitLoginFile(name), name).toBe(true);
    for (const name of ["app.js", "PROVENANCE.json", "bitlogin.integrity.json", "README.md", "bitlogin.js.map", "other/bitlogin.js"]) expect(isBitLoginFile(name), name).toBe(false);
  });

  it("writes the record the apps already check, and finds every way a folder can differ from it", () => {
    const files = { "bitlogin.js": built["bitlogin.js"], "cryptoWorker.js": built["cryptoWorker.js"] };
    const manifest = makeManifest({ files, source, version: "0.1.0" });
    expect(Object.keys(manifest)).toEqual(["package", "version", "source", "files"]);
    expect(manifest.files["bitlogin.js"]).toEqual({ sha256: sha256(built["bitlogin.js"]), bytes: built["bitlogin.js"].length });
    expect(checkAgainst(manifest, files)).toEqual([]);
    expect(checkAgainst(manifest, { "bitlogin.js": files["bitlogin.js"] })).toEqual(["cryptoWorker.js: in the record, not in the folder"]);
    expect(checkAgainst(manifest, { ...files, "bitlogin-extra.js": b("") })).toEqual(["bitlogin-extra.js: in the folder, not in the record"]);
    expect(checkAgainst(manifest, { ...files, "bitlogin.js": b("changed") })).toEqual(["bitlogin.js: differs from the record"]);
    expect(checkAgainst({ ...manifest, source: { ...source, commit: "abc" } }, files)).toEqual(["the record names no BitLogin commit"]);
  });
});
