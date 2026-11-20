#!/usr/bin/env node
// Vendor BitLogin's widget into an app, or check an app's copy.
//
//   node <bitlogin>/scripts/vendor.mjs <folder> [--manifest <file>] [--set all|widget]
//   node <bitlogin>/scripts/vendor.mjs <folder> --check [--manifest <file>]
//
// <folder>      where the app serves the files from, e.g. static/vendor/bitlogin
// --manifest    the record kept beside them; default <folder>.integrity.json
// --set         "all" (default): every built file. "widget": the widget, the
//               headless signer, the session reader and everything they load,
//               for an app that never opens the sign-in window itself.
// --check       change nothing: say whether the folder matches its record.
//
// Vendoring builds BitLogin from this checkout first, and refuses a checkout
// with uncommitted changes: the record names a commit, and the files must be
// what that commit builds. In the app's folder it deletes only BitLogin's own
// files (bitlogin*.js, cryptoWorker.js) and never anything else.
//
// The record is the format the apps already check: package, version, source
// (repository, commit, commitDate, dirty, provenance, toolchain), and each
// file's sha256 and size. Run the app's own checks after it.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkAgainst, chooseFiles, isBitLoginFile, makeManifest } from "./vendor-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages", "widget", "dist");

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const folderArg = args.find((a, i) => !a.startsWith("--") && !["--manifest", "--set"].includes(args[i - 1]));
if (!folderArg) {
  console.error("Usage: node scripts/vendor.mjs <folder> [--manifest <file>] [--set all|widget] [--check]");
  process.exit(2);
}
const folder = resolve(folderArg);
const manifestPath = resolve(option("--manifest") ?? `${folder}.integrity.json`);
const readFolder = () =>
  Object.fromEntries(
    (existsSync(folder) ? readdirSync(folder) : []).filter(isBitLoginFile).map((name) => [name, readFileSync(join(folder, name))])
  );

if (args.includes("--check")) {
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const problems = manifest ? checkAgainst(manifest, readFolder()) : [`no record at ${manifestPath}`];
  if (problems.length) {
    console.error(`[bitlogin vendor] ${folder} does not match its record:`);
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log(`[bitlogin vendor] ${Object.keys(manifest.files).length} files match the record (BitLogin ${manifest.source.commit.slice(0, 12)})`);
  process.exit(0);
}

const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8" }).trim();
if (git("status", "--porcelain") !== "") {
  console.error("[bitlogin vendor] The BitLogin checkout has uncommitted changes, so the files would match no commit. Commit or stash them first.");
  process.exit(1);
}
console.log(`[bitlogin vendor] building BitLogin ${git("rev-parse", "--short", "HEAD")}`);
execFileSync("npm", ["run", "build"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
if (git("status", "--porcelain") !== "") {
  console.error("[bitlogin vendor] Building changed tracked files in the BitLogin checkout. Stopping.");
  process.exit(1);
}

const built = Object.fromEntries(readdirSync(dist).filter((n) => n.endsWith(".js")).map((name) => [name, readFileSync(join(dist, name))]));
const names = chooseFiles(built, option("--set") ?? "all");

mkdirSync(folder, { recursive: true });
for (const name of readdirSync(folder)) if (isBitLoginFile(name) && !names.includes(name)) rmSync(join(folder, name));
for (const name of names) writeFileSync(join(folder, name), built[name]);

const pkg = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const manifest = makeManifest({
  version: pkg("packages/widget/package.json").version,
  files: Object.fromEntries(names.map((n) => [n, built[n]])),
  source: {
    repository: git("remote", "get-url", "origin"),
    commit: git("rev-parse", "HEAD"),
    commitDate: git("log", "-1", "--format=%cI"),
    dirty: false,
    provenance: "attributed",
    toolchain: { node: process.version, vite: pkg("packages/widget/package.json").devDependencies?.vite ?? pkg("package.json").devDependencies?.vite }
  }
});
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const problems = checkAgainst(manifest, readFolder());
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`[bitlogin vendor] wrote ${names.length} files to ${folder} and ${basename(manifestPath)} (BitLogin ${manifest.source.commit.slice(0, 12)})`);
