/** <bitlogin-auth> — the embeddable BitLogin login/create/recover widget (§3, §27). */
import {
  generatePassphrase,
  isValidLoginName,
  checkManualPassword,
  parseRecoveryExport,
  RecoveryExportParseError,
  type ManualPasswordCheck,
  type RecoveryExportFile
} from "@bitlogin/core/account";
import { encodeNpub } from "@bitlogin/core/nostr";
import { WorkerClient } from "./worker/workerClient.js";
import { createNip07Provider, type Nip07Provider } from "./provider.js";
import { readConfigFromElement } from "./config.js";
import { WIDGET_STYLES } from "./styles.js";

type Screen =
  | "welcome"
  | "import-key"
  | "create-name"
  | "create-credential"
  | "confirm-phrase"
  | "verify-phrase"
  | "login"
  | "recover-phrase"
  | "recover-new-credentials"
  | "dashboard"
  | "change-password"
  | "export"
  | "rollback-confirm";

interface ConfirmSlot {
  index: number;
  value: string;
}

export class BitLoginAuthElement extends HTMLElement {
  private root: ShadowRoot;
  private worker: WorkerClient;
  private vaultRelayUrls: string[] = [];
  private discoveryRelayUrls: string[] = [];
  private installedProvider: Nip07Provider | null = null;

  private screen: Screen = "welcome";
  private busy = false;
  private errorMessage: string | undefined;

  private loginName = "";
  private generatedCredential = "";
  private savedCheckbox = false;
  private recoveryPhrase = "";
  private confirmSlots: ConfirmSlot[] = [];

  // Manual password opt-in (§9.3). Off by default; the generated passphrase remains the
  // recommendation. manualPasswordFeedback is updated on every keystroke WITHOUT a full
  // re-render (see onInput) so the field never loses focus while the user is typing.
  // manualPasswordDraft/manualPasswordConfirmDraft re-populate the fields' value attribute
  // across a validation-failure re-render, so a rejected password isn't silently wiped,
  // forcing the user to retype it (and re-check "I saved it") from scratch.
  private manualPasswordMode = false;
  private manualPasswordFeedback: ManualPasswordCheck | null = null;
  private manualPasswordDraft = "";
  private manualPasswordConfirmDraft = "";

  // Import flow (§SF10). importKey holds the pasted nsec/hex only until registration completes.
  private importKey = "";
  private importPreviewNpub = "";

  private recoverPhraseInput = "";
  private recoveredPreview: { generalRelaysCount: number; dmRelaysCount: number; chainWarning?: string } | null = null;
  private newCredentialAfterRecovery = "";

  // Optional recovery-export-file fallback (§19.5) for when live relays can't be reached.
  // Never a substitute for the phrase -- the file never contains it or any phrase-derived key.
  private offlineExportFile: RecoveryExportFile | null = null;
  private offlineExportFileNotice: string | undefined;

  private session: { publicKey: string; npub: string; accountId?: string } | null = null;
  private sessionWarnings: string[] = [];
  private lastSignedEventJson = "";
  private exportedNsec = "";
  private changePasswordNewCredential = "";

  // Brief animated brass-seal stamp (matching the widget's own brand mark) shown once over
  // the destination screen right after a real security-relevant success -- see flashSuccess().
  private pendingSuccessLabel: string | null = null;
  private successDismissTimer: ReturnType<typeof setTimeout> | null = null;

  // Rollback confirmation (§16.2 step 6). A RollbackDetectedError from either login or
  // password-change means this device has already seen a newer credential generation than the
  // one just read -- most likely a rotated-away password being replayed from a relay that never
  // processed its tombstone. Rather than a passive dashboard banner shown after the fact (which
  // let an old, "revoked" password fully unlock a session), this blocks BEFORE claiming the
  // signer or dispatching bitlogin-login, and requires an explicit second step to proceed.
  private pendingRollback:
    | { kind: "login"; loginName: string; password: string }
    | { kind: "change-password"; oldPassword: string; newPassword: string }
    | null = null;
  private rollbackMessage = "";

  constructor() {
    super();
    this.root = this.attachShadow({ mode: "open" });
    // A parsed CSSStyleSheet assigned via adoptedStyleSheets isn't subject to a page's
    // style-src CSP the way an inline <style> element (or repeatedly re-injecting one on
    // every render()) is -- a host with a strict `style-src 'self'` (no 'unsafe-inline')
    // silently drops an inline <style>'s rules entirely, which left every shadow-DOM
    // element unstyled (the brand SVG rendering at its raw intrinsic ~590x119 size instead
    // of the intended 20px-tall lockup was the visible symptom). Built once here rather
    // than in render(), since the stylesheet text itself never changes between renders.
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(WIDGET_STYLES);
    this.root.adoptedStyleSheets = [sheet];
    this.worker = new WorkerClient();
  }

  connectedCallback(): void {
    const config = readConfigFromElement(this);
    this.vaultRelayUrls = config.vaultRelayUrls ?? [];
    this.discoveryRelayUrls = config.discoveryRelayUrls ?? [];
    void this.worker.configure({ vaultRelayUrls: this.vaultRelayUrls, discoveryRelayUrls: this.discoveryRelayUrls });

    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("submit", (e) => this.onSubmit(e));
    this.root.addEventListener("input", (e) => this.onInput(e));
    this.root.addEventListener("change", (e) => void this.onFileChange(e));
    this.render();

    this.installedProvider = createNip07Provider(this.worker, () => this.vaultRelayUrls);
    if (!(window as unknown as { nostr?: unknown }).nostr) {
      // See claimSigner()'s doc comment: an extension can make this property
      // non-configurable, which makes even this guarded assignment throw.
      try {
        (window as unknown as { nostr: unknown }).nostr = this.installedProvider;
      } catch {
        // Not fatal -- this element's own API surface doesn't depend on window.nostr.
      }
    }
  }

  disconnectedCallback(): void {
    if (this.successDismissTimer !== null) clearTimeout(this.successDismissTimer);
    this.releaseSigner();
    this.worker.terminate();
  }

