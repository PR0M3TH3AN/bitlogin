/** Request/response envelope for the main-thread <-> crypto-worker RPC channel. */
import type { NostrEvent, NostrTag } from "@bitlogin/core/nostr";
import type { RecoveryExportFile } from "@bitlogin/core/account";

export interface WorkerRequest<TAction extends string = string, TPayload = unknown> {
  id: string;
  action: TAction;
  payload: TPayload;
}

export type WorkerResponse<TResult = unknown> =
  | { id: string; ok: true; result: TResult }
  | { id: string; ok: false; error: string; errorName?: string };

export interface ConfigurePayload {
  vaultRelayUrls?: string[];
  discoveryRelayUrls?: string[];
}

export interface RegisterPayload {
  loginName: string;
  password: string;
  /** When present, import this existing identity (nsec or 64-char hex) instead of generating one (§SF10). */
  importKey?: string;
}
export interface RegisterResult {
  recoveryPhrase: string;
  everydayPublicKey: string;
  recoveryPublicKey: string;
  accountId: string;
  imported: boolean;
  credentialEventId: string;
  recoveryEventId: string;
}

export interface PreviewImportKeyPayload {
  nsecOrHex: string;
}
export interface PreviewImportKeyResult {
  everydayPublicKey: string;
  npub: string;
}

export interface LoginPayload {
  loginName: string;
  password: string;
  /** See `LoginParams.acknowledgeRollback` in `@bitlogin/core/account` (§16.2 step 6). */
  acknowledgeRollback?: boolean;
}
export interface LoginResult {
  everydayPublicKey: string;
  accountId: string;
  generation: number;
  rollbackWarning?: string;
  relayDisagreementWarning?: string;
}

export interface RecoverPayload {
  phrase: string;
  /**
   * A previously downloaded recovery export file (§19.5), parsed on the main thread and
   * passed through as-is. Used as a fallback alongside the live relay read when every
   * configured relay is unreachable or has lost the capsule -- never a replacement for the
   * phrase, which the file never contains.
   */
  offlineExportFile?: RecoveryExportFile;
}
export interface RecoverResult {
  everydayPublicKey: string;
  accountId: string;
  generalRelays: string[];
  dmRelays: string[];
  chainWarning?: string;
}

export interface CompleteRecoveryPayload {
  newLoginName: string;
  newPassword: string;
}
export interface CompleteRecoveryResult {
  locatorPublicKey: string;
  credentialEventId: string;
  refreshedRecoveryEventId: string;
}

export interface ChangePasswordPayload {
  loginName: string;
  oldPassword: string;
  newPassword: string;
  /** See `ChangePasswordParams.acknowledgeRollback` in `@bitlogin/core/account` (§16.2 step 6). */
  acknowledgeRollback?: boolean;
}
export interface ChangePasswordResult {
  newLocatorPublicKey: string;
  newGeneration: number;
  tombstoneAcknowledgedCount: number;
  deletionAcknowledgedCount: number;
}

export interface PublishProfilePayload {
  name?: string;
  about?: string;
  picture?: string;
  generalRelays: string[];
  dmRelays: string[];
}
export interface PublishProfileResult {
  profilePublished: boolean;
  relayListAcknowledgedCount: number;
  dmRelayListAcknowledgedCount: number;
  /** True when an existing kind:0 profile was already found for this identity, so BitLogin left it untouched (§28.1). */
  profileSkippedExisting: boolean;
  /** True when an existing NIP-65 relay list was already found and left untouched (§28.1). */
  relayListSkippedExisting: boolean;
  /** True when an existing NIP-17 DM relay list was already found and left untouched (§28.1). */
  dmRelayListSkippedExisting: boolean;
}

export interface SignEventPayload {
  kind: number;
  tags?: NostrTag[];
  content: string;
  created_at?: number;
}

export interface Nip44EncryptPayload {
  peerPublicKey: string;
  plaintext: string;
}
export interface Nip44DecryptPayload {
  peerPublicKey: string;
  payload: string;
}

export interface Nip04EncryptPayload {
  peerPublicKey: string;
  plaintext: string;
}
export interface Nip04DecryptPayload {
  peerPublicKey: string;
  payload: string;
}

export interface ExportIdentityResult {
  nsec: string;
  npub: string;
}

export interface RepairReplicasResult {
  credentialAcknowledgedCount: number;
  recoveryAcknowledgedCount: number;
  relaysTried: number;
}

export interface SessionStatusResult {
  unlocked: boolean;
  everydayPublicKey?: string;
}

export interface RestoreSessionResult {
  restored: boolean;
  everydayPublicKey?: string;
  accountId?: string;
}

// ---- Connection Vault (connection-vault.md §12, phase D; reveal mode) ----

export interface VaultStatusResult {
  /** True when this session holds the vault root and can use connections. */
  enabled: boolean;
  /** Set when enabled=false: the account predates the vault ("no-vault") or
   *  the root simply wasn't in the restored cache and a fresh sign-in would
   *  load it ("stale-cache"). */
  reason?: "no-vault" | "stale-cache";
  vaultPublicKey?: string;
}

/** Everything the UI needs and nothing an app must not see: no secrets. */
export interface VaultConnectionSummary {
  connectionId: string;
  connectionType: string;
  label: string;
  state: string;
  origin: string | null;
  createdAt: number;
  updatedAt: number;
  /** NWC display metadata (non-secret). */
  walletPubkey?: string;
  relayCount?: number;
}

