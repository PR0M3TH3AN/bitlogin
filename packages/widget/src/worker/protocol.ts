/** Request/response envelope for the main-thread <-> crypto-worker RPC channel. */
import type { NostrEvent, NostrTag } from "@bitlogin/core/nostr";

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
  exportIdentity: [Record<string, never>, ExportIdentityResult];
  buildRecoveryExport: [Record<string, never>, unknown];
  repairReplicas: [Record<string, never>, RepairReplicasResult];
  getSessionStatus: [Record<string, never>, SessionStatusResult];
  logout: [Record<string, never>, Record<string, never>];
};

export type WorkerAction = keyof WorkerActionMap;
