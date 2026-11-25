import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PANEL_CLIENTS } from "./embedded/panel.js";

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
const demoPages = ["index.html", "docs.html", "account.html", "signer/index.html", "connect/index.html"].map((name) =>
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
    // "Forgot password?" link (goto-recover), the rebuild screen's back button
    // to the phrase form (goto-recover), and the bunker screen's own
    // "Generate a new code" retry (goto-bunker).
    for (const [action, expected] of [
      ["goto-bunker", 3],
      ["goto-import", 2],
      ["goto-recover", 4],
    ] as const) {
      expect(menu).toContain(`optionRow("${action}"`);
      const occurrences = widgetSource.split(`"${action}"`).length - 1;
      expect(occurrences).toBe(expected);
    }
  });

  it("passkey registration cannot grant a session before the recovery ceremony", () => {
    // Owner decision 2026-08-04: a passkey account has no custodian, so the
    // phrase ceremony is mandatory. runPasskeyRegistration must hand off to
    // the phrase screens and must NOT dispatch a session itself; the deferred
    // "secure it later" state is gone entirely.
    const body = widgetSource.slice(
      widgetSource.indexOf("private async runPasskeyRegistration"),
      widgetSource.indexOf("private async handlePasskeySignInWith"),
    );
    expect(body).toContain('this.goto("confirm-phrase")');
    expect(body).not.toContain("dispatchLogin");
    expect(body).not.toContain("flashSuccess");
    expect(widgetSource).not.toContain("securePhrasePending");
  });

  it("an imported key gets no session before its private key is acknowledged as saved", () => {
    // Owner decision 2026-11-18, after a real loss: every relay dropped an
    // account's capsules, and the recovery phrase alone could not bring it
    // back. Generated identities are now derived from the phrase (spec §11.6)
    // so the phrase is enough for them. An imported key is not in the phrase,
    // so the phrase quiz hands it to the key-backup screen and grants nothing;
    // only the acknowledged save-key form does. Sessions for new accounts are
    // granted in exactly one place.
    const verifyBody = widgetSource.slice(
      widgetSource.indexOf("private async handleVerifyPhraseSubmit"),
      widgetSource.indexOf("private handleSaveKeySubmit"),
    );
    const generatedOnly = verifyBody.indexOf("if (!this.registeredByImport) {");
    expect(generatedOnly).toBeGreaterThan(-1);
    expect(verifyBody.indexOf("this.finishRegistration()")).toBeGreaterThan(generatedOnly);
    expect(verifyBody.split("this.finishRegistration()").length - 1).toBe(1);
    expect(verifyBody).toContain('this.goto("save-key")');
    for (const grant of ["dispatchLogin", "claimSigner", "flashSuccess"]) {
      expect(verifyBody).not.toContain(grant);
    }

    const saveBody = widgetSource.slice(
      widgetSource.indexOf("private handleSaveKeySubmit"),
      widgetSource.indexOf("private finishRegistration"),
    );
    const refusal = saveBody.indexOf("if (!this.keySavedCheckbox)");
    expect(refusal).toBeGreaterThan(-1);
    expect(saveBody.indexOf("this.finishRegistration()")).toBeGreaterThan(refusal);
    expect(saveBody).not.toContain("dispatchLogin");

    expect(widgetSource.split("this.finishRegistration()").length - 1).toBe(2);
  });

  it("a phrase rebuild publishes nothing until the user confirms the identity shown", () => {
    // Spec §17.6 step 3. For an imported key or an older account the derived
    // identity is a new, empty one; only the npub on screen tells the user.
    // The submit handler may preview, and only the confirm button may rebuild.
    const submitBody = widgetSource.slice(
      widgetSource.indexOf("private async handleRecoverPhraseSubmit"),
      widgetSource.indexOf("private async handleRebuildConfirm"),
    );
    expect(submitBody).toContain("this.worker.previewPhraseRebuild(");
    expect(submitBody).not.toContain("rebuildFromPhrase");
    expect(widgetSource.split("this.worker.rebuildFromPhrase(").length - 1).toBe(1);
    // The onClick case and the one button that triggers it.
    expect(widgetSource.split('"rebuild-confirm"').length - 1).toBe(2);
    expect(widgetSource).toContain("<strong>Only continue if this is your npub.</strong>");
  });

  it("the signed relay list never delays sign-in and never overrides a host's own relays", () => {
    // Spec §19.1. Looking for a newer list is a network round trip to every
    // relay; awaiting it in `configure` would put that in front of every
    // sign-in on every page load. And a host that names its own relays has
    // decided where its users' accounts live: a signed list must not add to
    // that behind its back.
    const worker = readFileSync(new URL("./worker/cryptoWorker.ts", import.meta.url), "utf8");
    const configure = worker.slice(worker.indexOf('case "configure": {'), worker.indexOf('case "register": {'));
    expect(configure).toContain("void refreshBootstrapList(store).then(applyRelaySets");
    expect(configure).not.toContain("await refreshBootstrapList");
    const apply = worker.slice(worker.indexOf("function applyRelaySets"), worker.indexOf("const requestQueue"));
    expect(apply).toContain("if (!hostVaultRelays) vaultRelayUrls = sets.vaultRelays;");
    expect(apply).toContain("if (!hostDiscoveryRelays) discoveryRelayUrls = sets.discoveryRelays;");
  });

  it("checks relay health only when the user asks", () => {
    // The check opens a connection to every vault relay and asks for both
    // capsule addresses. Running it on every page load of every embedding
    // site would be a standing privacy and traffic cost.
    const occurrences = widgetSource.split("this.worker.checkReplicaHealth()").length - 1;
    expect(occurrences).toBe(1);
    for (const lifecycle of ["connectedCallback(): void", "private async tryRestoreSession"]) {
      const start = widgetSource.indexOf(lifecycle);
      expect(start).toBeGreaterThan(-1);
      const body = widgetSource.slice(start, widgetSource.indexOf("\n  }\n", start));
      expect(body).not.toContain("ReplicaHealth");
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

  // Four sets of headers (docs/sign-in-window.md §SW6, §SW19): every page; the embedded signer, which other sites
  // frame; the sign-in window, which must keep its link to the page that opened it; and the sign-in panel, which
  // only the clients BitLogin lists may frame. Nothing else differs.
  const ruleFor = (source: string) => {
    const rule = vercel.headers.find((entry) => entry.source === source);
    expect(rule, `a header rule for ${source}`).toBeTruthy();
    return new Map(rule!.headers.map((header) => [header.key, header.value]));
  };

  it("pins the deployment CSP and baseline browser headers", () => {
    expect(vercel.headers.map((entry) => entry.source)).toEqual([
      "/((?!signer/|connect/).*)",
      "/signer/(.*)",
      "/connect/((?!panel/).*)",
      "/connect/panel/(.*)",
    ]);
    const headers = ruleFor("/((?!signer/|connect/).*)");
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

  it("lets other sites frame the embedded signer, and nothing else", () => {
    const signer = ruleFor("/signer/(.*)");
    const csp = signer.get("Content-Security-Policy") ?? "";
    // It may be framed by an https site. It loads nothing from anywhere else. Beyond its own files it reaches
    // relays, over TLS: to ask whether its site was taken back (docs/take-back.md). That was `connect-src 'self'`
    // alone until the owner agreed to open it for this, on 2026-11-19. And https, for VR way (the owner's "Yes,
    // allow it", 2026-11-25): narrowed in the page by its fetch guard to the person's own mints and file servers, in a
    // session with VR way on, and to nothing otherwise (embedded/vrWay.ts, vrSigner.ts).
    expect(csp).toContain("frame-ancestors https:");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/(^|; )connect-src 'self' wss: https:(;|$)/u);
    expect(csp).not.toMatch(/connect-src[^;]*(http:|ws: |ws:;|\*)/u);
    const signerPage = readFileSync(new URL("./embedded/signer.ts", import.meta.url), "utf8");
    const vrPage = readFileSync(new URL("./embedded/vrSigner.ts", import.meta.url), "utf8");
    // The guard is put over the frame's fetch as the signer starts, VR way or not: so with it off, nothing is reached.
    expect(signerPage).toContain("const vrHandler = createVrHandler(");
    expect(vrPage).toContain("globalThis.fetch = guard.wrap(globalThis.fetch.bind(globalThis));");
    expect(vrPage.indexOf("installVrGuard();")).toBeGreaterThan(vrPage.indexOf("export function createVrHandler("));
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).not.toContain(" 'unsafe-eval'");
    expect(csp).not.toMatch(/style-src|img-src|font-src/u);
    // A header that forbids framing would contradict the policy above.
    expect(signer.has("X-Frame-Options")).toBe(false);
    for (const required of ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy", "Cross-Origin-Resource-Policy"]) {
      expect(signer.has(required), `${required} must be configured`).toBe(true);
    }
    // Two rules anywhere allow framing: this one, and the panel's, which names its clients (below).
    const framable = vercel.headers.filter((entry) =>
      entry.headers.some((h) => h.key === "Content-Security-Policy" && !h.value.includes("frame-ancestors 'none'")),
    );
    expect(framable.map((entry) => entry.source)).toEqual(["/signer/(.*)", "/connect/panel/(.*)"]);
  });

  it("lets the sign-in window keep its link to the page that opened it, and nothing else", () => {
    const everything = ruleFor("/((?!signer/|connect/).*)");
    const connect = ruleFor("/connect/((?!panel/).*)");
    // The window finds the signer through window.opener. Cross-Origin-Opener-Policy: same-origin would cut that.
    expect(connect.has("Cross-Origin-Opener-Policy")).toBe(false);
    // It may also reach a mint, over TLS (docs/ecash.md): the ecash wallet lives on this page and the panel, and
    // a mint is an https address the person chooses. The embedded signer may too, behind its guard, for VR way
    // (above). No other page may: the account page and every worker keep `connect-src 'self' wss:`.
    expect(connect.get("Content-Security-Policy")).toMatch(/(^|; )connect-src 'self' wss: https:(;|$)/u);
    expect(everything.get("Content-Security-Policy")).toMatch(/(^|; )connect-src 'self' wss:(;|$)/u);
    // In every other respect it is a page like any other: it is never framed, and has the same policy.
    const rest = new Map(everything);
    rest.delete("Cross-Origin-Opener-Policy");
    rest.set("Content-Security-Policy", (rest.get("Content-Security-Policy") ?? "").replace("connect-src 'self' wss:;", "connect-src 'self' wss: https:;"));
    expect([...connect]).toEqual([...rest]);
    expect(connect.get("X-Frame-Options")).toBe("DENY");
    expect(connect.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
  });

  it("lets only the clients BitLogin lists frame the sign-in panel, and changes nothing else", () => {
    const connect = ruleFor("/connect/((?!panel/).*)");
    const panel = ruleFor("/connect/panel/(.*)");
    const csp = panel.get("Content-Security-Policy") ?? "";
    // Exactly the list in embedded/panel.ts: never https:, never a wildcard, never a world.
    expect(PANEL_CLIENTS.length).toBeGreaterThan(0);
    for (const origin of PANEL_CLIENTS) expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/u);
    expect(csp).toContain(`frame-ancestors ${PANEL_CLIENTS.join(" ")};`);
    expect(csp).not.toMatch(/frame-ancestors[^;]*(\*|https:(?!\/\/)|http:)/u);
    // A header that forbids framing would contradict it.
    expect(panel.has("X-Frame-Options")).toBe(false);
    // A passkey may be used in it, where the client delegates that to the frame.
    expect(panel.get("Permissions-Policy")).toContain("publickey-credentials-get=(self)");
    expect(panel.get("Permissions-Policy")).toContain("publickey-credentials-create=(self)");
    // Everything else is the window's, word for word.
    const rest = new Map(connect);
    rest.delete("X-Frame-Options");
    rest.set("Content-Security-Policy", (rest.get("Content-Security-Policy") ?? "").replace("frame-ancestors 'none'", `frame-ancestors ${PANEL_CLIENTS.join(" ")}`));
    rest.set("Permissions-Policy", `${rest.get("Permissions-Policy")}, publickey-credentials-get=(self), publickey-credentials-create=(self)`);
    expect([...panel].sort()).toEqual([...rest].sort());
  });

  it("keeps demo pages free of inline scripts and remote font dependencies", () => {
    for (const page of demoPages) {
      expect(page).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/iu);
      expect(page).not.toMatch(/fonts\.(?:googleapis|gstatic)\.com/iu);
    }
  });
});
