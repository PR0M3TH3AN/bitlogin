import { createHash } from "node:crypto";

export function renderServiceWorker(template, artifacts) {
  const ordered = [...artifacts].sort((a, b) => a.path.localeCompare(b.path));
  const digest = createHash("sha256");
  for (const artifact of ordered) {
    digest.update(artifact.path);
    digest.update("\0");
    digest.update(artifact.content);
    digest.update("\0");
  }
  const buildHash = digest.digest("hex").slice(0, 20);
  const manifest = ordered.map((artifact) => `./${artifact.path.replaceAll("\\", "/")}`);
  return template
    .replace("__BITLOGIN_BUILD_HASH__", buildHash)
    .replace('["__BITLOGIN_PRECACHE_MANIFEST__"]', JSON.stringify(manifest, null, 2));
}
