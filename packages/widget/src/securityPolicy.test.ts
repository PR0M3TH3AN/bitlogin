import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const widgetSource = readFileSync(
  new URL("./element.ts", import.meta.url),
  "utf8",
);
const readme = readFileSync(
  new URL("../../../README.md", import.meta.url),
  "utf8",
);
const vercel = JSON.parse(
  readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8"),
) as {
  headers: Array<{
    source: string;
    headers: Array<{ key: string; value: string }>;
  }>;
};
const demoPages = ["index.html", "docs.html", "account.html"].map((name) =>
  readFileSync(new URL(`../../demo/public/${name}`, import.meta.url), "utf8"),
);

describe("widget security policy", () => {
  it("does not expose manual-password creation, recovery, or rotation controls", () => {
    expect(widgetSource).not.toContain("toggle-manual-password");
    expect(widgetSource).not.toContain('name="manualPassword"');
    expect(widgetSource).not.toContain("checkManualPassword");
    expect(widgetSource).not.toContain("entropyBits");
  });

  it("renders vault integrity warnings on the management screen", () => {
    expect(widgetSource).toContain("buildVaultIntegrityWarnings(listed)");
    expect(widgetSource).toContain("this.vaultIntegrityWarnings.map");
  });

  it("documents only same-origin self-hosting, never a remote demo embed", () => {
    expect(readme).toContain("same-origin");
    expect(readme).toContain("self-host");
    expect(readme).not.toContain(
      'src="https://bitlogin.network/vendor/bitlogin/bitlogin.js"',
    );
  });

  it("pins the deployment CSP and baseline browser headers", () => {
    const headers = new Map(
      vercel.headers
        .flatMap((entry) => entry.headers)
        .map((header) => [header.key, header.value]),
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
    expect(headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    for (const required of [
      "X-Content-Type-Options",
      "Referrer-Policy",
      "Permissions-Policy",
      "Cross-Origin-Opener-Policy",
      "Cross-Origin-Resource-Policy",
      "X-Frame-Options",
    ]) {
      expect(headers.has(required), `${required} must be configured`).toBe(
        true,
      );
    }
  });

  it("keeps demo pages free of inline scripts and remote font dependencies", () => {
    for (const page of demoPages) {
      expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/iu);
      expect(page).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    }
  });
});
