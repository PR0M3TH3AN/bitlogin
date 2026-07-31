// Copies the built @bitlogin/widget bundle into the static demo and stamps the
// service worker with a hash and manifest covering the complete release graph.
import { cpSync, mkdirSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";
import { renderServiceWorker } from "./swBuild.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const widgetDir = join(__dirname, "..", "widget");
const widgetDist = join(widgetDir, "dist");
const publicDir = join(__dirname, "public");
const outDir = join(__dirname, "dist");

if (!existsSync(widgetDist)) {
  console.log("Building @bitlogin/widget first...");
  execSync("npm run build", { cwd: widgetDir, stdio: "inherit" });
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

cpSync(publicDir, outDir, { recursive: true });
mkdirSync(join(outDir, "vendor", "bitlogin"), { recursive: true });
cpSync(widgetDist, join(outDir, "vendor", "bitlogin"), { recursive: true });

function filesBelow(directory, prefix = "") {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? filesBelow(join(directory, entry.name), relative) : [relative];
  });
}

const swPath = join(outDir, "sw.js");
const swTemplate = readFileSync(swPath, "utf8");
const artifacts = filesBelow(outDir)
  .filter((path) => path !== "sw.js")
  .map((path) => ({ path, content: readFileSync(join(outDir, path)) }));
writeFileSync(swPath, renderServiceWorker(swTemplate, artifacts));

console.log(`Demo site assembled with a content-versioned service worker at ${outDir}`);
