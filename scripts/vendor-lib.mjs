// The pure parts of scripts/vendor.mjs: which files an app needs, what its
// record says, and whether what it has matches. No file system, no git.

import { createHash } from "node:crypto";

/**
 * What an app loads. "all" is every built file; "widget" is the widget, the
 * headless signer and the session reader, and the worker that holds the key.
 *
 * The worker is named here and not found by following imports: the widget
 * builds its file name at run time (`["cryptoWorker", ".js"].join("")`, in
 * worker/workerClient.ts) so that an app's own bundler leaves it alone, and so
 * no scan of the built files can see it. Left out, sign-in breaks.
 */
export const ENTRIES = {
  all: null,
  widget: ["bitlogin.js", "bitlogin-headless.js", "bitlogin-session.js", "cryptoWorker.js"]
};

/** A file this script owns in an app's folder: anything it may delete there. Nothing else is ever touched. */
export const isBitLoginFile = (name) => /^bitlogin(-[A-Za-z0-9_-]+)?\.js$/u.test(name) || name === "cryptoWorker.js";

/** Every file another file names by a relative path: `import ... from "./x.js"`, `import("./x.js")`, `new URL("./x.js", ...)`. */
export function relativeImports(source) {
  const out = new Set();
  const patterns = [/(?:\bfrom|\bimport)\s*\(?\s*["']\.\/([^"'/]+\.js)["']/gu, /new URL\(\s*["']\.\/([^"'/]+\.js)["']/gu];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) out.add(m[1]);
  return [...out];
}

/**
 * The files to vendor: for "all", every built file; otherwise the entries and
 * everything they load, followed to the end. Throws if anything loaded is not
 * in the build, so an app is never handed a set with a hole in it.
 */
export function chooseFiles(built, set) {
  const names = Object.keys(built).sort();
  if (!(set in ENTRIES)) throw new Error(`unknown set "${set}": use ${Object.keys(ENTRIES).join(" or ")}`);
  const chosen = new Set(ENTRIES[set] ?? names);
  const queue = [...chosen];
  while (queue.length) {
    const name = queue.shift();
    if (!(name in built)) throw new Error(`${name} is not in the build`);
    for (const next of relativeImports(built[name].toString("utf8"))) {
      if (!chosen.has(next)) {
        chosen.add(next);
        queue.push(next);
      }
    }
  }
  return [...chosen].sort();
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The record an app keeps beside the files: the format Satisfied, Bitvid, BitUnlock, BitRoad and AdZap already check. */
export function makeManifest({ files, source, version }) {
  return {
    package: "@bitlogin/widget",
    version,
    source,
    files: Object.fromEntries(Object.keys(files).sort().map((name) => [name, { sha256: sha256(files[name]), bytes: files[name].length }]))
  };
}

/** What is wrong between a folder's BitLogin files and its record. Empty when they match. */
export function checkAgainst(manifest, present) {
  const problems = [];
  const want = Object.keys(manifest?.files ?? {}).sort();
  const have = Object.keys(present).sort();
  for (const name of want) if (!have.includes(name)) problems.push(`${name}: in the record, not in the folder`);
  for (const name of have) if (!want.includes(name)) problems.push(`${name}: in the folder, not in the record`);
  for (const name of want) {
    if (!(name in present)) continue;
    const entry = manifest.files[name];
    if (sha256(present[name]) !== entry.sha256 || present[name].length !== entry.bytes) problems.push(`${name}: differs from the record`);
  }
  if (!/^[0-9a-f]{40}$/u.test(manifest?.source?.commit ?? "")) problems.push("the record names no BitLogin commit");
  return problems;
}
