/** <bitlogin-auth> — the embeddable BitLogin login/create/recover widget (§3, §27). */
import { generatePassphrase, isValidLoginName, checkManualPassword, type ManualPasswordCheck } from "@bitlogin/core/account";
import { encodeNpub } from "@bitlogin/core/nostr";
import { WorkerClient } from "./worker/workerClient.js";
import { createNip07Provider } from "./provider.js";
import { readConfigFromElement } from "./config.js";
import { WIDGET_STYLES } from "./styles.js";

type Screen =
  | "welcome"
  | "import-key"
  | "create-name"
  | "create-credential"
  | "confirm-phrase"
  | "login"
  | "recover-phrase"
  | "recover-new-credentials"
  | "dashboard"
  | "change-password"
  | "export";

interface ConfirmSlot {
  index: number;
  value: string;
}

export class BitLoginAuthElement extends HTMLElement {
  private root: ShadowRoot;
  private worker: WorkerClient;
  private vaultRelayUrls: string[] = [];
  private discoveryRelayUrls: string[] = [];

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
  private manualPasswordMode = false;
  private manualPasswordFeedback: ManualPasswordCheck | null = null;

  // Import flow (§SF10). importKey holds the pasted nsec/hex only until registration completes.
  private importKey = "";
  private importPreviewNpub = "";

  private recoverPhraseInput = "";
  private recoveredPreview: { generalRelaysCount: number; dmRelaysCount: number; chainWarning?: string } | null = null;
  private newCredentialAfterRecovery = "";

  private session: { publicKey: string; npub: string; accountId?: string } | null = null;
  private sessionWarnings: string[] = [];
  private lastSignedEventJson = "";
  private exportedNsec = "";
  private changePasswordNewCredential = "";

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
    this.render();

