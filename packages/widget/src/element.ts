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
    this.goto("dashboard");
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
      this.goto("dashboard");
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
    this.goto("dashboard");
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
      this.goto("dashboard");
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
    this.root.innerHTML = `<style>${WIDGET_STYLES}</style><div class="card">${this.renderScreen()}</div>`;
  }

  private renderError(): string {
    return this.errorMessage ? `<div class="notice error">${escapeHtml(this.errorMessage)}</div>` : "";
  }

  private renderWarnings(): string {
    return this.sessionWarnings.map((w) => `<div class="notice warn">${escapeHtml(w)}</div>`).join("");
  }

  private renderScreen(): string {
    switch (this.screen) {
      case "welcome":
        return `
          <h2>BitLogin</h2>
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
