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

// A beta build says so on every page a person can see. The beta site is a
// real sign-in address with real key handling, so nobody should mistake it
// for the one their accounts live at. The mark is a body attribute and a CSS
// rule, with no script: the pages' policies stay exactly as they are. The
// embedded signer's page is left alone, because it has no interface.
const channel = process.env.BITLOGIN_CHANNEL ?? "";
if (channel) {
  if (!/^[a-z]{1,12}$/u.test(channel)) throw new Error("BITLOGIN_CHANNEL must be a short lowercase word.");
  for (const page of filesBelow(outDir).filter((path) => path.endsWith(".html") && !path.startsWith("signer"))) {
    const file = join(outDir, page);
    const html = readFileSync(file, "utf8");
    if (!/<body[ >]/u.test(html)) throw new Error(`No <body> to mark in ${page}`);
    writeFileSync(file, html.replace(/<body([ >])/u, `<body data-channel="${channel}"$1`));
  }
  console.log(`Marked every page as the ${channel} channel.`);
}

const swPath = join(outDir, "sw.js");
const swTemplate = readFileSync(swPath, "utf8");
const artifacts = filesBelow(outDir)
  .filter((path) => path !== "sw.js")
  .map((path) => ({ path, content: readFileSync(join(outDir, path)) }));
writeFileSync(swPath, renderServiceWorker(swTemplate, artifacts));

console.log(`Demo site assembled with a content-versioned service worker at ${outDir}`);