    if (!(window as unknown as { nostr?: unknown }).nostr) {
      (window as unknown as { nostr: unknown }).nostr = createNip07Provider(this.worker, () => this.vaultRelayUrls);
    }
  }

  disconnectedCallback(): void {
    this.worker.terminate();
  }

  // ---- Public API mirroring window.nostr, scoped to this element instance ----
  async getPublicKey(): Promise<string> {
    return (await this.worker.getPublicKey()).publicKey;
  }
  async signEvent(event: { kind: number; tags?: string[][]; content: string; created_at?: number }) {
    return this.worker.signEvent(event);
  }
  async logout(): Promise<void> {
    await this.worker.logout();
    this.session = null;
    this.dispatchEvent(new CustomEvent("bitlogin-logout"));
    this.goto("welcome");
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
        this.goto("recover-phrase");
        return;
      case "goto-welcome":
        this.goto("welcome");
        return;
      case "goto-dashboard":
        this.goto("dashboard");
        return;
      case "goto-change-password":
        this.changePasswordNewCredential = generatePassphrase().secret;
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
        this.savedCheckbox = false;
        this.render();
        return;
      case "copy-credential": {
        const box = this.root.querySelector<HTMLElement>("#credential-box");
        if (box) void navigator.clipboard?.writeText(box.textContent ?? "");
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
        case "confirm-phrase":
          return this.handleConfirmPhraseSubmit();
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
   * Live entropy/strength feedback for the manual-password field, updated by DIRECTLY
   * patching a feedback element's text — never calling this.render() — so the input never
   * loses focus or cursor position while the user is typing (§9.3).
   */
  private onInput(e: Event): void {
    const target = e.target as HTMLElement;
    if (!(target instanceof HTMLInputElement) || target.name !== "manualPassword") return;
    this.manualPasswordFeedback = target.value ? checkManualPassword(target.value, this.loginName) : null;
    const feedback = this.root.querySelector<HTMLElement>("#manual-password-feedback");
    if (!feedback) return;
    if (!this.manualPasswordFeedback) {
      feedback.textContent = "";
      feedback.className = "notice info";
      return;
    }
    const bits = this.manualPasswordFeedback.entropyBits.toFixed(0);
    if (this.manualPasswordFeedback.ok) {
      feedback.textContent = `Looks good (~${bits} bits estimated).`;
      feedback.className = "notice info";
    } else {
      feedback.textContent = `${this.manualPasswordFeedback.reason} (~${bits} bits estimated)`;
      feedback.className = "notice warn";
    }
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
    this.goto("create-credential");
  }

  private async handleCreateCredentialSubmit(): Promise<void> {
    let password = this.generatedCredential;
    if (this.manualPasswordMode) {
      const typed = this.field("manualPassword");
      const check = checkManualPassword(typed, this.loginName);
      if (!check.ok) {
        this.errorMessage = `Password not accepted: ${check.reason}`;
        this.render();
        return;
      }
      password = typed;
    }
    this.savedCheckbox = (this.root.querySelector("#saved-check") as HTMLInputElement | null)?.checked ?? false;
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
    // just a bare npub in every other Nostr client.
    void this.worker.publishProfileAndRelayLists({
      name: this.loginName,
      generalRelays: this.vaultRelayUrls,
      dmRelays: this.vaultRelayUrls
    });
    void this.offerToSaveCredential(this.loginName, password);
  }

  private handleConfirmPhraseSubmit(): void {
    const words = this.recoveryPhrase.split(" ");
    for (const slot of this.confirmSlots) {
      const typed = this.field(`confirm-${slot.index}`).trim().toLowerCase();
      if (typed !== words[slot.index]) {
        this.errorMessage = `Word #${slot.index + 1} doesn't match. Please check your saved phrase and try again.`;
        this.render();
        return;
      }
    }
    this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: this.session?.publicKey } }));
    this.goto("dashboard");
  }

  private async handleLoginSubmit(): Promise<void> {
    const loginName = this.field("loginName").trim().toLowerCase();
    const password = this.field("password");
    this.setBusy(true);
    const result = await this.worker.login({ loginName, password });
    this.loginName = loginName;
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId };
    this.sessionWarnings = [result.rollbackWarning, result.relayDisagreementWarning].filter((w): w is string => !!w);
    this.busy = false;
    this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: result.everydayPublicKey } }));
    this.goto("dashboard");
    void this.offerToSaveCredential(loginName, password);
  }

  private async handleRecoverPhraseSubmit(): Promise<void> {
    const phrase = this.field("phrase").trim();
    this.setBusy(true);
    const result = await this.worker.recover({ phrase });
    this.recoverPhraseInput = phrase;
    this.recoveredPreview = {
      generalRelaysCount: result.generalRelays.length,
      dmRelaysCount: result.dmRelays.length,
      chainWarning: result.chainWarning
    };
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId };
    this.newCredentialAfterRecovery = generatePassphrase().secret;
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
    this.setBusy(true);
    await this.worker.completeRecovery({ newLoginName, newPassword: this.newCredentialAfterRecovery });
    this.loginName = newLoginName;
    this.busy = false;
    this.dispatchEvent(new CustomEvent("bitlogin-login", { detail: { publicKey: this.session?.publicKey } }));
    this.goto("dashboard");
    void this.offerToSaveCredential(newLoginName, this.newCredentialAfterRecovery);
  }

  private async handleChangePasswordSubmit(): Promise<void> {
    const oldPassword = this.field("oldPassword");
    this.setBusy(true);
    await this.worker.changePassword({
      loginName: this.loginName,
      oldPassword,
      newPassword: this.changePasswordNewCredential
    });
    this.busy = false;
    this.goto("dashboard");
    void this.offerToSaveCredential(this.loginName, this.changePasswordNewCredential);
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
              <label for="manualPassword">Password</label>
              <input type="password" name="manualPassword" id="manualPassword" autocomplete="new-password" required minlength="12" />
              <div class="notice info" id="manual-password-feedback"></div>
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
          <form data-form="confirm-phrase">
            <p class="sub" style="margin-top:14px">Confirm you saved it by typing the requested words:</p>
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
        return `
          <h2>Identity recovered</h2>
          <p class="sub">Found your account. Restored ${this.recoveredPreview?.generalRelaysCount ?? 0} general relay(s) and ${
            this.recoveredPreview?.dmRelaysCount ?? 0
          } DM relay(s) from your public events.</p>
          ${chainWarning}
          <p class="sub">Now set a new login name and password.</p>
          <div class="credential-box">${escapeHtml(this.newCredentialAfterRecovery)}</div>
          ${this.renderError()}
          <form data-form="recover-new-credentials">
            <label for="newLoginName">New login name</label>
            <input type="text" name="newLoginName" id="newLoginName" autocomplete="off" required />
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Finishing recovery…' : "Finish recovery"}
            </button>
          </form>
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

      case "change-password":
        return `
          <h2>Rotate password</h2>
          <p class="sub">Your old password's capsule will be tombstoned and a deletion request issued. This does not erase copies an attacker may already have downloaded.</p>
          <div class="credential-box">${escapeHtml(this.changePasswordNewCredential)}</div>
          ${this.renderError()}
          <form data-form="change-password">
            <label for="oldPassword">Current password</label>
            <input type="password" name="oldPassword" id="oldPassword" autocomplete="current-password" required />
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Rotating…' : "Confirm rotation"}
            </button>
          </form>
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
