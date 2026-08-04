/** <bitlogin-auth> — the embeddable BitLogin login/create/recover widget (§3, §27). */
import {
  generatePassphrase,
  isValidLoginName,
  parseRecoveryExport,
  RecoveryExportParseError,
  type RecoveryExportFile
} from "@bitlogin/core/account";
import { encodeNpub } from "@bitlogin/core/nostr";
import { randomUniformInt } from "@bitlogin/core/crypto";
import { WorkerClient } from "./worker/workerClient.js";
import { createElementRoutedProvider, type Nip07Provider } from "./provider.js";
import { readConfigFromElement } from "./config.js";
import { WIDGET_STYLES } from "./styles.js";
import { chooseWalletViaBitcoinConnect } from "./vault/bitcoinConnect.js";
import type { VaultConnectionSummary } from "./worker/protocol.js";
import { buildVaultIntegrityWarnings } from "./vault/integrityWarnings.js";
import { detectForeignNip07Provider, Nip07Signer } from "./signers/nip07.js";
import { Nip46Signer } from "./signers/nip46.js";
import type { Signer, SignerCapabilities, SignerMethod } from "./signers/types.js";
import { renderQrSvg } from "./qr.js";
import { setActiveSession, clearActiveSession } from "./globalSession.js";
import {
  buildPasskeyCreateOptions,
  buildPasskeyGetOptions,
  deriveCredentialFromPrf,
  extractPrfOutput,
  passkeySupported
} from "./passkey.js";

type Screen =
  | "welcome"
  | "extension-confirm"
  | "bunker-connect"
  | "bunker-confirm"
  | "passkey"
  | "passkey-create"
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
  | "rollback-confirm"
  | "vault-consent"
  | "vault-import"
  | "vault-manage"
  | "vault-offer";

interface ConfirmSlot {
  index: number;
  value: string;
}

/** Line icons for the "More sign-in options" menu: stroke-based so they pick
 *  up the muted foreground in either theme, sized by .option-icon. */
const OPTION_ICONS = {
  extension: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M6.5 6.7h.01"/><path d="M9.3 6.7h.01"/></svg>`,
  remote: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3"/><path d="M21 14v0.01"/><path d="M14 21h0.01"/><path d="M17.5 17.5L21 21"/></svg>`,
  importKey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21"/><path d="M18 12v3.2"/><path d="M14.8 12v2.2"/></svg>`,
  recover: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 5v5h5"/><path d="M4.2 14a8 8 0 1 0 1.9-8.3L2.5 10"/></svg>`,
  passkey: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3.5c-3 0-5.5 2.4-5.5 5.4v2.3c0 3.4-.7 5.3-1.6 6.8"/><path d="M12 7.2a2.9 2.9 0 0 0-2.9 2.9v2.1c0 2.6-.5 4.6-1.3 6.3"/><path d="M12 10.5v2.2c0 2.7-.4 4.9-1.1 6.8"/><path d="M15 9.6c.3.7.4 1.5.4 2.4 0 2.9-.3 5.3-.9 7.3"/><path d="M17.5 8.9c.6 3.4.4 7.1-.4 10.2"/></svg>`
} as const;

const CHEVRON_DOWN = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`;

const CHEVRON_LEFT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>`;

export class BitLoginAuthElement extends HTMLElement {
  private root: ShadowRoot;
  private worker: WorkerClient;
  private vaultRelayUrls: string[] = [];
  private discoveryRelayUrls: string[] = [];
  private installedProvider: Nip07Provider | null = null;

  private screen: Screen = "welcome";
  private busy = false;
  private errorMessage: string | undefined;
  /** Welcome-screen disclosure for non-primary sign-in paths; survives
   *  re-renders so an open menu doesn't snap shut on an error render. */
  private moreOptionsOpen = false;

  private loginName = "";
  private generatedCredential = "";
  private savedCheckbox = false;
  private recoveryPhrase = "";
  private confirmSlots: ConfirmSlot[] = [];

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

  private session: { publicKey: string; npub: string; accountId?: string; method: SignerMethod } | null = null;

  // ---- Alternative-method sessions (docs/login-methods.md §LM4, §LM5, §LM7) ----
  // `pending*` state holds a candidate between "the signer answered" and the user
  // confirming that npub is theirs; only `altSigner` routes the public API. Thin by
  // design: no capsule, no vault, no persistence -- a reload simply signs the user
  // out, and the signer is asked again next visit.
  private pendingExtensionSigner: Nip07Signer | null = null;
  private altSigner: Signer | null = null;
  private extensionPreviewNpub = "";
  private extensionPreviewPubkey = "";

  // NIP-46 connect flow (§LM5). The QR/copyable nostrconnect URI, the signer's
  // interactive-approval URL if one arrives mid-connect, and the confirmed-but-
  // not-yet-adopted user identity.
  private bunkerConnectUri = "";
  private bunkerAuthUrl = "";
  private pendingBunker: { userPubkey: string; npub: string } | null = null;

  // ---- Passkey rail (docs/passkey-login.md) ----
  // Zero registration, zero servers: a PRF-capable passkey deterministically
  // derives this site's login name + password (a frozen contract, see
  // passkey.ts), and the ordinary password flows do everything else.
  // `pendingPasskey` holds the derived credential between "the ceremony
  // succeeded" and the new user's fresh-vs-import choice. `passkeySession`
  // marks the standing for dashboard labeling. `securePhrasePending` is the
  // Tier B2 deferred phrase ceremony behind the dashboard card.
  private pendingPasskey: { loginName: string; password: string } | null = null;
  private passkeySession = false;
  private securePhrasePending = false;
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