export interface VaultListResult {
  connections: VaultConnectionSummary[];
  rollbackWarnings: string[];
  /** Signed records that could not be decrypted or validated and were omitted. */
  unreadable: string[];
  /** True when at least one relay filled the fetch page, so records may be missing. */
  truncated: boolean;
  /** True when enough configured relays participated in the read. */
  quorumMet: boolean;
}

export interface VaultSaveNwcPayload {
  uri: string;
  label: string;
}

/** No origin field: the worker derives its own (see selfOrigin). */
export type VaultFindForOriginPayload = Record<string, never>;

export interface VaultRevealNwcPayload {
  connectionId: string;
}
export interface VaultRevealNwcResult {
  uri: string;
}

export interface VaultSetBindingPayload {
  connectionId: string;
  origin: string | null;
}

export interface VaultDeletePayload {
  connectionId: string;
}

export interface VaultOfferCheckPayload {
  uri: string;
}
/** duplicate=true means the same wallet+secret is already stored; the worker
 *  has silently refreshed its origin binding, and no consent UI is needed —
 *  nothing new entered the vault. */
export interface VaultOfferCheckResult {
  duplicate: boolean;
  connection?: VaultConnectionSummary;
}

// ---- NIP-46 remote-signer session (docs/login-methods.md §LM5) ----
// Memory-only: the ephemeral client key and Nip46Client live in the worker
// (§LM5.4) and vanish with it. Nothing below touches account/vault state.

export interface Nip46ConnectPayload {
  /** A bunker:// URI pasted by the user. */
  uri: string;
}
export interface Nip46ConnectResult {
  userPubkey: string;
}
export interface Nip46NostrconnectStartPayload {
  appName?: string;
}
export interface Nip46NostrconnectStartResult {
  /** The nostrconnect:// URI to show as a QR / copyable string. */
  uri: string;
}
export interface Nip46NostrconnectAwaitResult {
  userPubkey: string;
}

/**
 * Unsolicited worker -> main-thread frame. Distinguished from WorkerResponse
 * by having `notify` and no `id`; used where a request/response pair cannot
 * carry the information -- the signer's interactive-approval URL arrives in
 * the middle of a still-pending connect call.
 */
export interface WorkerNotification {
  notify: "nip46-auth-url";
  url: string;
}

export type WorkerActionMap = {
  configure: [ConfigurePayload, Record<string, never>];
  register: [RegisterPayload, RegisterResult];
  previewImportKey: [PreviewImportKeyPayload, PreviewImportKeyResult];
  login: [LoginPayload, LoginResult];
  recover: [RecoverPayload, RecoverResult];
  completeRecovery: [CompleteRecoveryPayload, CompleteRecoveryResult];
  changePassword: [ChangePasswordPayload, ChangePasswordResult];
  publishProfileAndRelayLists: [PublishProfilePayload, PublishProfileResult];
  getPublicKey: [Record<string, never>, { publicKey: string }];
  signEvent: [SignEventPayload, NostrEvent];
  nip44Encrypt: [Nip44EncryptPayload, { ciphertext: string }];
  nip44Decrypt: [Nip44DecryptPayload, { plaintext: string }];
  nip04Encrypt: [Nip04EncryptPayload, { ciphertext: string }];
  nip04Decrypt: [Nip04DecryptPayload, { plaintext: string }];
  exportIdentity: [Record<string, never>, ExportIdentityResult];
  buildRecoveryExport: [Record<string, never>, unknown];
  repairReplicas: [Record<string, never>, RepairReplicasResult];
  getSessionStatus: [Record<string, never>, SessionStatusResult];
  restoreSession: [Record<string, never>, RestoreSessionResult];
  logout: [Record<string, never>, Record<string, never>];
  vaultStatus: [Record<string, never>, VaultStatusResult];
  vaultList: [Record<string, never>, VaultListResult];
  vaultSaveNwc: [VaultSaveNwcPayload, VaultConnectionSummary];
  vaultFindForOrigin: [VaultFindForOriginPayload, { connection: VaultConnectionSummary | null }];
  vaultRevealNwc: [VaultRevealNwcPayload, VaultRevealNwcResult];
  vaultSetBinding: [VaultSetBindingPayload, VaultConnectionSummary];
  vaultDelete: [VaultDeletePayload, Record<string, never>];
  vaultOfferCheck: [VaultOfferCheckPayload, VaultOfferCheckResult];
  nip46Connect: [Nip46ConnectPayload, Nip46ConnectResult];
  nip46NostrconnectStart: [Nip46NostrconnectStartPayload, Nip46NostrconnectStartResult];
  nip46NostrconnectAwait: [Record<string, never>, Nip46NostrconnectAwaitResult];
  nip46SignEvent: [SignEventPayload, NostrEvent];
  nip46Nip44Encrypt: [Nip44EncryptPayload, { ciphertext: string }];
  nip46Nip44Decrypt: [Nip44DecryptPayload, { plaintext: string }];
  nip46Nip04Encrypt: [Nip04EncryptPayload, { ciphertext: string }];
  nip46Nip04Decrypt: [Nip04DecryptPayload, { plaintext: string }];
  nip46Disconnect: [Record<string, never>, Record<string, never>];
};

export type WorkerAction = keyof WorkerActionMap;
