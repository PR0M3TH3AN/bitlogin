import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// The demo build helper is plain ESM because the static demo has no TypeScript build.
// @ts-expect-error no declaration file is needed for this build-only module.
import { renderServiceWorker } from "../../../demo/swBuild.mjs";

describe("demo service-worker generation", () => {
  const template =
    'const CACHE_NAME = "release-__BITLOGIN_BUILD_HASH__";\nconst FILES = ["__BITLOGIN_PRECACHE_MANIFEST__"];';

  it("changes the cache version when any release artifact changes", () => {
    const first = renderServiceWorker(template, [
      { path: "app.js", content: Buffer.from("one") },
    ]);
    const second = renderServiceWorker(template, [
      { path: "app.js", content: Buffer.from("two") },
    ]);
    expect(first).not.toBe(second);
    expect(first).not.toContain("__BITLOGIN_");
  });

  it("includes the complete artifact graph in deterministic order", () => {
    const output = renderServiceWorker(template, [
      { path: "vendor/worker.js", content: Buffer.from("worker") },
      { path: "index.html", content: Buffer.from("html") },
    ]);
    expect(output.indexOf("./index.html")).toBeLessThan(
      output.indexOf("./vendor/worker.js"),
    );
  });

  it("keeps active clients on one release until the complete successor can activate", () => {
    const serviceWorker = readFileSync(
      new URL("../../../demo/public/sw.js", import.meta.url),
      "utf8",
    );
    expect(serviceWorker).not.toContain("self.skipWaiting(");
    expect(serviceWorker).not.toContain("self.clients.claim(");
    expect(serviceWorker).toContain("navigationForThisRelease");
    expect(serviceWorker).toContain(
      "event.respondWith(cacheFirst(event.request))",
    );
  });
});
