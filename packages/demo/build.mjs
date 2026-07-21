// Copies the built @bitlogin/widget bundle in as a vendored script and assembles the
// static demo site into dist/. No bundler needed for the demo itself -- that's the point:
// any static site can consume BitLogin the same way.
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execSync } from "node:child_process";

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

console.log(`Demo site assembled at ${outDir}`);
