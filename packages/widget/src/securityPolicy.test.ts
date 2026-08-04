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
    const optionsMenuSlot = widgetSource.indexOf("${optionsMenu}");
    expect(passwordSignIn).toBeGreaterThan(-1);
    expect(optionsMenuSlot).toBeGreaterThan(-1);
    expect(passwordSignIn).toBeLessThan(optionsMenuSlot);
    // The extension row renders inside the collapsed menu, not free-standing.
    expect(widgetSource).toContain('"extension-signin",');
  });

  it("keeps every alternative method inside the collapsed options menu", () => {
    // Same owner decision as the pin above, applied to all of NIP-46, key
    // import, and recovery: each renders as a row of the option-menu that the
    // "${optionsMenu}" slot (already pinned after the primary sign-in button)
    // interpolates -- never as a free-standing button beside the primaries.
    const menuStart = widgetSource.indexOf('`<div class="option-menu">');
    const menuEnd = widgetSource.indexOf("</div>`", menuStart);
    expect(menuStart).toBeGreaterThan(-1);
    expect(menuEnd).toBeGreaterThan(menuStart);
    const menu = widgetSource.slice(menuStart, menuEnd);
    // Expected occurrences: the onClick case + the menu row, plus sanctioned
    // contextual renderings AWAY from the welcome screen -- the login screen's
    // "Forgot password?" link (goto-recover) and the bunker screen's own
    // "Generate a new code" retry (goto-bunker).
    for (const [action, expected] of [
      ["goto-bunker", 3],
      ["goto-import", 2],
      ["goto-recover", 3],
    ] as const) {
      expect(menu).toContain(`optionRow("${action}"`);
      const occurrences = widgetSource.split(`"${action}"`).length - 1;
      expect(occurrences).toBe(expected);
    }
  });

  it("the passkey row lives inside the menu with an honest custody label", () => {
    // docs/passkey-login.md: zero registration, zero servers -- and the
    // OAuth on-ramps that preceded it stay removed (owner decision
    // 2026-08-04: static only, no per-site provider registration).
    const menuStart = widgetSource.indexOf('`<div class="option-menu">');
    const menuEnd = widgetSource.indexOf("</div>`", menuStart);
    const menu = widgetSource.slice(menuStart, menuEnd);
    expect(menu).toContain("${passkeyRow}");
    expect(widgetSource).toContain("Kept in your phone or browser's password manager");
    expect(menu).toContain(">Use an account you already have</div>");
    for (const removed of ["onramp-signin", "google-signin", "onramp-url", "googleapis"]) {
      expect(widgetSource).not.toContain(removed);
    }
  });

  it("keeps all network I/O out of the element", () => {
    // The element orchestrates; network lives behind the worker RPC where
    // destinations are constrained. The passkey rail needs NO network of its
    // own -- the credential is derived, not fetched.
    expect(widgetSource).not.toContain("fetch(");
    const passkeySource = readFileSync(new URL("./passkey.ts", import.meta.url), "utf8");
    expect(passkeySource).not.toContain("fetch");
  });

  it("treats the bunker URI as a secret and keeps the element storage-free", () => {
    // A bunker:// URI carries a connection token; it gets a password input
    // (no shoulder-surfing, no autofill heuristics), and the element itself
    // must never touch web storage -- alternative-method sessions are
    // memory-only by design (§LM5, §LM7), and the ONLY persistence in the
    // widget lives behind the worker's session cache.
    expect(widgetSource).toContain('type="password" name="bunkerUri"');
    expect(widgetSource).not.toContain("localStorage");
    expect(widgetSource).not.toContain("sessionStorage");
  });

  it("extension sessions never claim window.nostr and never persist", () => {
    // §LM4: NIP-07 mode delegates to the extension's provider; fighting it for the
    // window.nostr slot is reserved for BitLogin-account sessions. There must be no
    // claimSigner() call in the extension confirm path, and no storage write.
    const confirmBody = widgetSource.slice(
      widgetSource.indexOf("private handleExtensionConfirm"),
      // Ends where the NIP-46 handlers begin -- those claim the slot
      // legitimately (§LM5: the routed provider IS that session's backend).
      widgetSource.indexOf("private async startNostrconnect"),
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
