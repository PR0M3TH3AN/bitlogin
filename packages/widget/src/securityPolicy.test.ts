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

  it("keeps username/password primary; the extension method is a secondary affordance", () => {
    // Owner decision 2026-08-04 (login-methods.md §LM9.1): alternative methods must
    // not displace the password path. The welcome screen's primary sign-in button has
    // to appear before the extension option in the rendered template.
    const passwordSignIn = widgetSource.indexOf('data-action="goto-login">Sign in</button>');
    const extensionSlot = widgetSource.indexOf("${extensionOption}");
    expect(passwordSignIn).toBeGreaterThan(-1);
    expect(extensionSlot).toBeGreaterThan(-1);
    expect(passwordSignIn).toBeLessThan(extensionSlot);
  });

  it("extension sessions never claim window.nostr and never persist", () => {
    // §LM4: NIP-07 mode delegates to the extension's provider; fighting it for the
    // window.nostr slot is reserved for BitLogin-account sessions. There must be no
    // claimSigner() call in the extension confirm path, and no storage write.
    const confirmBody = widgetSource.slice(
      widgetSource.indexOf("private handleExtensionConfirm"),
      widgetSource.indexOf("private async tryRestoreSession"),
    );
    expect(confirmBody.length).toBeGreaterThan(0);
    expect(confirmBody).not.toContain("claimSigner");
    expect(confirmBody).not.toContain("localStorage");
    expect(confirmBody).not.toContain("sessionCache");
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
    // Argon2id (hash-wasm) compiles a WASM module inside the crypto worker;
    // script-src without 'wasm-unsafe-eval' blocks WebAssembly.compile and
    // breaks every password flow on the deployed site. The keyword permits
    // WASM compilation ONLY -- plain 'unsafe-eval' (JS eval) must stay out.
    expect(headers.get("Content-Security-Policy")).toContain(
      "script-src 'self' 'wasm-unsafe-eval'",
    );
    expect(headers.get("Content-Security-Policy")).not.toContain(
      " 'unsafe-eval'",
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
