/** Any-device password login (§16). */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { base64urlToBytes } from "../crypto/encoding.js";
import { derivePasswordKeys, normalizeLoginName } from "./normalize.js";
import { RelayPool } from "../nostr/pool.js";
import { readCredentialCapsule } from "./capsuleReader.js";
import { AccountNotFoundError } from "./errors.js";
import { getHighWaterMark, raiseHighWaterMark } from "./highWaterMark.js";
import { InMemoryKeyValueStore, type KeyValueStore } from "../storage/interface.js";
import type { NostrEvent } from "../nostr/event.js";

export interface LoginParams {
  loginName: string;
  password: string;
  vaultRelayUrls: string[];
  store?: KeyValueStore;
  timeoutMs?: number;
}

export interface LoginResult {
  everydayPrivateKey: Uint8Array;
  everydayPublicKey: string;
  recoveryPublicKey: string;
  accountId: string;
  generation: number;
  credentialEvent: NostrEvent;
  /** Set when the accepted generation is lower than one this device has previously seen (§16.2 step 6). */
  rollbackWarning?: string;
  /** Set when responsive relays disagree about which capsule is newest (§16.2 step 8). */
  relayDisagreementWarning?: string;
}

/**
 * Queries bootstrap relays for the password-derived locator's credential
 * capsule, decrypts it, and applies rollback resistance (§16.2). The caller
 * is responsible for closing this connection before opening any connection
 * that will carry everyday-identity traffic (§23.4) — capsule and
 * everyday-identity operations must never share a relay connection.
 */
export async function loginWithPassword(params: LoginParams): Promise<LoginResult> {
  const normalizedLoginName = normalizeLoginName(params.loginName);
  const { locatorPrivateKey, capsuleKey } = await derivePasswordKeys(params.password, normalizedLoginName);
  const locatorPublicKey = getPublicKeyHex(locatorPrivateKey);

  const pool = new RelayPool(params.vaultRelayUrls, { authPrivateKey: locatorPrivateKey });
  try {
    const result = await readCredentialCapsule(pool, locatorPublicKey, capsuleKey, params.timeoutMs);

    if (!result.quorumMet) throw new AccountNotFoundError("quorum-not-met");
    if (!result.best) {
      throw new AccountNotFoundError(result.candidates.length > 0 ? "no-valid-candidate" : "no-matching-event");
    }
    const payload = result.best.payload!;

    const store = params.store ?? new InMemoryKeyValueStore();
    const hwm = await getHighWaterMark(store, payload.operational_public_key);
    const rollbackWarning =
      payload.generation < hwm.generation
        ? `This device previously saw credential generation ${hwm.generation}, but the accepted capsule is generation ${payload.generation}. Relays may be serving stale data, or an old capsule is being replayed.`
        : undefined;
    await raiseHighWaterMark(store, payload.operational_public_key, { generation: payload.generation });

    const relayDisagreementWarning = result.relayDisagreement
      ? "Configured relays returned different credential capsules as \"latest\" for this account. Some relays may be stale, censored, or malicious."
      : undefined;

    return {
      everydayPrivateKey: base64urlToBytes(payload.operational_private_key),
      everydayPublicKey: payload.operational_public_key,
      recoveryPublicKey: payload.recovery_public_key,
      accountId: payload.account_id,
      generation: payload.generation,
      credentialEvent: result.best.event,
      rollbackWarning,
      relayDisagreementWarning
    };
  } finally {
    pool.closeAll();
  }
}
