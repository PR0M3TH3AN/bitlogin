// Assembles the widget's release artifact set and its integrity manifest.
//
//   npm run release:artifacts
//
// Output: release/bitlogin-widget-v<version>/ — every file a consumer deploys
// side by side (bitlogin.js, cryptoWorker.js, the shared chunks, the session
// and headless entries), plus:
//
//   integrity.json   version, source commit, and sha256 + SRI for each file
//   SHA256SUMS.txt   the same hashes in `sha256sum -c` format
//
// Consumers vendor this folder and record the hashes, so drift between
// vendored copies is detectable (BitBlocks convention D7). This script only
// packages what `npm run build` produced; it changes nothing about the build,
// and it does not publish anything.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages", "widget", "dist");
if (!existsSync(join(dist, "bitlogin.js"))) {
  console.error("packages/widget/dist is missing. Run `npm run build` first.");
  process.exit(1);
}

const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const version = JSON.parse(readFileSync(join(root, "packages", "widget", "package.json"), "utf8")).version;
const commit = git("rev-parse", "HEAD");
// A manifest must not claim a commit the files weren't built from.
const dirty = git("status", "--porcelain", "--", "packages/core/src", "packages/widget/src", "packages/widget/vite.config.ts", "package-lock.json") !== "";
if (dirty) {
  console.error("Source files have uncommitted changes. Commit or stash them, rebuild, and run this again.");
  process.exit(1);
}

const out = join(root, "release", `bitlogin-widget-v${version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = {};
for (const name of readdirSync(dist).sort()) {
  const bytes = readFileSync(join(dist, name));
  cpSync(join(dist, name), join(out, name));
  files[name] = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sri: `sha384-${createHash("sha384").update(bytes).digest("base64")}`,
  };
}
cpSync(join(root, "LICENSE"), join(out, "LICENSE"));

const manifest = { name: "@bitlogin/widget", version, commit, files };
writeFileSync(join(out, "integrity.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(join(out, "SHA256SUMS.txt"), `${Object.entries(files).map(([name, f]) => `${f.sha256}  ${name}`).join("\n")}\n`);

console.log(`release/bitlogin-widget-v${version}: ${Object.keys(files).length} files @ ${commit.slice(0, 7)}`);
