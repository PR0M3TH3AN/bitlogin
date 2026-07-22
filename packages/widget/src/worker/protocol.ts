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
};

export type WorkerAction = keyof WorkerActionMap;