  // ---- Connection Vault request flow (vault-ux.md §2-§4, reveal mode) ----
  // stage "auth": waiting for the user to sign in first; the goto("dashboard")
  // hook resumes the request exactly once. stage "active": the vault screens
  // own navigation until finishVaultRequest() settles the promise.
  private vaultRequest: {
    appName: string;
    reason?: string;
    origin: string;
    stage: "auth" | "active";
    resolve: (uri: string | null) => void;
  } | null = null;
  private vaultCandidate: VaultConnectionSummary | null = null;
  /** True when the account cannot store the connection (no vault root); the
   *  flow still hands the URI to the app, labeled as unsaved. */
  private vaultUnsaved = false;
  private vaultUnsavedReason: "no-vault" | "stale-cache" | undefined;
  private vaultConnections: VaultConnectionSummary[] | null = null;
  private vaultIntegrityWarnings: string[] = [];
  /** offerNwcConnection state: the app already holds this URI; the only
   *  question on screen is whether a copy enters the user's vault. */
  /** Claimed synchronously by offerNwcConnection before any await (see there). */
  private offerInFlight = false;
  private vaultOffer: {
    uri: string;
    appName: string;
    label: string;
    resolve: (outcome: "saved" | "declined") => void;
  } | null = null;

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
    this.worker.onNotification = (notification) => {
      if (notification.notify === "nip46-auth-url") {
        // Arrives mid-connect, while nip46Connect is still pending (§LM5.1).
        this.bunkerAuthUrl = notification.url;
        this.render();
      }
    };
  }

  connectedCallback(): void {
    const config = readConfigFromElement(this);
    this.vaultRelayUrls = config.vaultRelayUrls ?? [];
    this.discoveryRelayUrls = config.discoveryRelayUrls ?? [];
    void this.worker
      .configure({ vaultRelayUrls: this.vaultRelayUrls, discoveryRelayUrls: this.discoveryRelayUrls })
      .then(() => this.tryRestoreSession());

    this.root.addEventListener("click", (e) => this.onClick(e));
    this.root.addEventListener("submit", (e) => this.onSubmit(e));
    this.root.addEventListener("change", (e) => void this.onFileChange(e));
    this.render();

    // Routed through this element, not bound to the worker directly, so the
    // provider follows the ACTIVE signer -- worker for BitLogin accounts,
    // worker-held NIP-46 client for remote-signer sessions (§LM3, §LM5).
    this.installedProvider = createElementRoutedProvider(this, () => this.vaultRelayUrls);
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
    clearActiveSession(this);
    this.releaseSigner();
    this.worker.terminate();
  }

  // ---- Public API mirroring window.nostr, scoped to this element instance ----
  // Routed through the active signer: the worker for BitLogin-account sessions (as
  // always), the extension's provider for a NIP-07 session (§LM3). Hosts holding a
  // reference to this element get the right backend either way.
  async getPublicKey(): Promise<string> {
    if (this.altSigner) return this.altSigner.getPublicKey();
    return (await this.worker.getPublicKey()).publicKey;
  }
  async signEvent(event: { kind: number; tags?: string[][]; content: string; created_at?: number }) {
    if (this.altSigner) return this.altSigner.signEvent(event);
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
    if (this.altSigner) return this.altSigner.nip44Encrypt(peerPublicKey, plaintext);
    return (await this.worker.nip44Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }
  async nip44Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    if (this.altSigner) return this.altSigner.nip44Decrypt(peerPublicKey, payload);
    return (await this.worker.nip44Decrypt({ peerPublicKey, payload })).plaintext;
  }
  /**
   * Legacy relative to nip44Encrypt/nip44Decrypt above, but still what a real NIP-07
   * extension exposes as window.nostr.nip04 -- implemented for drop-in parity with sites
   * (or their older DM code paths) that still expect NIP-04 rather than NIP-44.
   */
  async nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    if (this.altSigner) return this.altSigner.nip04Encrypt(peerPublicKey, plaintext);
    return (await this.worker.nip04Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }
  async nip04Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    if (this.altSigner) return this.altSigner.nip04Decrypt(peerPublicKey, payload);
    return (await this.worker.nip04Decrypt({ peerPublicKey, payload })).plaintext;
  }
  async logout(): Promise<void> {
    if (this.altSigner) {
      // Thin sessions persist nothing (§LM7). A NIP-46 session additionally
      // holds a live client in the worker to close, and claimed window.nostr
      // (its backend is ours) -- releaseSigner is a safe no-op for NIP-07,
      // which never claimed the slot (§LM4).
      if (this.altSigner.method === "nip46") void this.worker.nip46Disconnect();
      this.altSigner = null;
      this.session = null;
      this.passkeySession = false;
      this.securePhrasePending = false;
      clearActiveSession(this);
      this.releaseSigner();
      this.dispatchEvent(new CustomEvent("bitlogin-logout"));
      this.goto("welcome");
      return;
    }
    await this.worker.logout();
    this.session = null;
    this.passkeySession = false;
    this.securePhrasePending = false;
    clearActiveSession(this);
    this.releaseSigner();
    this.dispatchEvent(new CustomEvent("bitlogin-logout"));
    this.goto("welcome");
  }

  /**
   * Connection Vault request API (connection-vault.md §12, vault-ux.md §2-§4).
   *
   * Asks the user to share an NWC wallet connection with THIS page's origin
   * and resolves the raw `nostr+walletconnect://` URI, or null if the user
   * declines or dismisses. REVEAL MODE, stated plainly: the caller receives
   * the full bearer credential and everything its wallet-side budget allows —
   * an embedded same-origin widget cannot broker (§CV12.3), so it does not
   * pretend to. The consent copy tells the user the same thing.
   *
   * If nobody is signed in, the widget shows its sign-in flow first and
   * resumes the request after. If the account already has a connection bound
   * to this origin, the user sees a one-tap approval; otherwise a guided
   * import (Bitcoin Connect chooser, or paste).
   */
  async requestNwcConnection(options: { appName?: string; reason?: string } = {}): Promise<string | null> {
    if (this.vaultRequest) throw new Error("A wallet connection request is already in progress.");
    // Extension sessions are signer-only (§LM7): no vault, and prompting a password
    // sign-in over an active session would be worse than an honest decline.
    if (this.altSigner) return null;
    const origin = window.location.origin;
    const appName = options.appName?.trim() || window.location.hostname || "This app";
    return new Promise<string | null>((resolve) => {
      this.vaultRequest = { appName, reason: options.reason, origin, stage: "auth", resolve };
      // Symmetric with bitlogin-offer-pending. Without it, a host following
      // the recommended hidden-mount pattern navigated a HIDDEN element to a
      // consent screen nobody could see, and the promise never settled.
      this.dispatchEvent(new CustomEvent("bitlogin-request-pending"));
      void (async () => {
        try {
          const status = await this.worker.getSessionStatus();
          if (!status.unlocked) {
            // Sign-in first; the goto("dashboard") hook resumes the request.
            this.goto("login");
            return;
          }
          await this.continueVaultRequest();
        } catch (err) {
          this.fail(err);
        }
      })();
    });
  }

  /**
   * Offer-to-save (the inverse of requestNwcConnection): the app OBTAINED an
   * NWC URI by its own means — its own wallet chooser, its own paste box —
   * and offers the user a portable copy. Consent-gated in this widget's own
   * UI, never silent: the write goes to the user's account (encrypted events
   * under their vault identity), and nothing enters or leaves the vault
   * without the user seeing it happen in BitLogin's chrome.
   *
   * Resolves "saved", "declined", "already-saved" (same wallet + secret
   * exists; its origin binding was refreshed, no UI shown), or "unavailable"
   * (no session or no vault root — the offer is quietly impossible, and an
   * app should treat that as a no-op rather than an error).
   */
  async offerNwcConnection(
    uri: string,
    options: { appName?: string; label?: string } = {}
  ): Promise<"saved" | "declined" | "already-saved" | "unavailable"> {
    // The slot is claimed SYNCHRONOUSLY. The guard used to sit above three
    // awaits, so two concurrent calls both passed it and the second
    // overwrote the first's resolve -- dropping a promise that never settled.
    if (this.vaultOffer || this.vaultRequest || this.offerInFlight) return "unavailable";
    this.offerInFlight = true;
    try {
      return await this.runOfferNwcConnection(uri, options);
    } finally {
      this.offerInFlight = false;
    }
  }

  private async runOfferNwcConnection(
    uri: string,
    options: { appName?: string; label?: string }
  ): Promise<"saved" | "declined" | "already-saved" | "unavailable"> {
    const status = await this.worker.getSessionStatus().catch(() => ({ unlocked: false }));
    if (!status.unlocked) return "unavailable";
    const vaultStatus = await this.worker.vaultStatus();
    if (!vaultStatus.enabled) return "unavailable";
    const check = await this.worker.vaultOfferCheck({ uri });
    if (check.duplicate) return "already-saved";

    const appName = options.appName?.trim() || window.location.hostname || "This app";
    return new Promise((resolve) => {
      this.vaultOffer = {
        uri,
        appName,
        label: options.label?.trim() || `${appName} wallet`,
        resolve
      };
      // Hosts that keep this element hidden until needed (the recommended
      // permanent-mount pattern) listen for this to reveal it: the silent
      // outcomes above never fire it, so nothing flashes for a duplicate.
      this.dispatchEvent(new CustomEvent("bitlogin-offer-pending"));
      this.goto("vault-offer");
    });
  }

  private finishVaultOffer(outcome: "saved" | "declined"): void {
    const offer = this.vaultOffer;
    if (!offer) return;
    this.vaultOffer = null;
    offer.resolve(outcome);
    this.goto(this.session ? "dashboard" : "welcome");
  }

  private async acceptVaultOffer(): Promise<void> {
    const offer = this.vaultOffer;
    if (!offer) return;
    this.setBusy(true);
    try {
      const label = this.field("vaultOfferLabel").trim() || offer.label;
      await this.worker.vaultSaveNwc({ uri: offer.uri, label });
      this.setBusy(false);
      this.finishVaultOffer("saved");
      this.flashSuccess(this.screen, "Wallet saved");
      this.dispatchEvent(
        new CustomEvent("bitlogin-connection-granted", { detail: { origin: window.location.origin } })
      );
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
  }

  /** Settles the pending request exactly once and returns to a neutral screen. */
  private finishVaultRequest(uri: string | null): void {
    const request = this.vaultRequest;
    if (!request) return;
    this.vaultRequest = null;
    this.vaultCandidate = null;
    this.vaultUnsaved = false;
    this.vaultUnsavedReason = undefined;
    request.resolve(uri);
    if (uri !== null) {
      this.dispatchEvent(
        new CustomEvent("bitlogin-connection-granted", { detail: { origin: request.origin } })
      );
    }
    this.goto(this.session ? "dashboard" : "welcome");
  }

  private async continueVaultRequest(): Promise<void> {
    const request = this.vaultRequest;
    if (!request) return;
    request.stage = "active";
    const status = await this.worker.vaultStatus();
    if (!status.enabled) {
      this.vaultUnsaved = true;
      this.vaultUnsavedReason = status.reason;
      this.goto("vault-import");
      return;
    }
    this.vaultUnsaved = false;
    const found = await this.worker.vaultFindForOrigin();
    if (found.connection) {
      this.vaultCandidate = found.connection;
      this.goto("vault-consent");
    } else {
      this.goto("vault-import");
    }
  }

  private async approveVaultCandidate(): Promise<void> {
    const candidate = this.vaultCandidate;
    if (!candidate || !this.vaultRequest) return;
    this.setBusy(true);
    try {
      const { uri } = await this.worker.vaultRevealNwc({ connectionId: candidate.connectionId });
      this.setBusy(false);
      this.finishVaultRequest(uri);
      this.flashSuccess(this.screen, "Wallet shared");
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
  }

  private async runVaultBcChooser(): Promise<void> {
    const request = this.vaultRequest;
    if (!request) return;
    this.setBusy(true);
    try {
      const uri = await chooseWalletViaBitcoinConnect(request.appName);
      if (uri === null) {
        this.setBusy(false);
        return; // modal dismissed — stay on the import screen
      }
      await this.saveAndShareVaultUri(uri, this.field("vaultLabel"));
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
  }

  private async handleVaultImportSubmit(): Promise<void> {
    const uri = this.field("vaultUri").trim();
    if (!uri) return;
    this.setBusy(true);
    try {
      await this.saveAndShareVaultUri(uri, this.field("vaultLabel"));
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
  }

  private async saveAndShareVaultUri(uri: string, labelDraft: string): Promise<void> {
    const request = this.vaultRequest;
    if (!request) return;
    if (this.vaultUnsaved) {
      // No vault root in this session: hand the URI to the app, honestly unsaved.
      this.setBusy(false);
      this.finishVaultRequest(uri);
      return;
    }
    const label = labelDraft.trim() || `${request.appName} wallet`;
    await this.worker.vaultSaveNwc({ uri, label });
    this.setBusy(false);
    this.finishVaultRequest(uri);
    this.flashSuccess(this.screen, "Wallet connected");
  }

  private async loadVaultManage(): Promise<void> {
    this.vaultConnections = null;
    this.vaultIntegrityWarnings = [];
    this.goto("vault-manage");
    try {
      const listed = await this.worker.vaultList();
      this.vaultConnections = listed.connections;
      this.vaultIntegrityWarnings = buildVaultIntegrityWarnings(listed);
    } catch (err) {
      this.errorMessage = err instanceof Error ? err.message : String(err);
      this.vaultConnections = [];
    }
    this.render();
  }

  private async vaultUnbind(connectionId: string): Promise<void> {
    this.setBusy(true);
    try {
      await this.worker.vaultSetBinding({ connectionId, origin: null });
      this.busy = false;
      await this.loadVaultManage();
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
  }

  private async vaultDeleteConnection(connectionId: string): Promise<void> {
    this.setBusy(true);
    try {
      await this.worker.vaultDelete({ connectionId });
      this.busy = false;
      await this.loadVaultManage();
    } catch (err) {
      this.setBusy(false);
      this.fail(err);
    }
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
  /** Single dispatch point for bitlogin-login so every sign-in path reports the same
   * detail shape: which method granted the session and what it can do (§LM3). The
   * pre-existing `publicKey` field is unchanged for hosts written before `method`. */
  private dispatchLogin(): void {
    const capabilities: SignerCapabilities = this.altSigner?.capabilities ?? {
      nip44: true,
      nip04: true,
      getRelays: true
    };
    if (this.session) {
      // Keep window.bitlogin.activeMethod()/activeSession() in step with the
      // bitlogin-login event -- hosts may use either.
      setActiveSession(this, {
        method: this.session.method,
        publicKey: this.session.publicKey,
        npub: this.session.npub
      });
    }
    this.dispatchEvent(
      new CustomEvent("bitlogin-login", {
        detail: {
          publicKey: this.session?.publicKey,
          method: this.session?.method ?? "bitlogin",
          capabilities
        }
      })
    );
  }

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
    // A pending wallet request hijacks the two navigation moments that decide
    // its fate: landing on the dashboard after the sign-in it was waiting for
    // (resume), and backing all the way out to welcome (decline).
    if (screen === "dashboard" && this.vaultRequest?.stage === "auth") {
      void this.continueVaultRequest().catch((err) => this.fail(err));
      return;
    }
    if (screen === "welcome" && this.vaultRequest) {
      this.finishVaultRequest(null);
      return;
    }
    if (screen === "welcome" && this.vaultOffer) {
      this.finishVaultOffer("declined");
      return;
    }
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
    // A synthetic click is not consent. The shadow root is open (by design,
    // for host theming), so a host page can find and .click() any button in
    // here -- including "approve this wallet" and "reveal my nsec". isTrusted
    // is false for anything script-dispatched. This does NOT make the widget
    // a security boundary against its host (see connection-vault.md §12.3;
    // the host can still style the real button under its own), but it closes
    // the zero-effort version where no human ever sees a screen.
    if (!e.isTrusted) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target) return;
    const action = target.dataset.action!;
    switch (action) {
      case "vault-offer-save":
        return this.acceptVaultOffer();
      case "vault-offer-decline":
        this.finishVaultOffer("declined");
        return;
      case "vault-approve":
        return this.approveVaultCandidate();
      case "vault-different":
        this.vaultCandidate = null;
        this.goto("vault-import");
        return;
      case "vault-bc":
        return this.runVaultBcChooser();
      case "vault-cancel":
        this.finishVaultRequest(null);
        return;
      case "goto-vault-manage":
        return this.loadVaultManage();
      case "vault-unbind":
        return this.vaultUnbind(target.dataset.id!);
      case "vault-delete":
        return this.vaultDeleteConnection(target.dataset.id!);
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
        this.pendingExtensionSigner = null;
        this.pendingPasskey = null;
        // Backing out of an unfinished bunker connect abandons the worker-side
        // attempt -- but never a live session (altSigner) that's merely
        // navigating around.
        if (!this.altSigner && (this.bunkerConnectUri || this.pendingBunker)) {
          void this.worker.nip46Disconnect();
        }
        this.pendingBunker = null;
        this.bunkerConnectUri = "";
        this.bunkerAuthUrl = "";
        this.goto("welcome");
        return;
      case "toggle-more":
        this.moreOptionsOpen = !this.moreOptionsOpen;
        this.render();
        return;
      case "goto-passkey":
        this.pendingPasskey = null;
        this.errorMessage = undefined;
        this.goto("passkey");
        return;
      case "passkey-auth":
        return this.handlePasskeyAuth();
      case "passkey-register":
        return this.handlePasskeyRegisterCeremony();
      case "passkey-new":
        this.importKey = "";
        this.importPreviewNpub = "";
        return void this.runPasskeyRegistration();
      case "passkey-import":
        this.importKey = "";
        this.importPreviewNpub = "";
        this.goto("import-key");
        return;
      case "extension-signin":
        return this.handleExtensionSignIn();
      case "extension-continue":
        this.handleExtensionConfirm();
        return;
      case "goto-bunker":
        this.pendingBunker = null;
        this.bunkerConnectUri = "";
        this.bunkerAuthUrl = "";
        this.errorMessage = undefined;
        this.goto("bunker-connect");
        void this.startNostrconnect();
        return;
      case "bunker-continue":
        this.handleBunkerConfirm();
        return;
      case "copy-bunker-uri": {
        const button = target;
        const original = button.textContent ?? "Copy";
        const flash = (text: string) => {
          button.textContent = text;
          setTimeout(() => {
            if (button.isConnected) button.textContent = original;
          }, 2000);
        };
        if (!this.bunkerConnectUri || !navigator.clipboard?.writeText) {
          flash("Copy not available");
          return;
        }
        navigator.clipboard.writeText(this.bunkerConnectUri).then(
          () => flash("Copied"),
          () => flash("Copy failed")
        );
        return;
      }
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
    if (!e.isTrusted) return; // see onClick: synthetic submits are not consent

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
        case "vault-import":
          return await this.handleVaultImportSubmit();
        case "bunker-connect":
          return await this.handleBunkerSubmit();
        default:
          return;
      }
    } catch (err) {
      this.fail(err);
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
    if (this.pendingPasskey) {
      // Passkey setup chose "use my existing key": same §SF10 wrap, with the
      // passkey-derived credential in place of a typed password.
      void this.runPasskeyRegistration();
      return;
    }
    this.loginName = "";
    this.goto("create-name");
  }

  private static readonly PRF_UNSUPPORTED_MESSAGE =
    "This passkey (or this browser) doesn't support the extension BitLogin needs. Try a different browser or password manager, or use one of the other sign-in methods.";

  /** Runs a WebAuthn ceremony and returns the derived credential, or null
   *  after rendering the appropriate message (cancelled / PRF-unsupported). */
  private async runPasskeyCeremony(kind: "get" | "create"): Promise<{ loginName: string; password: string } | null> {
    try {
      const credential = (kind === "get"
        ? await navigator.credentials.get(buildPasskeyGetOptions())
        : await navigator.credentials.create(buildPasskeyCreateOptions("BitLogin"))) as PublicKeyCredential | null;
      if (!credential) throw new Error("The passkey ceremony returned nothing.");
      let prf = extractPrfOutput(credential);
      if (!prf && kind === "create") {
        // Some authenticators only reveal PRF results during assertion; ask
        // for one immediately against the passkey that was just created.
        const assertion = (await navigator.credentials.get(buildPasskeyGetOptions())) as PublicKeyCredential | null;
        prf = assertion ? extractPrfOutput(assertion) : null;
      }
      if (!prf) {
        this.busy = false;
        this.errorMessage = BitLoginAuthElement.PRF_UNSUPPORTED_MESSAGE;
        this.render();
        return null;
      }
      return deriveCredentialFromPrf(prf);
    } catch (err) {
      this.busy = false;
      this.errorMessage =
        err instanceof Error && err.name === "NotAllowedError"
          ? "The passkey prompt was cancelled or timed out."
          : err instanceof Error
            ? err.message
            : String(err);
      this.render();
      return null;
    }
  }

  /** "Use my passkey": sign in, or route a passkey with no account here into
   *  first-time setup with the credential it derived. */
  private async handlePasskeyAuth(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    const parts = await this.runPasskeyCeremony("get");
    if (!parts) return;
    try {
      const result = await this.worker.login({ loginName: parts.loginName, password: parts.password });
      this.loginName = parts.loginName;
      this.session = {
        publicKey: result.everydayPublicKey,
        npub: encodeNpub(result.everydayPublicKey),
        accountId: result.accountId,
        method: "bitlogin"
      };
      this.sessionWarnings = [result.rollbackWarning, result.relayDisagreementWarning].filter((w): w is string => !!w);
      this.busy = false;
      this.passkeySession = true;
      this.noteSignerClaim(this.claimSigner());
      this.dispatchLogin();
      this.flashSuccess("dashboard", "Signed in");
    } catch (err) {
      if (err instanceof Error && err.name === "AccountNotFoundError") {
        // A perfectly good passkey with no account on this site yet.
        this.pendingPasskey = parts;
        this.busy = false;
        this.goto("passkey-create");
        return;
      }
      if (err instanceof Error && err.name === "RollbackDetectedError") {
        this.pendingRollback = { kind: "login", loginName: parts.loginName, password: parts.password };
        this.rollbackMessage = err.message;
        this.busy = false;
        this.goto("rollback-confirm");
        return;
      }
      this.fail(err);
    }
  }

  /** "Create a new passkey": mint it, then set up (or rejoin) its account. */
  private async handlePasskeyRegisterCeremony(): Promise<void> {
    if (this.busy) return;
    this.setBusy(true);
    const parts = await this.runPasskeyCeremony("create");
    if (!parts) return;
    this.pendingPasskey = parts;
    this.busy = false;
    this.goto("passkey-create");
  }

  /** Registers the account a passkey-derived credential unlocks (fresh
   *  identity, or wrapping an imported key, §SF10). Tier B2 phrase handling:
   *  ceremony deferred behind the dashboard card. */
  private async runPasskeyRegistration(): Promise<void> {
    const pending = this.pendingPasskey;
    if (!pending) return;
    this.setBusy(true);
    try {
      const result = await this.worker.register({
        loginName: pending.loginName,
        password: pending.password,
        importKey: this.importKey || undefined
      });
      this.importKey = "";
      this.importPreviewNpub = "";
      this.pendingPasskey = null;
      this.loginName = pending.loginName;
      this.recoveryPhrase = result.recoveryPhrase;
      const words = this.recoveryPhrase.split(" ");
      const indices = pickRandomIndices(words.length, 3);
      this.confirmSlots = indices.map((index) => ({ index, value: "" }));
      this.session = {
        publicKey: result.everydayPublicKey,
        npub: encodeNpub(result.everydayPublicKey),
        accountId: result.accountId,
        method: "bitlogin"
      };
      this.sessionWarnings = [];
      void this.worker.publishProfileAndRelayLists({
        name: this.loginName,
        generalRelays: this.vaultRelayUrls,
        dmRelays: this.vaultRelayUrls
      });
      this.busy = false;
      this.passkeySession = true;
      this.securePhrasePending = true;
      this.noteSignerClaim(this.claimSigner());
      this.dispatchLogin();
      this.flashSuccess("dashboard", "Account created");
    } catch (err) {
      if (err instanceof Error && err.name === "AccountAlreadyExistsError") {
        // This passkey already has an account here (an earlier setup finished
        // after all) -- just sign in with the same derived credential.
        this.pendingPasskey = null;
        this.busy = false;
        void this.handlePasskeySignInWith(pending);
        return;
      }
      this.fail(err);
    }
  }

  private async handlePasskeySignInWith(parts: { loginName: string; password: string }): Promise<void> {
    this.passkeySession = true;
    await this.attemptLogin(parts.loginName, parts.password);
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
    this.goto("create-credential");
  }

  private async handleCreateCredentialSubmit(): Promise<void> {
    // Read the checkbox before password validation so a rejected password doesn't also
    // silently un-check it on the retry render.
    this.savedCheckbox = (this.root.querySelector("#saved-check") as HTMLInputElement | null)?.checked ?? false;
    const password = this.generatedCredential;
    if (!this.savedCheckbox) {
      this.errorMessage = "Please confirm you saved your password before continuing.";
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
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId, method: "bitlogin" };
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
    if (this.securePhrasePending) {
      // Tier B2 deferred ceremony (§CO4): the session already exists and
      // bitlogin-login already fired at registration -- this just retires
      // the "Secure your account" card.
      this.securePhrasePending = false;
      this.flashSuccess("dashboard", "Recovery phrase secured");
      return;
    }
    this.sessionWarnings = [];
    this.noteSignerClaim(this.claimSigner());
    this.dispatchLogin();
    this.flashSuccess("dashboard", "Account created");
  }

  private async handleLoginSubmit(): Promise<void> {
    const loginName = this.field("loginName").trim().toLowerCase();
    const password = this.field("password");
    this.passkeySession = false; // typed credentials: the user is their own password manager here
    await this.attemptLogin(loginName, password);
  }

  /**
   * "Use your Nostr extension instead" (§LM4) -- asks the detected extension for its
   * public key, then shows it for the user to confirm before any session exists. The
   * provider reference is snapshotted here so a later change of window.nostr occupant
   * can never swap the backend mid-session.
   */
  private async handleExtensionSignIn(): Promise<void> {
    if (this.busy) return;
    const provider = detectForeignNip07Provider();
    if (!provider) {
      this.errorMessage = "No Nostr signer extension was found in this browser.";
      this.render();
      return;
    }
    this.setBusy(true);
    try {
      const signer = new Nip07Signer(provider);
      const publicKey = await signer.getPublicKey();
      this.pendingExtensionSigner = signer;
      this.extensionPreviewPubkey = publicKey;
      this.extensionPreviewNpub = encodeNpub(publicKey);
      this.busy = false;
      this.goto("extension-confirm");
    } catch (err) {
      this.pendingExtensionSigner = null;
      this.fail(err);
    }
  }

  /** The user confirmed the npub the extension reported is theirs; grant the thin
   * session (§LM7). Deliberately no claimSigner(): the extension owns window.nostr
   * and this session's whole point is to use it, not replace it (§LM4). */
  private handleExtensionConfirm(): void {
    const signer = this.pendingExtensionSigner;
    if (!signer || !this.extensionPreviewPubkey) {
      this.goto("welcome");
      return;
    }
    this.pendingExtensionSigner = null;
    this.altSigner = signer;
    this.session = { publicKey: this.extensionPreviewPubkey, npub: this.extensionPreviewNpub, method: "nip07" };
    this.sessionWarnings = [];
    // A wallet request that was waiting on sign-in expected a BitLogin account; an
    // extension session has no vault, so settle it honestly instead of letting the
    // dashboard hook run it into worker calls that cannot succeed (§LM7).
    if (this.vaultRequest) this.finishVaultRequest(null);
    this.dispatchLogin();
    this.flashSuccess("dashboard", "Signed in");
  }

  /**
   * nostrconnect leg of the remote-signer flow (§LM5.1): the worker mints an
   * ephemeral client key and a secret, we show the resulting URI as a QR for a
   * phone signer to scan, and the worker listens for whichever signer echoes
   * the secret. Runs alongside the paste form -- whichever leg completes first
   * wins, and the worker refuses a superseded listen.
   */
  private async startNostrconnect(): Promise<void> {
    try {
      const { uri } = await this.worker.nip46NostrconnectStart({
        appName: window.location.hostname || "BitLogin"
      });
      if (this.screen !== "bunker-connect") return; // user navigated away
      this.bunkerConnectUri = uri;
      this.render();
      const { userPubkey } = await this.worker.nip46NostrconnectAwait();
      if (this.screen !== "bunker-connect" || this.pendingBunker) {
        // The paste leg (or another flow entirely) won while we listened.
        return;
      }
      this.adoptBunkerPreview(userPubkey);
    } catch (err) {
      // Only worth surfacing if the user is still looking at this screen and
      // nothing else succeeded -- a superseded or abandoned listen is expected.
      if (this.screen === "bunker-connect" && !this.pendingBunker && !this.session) {
        this.bunkerConnectUri = "";
        this.fail(err);
      }
    }
  }

  /** bunker:// paste leg (§LM5.1). */
  private async handleBunkerSubmit(): Promise<void> {
    const uri = this.field("bunkerUri").trim();
    if (!uri) {
      this.errorMessage = "Paste a bunker:// address first.";
      this.render();
      return;
    }
    this.setBusy(true);
    this.bunkerAuthUrl = "";
    try {
      const { userPubkey } = await this.worker.nip46Connect({ uri });
      this.busy = false;
      this.adoptBunkerPreview(userPubkey);
    } catch (err) {
      this.fail(err);
    }
  }

  private adoptBunkerPreview(userPubkey: string): void {
    this.pendingBunker = { userPubkey, npub: encodeNpub(userPubkey) };
    this.bunkerConnectUri = "";
    this.bunkerAuthUrl = "";
    this.errorMessage = undefined;
    this.goto("bunker-confirm");
  }

  /** The user confirmed the identity their remote signer reported (§LM5). */
  private handleBunkerConfirm(): void {
    const pending = this.pendingBunker;
    if (!pending) {
      this.goto("welcome");
      return;
    }
    this.pendingBunker = null;
    this.altSigner = new Nip46Signer(this.worker, pending.userPubkey);
    this.session = { publicKey: pending.userPubkey, npub: pending.npub, method: "nip46" };
    this.sessionWarnings = [];
    if (this.vaultRequest) this.finishVaultRequest(null);
    // Unlike NIP-07 there is no extension owning window.nostr here -- the
    // element-routed provider IS this session's public surface, so claim the
    // slot (best-effort, §LM4's claim semantics unchanged).
    this.noteSignerClaim(this.claimSigner());
    this.dispatchLogin();
    this.flashSuccess("dashboard", "Signed in");
  }

  /**
   * Called once per connectedCallback, right after "configure" -- restores whatever
   * a prior login/register/rotate cached locally (§21), so a page reload lands
   * straight on the dashboard instead of asking for the login name + password
   * again. Silent by design: no flashSuccess() stamp (that's reserved for a
   * deliberate action the user just took) and no offerToSaveCredential (there's
   * no password in hand to save). If the welcome screen already rendered by the
   * time this resolves, goto() just re-renders over it -- a brief flash, not a
   * correctness issue.
   */
  private async tryRestoreSession(): Promise<void> {
    try {
      const result = await this.worker.restoreSession();
      if (!result.restored || !result.everydayPublicKey) return;
      this.session = {
        publicKey: result.everydayPublicKey,
        npub: encodeNpub(result.everydayPublicKey),
        accountId: result.accountId,
        method: "bitlogin"
      };
      this.noteSignerClaim(this.claimSigner());
      this.dispatchLogin();
      this.goto("dashboard");
    } catch {
      // No cached session, or the worker/IndexedDB isn't available -- fall
      // through to the normal welcome screen already rendered.
    }
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
      this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId, method: "bitlogin" };
      this.sessionWarnings = [result.rollbackWarning, result.relayDisagreementWarning].filter((w): w is string => !!w);
      this.busy = false;
      this.noteSignerClaim(this.claimSigner());
      this.dispatchLogin();
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
    this.session = { publicKey: result.everydayPublicKey, npub: encodeNpub(result.everydayPublicKey), accountId: result.accountId, method: "bitlogin" };
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
    const newPassword = this.newCredentialAfterRecovery;
    this.setBusy(true);
    await this.worker.completeRecovery({ newLoginName, newPassword });
    this.loginName = newLoginName;
    this.busy = false;
    this.sessionWarnings = [];
    this.noteSignerClaim(this.claimSigner());
    this.dispatchLogin();
    this.flashSuccess("dashboard", "Account recovered");
    void this.offerToSaveCredential(newLoginName, newPassword);
  }

  private async handleChangePasswordSubmit(): Promise<void> {
    const oldPassword = this.field("oldPassword");
    const newPassword = this.changePasswordNewCredential;
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
    // this.signEvent, not this.worker.signEvent: routes to the extension for a NIP-07 session.
    try {
      const event = await this.signEvent({ kind: 1, content: `Hello from BitLogin at ${new Date().toISOString()}` });
      this.lastSignedEventJson = JSON.stringify(event, null, 2);
      this.render();
    } catch (err) {
      // An extension can decline or time out where the worker path couldn't (§LM4).
      this.fail(err);
    }
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

  /** Screen header with an icon back button, replacing the dangling "Back"
   *  link every pre-auth screen used to end with -- back navigation belongs
   *  where the eye starts, not after the form. */
  private renderScreenHead(title: string, backAction = "goto-welcome"): string {
    return `
      <div class="screen-head">
        <button class="icon-back" type="button" data-action="${backAction}" aria-label="Back">${CHEVRON_LEFT}</button>
        <h2>${title}</h2>
      </div>`;
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
      case "welcome": {
        // Username/password is the primary method (§LM9.1, resolved:
        // password-first); every alternative path lives behind the collapsed
        // "More sign-in options" disclosure below the two primary buttons.
        const optionRow = (action: string, icon: string, title: string, sub: string, disabled = false) => `
          <button class="option-row" type="button" data-action="${action}" ${disabled ? "disabled" : ""}>
            <span class="option-icon">${icon}</span>
            <span class="option-text"><span>${title}</span><span class="option-sub">${sub}</span></span>
          </button>`;
        const extensionRow = detectForeignNip07Provider()
          ? optionRow(
              "extension-signin",
              OPTION_ICONS.extension,
              this.busy ? "Asking your extension…" : "Nostr extension",
              "Use the signer extension in this browser",
              this.busy
            )
          : "";
        // Passkey rail (docs/passkey-login.md): zero site setup, zero servers
        // -- the sub-label states where the custody actually lives.
        const passkeyRow = passkeySupported()
          ? optionRow(
              "goto-passkey",
              OPTION_ICONS.passkey,
              "Continue with a passkey",
              "Kept in your phone or browser's password manager"
            )
          : "";
        const optionsMenu = this.moreOptionsOpen
          ? `<div class="option-menu">
              <div class="option-group-label">Use an account you already have</div>
              ${passkeyRow}
              ${extensionRow}
              ${optionRow("goto-bunker", OPTION_ICONS.remote, "Remote signer", "Scan a code with Amber or another signer app")}
              ${optionRow("goto-import", OPTION_ICONS.importKey, "Import a Nostr key", "Wrap an existing identity in a login name and password")}
              ${optionRow("goto-recover", OPTION_ICONS.recover, "Recover account", "Sign back in with your 12-word recovery phrase")}
            </div>`
          : "";
        return `
          ${this.renderBrandLockup()}
          <p class="sub">A portable Nostr identity with a familiar login name and password.</p>
          ${this.renderError()}
          <button class="primary" data-action="goto-login">Sign in</button>
          <button class="secondary" data-action="goto-create">Create account</button>
          <button class="options-toggle ${this.moreOptionsOpen ? "open" : ""}" type="button" data-action="toggle-more" aria-expanded="${this.moreOptionsOpen}">
            More sign-in options ${CHEVRON_DOWN}
          </button>
          ${optionsMenu}
        `;
      }

      case "passkey":
        return `
          ${this.renderScreenHead("Use a passkey")}
          <p class="sub">A passkey kept in your phone, browser, or security key — usually synced by your Google or Apple account. This site needs no setup and runs no server; the passkey itself unlocks your Nostr account.</p>
          ${this.renderError()}
          <button class="primary" type="button" data-action="passkey-auth" ${this.busy ? "disabled" : ""}>
            ${this.busy ? '<span class="spinner"></span>Waiting for your passkey…' : "Use my passkey"}
          </button>
          <button class="secondary" type="button" data-action="passkey-register" ${this.busy ? "disabled" : ""}>Create a new passkey</button>
          <p class="small">First time here? "Use my passkey" also works — if this passkey has no account on this site yet, you'll be taken to set one up.</p>
        `;

      case "passkey-create":
        return `
          ${this.renderScreenHead("Almost there")}
          <p class="sub">Your passkey is ready — it will unlock this account from now on, with nothing stored anywhere else. Choose how to set up the account's identity:</p>
          ${this.renderError()}
          <button class="primary" type="button" data-action="passkey-new" ${this.busy ? "disabled" : ""}>
            ${this.busy ? '<span class="spinner"></span>Creating your account…' : "Create a fresh identity"}
          </button>
          <button class="secondary" type="button" data-action="passkey-import" ${this.busy ? "disabled" : ""}>I already have a Nostr key</button>
          <p class="small">Either way you can later take full control of the account — or leave for any other Nostr app — without losing your identity.</p>
        `;

      case "extension-confirm":
        return `
          ${this.renderScreenHead("Sign in with your extension")}
          <p class="sub">Your Nostr signer extension reports this identity:</p>
          <div class="credential-box">${escapeHtml(this.extensionPreviewNpub)}</div>
          <p class="small">Check this is the profile you expect — extensions can hold more than one. BitLogin never sees this identity's private key; your extension signs on its behalf. This session lasts until you log out or leave the page, and BitLogin account features (wallet connections, password rotation, recovery) stay with BitLogin accounts.</p>
          ${this.renderError()}
          <button class="primary" type="button" data-action="extension-continue">This is me — continue</button>
        `;

      case "bunker-connect": {
        const authNotice = this.bunkerAuthUrl
          ? `<div class="notice info">Your signer asks you to approve this connection first.
               <a href="${escapeHtml(this.bunkerAuthUrl)}" target="_blank" rel="noopener noreferrer">Open the approval page</a>, then return here.</div>`
          : "";
        const qrBlock = this.bunkerConnectUri
          ? `<div class="qr-wrap" aria-live="polite">${renderQrSvg(this.bunkerConnectUri, "Nostr Connect QR code")}</div>
             <button class="secondary" type="button" data-action="copy-bunker-uri">Copy connection code</button>
             <p class="small">Waiting for your signer to connect…</p>`
          : this.errorMessage
            ? `<button class="secondary" type="button" data-action="goto-bunker">Generate a new code</button>`
            : `<p class="sub"><span class="spinner"></span>Preparing connection code…</p>`;
        return `
          ${this.renderScreenHead("Use a remote signer")}
          <p class="sub">Scan with a signer app on your phone (Amber, nsec.app, …). Your key stays in the signer; BitLogin only requests signatures.</p>
          ${this.renderError()}
          ${authNotice}
          ${qrBlock}
          <div class="divider"></div>
          <form data-form="bunker-connect">
            <label for="bunkerUri">Or paste a bunker:// address</label>
            <input type="password" name="bunkerUri" id="bunkerUri" autocomplete="off" placeholder="bunker://…" />
            <button class="secondary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Contacting your signer…' : "Connect"}
            </button>
          </form>
        `;
      }

      case "bunker-confirm":
        return `
          ${this.renderScreenHead("Remote signer connected")}
          <p class="sub">Your signer reports this identity:</p>
          <div class="credential-box">${escapeHtml(this.pendingBunker?.npub ?? "")}</div>
          <p class="small">Check this is the profile you expect. Your private key stays in your signer — each signature is requested over relays, and your signer can require approval or be disconnected at any time. This session lasts until you log out or leave the page; BitLogin account features (wallet connections, password rotation, recovery) stay with BitLogin accounts.</p>
          ${this.renderError()}
          <button class="primary" type="button" data-action="bunker-continue">This is me — continue</button>
        `;

      case "import-key": {
        const previewed = !!this.importPreviewNpub;
        return `
          ${this.renderScreenHead("Import an existing Nostr key")}
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
        `;
      }

      case "create-name":
        return `
          ${this.renderScreenHead(this.importKey ? "Set up your login" : "Create your BitLogin")}
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
        `;

      case "create-credential": {
        const submitLabel = this.busy
          ? `<span class="spinner"></span>${this.importKey ? "Importing…" : "Creating account…"}`
          : this.importKey
            ? "Import account"
            : "Create account";

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
          ${this.renderScreenHead("Sign in")}
          ${this.renderError()}
          <form data-form="login">
            <label for="loginName">Login name</label>
            <input type="text" name="loginName" id="loginName" autocomplete="username" required />
            <label for="password">Password</label>
            <input type="password" name="password" id="password" autocomplete="current-password" required />
            <div class="field-hint">
              <button class="link-inline" type="button" data-action="goto-recover">Forgot password?</button>
            </div>
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.busy ? '<span class="spinner"></span>Signing in…' : "Sign in"}
            </button>
          </form>
        `;

      case "recover-phrase":
        return `
          ${this.renderScreenHead("Recover with phrase")}
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
          <p class="sub">Now set a new login name. BitLogin generated a new high-entropy password for this account.</p>
          <div class="credential-box" id="credential-box">${escapeHtml(this.newCredentialAfterRecovery)}</div>
          <button class="secondary" type="button" data-action="copy-credential">Copy generated password</button>
          ${this.renderError()}
          <form data-form="recover-new-credentials">
            <label for="newLoginName">New login name</label>
            <input type="text" name="newLoginName" id="newLoginName" autocomplete="off" required />
            <button class="primary" type="submit" ${this.busy ? "disabled" : ""}>${submitLabel}</button>
          </form>
        `;
      }

      case "dashboard": {
        // Alternative-method sessions are signer-only (§LM7): the account actions
        // below the divider are all account-backed (vault, rotation, export) and have
        // no meaning without a BitLogin account, so they are omitted rather than left
        // to fail.
        const method = this.session?.method ?? "bitlogin";
        const altNote =
          method === "nip07"
            ? "Signed in through your Nostr extension."
            : "Signed in through your remote signer — each signature is requested from it over relays.";
        const accountActions =
          method !== "bitlogin"
            ? `<p class="small">${altNote} Wallet connections, password rotation, and identity export are features of BitLogin accounts — create one to get your settings on every device.</p>`
            : `
          <button class="secondary" type="button" data-action="goto-vault-manage">Wallet connections</button>
          <button class="secondary" type="button" data-action="goto-change-password">Rotate password</button>
          <button class="secondary" type="button" data-action="goto-export">Export identity</button>`;
        // Tier B2 (§CO4): the phrase exists only in this session's memory
        // until the user claims it -- the one nudge that stays until acted on.
        const securePhraseCard = this.securePhrasePending
          ? `<div class="notice warn">Secure your account: your recovery phrase is available <strong>only during this session</strong>. Save it now and your account stays yours even if you lose your passkey.
               <button class="link-inline" type="button" data-action="goto-confirm-phrase">View and save it</button></div>`
          : "";
        const passkeyStanding = this.passkeySession
          ? `<p class="small">Signed in with a passkey — it unlocks this account from your device's password manager; your identity lives on the open Nostr network.</p>`
          : "";
        return `
          <h2>Signed in</h2>
          ${securePhraseCard}
          ${this.renderWarnings()}
          <p class="pubkey">${escapeHtml(this.session?.npub ?? "")}</p>
          ${passkeyStanding}
          ${this.renderError()}
          <button class="secondary" type="button" data-action="sign-test-event">Sign a test event</button>
          ${
            this.lastSignedEventJson
              ? `<div class="credential-box" style="white-space:pre-wrap">${escapeHtml(this.lastSignedEventJson)}</div>`
              : ""
          }
          <div class="divider"></div>
          ${accountActions}
          <button class="secondary" type="button" data-action="logout">Log out</button>
        `;
      }

      case "vault-consent": {
        const request = this.vaultRequest;
        const candidate = this.vaultCandidate;
        if (!request || !candidate) return `<div class="notice error">No wallet request is in progress.</div>`;
        const connectedOn = new Date(candidate.createdAt * 1000).toLocaleDateString();
        return `
          <h2>Share a wallet with ${escapeHtml(request.appName)}?</h2>
          ${request.reason ? `<p class="sub">Reason given: ${escapeHtml(request.reason)}</p>` : ""}
          ${this.renderError()}
          <div class="credential-box">
            <strong>${escapeHtml(candidate.label)}</strong><br />
            Connected ${escapeHtml(connectedOn)} · wallet ${escapeHtml((candidate.walletPubkey ?? "").slice(0, 10))}…
          </div>
          <div class="notice info">${escapeHtml(request.appName)} will receive this connection and can spend within the budget your wallet enforces, until you revoke it from Wallet connections.</div>
          <button class="primary" type="button" data-action="vault-approve" ${this.busy ? "disabled" : ""}>
            ${this.busy ? '<span class="spinner"></span>Sharing…' : "Use this wallet"}
          </button>
          <button class="secondary" type="button" data-action="vault-different">Use a different wallet</button>
          <button class="link" type="button" data-action="vault-cancel">Cancel</button>
        `;
      }

      case "vault-import": {
        const request = this.vaultRequest;
        if (!request) return `<div class="notice error">No wallet request is in progress.</div>`;
        const unsavedNotice = this.vaultUnsaved
          ? `<div class="notice warn">${
              this.vaultUnsavedReason === "no-vault"
                ? "This account predates the Connection Vault, so the connection will be handed to the app but not saved to your account. Enable the vault from your account manager (recovery phrase required) to make wallets portable."
                : "Sign in again to save connections to your account — until then the connection will be handed to the app but not saved."
            }</div>`
          : "";
        return `
          <h2>Connect a wallet for ${escapeHtml(request.appName)}</h2>
          ${request.reason ? `<p class="sub">Reason given: ${escapeHtml(request.reason)}</p>` : ""}
          ${unsavedNotice}
          ${this.renderError()}
          <button class="primary" type="button" data-action="vault-bc" ${this.busy ? "disabled" : ""}>
            ${this.busy ? '<span class="spinner"></span>Waiting for your wallet…' : "Connect a wallet"}
          </button>
          <div class="divider"></div>
          <form data-form="vault-import">
            <label for="vaultUri">Or paste an NWC connection</label>
            <input type="password" name="vaultUri" id="vaultUri" autocomplete="off" placeholder="nostr+walletconnect://…" />
            <label for="vaultLabel">Name this connection</label>
            <input type="text" name="vaultLabel" id="vaultLabel" autocomplete="off" maxlength="120" value="${escapeHtml(`${request.appName} wallet`)}" />
            <button class="secondary" type="submit" ${this.busy ? "disabled" : ""}>
              ${this.vaultUnsaved ? "Share without saving" : "Save and share"}
            </button>
          </form>
          <div class="notice info">Set a spending budget on the wallet's own authorization page — the wallet is the only place a budget is actually enforced.</div>
          <button class="link" type="button" data-action="vault-cancel">Cancel</button>
        `;
      }

      case "vault-offer": {
        const offer = this.vaultOffer;
        if (!offer) return `<div class="notice error">No wallet offer is in progress.</div>`;
        return `
          <h2>Save this wallet to your BitLogin?</h2>
          <p class="sub">${escapeHtml(offer.appName)} just connected a wallet on this device. Saved to your BitLogin, the connection follows you — on a new device it's one tap instead of another paste.</p>
          ${this.renderError()}
          <label for="vaultOfferLabel">Name this connection</label>
          <input type="text" name="vaultOfferLabel" id="vaultOfferLabel" autocomplete="off" maxlength="120" value="${escapeHtml(offer.label)}" />
          <button class="primary" type="button" data-action="vault-offer-save" ${this.busy ? "disabled" : ""}>
            ${this.busy ? '<span class="spinner"></span>Saving…' : "Save to BitLogin"}
          </button>
          <button class="link" type="button" data-action="vault-offer-decline" ${this.busy ? "disabled" : ""}>No thanks — keep it on this device only</button>
          <div class="notice info">Stored encrypted on your account; ${escapeHtml(offer.appName)} keeps working either way. Remove it any time from Wallet connections.</div>
        `;
      }

      case "vault-manage": {
        const list = this.vaultConnections;
        const rows =
          list === null
            ? `<p class="sub">Loading…</p>`
            : list.length === 0
              ? `<p class="sub">No connections stored yet. They're added when you connect a wallet inside an app.</p>`
              : list
                  .map(
                    (c) => `
          <div class="credential-box">
            <strong>${escapeHtml(c.label)}</strong> <span class="sub">(${escapeHtml(c.connectionType)})</span><br />
            ${c.origin ? `Linked to ${escapeHtml(c.origin)}` : "Not linked to an app"}
            <div>
              ${c.origin ? `<button class="link" type="button" data-action="vault-unbind" data-id="${escapeHtml(c.connectionId)}" ${this.busy ? "disabled" : ""}>Revoke app access</button>` : ""}
              <button class="link" type="button" data-action="vault-delete" data-id="${escapeHtml(c.connectionId)}" ${this.busy ? "disabled" : ""}>Remove from BitLogin</button>
            </div>
          </div>`
                  )
                  .join("");
        return `
          <h2>Wallet connections</h2>
          <p class="sub">Connections your apps use, stored encrypted on your account and restored on any device you sign in to.</p>
          ${this.renderError()}
          ${this.vaultIntegrityWarnings.map((warning) => `<div class="notice warn">${escapeHtml(warning)}</div>`).join("")}
          ${rows}
          <div class="notice info">"Remove from BitLogin" deletes the stored copy only — the connection itself keeps working for any app that already has it. To revoke spending authority, delete the connection inside your wallet app.</div>
          <button class="link" data-action="goto-dashboard">Back</button>
        `;
      }

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
          ${
            this.passkeySession
              ? `<div class="notice info">This takes over from passkey sign-in: your passkey stops unlocking this account, and from then on you sign in with the new password below — you hold it, nobody else. This is the graduation step.</div>`
              : ""
          }
          <p class="sub">Your old password's capsule will be tombstoned and a deletion request issued. This does not erase copies an attacker may already have downloaded, and a relay that hasn't processed the deletion may keep serving the old password's capsule until a device that has already seen the new generation refuses it.</p>
          <div class="credential-box" id="credential-box">${escapeHtml(this.changePasswordNewCredential)}</div>
          <button class="secondary" type="button" data-action="copy-credential">Copy generated password</button>
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

/**
 * Picks `count` distinct indices in [0, max) for the write-it-down confirmation
 * quiz.
 *
 * This is not a secret and leaks no entropy — the recovery phrase itself comes
 * from randomEntropy128, and an attacker who cannot see the phrase gains
 * nothing from predicting which words get quizzed. It uses the CSPRNG anyway so
 * that `Math.random` can be banned outright in this package (see
 * .semgrep.yml). A ban with a standing exception is where the next real misuse
 * hides.
 */
function pickRandomIndices(max: number, count: number): number[] {
  const pool = Array.from({ length: max }, (_, i) => i);
  const chosen: number[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    chosen.push(pool.splice(randomUniformInt(pool.length), 1)[0]!);
  }
  return chosen.sort((a, b) => a - b);
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/gu, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
