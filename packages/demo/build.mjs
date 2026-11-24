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

// The sign-in panel (docs/sign-in-window.md §SW19) is the window's own page, served at an address of its own so it can
// have headers of its own: a client BitLogin lists may frame it, and nothing else may. It is made from the window's
// page here, so the two can never say different things. Only the paths change, one folder deeper.
{
  const windowPage = readFileSync(join(publicDir, "connect", "index.html"), "utf8");
  const panelPage = windowPage.replace(/(src|href)="\.\.\//gu, '$1="../../');
  if (panelPage === windowPage || /(src|href)="\.\.\/(?!\.\.\/)/u.test(panelPage)) throw new Error("The panel's paths were not all moved one folder deeper.");
  mkdirSync(join(outDir, "connect", "panel"), { recursive: true });
  writeFileSync(join(outDir, "connect", "panel", "index.html"), panelPage);
}

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

// Which build this is (2026-11-24): a page kept open across a release, as a shell keeps the panel, asks `build.json`
// whether it is still the one being served, and brings itself up to date when it isn't. Its own id is in its page.
// The id is the hash of everything built so far, so two builds of the same files have the same one.
{
  const { createHash } = await import("node:crypto");
  const digest = createHash("sha256");
  for (const path of filesBelow(outDir).sort()) {
    digest.update(path);
    digest.update("\0");
    digest.update(readFileSync(join(outDir, path)));
    digest.update("\0");
  }
  const build = digest.digest("hex").slice(0, 16);
  for (const page of filesBelow(outDir).filter((path) => path.endsWith(".html"))) {
    const file = join(outDir, page);
    const html = readFileSync(file, "utf8");
    if (!html.includes("</head>")) continue;
    writeFileSync(file, html.replace("</head>", `<meta name="bitlogin-build" content="${build}" />\n</head>`));
  }
  writeFileSync(join(outDir, "build.json"), `${JSON.stringify({ build })}\n`);
}

const swPath = join(outDir, "sw.js");
const swTemplate = readFileSync(swPath, "utf8");
const artifacts = filesBelow(outDir)
  .filter((path) => path !== "sw.js")
  .map((path) => ({ path, content: readFileSync(join(outDir, path)) }));
writeFileSync(swPath, renderServiceWorker(swTemplate, artifacts));

console.log(`Demo site assembled with a content-versioned service worker at ${outDir}`);