  // ---- Public API mirroring window.nostr, scoped to this element instance ----
  async getPublicKey(): Promise<string> {
    return (await this.worker.getPublicKey()).publicKey;
  }
  async signEvent(event: { kind: number; tags?: string[][]; content: string; created_at?: number }) {
    return this.worker.signEvent(event);
  }
  /**
   * Element-scoped NIP-44 encryption, matching getPublicKey/signEvent above. A host page
   * embedding multiple signing methods (its own extension detection, another widget) should
   * prefer this over reaching through `window.nostr.nip44` -- window.nostr is a single global
   * slot that whichever provider signed in last currently owns, so a host holding a direct
   * reference to ITS OWN `<bitlogin-auth>` element can talk to it deterministically instead of
   * racing other providers for that slot.
   */
  async nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return (await this.worker.nip44Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }
  async nip44Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return (await this.worker.nip44Decrypt({ peerPublicKey, payload })).plaintext;
  }
  /**
   * Legacy relative to nip44Encrypt/nip44Decrypt above, but still what a real NIP-07
   * extension exposes as window.nostr.nip04 -- implemented for drop-in parity with sites
   * (or their older DM code paths) that still expect NIP-04 rather than NIP-44.
   */
  async nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return (await this.worker.nip04Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }
  async nip04Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return (await this.worker.nip04Decrypt({ peerPublicKey, payload })).plaintext;
  }
  async logout(): Promise<void> {
    await this.worker.logout();
    this.session = null;
    this.releaseSigner();
    this.dispatchEvent(new CustomEvent("bitlogin-logout"));
    this.goto("welcome");
  }

  /**
   * (Re)installs this element's own provider as window.nostr, taking over from whatever is
   * currently there (an extension, a different BitLogin instance, or nothing). Called
   * automatically whenever a user completes sign-in through this widget — that's an
   * explicit signal they want BitLogin active. Also public: a host page offering several
   * signing methods can call it directly (e.g. `document.querySelector('bitlogin-auth').claimSigner()`)
   * when the user re-selects BitLogin from its own method picker, without a page reload.
   *
   * Best-effort: some NIP-07 extensions install window.nostr as a non-configurable,
   * non-writable property specifically to prevent another script from overwriting it, and
   * the plain assignment below throws a TypeError in that case ("Cannot assign to read only
   * property 'nostr'..."). This is never fatal to BitLogin's own session -- a host page
   * holding a reference to this element (getPublicKey/signEvent/nip44Encrypt/nip44Decrypt
   * above) never depends on window.nostr at all -- so the failure is caught and reported
   * through the returned boolean and the event detail rather than thrown, and every caller
   * below proceeds to complete sign-in regardless. Only a host page that reads window.nostr
   * directly (instead of talking to this element) is actually affected, and only for as long
   * as the other extension holds the slot.
   */
  claimSigner(): boolean {
    try {
      (window as unknown as { nostr: unknown }).nostr = this.installedProvider;
      this.dispatchEvent(new CustomEvent("bitlogin-signer-claimed", { detail: { windowNostrClaimed: true } }));
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.dispatchEvent(new CustomEvent("bitlogin-signer-claimed", { detail: { windowNostrClaimed: false, error: message } }));
      return false;
    }
  }

  /**
   * Surfaces a claimSigner() failure on the dashboard itself (not just the event detail),
   * using the same sessionWarnings/renderWarnings mechanism already shown for rollback and
   * relay-disagreement warnings -- so a user isn't left wondering why some other app still
   * seems to be using a different signer.
   */
  private noteSignerClaim(claimed: boolean): void {
    if (claimed) return;
    this.sessionWarnings = [
      ...this.sessionWarnings,
      "Another Nostr signer (browser extension) is active in this browser and couldn't be replaced. You're signed in to BitLogin, but any app that reads window.nostr directly may still use that other signer instead of this one."
    ];
  }

  /**
   * Releases window.nostr back to undefined, but only if it's still this element's own
   * provider — never clobbers a different signing method a host page (or another widget
   * instance) may have since taken over. Called automatically on logout and on removal from
   * the DOM, so a page offering multiple signing methods (an extension, a NIP-46 bunker,
   * BitLogin) can let a user switch away from BitLogin without a full page reload — before
   * this existed, window.nostr stayed pointed at a signed-out BitLogin provider forever.
   * Returns whether it actually released anything. Best-effort for the same reason as
   * claimSigner above: a property some other extension made non-configurable can also fail
   * to `delete`, and that must not block logout either.
   */
  releaseSigner(): boolean {
    const w = window as unknown as { nostr?: unknown };
    if (this.installedProvider && w.nostr === this.installedProvider) {
      try {
        delete w.nostr;
      } catch {
        return false;
      }
      this.dispatchEvent(new CustomEvent("bitlogin-signer-released"));
      return true;
    }
    return false;
  }

  private goto(screen: Screen): void {
    this.screen = screen;
    this.errorMessage = undefined;
    this.render();
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.render();
  }

  private fail(err: unknown): void {
    this.errorMessage = err instanceof Error ? err.message : String(err);
    this.busy = false;
    this.render();
  }

  private field(name: string): string {
    return (this.root.querySelector(`[name="${name}"]`) as HTMLInputElement | null)?.value ?? "";
  }

  /**
   * Shared manual-password field markup (§9.3), reused on every screen that lets a user set
   * their own password (initial creation, phrase recovery, and password rotation) so the
   * option isn't only available at signup.
   */
  private renderManualPasswordFields(): string {
    return `
      <label for="manualPassword">Password</label>
      <input type="password" name="manualPassword" id="manualPassword" autocomplete="new-password" required minlength="12" value="${escapeHtml(this.manualPasswordDraft)}" />
      <div class="notice info" id="manual-password-feedback"></div>
      <label for="manualPasswordConfirm">Confirm password</label>
      <input type="password" name="manualPasswordConfirm" id="manualPasswordConfirm" autocomplete="new-password" required minlength="12" value="${escapeHtml(this.manualPasswordConfirmDraft)}" />
      <div class="notice info" id="manual-password-match-feedback"></div>
    `;
  }

  /**
   * Reads and validates the manual-password fields against a caller-supplied login name.
   * Always stashes what was typed into manualPasswordDraft/manualPasswordConfirmDraft so a
   * validation-failure re-render can restore it (see renderManualPasswordFields).
   */
  private readManualPassword(loginNameForValidation: string): { password: string; error?: string } {
    const typed = this.field("manualPassword");
    const confirmTyped = this.field("manualPasswordConfirm");
    this.manualPasswordDraft = typed;
    this.manualPasswordConfirmDraft = confirmTyped;
    const check = checkManualPassword(typed, loginNameForValidation);
    if (!check.ok) return { password: "", error: `Password not accepted: ${check.reason}` };
    if (typed !== confirmTyped) return { password: "", error: "Passwords do not match. Please re-enter both." };
    return { password: typed };
  }

  /**
   * Explicitly asks the browser to offer saving this credential via the Credential
   * Management API (Chromium-based browsers only — Firefox and Safari never implemented
   * `PasswordCredential`). This is the primary fix for password-manager integration here,
   * not just a nice-to-have: the generated-password screen never puts the password into a
   * real `<input>` for a browser to observe being filled (it's shown as text), and even on
   * the login screen — which does use real, correctly-`autocomplete`d inputs — save/autofill
   * heuristics are unreliable inside a shadow root, and this widget's JS-driven submit
   * (`preventDefault`, no real form POST) doesn't produce the passive signal most heuristics
   * expect anyway. An explicit `navigator.credentials.store()` call sidesteps all of that.
   * Best-effort only: never blocks or fails the surrounding flow.
   */
  private async offerToSaveCredential(loginName: string, password: string): Promise<void> {
    try {
      const PasswordCredentialCtor = (
        window as unknown as { PasswordCredential?: new (data: { id: string; password: string; name?: string }) => Credential }
      ).PasswordCredential;
      if (!PasswordCredentialCtor || !navigator.credentials?.store) return;
      const credential = new PasswordCredentialCtor({ id: loginName, password, name: loginName });
      await navigator.credentials.store(credential);
    } catch {
      // Best-effort only.
    }
  }

  private async onClick(e: Event): Promise<void> {
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action!;
    switch (action) {
      case "goto-create":
        this.loginName = "";
        this.importKey = "";
        this.importPreviewNpub = "";
        this.goto("create-name");
        return;
      case "goto-import":
        this.importKey = "";
        this.importPreviewNpub = "";
        this.goto("import-key");
        return;
      case "preview-import":
        return this.handlePreviewImport();
      case "import-continue":
        return this.handleImportContinue();
      case "goto-login":
        this.goto("login");
        return;
      case "goto-recover":
        this.offlineExportFile = null;
        this.offlineExportFileNotice = undefined;
        this.goto("recover-phrase");
        return;
      case "goto-welcome":
        this.pendingRollback = null;
        this.goto("welcome");
        return;
      case "goto-dashboard":
        this.goto("dashboard");
        return;
      case "goto-verify-phrase":
        this.goto("verify-phrase");
        return;
      case "goto-confirm-phrase":
        this.goto("confirm-phrase");
        return;
      case "goto-change-password":
        this.changePasswordNewCredential = generatePassphrase().secret;
        this.manualPasswordMode = false;
        this.manualPasswordFeedback = null;
        this.manualPasswordDraft = "";
        this.manualPasswordConfirmDraft = "";
        this.goto("change-password");
        return;
      case "goto-export":
        this.goto("export");
        return;
      case "regenerate-credential":
        this.generatedCredential = generatePassphrase().secret;
        this.savedCheckbox = false;
        this.render();
        return;
      case "toggle-manual-password":
        this.manualPasswordMode = !this.manualPasswordMode;
        this.manualPasswordFeedback = null;
        this.manualPasswordDraft = "";
        this.manualPasswordConfirmDraft = "";
        this.savedCheckbox = false;
        this.render();
        return;
      case "copy-credential": {
        const box = this.root.querySelector<HTMLElement>("#credential-box");
        const button = target;
        const original = button.textContent ?? "Copy";
        const flash = (text: string) => {
          button.textContent = text;
          setTimeout(() => {
            if (button.isConnected) button.textContent = original;
          }, 2000);
        };
        if (!box || !navigator.clipboard?.writeText) {
          flash("Copy not available — select the text manually");
          return;
        }
        navigator.clipboard.writeText(box.textContent ?? "").then(
          () => flash("Copied"),
          () => flash("Copy failed — select the text manually")
        );
        return;
      }
      case "download-recovery-export":
        return this.handleDownloadRecoveryExport();
      case "sign-test-event":
        return this.handleSignTestEvent();
      case "reveal-nsec":
        return this.handleRevealNsec();
      case "logout":
        return this.logout();
      case "rollback-retry": {
        const kind = this.pendingRollback?.kind;
        this.pendingRollback = null;
        this.goto(kind === "change-password" ? "change-password" : "login");
        return;
      }
      case "rollback-continue":
        return this.handleRollbackContinue();
      default:
        return;
    }
  }

  private async onSubmit(e: Event): Promise<void> {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const formName = form.dataset.form;
    try {
      switch (formName) {
        case "import-key":
          return await this.handlePreviewImport();
        case "create-name":
          return this.handleCreateNameSubmit();
        case "create-credential":
          return await this.handleCreateCredentialSubmit();
        case "verify-phrase":
          return this.handleVerifyPhraseSubmit();
        case "login":
          return await this.handleLoginSubmit();
        case "recover-phrase":
          return await this.handleRecoverPhraseSubmit();
        case "recover-new-credentials":
          return await this.handleRecoverNewCredentialsSubmit();
        case "change-password":
          return await this.handleChangePasswordSubmit();
        default:
          return;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  /**
   * Live entropy/strength and match feedback for the manual-password fields, updated by
   * DIRECTLY patching feedback elements' text — never calling this.render() — so neither
   * input loses focus or cursor position while the user is typing (§9.3).
   */
  private onInput(e: Event): void {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.name !== "manualPassword" && target.name !== "manualPasswordConfirm") return;

    const pw = (this.root.querySelector('input[name="manualPassword"]') as HTMLInputElement | null)?.value ?? "";
    const confirm = (this.root.querySelector('input[name="manualPasswordConfirm"]') as HTMLInputElement | null)?.value ?? "";

    this.manualPasswordFeedback = pw ? checkManualPassword(pw, this.loginName) : null;
    const feedback = this.root.querySelector<HTMLElement>("#manual-password-feedback");
    if (feedback) {
      if (!this.manualPasswordFeedback) {
        feedback.textContent = "";
        feedback.className = "notice info";
      } else {
        const bits = this.manualPasswordFeedback.entropyBits.toFixed(0);
        if (this.manualPasswordFeedback.ok) {
          feedback.textContent = `Looks good (~${bits} bits estimated).`;
          feedback.className = "notice info";
        } else {
          feedback.textContent = `${this.manualPasswordFeedback.reason} (~${bits} bits estimated)`;
          feedback.className = "notice warn";
        }
      }
    }

    const matchFeedback = this.root.querySelector<HTMLElement>("#manual-password-match-feedback");
    if (matchFeedback) {
      if (!confirm) {
        matchFeedback.textContent = "";
        matchFeedback.className = "notice info";
      } else if (confirm === pw) {
        matchFeedback.textContent = "Passwords match.";
        matchFeedback.className = "notice info";
      } else {
        matchFeedback.textContent = "Passwords do not match.";
        matchFeedback.className = "notice warn";
      }
    }
  }

  /**
   * Reads and validates an optional recovery-export file (§19.5) for the recover-phrase
   * screen. Purely a relay-outage fallback -- the file never contains the phrase or any
   * phrase-derived key, so it's ignored entirely unless the user also enters their phrase.
   */
  private async onFileChange(e: Event): Promise<void> {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || target.name !== "offlineExportFile" || target.type !== "file") return;
    const file = target.files?.[0];
    if (!file) {
      this.offlineExportFile = null;
      this.offlineExportFileNotice = undefined;
      this.render();
      return;
    }
    try {
      const text = await file.text();
      this.offlineExportFile = parseRecoveryExport(JSON.parse(text));
      this.offlineExportFileNotice = `Loaded recovery export from ${new Date(this.offlineExportFile.created_at * 1000).toLocaleString()}.`;
    } catch (err) {
      this.offlineExportFile = null;
      this.offlineExportFileNotice =
        err instanceof RecoveryExportParseError || err instanceof SyntaxError
          ? `Couldn't read that file: ${err.message}`
          : `Couldn't read that file: ${String(err)}`;
    }
    this.render();
  }

  private async handlePreviewImport(): Promise<void> {
    const pasted = this.field("importKey").trim();
    if (!pasted) {
      this.errorMessage = "Paste your nsec or hex private key first.";
      this.render();
      return;
    }
    this.setBusy(true);
    try {
      const preview = await this.worker.previewImportKey({ nsecOrHex: pasted });
      this.importKey = pasted;
      this.importPreviewNpub = preview.npub;
      this.busy = false;
      this.render();
    } catch (err) {
      this.importKey = "";
      this.importPreviewNpub = "";
      this.fail(err);
    }
  }

  private handleImportContinue(): void {
    // Reached only after a successful preview; move into the normal name -> credential flow,
    // which will register with importKey set (§SF10).
    if (!this.importKey || !this.importPreviewNpub) {
      this.errorMessage = "Check your key before continuing.";
      this.render();
      return;
    }
    this.loginName = "";
    this.goto("create-name");
  }

  private handleCreateNameSubmit(): void {
    const name = this.field("loginName").trim().toLowerCase();
    if (!isValidLoginName(name)) {
      this.errorMessage = "Login name must be 3-32 characters: a-z, 0-9, '.', '_', '-', and not start/end with punctuation.";
      this.render();
      return;
    }
    this.loginName = name;
    this.generatedCredential = generatePassphrase().secret;
    this.savedCheckbox = false;
    this.manualPasswordMode = false;
    this.manualPasswordFeedback = null;
    this.manualPasswordDraft = "";
    this.manualPasswordConfirmDraft = "";
    this.goto("create-credential");
  }

  private async handleCreateCredentialSubmit(): Promise<void> {
    // Read the checkbox before password validation so a rejected password doesn't also
    // silently un-check it on the retry render.
    this.savedCheckbox = (this.root.querySelector("#saved-check") as HTMLInputElement | null)?.checked ?? false;
    let password = this.generatedCredential;
    if (this.manualPasswordMode) {
      const { password: manualPassword, error } = this.readManualPassword(this.loginName);
      if (error) {
        this.errorMessage = error;
        this.render();
        return;
      }
      password = manualPassword;
    }
    if (!this.savedCheckbox) {
      this.errorMessage = this.manualPasswordMode
        ? "Please confirm you've saved your password (or written it down) before continuing."
        : "Please confirm you saved your password before continuing.";
      this.render();
      return;
    }
    this.setBusy(true);
    const result = await this.worker.register({
      loginName: this.loginName,
      password,
      importKey: this.importKey || undefined
    });
    // The pasted key is now wrapped in the capsules; drop the main-thread copy (§11.10).
    this.importKey = "";
    this.importPreviewNpub = "";
    this.recoveryPhrase = result.recoveryPhrase;
    const words = this.recoveryPhrase.split(" ");
    const indices = pickRandomIndices(words.length, 3);
    this.confirmSlots = indices.map((index) => ({ index, value: "" }));
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId };
    this.busy = false;
    this.goto("confirm-phrase");
    // §15.8/§19.6 — publish relay preferences immediately after successful registration,
    // defaulting the public profile name to the chosen login name so the account isn't
    // just a bare npub in every other Nostr client. This same call also runs after
    // importing an existing nsec; the worker checks for an existing profile/relay list
    // first and never overwrites one, so an imported identity's real profile survives (§28.1).
    void this.worker.publishProfileAndRelayLists({
      name: this.loginName,
      generalRelays: this.vaultRelayUrls,
      dmRelays: this.vaultRelayUrls
    });
    void this.offerToSaveCredential(this.loginName, password);
  }

  private handleVerifyPhraseSubmit(): void {
    const words = this.recoveryPhrase.split(" ");
    for (const slot of this.confirmSlots) {
      const typed = this.field(`confirm-${slot.index}`).trim().toLowerCase();
      if (typed !== words[slot.index]) {
        this.errorMessage = `Word #${slot.index + 1} doesn't match. Please check your saved phrase and try again.`;
        this.render();
        return;
      }
    }
    this.sessionWarnings = [];
    this.noteSignerClaim(this.claimSigner());
    this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: this.session?.publicKey } }));
    this.flashSuccess("dashboard", "Account created");
  }

  private async handleLoginSubmit(): Promise<void> {
    const loginName = this.field("loginName").trim().toLowerCase();
    const password = this.field("password");
    await this.attemptLogin(loginName, password);
  }

  /**
   * Shared by the login form and the "continue anyway" rollback-confirmation step so both
   * paths grant a session identically -- claimSigner() and the bitlogin-login event only ever
   * fire once a RollbackDetectedError (if any) has been resolved one way or the other.
   */
  private async attemptLogin(loginName: string, password: string, acknowledgeRollback = false): Promise<void> {
    this.setBusy(true);
    try {
      const result = await this.worker.login({ loginName, password, acknowledgeRollback });
      this.loginName = loginName;
      this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId };
      this.sessionWarnings = [result.rollbackWarning, result.relayDisagreementWarning].filter((w): w is string => !!w);
      this.busy = false;
      this.noteSignerClaim(this.claimSigner());
      this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: result.everydayPublicKey } }));
      this.flashSuccess("dashboard", "Signed in");
      void this.offerToSaveCredential(loginName, password);
    } catch (err) {
      if (err instanceof Error && err.name === "RollbackDetectedError") {
        this.pendingRollback = { kind: "login", loginName, password };
        this.rollbackMessage = err.message;
        this.busy = false;
        this.goto("rollback-confirm");
        return;
      }
      this.fail(err);
    }
  }

  private async handleRollbackContinue(): Promise<void> {
    const pending = this.pendingRollback;
    this.pendingRollback = null;
    if (!pending) {
      this.goto("welcome");
      return;
    }
    if (pending.kind === "login") {
      await this.attemptLogin(pending.loginName, pending.password, true);
    } else {
      await this.attemptChangePassword(pending.oldPassword, pending.newPassword, true);
    }
  }

  private async handleRecoverPhraseSubmit(): Promise<void> {
    const phrase = this.field("phrase").trim();
    this.setBusy(true);
    const result = await this.worker.recover({ phrase, offlineExportFile: this.offlineExportFile ?? undefined });
    this.recoverPhraseInput = phrase;
    this.recoveredPreview = {
      generalRelaysCount: result.generalRelays.length,
      dmRelaysCount: result.dmRelays.length,
      chainWarning: result.chainWarning
    };
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId };
    this.newCredentialAfterRecovery = generatePassphrase().secret;
    this.manualPasswordMode = false;
    this.manualPasswordFeedback = null;
    this.manualPasswordDraft = "";
    this.manualPasswordConfirmDraft = "";
    this.busy = false;
    this.goto("recover-new-credentials");
  }

  private async handleRecoverNewCredentialsSubmit(): Promise<void> {
    const newLoginName = this.field("newLoginName").trim().toLowerCase();
    if (!isValidLoginName(newLoginName)) {
      this.errorMessage = "Login name must be 3-32 characters: a-z, 0-9, '.', '_', '-', and not start/end with punctuation.";
      this.render();
      return;
    }
    let newPassword = this.newCredentialAfterRecovery;
    if (this.manualPasswordMode) {
      const { password, error } = this.readManualPassword(newLoginName);
      if (error) {
        this.errorMessage = error;
        this.render();
        return;
      }
      newPassword = password;
    }
    this.setBusy(true);
    await this.worker.completeRecovery({ newLoginName, newPassword });
    this.loginName = newLoginName;
    this.busy = false;
    this.sessionWarnings = [];
    this.noteSignerClaim(this.claimSigner());
    this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: this.session?.publicKey } }));
    this.flashSuccess("dashboard", "Account recovered");
    void this.offerToSaveCredential(newLoginName, newPassword);
  }

  private async handleChangePasswordSubmit(): Promise<void> {
    const oldPassword = this.field("oldPassword");
    let newPassword = this.changePasswordNewCredential;
    if (this.manualPasswordMode) {
      const { password, error } = this.readManualPassword(this.loginName);
      if (error) {
        this.errorMessage = error;
        this.render();
        return;
      }
      newPassword = password;
    }
    await this.attemptChangePassword(oldPassword, newPassword);
  }

  /** Shared by the rotation form and the "continue anyway" rollback-confirmation step; see attemptLogin. */
  private async attemptChangePassword(oldPassword: string, newPassword: string, acknowledgeRollback = false): Promise<void> {
    this.setBusy(true);
    try {
      await this.worker.changePassword({
        loginName: this.loginName,
        oldPassword,
        newPassword,
        acknowledgeRollback
      });
      this.busy = false;
      this.sessionWarnings = [];
      this.noteSignerClaim(this.claimSigner());
      this.flashSuccess("dashboard", "Password updated");
      void this.offerToSaveCredential(this.loginName, newPassword);
    } catch (err) {
      if (err instanceof Error && err.name === "RollbackDetectedError") {
        this.pendingRollback = { kind: "change-password", oldPassword, newPassword };
        this.rollbackMessage = err.message;
        this.busy = false;
        this.goto("rollback-confirm");
        return;
      }
      this.fail(err);
    }
  }

  private async handleDownloadRecoveryExport(): Promise<void> {
    const file = await this.worker.buildRecoveryExport();
    const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bitlogin-recovery-export.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  private async handleSignTestEvent(): Promise<void> {
    const event = await this.worker.signEvent({ kind: 1, content: `Hello from BitLogin at ${new Date().toISOString()}` });
    this.lastSignedEventJson = JSON.stringify(event, null, 2);
    this.render();
  }

  private async handleRevealNsec(): Promise<void> {
    const { nsec } = await this.worker.exportIdentity();
    this.exportedNsec = nsec;
    this.render();
  }

  private render(): void {
    const successOverlay = this.pendingSuccessLabel ? this.renderSuccessOverlay(this.pendingSuccessLabel) : "";
    this.root.innerHTML = `<div class="card">${this.renderScreen()}${successOverlay}</div>`;
  }

  private renderSuccessOverlay(label: string): string {
    return `
      <div class="success-overlay" data-success-overlay>
        <span class="success-stamp">
          <svg viewBox="0 0 64 64" aria-hidden="true">
            <defs>
              <linearGradient id="bl-success-brass" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stop-color="#e6c481" />
                <stop offset="1" stop-color="#b3924a" />
              </linearGradient>
            </defs>
            <circle cx="32" cy="32" r="21" fill="none" stroke="url(#bl-success-brass)" stroke-width="2.5" />
            <path d="M27 32.5l3.6 3.6L38 28.2" fill="none" stroke="url(#bl-success-brass)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </span>
        <p class="success-label">${escapeHtml(label)}</p>
      </div>
    `;
  }

  /**
   * Navigates to `screen` and briefly stamps it with the same brass-ring-and-checkmark mark
   * used in the logo, for the handful of moments that are a genuine security-relevant success
   * -- signing in, creating an account, recovering one, or rotating a password -- rather than
   * every validation step or navigation. Purely decorative: `pointer-events: none` (see
   * styles.ts) means it never blocks interacting with the screen underneath, and a JS timer
   * (not just the CSS animation) guarantees it's removed even if the animation can't run.
   */
  private flashSuccess(screen: Screen, label: string): void {
    this.goto(screen);
    if (this.successDismissTimer !== null) clearTimeout(this.successDismissTimer);
    this.pendingSuccessLabel = label;
    this.render();
    this.successDismissTimer = setTimeout(() => {
      this.pendingSuccessLabel = null;
      this.successDismissTimer = null;
      this.root.querySelector("[data-success-overlay]")?.remove();
    }, 1100);
  }

  private renderError(): string {
    return this.errorMessage ? `<div class="notice error">${escapeHtml(this.errorMessage)}</div>` : "";
  }

  private renderWarnings(): string {
    return this.sessionWarnings.map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`).join("");
  }

  /** The widget's own brand lockup (mark + wordmark), inlined as vector paths rather than
   * relying on the host page having loaded any particular font -- shown once, on the
   * welcome screen, as the widget's one branding moment. */
  private renderBrandLockup(): string {
    return `<svg class="brand-lockup" xmlns="http://www.w3.org/2000/svg" viewBox="0 -74.8 511.6 103.3" role="img" aria-label="BitLogin"> <defs> <linearGradient id="bl-lockup-seal" x1="0" y1="0" x2="1" y2="1"> <stop offset="0" stop-color="#8368ff" /> <stop offset="1" stop-color="#6a4de8" /> </linearGradient> <linearGradient id="bl-lockup-brass" x1="0" y1="0" x2="1" y2="1"> <stop offset="0" stop-color="#e6c481" /> <stop offset="1" stop-color="#b3924a" /> </linearGradient> </defs> <g transform="translate(0 -61.88) scale(1.3496)"> <circle cx="32" cy="32" r="21" fill="none" stroke="url(#bl-lockup-brass)" stroke-width="2.5" /> <circle cx="32" cy="32" r="14.5" fill="url(#bl-lockup-seal)" /> <path d="M27 32.5l3.6 3.6L38 28.2" fill="none" stroke="url(#bl-lockup-brass)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" /> </g> <g transform="translate(92.50 0)"> <path d="M68.55 -16.85Q68.55 -9.4 62.13 -4.7Q55.7 0 42.85 0L8.2 0Q6.65 0 5.93 -0.62Q5.2 -1.25 5.2 -2.3Q5.2 -4.2 7.3 -4.85L10.15 -5.5Q11.4 -5.85 12.03 -6.55Q12.65 -7.25 12.65 -8.35L12.65 -61.65Q12.65 -62.75 12.03 -63.45Q11.4 -64.15 10.15 -64.5L7.3 -65.15Q5.2 -65.8 5.2 -67.7Q5.2 -68.8 5.93 -69.4Q6.65 -70 8.2 -70L35.2 -70Q44.5 -70 51.08 -67.45Q57.65 -64.9 61.1 -60.37Q64.55 -55.85 64.55 -49.8Q64.55 -44.75 61.73 -40.8Q58.9 -36.85 53.35 -34.58Q47.8 -32.3 39.65 -32.3L42.45 -33.85Q50.4 -33.85 56.25 -31.67Q62.1 -29.5 65.33 -25.67Q68.55 -21.85 68.55 -16.85ZM37.15 -30.45L23.8 -30.45L23.8 -34.5L35.9 -34.5Q40.35 -34.5 43.45 -36.18Q46.55 -37.85 48.15 -41.1Q49.75 -44.35 49.75 -49Q49.75 -53.95 47.78 -57.62Q45.8 -61.3 42 -63.35Q38.2 -65.4 32.7 -65.4L28.15 -65.4L28.15 -9.45Q28.15 -7 29.68 -5.8Q31.2 -4.6 34.15 -4.6L39.45 -4.6Q43.9 -4.6 46.93 -6.15Q49.95 -7.7 51.5 -10.57Q53.05 -13.45 53.05 -17.25Q53.05 -23.25 48.98 -26.85Q44.9 -30.45 37.15 -30.45ZM94.5 -45.1L94.5 -8Q94.5 -6.45 94.93 -5.72Q95.35 -5 96.25 -4.7L98.15 -4.2Q99.1 -3.9 99.55 -3.37Q100 -2.85 100 -2.05Q100 -1.1 99.35 -0.55Q98.7 0 97.25 0L77.55 0Q76.15 0 75.5 -0.55Q74.85 -1.1 74.85 -2.05Q74.85 -2.8 75.3 -3.32Q75.75 -3.85 76.7 -4.2L78.65 -4.7Q79.55 -5.05 79.98 -5.75Q80.4 -6.45 80.4 -8L80.4 -36.65Q80.4 -37.95 80.03 -38.5Q79.65 -39.05 78.8 -39.2L76.15 -39.4Q75.25 -39.6 74.85 -40.05Q74.45 -40.5 74.45 -41.2Q74.45 -42.05 74.93 -42.55Q75.4 -43.05 76.75 -43.55L86.05 -46.95Q88 -47.65 89.18 -47.95Q90.35 -48.25 91.15 -48.25Q92.85 -48.25 93.68 -47.37Q94.5 -46.5 94.5 -45.1ZM86.35 -55.9Q82.35 -55.9 79.93 -57.97Q77.5 -60.05 77.5 -63.4Q77.5 -66.75 79.93 -68.78Q82.35 -70.8 86.35 -70.8Q90.4 -70.8 92.83 -68.78Q95.25 -66.75 95.25 -63.4Q95.25 -60.05 92.83 -57.97Q90.4 -55.9 86.35 -55.9ZM108.9 -42.45L106.6 -43.15Q105.4 -43.55 104.9 -44.07Q104.4 -44.6 104.4 -45.3Q104.4 -46.3 105.08 -46.82Q105.75 -47.35 106.9 -47.35L109.95 -47.35Q111.15 -47.35 111.95 -47.8Q112.75 -48.25 113.6 -49.4L119.05 -57.05Q120.1 -58.35 121.05 -58.95Q122 -59.55 122.95 -59.55Q124 -59.55 124.6 -58.9Q125.2 -58.25 125.2 -57L125.2 -14.25Q125.2 -10.75 126.58 -8.9Q127.95 -7.05 130.4 -7.05Q132.25 -7.05 133.28 -7.77Q134.3 -8.5 134.9 -9.45Q135.5 -10.4 136.08 -11.12Q136.65 -11.85 137.55 -11.9Q138.3 -11.9 138.73 -11.4Q139.15 -10.9 139.15 -9.75Q139.1 -6.9 137.28 -4.45Q135.45 -2 132.2 -0.47Q128.95 1.05 124.8 1.05Q118.4 1.05 114.78 -2.18Q111.15 -5.4 111.15 -11.9L111.15 -39.5Q111.15 -40.8 110.63 -41.42Q110.1 -42.05 108.9 -42.45ZM119.65 -42.4L119.65 -47.35L136.2 -47.35Q137.35 -47.35 138.03 -46.87Q138.7 -46.4 138.7 -45.5Q138.7 -44.2 137.4 -43.3Q136.1 -42.4 133.2 -42.4ZM174.95 -65.15L172.1 -64.5Q170.9 -64.15 170.25 -63.45Q169.6 -62.75 169.6 -61.65L169.6 -8.55Q169.6 -6.65 170.7 -5.82Q171.8 -5 174.05 -5L182.35 -5Q185.2 -5 187.2 -5.77Q189.2 -6.55 190.8 -8.5Q192.4 -10.45 194.05 -14.05L197.05 -20.95Q197.65 -22.2 198.53 -22.62Q199.4 -23.05 200.55 -22.75Q201.75 -22.45 202.25 -21.62Q202.75 -20.8 202.35 -19.4L197.85 -1.8Q197.3 0.05 196.48 0.95Q195.65 1.85 194.05 1.85Q193 1.85 191.98 1.4Q190.95 0.95 189.73 0.48Q188.5 0 186.65 0L149.7 0Q148.15 0 147.43 -0.62Q146.7 -1.25 146.7 -2.3Q146.7 -4.2 148.8 -4.85L151.65 -5.5Q152.85 -5.85 153.5 -6.55Q154.15 -7.25 154.15 -8.35L154.15 -61.65Q154.15 -62.75 153.5 -63.45Q152.85 -64.15 151.65 -64.5L148.8 -65.15Q146.7 -65.8 146.7 -67.7Q146.7 -68.8 147.43 -69.4Q148.15 -70 149.7 -70L174.05 -70Q175.6 -70 176.33 -69.4Q177.05 -68.8 177.05 -67.7Q177.05 -65.8 174.95 -65.15ZM234.65 -48.5Q242.4 -48.5 248.25 -45.35Q254.1 -42.2 257.38 -36.58Q260.65 -30.95 260.65 -23.5Q260.65 -16.45 257.27 -10.85Q253.9 -5.25 247.95 -2Q242 1.25 234.15 1.25Q226.45 1.25 220.63 -1.95Q214.8 -5.15 211.5 -10.77Q208.2 -16.4 208.2 -23.75Q208.2 -30.9 211.58 -36.47Q214.95 -42.05 220.9 -45.28Q226.85 -48.5 234.65 -48.5ZM238.2 -4Q241.6 -4.5 243.68 -7.12Q245.75 -9.75 246.33 -14.35Q246.9 -18.95 245.7 -25.4Q244.55 -31.85 242.35 -36.02Q240.15 -40.2 237.15 -42.05Q234.15 -43.9 230.65 -43.3Q227.2 -42.75 225.13 -40.12Q223.05 -37.5 222.53 -32.93Q222 -28.35 223.15 -21.85Q224.3 -15.45 226.5 -11.27Q228.7 -7.1 231.7 -5.25Q234.7 -3.4 238.2 -4ZM299.9 -4.6Q292.95 -5.6 289.83 -6.37Q286.7 -7.15 285.9 -7.85Q285.1 -8.55 285.1 -9.3Q285.1 -10.1 285.75 -10.8Q286.4 -11.5 287.9 -12.15L286.85 -12.95Q281.9 -12.45 279.08 -11.12Q276.25 -9.8 275.08 -7.95Q273.9 -6.1 273.9 -4Q273.9 -1.6 275.33 0.1Q276.75 1.8 280.65 3.13Q284.55 4.45 292.05 5.55Q298.15 6.45 301.55 7.48Q304.95 8.5 306.3 9.8Q307.65 11.1 307.65 12.85Q307.65 15.05 306.25 16.63Q304.85 18.2 301.8 19.03Q298.75 19.85 293.7 19.85Q284.9 19.85 281.35 17.23Q277.8 14.6 277.8 10.3Q277.8 7.95 279.77 6.08Q281.75 4.2 285.5 3.6L284.7 2.1Q274.75 3.3 270.9 6.35Q267.05 9.4 267.05 13.35Q267.05 16.55 269.35 19.08Q271.65 21.6 276.97 23.05Q282.3 24.5 291.35 24.5Q305.3 24.5 312.68 20.13Q320.05 15.75 320.05 8.9Q320.05 5.15 318.13 2.5Q316.2 -0.15 311.77 -1.87Q307.35 -3.6 299.9 -4.6ZM301.05 -43.3L304.3 -42.85Q306.15 -46.5 307.35 -47.75Q308.55 -49 310.15 -49Q311.6 -49 312.43 -48.28Q313.25 -47.55 313.9 -46.6Q314.55 -45.65 315.45 -44.92Q316.35 -44.2 317.95 -44.2Q320.25 -44.2 321.6 -45.87Q322.95 -47.55 322.95 -50.3Q322.95 -53.4 320.95 -55.17Q318.95 -56.95 315.8 -56.95Q311.95 -56.95 308.52 -54.42Q305.1 -51.9 302.75 -46.8ZM315.9 -30.45Q315.9 -35.5 313.13 -39.58Q310.35 -43.65 305.23 -46Q300.1 -48.35 293 -48.35Q285.7 -48.35 280.22 -45.9Q274.75 -43.45 271.72 -39.08Q268.7 -34.7 268.7 -28.9Q268.7 -23.85 271.47 -19.78Q274.25 -15.7 279.4 -13.35Q284.55 -11 291.65 -11Q298.95 -11 304.43 -13.45Q309.9 -15.9 312.9 -20.28Q315.9 -24.65 315.9 -30.45ZM290.5 -44.1Q294.8 -44.4 297.55 -40.7Q300.3 -37 301.1 -30Q301.9 -23.15 300.08 -19.45Q298.25 -15.75 294.1 -15.45Q291.25 -15.3 289.05 -16.87Q286.85 -18.45 285.45 -21.67Q284.05 -24.9 283.5 -29.55Q283 -34.15 283.63 -37.3Q284.25 -40.45 286 -42.17Q287.75 -43.9 290.5 -44.1ZM345.55 -45.1L345.55 -8Q345.55 -6.45 345.98 -5.72Q346.4 -5 347.3 -4.7L349.2 -4.2Q350.15 -3.9 350.6 -3.37Q351.05 -2.85 351.05 -2.05Q351.05 -1.1 350.4 -0.55Q349.75 0 348.3 0L328.6 0Q327.2 0 326.55 -0.55Q325.9 -1.1 325.9 -2.05Q325.9 -2.8 326.35 -3.32Q326.8 -3.85 327.75 -4.2L329.7 -4.7Q330.6 -5.05 331.03 -5.75Q331.45 -6.45 331.45 -8L331.45 -36.65Q331.45 -37.95 331.08 -38.5Q330.7 -39.05 329.85 -39.2L327.2 -39.4Q326.3 -39.6 325.9 -40.05Q325.5 -40.5 325.5 -41.2Q325.5 -42.05 325.97 -42.55Q326.45 -43.05 327.8 -43.55L337.1 -46.95Q339.05 -47.65 340.23 -47.95Q341.4 -48.25 342.2 -48.25Q343.9 -48.25 344.73 -47.37Q345.55 -46.5 345.55 -45.1ZM337.4 -55.9Q333.4 -55.9 330.98 -57.97Q328.55 -60.05 328.55 -63.4Q328.55 -66.75 330.98 -68.78Q333.4 -70.8 337.4 -70.8Q341.45 -70.8 343.88 -68.78Q346.3 -66.75 346.3 -63.4Q346.3 -60.05 343.88 -57.97Q341.45 -55.9 337.4 -55.9ZM377.2 -45.1L377.2 -8Q377.2 -6.45 377.65 -5.75Q378.1 -5.05 379 -4.7L380.8 -4.2Q382.4 -3.55 382.4 -2.2Q382.4 0 379.6 0L360.3 0Q358.9 0 358.25 -0.55Q357.6 -1.1 357.6 -2.05Q357.6 -2.8 358.03 -3.32Q358.45 -3.85 359.4 -4.2L361.4 -4.7Q362.3 -5.05 362.73 -5.75Q363.15 -6.45 363.15 -8L363.15 -36.65Q363.15 -37.95 362.78 -38.5Q362.4 -39.05 361.55 -39.2L358.9 -39.4Q358 -39.6 357.6 -40.05Q357.2 -40.5 357.2 -41.2Q357.2 -42.05 357.67 -42.55Q358.15 -43.05 359.5 -43.55L368.8 -46.95Q370.7 -47.65 371.85 -47.95Q373 -48.25 374.05 -48.25Q375.6 -48.25 376.4 -47.37Q377.2 -46.5 377.2 -45.1ZM375.7 -33.95L373.4 -36.3L375.35 -38.05Q381.7 -43.85 386.42 -46.17Q391.15 -48.5 395.3 -48.5Q401.75 -48.5 405.67 -44.4Q409.6 -40.3 409.6 -33.4L409.6 -8.15Q409.6 -6.5 410.08 -5.75Q410.55 -5 411.5 -4.7L413.25 -4.2Q414.25 -3.85 414.67 -3.32Q415.1 -2.8 415.1 -2.05Q415.1 -1.1 414.45 -0.55Q413.8 0 412.4 0L393.05 0Q390.25 0 390.25 -2.2Q390.25 -3.55 391.8 -4.2L393.7 -4.7Q394.7 -5.05 395.13 -5.8Q395.55 -6.55 395.55 -8.15L395.55 -31.35Q395.55 -35.75 393.4 -37.93Q391.25 -40.1 387.65 -40.1Q385.4 -40.1 382.88 -39.05Q380.35 -38 377.7 -35.7Z" fill="currentColor" /> </g> </svg>`;
  }

  private renderScreen(): string {
    switch (this.screen) {
      case "welcome":
        return `
          ${this.renderBrandLockup()}
          <p class="sub">A portable Nostr identity with a familiar login name and password.</p>
          ${this.renderError()}
          <button class="primary" data-action="goto-login">Sign in</button>
          <button class="secondary" data-action="goto-create">Create account</button>
          <button class="link" data-action="goto-import">Import an existing Nostr key</button>
          <button class="link" data-action="goto-recover">Forgot password? Recover with phrase</button>
        `;

      case "import-key": {
        const previewed = !!this.importPreviewNpub;
        return `
          <h2>Import an existing Nostr key</h2>
          <p class="sub">Wrap a Nostr identity you already control in a BitLogin login name and password. Your key never changes — you just get a friendlier way in.</p>
          <div class="notice warn">Pasting a private key into any web page is risky. Only do this on a BitLogin build you trust, and clear your clipboard afterward. BitLogin can't secure copies of this key that already exist elsewhere.</div>
          ${this.renderError()}
          <form data-form="import-key">
            <label for="importKey">Your nsec or hex private key</label>
            <input type="password" name="importKey" id="importKey" autocomplete="off" placeholder="nsec1… or 64-character hex" required />
            <button class="secondary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Checking…' : "Check key"}
            </button>
          </form>
          ${
            previewed
              ? `<div class="notice info">This key's public identity:</div>
                 <div class="credential-box">${escapeHtml(this.importPreviewNpub)}</div>
                 <button class="primary" type="button" data-action="import-continue">This is my identity — continue</button>`
              : ""
          }
          <button class="link" data-action="goto-welcome">Back</button>
        `;
      }

      case "create-name":
        return `
          <h2>${this.importKey ? "Set up your login" : "Create your BitLogin"}</h2>
          <p class="sub">${
            this.importKey
              ? "Choose a login name for your imported identity. It's a convenience, not a secret."
              : "Choose a login name. It's a convenience, not a secret (it contributes no security)."
          }</p>
          ${this.renderError()}
          <form data-form="create-name">
            <label for="loginName">Login name</label>
            <input type="text" name="loginName" id="loginName" placeholder="adam" autocomplete="off" required minlength="3" maxlength="32" />
            <button class="primary" type="submit">Continue</button>
          </form>
          <button class="link" data-action="goto-welcome">Back</button>
        `;

      case "create-credential": {
        const submitLabel = this.busy
          ? `<span class="spinner"></span>${this.importKey ? "Importing…" : "Creating account…"}`
          : this.importKey
            ? "Import account"
            : "Create account";

        if (this.manualPasswordMode) {
          return `
            <h2>Choose your own password</h2>
            <p class="sub">Not recommended: a downloadable encrypted file can be guessed against forever, offline, with no rate limit. BitLogin can only run basic checks here — not a breach-database lookup — so weak or reused passwords are still your risk to carry.</p>
            <div class="notice warn">Offline guessing against this password can never be fully prevented. The generated passphrase remains the safer default.</div>
            ${this.renderError()}
            <form data-form="create-credential">
              ${this.renderManualPasswordFields()}
              <label class="checkbox-row">
                <input type="checkbox" id="saved-check" ${this.savedCheckbox ? "checked" : ""} />
                I have saved this password somewhere safe.
              </label>
              <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>${submitLabel}</button>
            </form>
            <button class="link" data-action="toggle-manual-password">Use a generated password instead (recommended)</button>
          `;
        }

        return `
          <h2>Your generated password</h2>
          <p class="sub">BitLogin generates your password because no server can rate-limit guesses against a downloadable encrypted file.</p>
          <div class="credential-box" id="credential-box">${escapeHtml(this.generatedCredential)}</div>
          <button class="secondary" type="button" data-action="copy-credential">Copy</button>
          <button class="secondary" type="button" data-action="regenerate-credential">Generate a different one</button>
          ${this.renderError()}
          <form data-form="create-credential" autocomplete="on">
            <input type="text" name="username" autocomplete="username" value="${escapeHtml(this.loginName)}" readonly hidden />
            <label class="checkbox-row">
              <input type="checkbox" id="saved-check" ${this.savedCheckbox ? "checked" : ""} />
              I have saved this password somewhere safe.
            </label>
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>${submitLabel}</button>
          </form>
          <button class="link" data-action="toggle-manual-password">Use my own password instead (not recommended)</button>
        `;
      }

      case "confirm-phrase":
        return `
          <h2>Save your recovery phrase</h2>
          <p class="sub">These 12 words can recover your identity if you forget your password or lose all your devices. We cannot recover these words for you.</p>
          <p class="small">Do not enter a Bitcoin or other cryptocurrency-wallet recovery phrase into BitLogin. This is a BitLogin-only phrase.</p>
          <div class="phrase-grid">
            ${this.recoveryPhrase
              .split(" ")
              .map((w, i) => `<div class="phrase-word"><span>${i + 1}.</span>${escapeHtml(w)}</div>`)
              .join("")}
          </div>
          ${this.renderError()}
          <button class="primary" type="button" data-action="goto-verify-phrase">I've saved my phrase — continue</button>
        `;

      case "verify-phrase":
        return `
          <h2>Verify your recovery phrase</h2>
          <p class="sub">Your phrase is hidden now so you can confirm you actually saved it. Enter the requested words below.</p>
          ${this.renderError()}
          <form data-form="verify-phrase">
            ${this.confirmSlots
              .map(
                (slot) => `
              <label for="confirm-${slot.index}">Word #${slot.index + 1}</label>
              <input type="text" name="confirm-${slot.index}" id="confirm-${slot.index}" autocomplete="off" required />
            `
              )
              .join("")}
            <button class="primary" type="submit">Confirm and continue</button>
          </form>
          <button class="link" data-action="goto-confirm-phrase">Back to phrase</button>
        `;

      case "login":
        return `
          <h2>Sign in</h2>
          ${this.renderError()}
          <form data-form="login">
            <label for="loginName">Login name</label>
            <input type="text" name="loginName" id="loginName" autocomplete="username" required />
            <label for="password">Password</label>
            <input type="password" name="password" id="password" autocomplete="current-password" required />
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Signing in…' : "Sign in"}
            </button>
          </form>
          <button class="link" data-action="goto-recover">Forgot password? Recover with phrase</button>
          <button class="link" data-action="goto-welcome">Back</button>
        `;

      case "recover-phrase":
        return `
          <h2>Recover with phrase</h2>
          <p class="sub">Enter your 12-word BitLogin recovery phrase.</p>
          <p class="small">Do not enter a Bitcoin or other cryptocurrency-wallet recovery phrase into BitLogin.</p>
          ${this.renderError()}
          <form data-form="recover-phrase">
            <label for="phrase">Recovery phrase</label>
            <input type="text" name="phrase" id="phrase" autocomplete="off" required placeholder="12 words separated by spaces" />
            <label for="offlineExportFile" style="margin-top:14px">Recovery export file (optional)</label>
            <input type="file" name="offlineExportFile" id="offlineExportFile" accept=".json,application/json" />
            <p class="small">Only needed if relays are unreachable -- the phrase above is still required either way. The file alone can never recover an account by itself.</p>
            ${
              this.offlineExportFileNotice
                ? `<div class="notice ${this.offlineExportFile ? "info" : "warn"}">${escapeHtml(this.offlineExportFileNotice)}</div>`
                : ""
            }
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Recovering…' : "Continue"}
            </button>
          </form>
          <button class="link" data-action="goto-welcome">Back</button>
        `;

      case "recover-new-credentials": {
        const chainWarning = this.recoveredPreview?.chainWarning
          ? `<div class="notice warn">${escapeHtml(this.recoveredPreview.chainWarning)}</div>`
          : "";
        const submitLabel = this.busy ? '<span class="spinner"></span>Finishing recovery…' : "Finish recovery";
        return `
          <h2>Identity recovered</h2>
          <p class="sub">Found your account. Restored ${this.recoveredPreview?.generalRelaysCount ?? 0} general relay(s) and ${
            this.recoveredPreview?.dmRelaysCount ?? 0
          } DM relay(s) from your public events.</p>
          ${chainWarning}
          <p class="sub">Now set a new login name and password.</p>
          ${
            this.manualPasswordMode
              ? `<div class="notice warn">Offline guessing against this password can never be fully prevented. The generated passphrase remains the safer default.</div>`
              : `<div class="credential-box">${escapeHtml(this.newCredentialAfterRecovery)}</div>`
          }
          ${this.renderError()}
          <form data-form="recover-new-credentials">
            <label for="newLoginName">New login name</label>
            <input type="text" name="newLoginName" id="newLoginName" autocomplete="off" required />
            ${this.manualPasswordMode ? this.renderManualPasswordFields() : ""}
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>${submitLabel}</button>
          </form>
          <button class="link" data-action="toggle-manual-password">
            ${this.manualPasswordMode ? "Use a generated password instead (recommended)" : "Use my own password instead (not recommended)"}
          </button>
        `;
      }

      case "dashboard":
        return `
          <h2>Signed in</h2>
          ${this.renderWarnings()}
          <p class="pubkey">${this.session?.npub ?? ""}</p>
          ${this.renderError()}
          <button class="secondary" type="button" data-action="sign-test-event">Sign a test event</button>
          ${
            this.lastSignedEventJson
              ? `<div class="credential-box" style="white-space:pre-wrap">${escapeHtml(this.lastSignedEventJson)}</div>`
              : ""
          }
          <div class="divider"></div>
          <button class="secondary" type="button" data-action="goto-change-password">Rotate password</button>
          <button class="secondary" type="button" data-action="goto-export">Export identity</button>
          <button class="secondary" type="button" data-action="logout">Log out</button>
        `;

      case "rollback-confirm":
        return `
          <h2>This looks like a stale or revoked credential</h2>
          <div class="notice warn">${escapeHtml(this.rollbackMessage)}</div>
          <p class="sub">This usually means the password just entered was rotated away in an earlier session on this device, and a relay hasn't caught up with that change. If you rotated your password, use the new one instead. Only continue if you're confident this is relay lag, not a stale credential.</p>
          <button class="primary" type="button" data-action="rollback-retry">Try again</button>
          <button class="link" type="button" data-action="rollback-continue">I understand the risk — continue anyway</button>
          <button class="link" data-action="goto-welcome">Cancel</button>
        `;

      case "change-password":
        return `
          <h2>Rotate password</h2>
          <p class="sub">Your old password's capsule will be tombstoned and a deletion request issued. This does not erase copies an attacker may already have downloaded, and a relay that hasn't processed the deletion may keep serving the old password's capsule until a device that has already seen the new generation refuses it.</p>
          ${
            this.manualPasswordMode
              ? `<div class="notice warn">Offline guessing against this password can never be fully prevented. The generated passphrase remains the safer default.</div>`
              : `<div class="credential-box">${escapeHtml(this.changePasswordNewCredential)}</div>`
          }
          ${this.renderError()}
          <form data-form="change-password">
            <label for="oldPassword">Current password</label>
            <input type="password" name="oldPassword" id="oldPassword" autocomplete="current-password" required />
            ${this.manualPasswordMode ? this.renderManualPasswordFields() : ""}
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Rotating…' : "Confirm rotation"}
            </button>
          </form>
          <button class="link" data-action="toggle-manual-password">
            ${this.manualPasswordMode ? "Use a generated password instead (recommended)" : "Use my own password instead (not recommended)"}
          </button>
          <button class="link" data-action="goto-dashboard">Cancel</button>
        `;

      case "export":
        return `
          <h2>Export identity</h2>
          <p class="sub">Your public identity (npub) is safe to share. Your private key (nsec) is not.</p>
          <label>Public key (npub)</label>
          <div class="credential-box">${escapeHtml(this.session?.npub ?? "")}</div>
          <button class="secondary" type="button" data-action="download-recovery-export">Download recovery export</button>
          ${this.renderError()}
          <button class="secondary" type="button" data-action="reveal-nsec">Reveal private key (nsec)</button>
          ${
            this.exportedNsec
              ? `<div class="notice warn">Never share this. Anyone with it controls your identity.</div><div class="credential-box">${escapeHtml(
                  this.exportedNsec
                )}</div>`
              : ""
          }
          <button class="link" data-action="goto-dashboard">Back</button>
        `;

      default:
        return "";
    }
  }
}

function pickRandomIndices(max: number, count: number): number[] {
  const pool = Array.from({ length: max }, (_, i) => i);
  const chosen: number[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    chosen.push(pool.splice(idx, 1)[0]!);
  }
  return chosen.sort((a, b) => a - b);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
