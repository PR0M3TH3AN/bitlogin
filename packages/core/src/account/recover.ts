/** Phrase recovery flow (§17), including the mandatory recovery-capsule refresh (§17.5). */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { wipe } from "../crypto/memory.js";
import { base64urlToBytes, bytesToBase64url } from "../crypto/encoding.js";
import { randomAccountId, randomBytes } from "../crypto/random.js";
import {
  isValidRecoveryPhrase,
  recoveryPhraseToSeed,
} from "../crypto/bip39.js";
import {
  deriveEverydayPrivateKey,
  deriveRecoveryKeys,
  derivePasswordKeys,
  normalizeLoginName,
} from "./normalize.js";
import { nextCreatedAt } from "./timestamp.js";
import { RelayPool } from "../nostr/pool.js";
import { verifyNostrEvent, type NostrEvent } from "../nostr/event.js";
import {
  D_TAG_PASSWORD_CAPSULE,
  D_TAG_RECOVERY_CAPSULE,
  KIND_DM_RELAY_LIST,
  KIND_PROFILE,
  KIND_RELAY_LIST,
  SCHEMA_CREDENTIAL_V1,
  SCHEMA_RECOVERY_V1,
} from "../nostr/kinds.js";
import {
  readCredentialCapsule,
  readRecoveryCapsule,
  readAccountCarefully,
  checkRecoveryChainAcrossCandidates,
  type Candidate,
} from "./capsuleReader.js";
import {
  buildRecoveryCapsuleEvent,
  decryptRecoveryCapsuleEvent,
} from "../capsules/recoveryCapsule.js";
import { buildCredentialCapsuleEvent } from "../capsules/credentialCapsule.js";
import {
  PROTOCOL_CAPSULE_ENCRYPTION,
  PROTOCOL_PASSWORD_KDF,
  PROTOCOL_RECOVERY_DERIVATION,
  everydayDerivationField,
  vaultRelayHints,
} from "../capsules/types.js";
import type { CredentialPayload, RecoveryPayload } from "../capsules/types.js";
import { parseDmRelayListEvent, parseRelayListEvent } from "./profileEvents.js";
import { publishAndVerify, type PublishVerificationResult } from "./publish.js";
import { checkAddressFree, UNCHECKED_WORDS } from "./freeAddress.js";
import { AccountNotFoundError, RecoveryFailedError } from "./errors.js";
import { resetHighWaterMark } from "./highWaterMark.js";
import type { KeyValueStore } from "../storage/interface.js";

export interface RecoverWithPhraseParams {
  phrase: string;
  vaultRelayUrls: string[];
  discoveryRelayUrls: string[];
  timeoutMs?: number;
  /**
   * Recovery-capsule events from a previously downloaded recovery export file (§19.5), used
   * as a fallback alongside the live relay read. The file alone can never recover an account
   * on its own — it holds only the encrypted capsule, never the phrase or a phrase-derived
   * key — so this only ever supplements the phrase-derived read, e.g. when every configured
   * relay is unreachable or has lost the capsule.
   */
  offlineRecoveryCapsuleEvents?: NostrEvent[];
}

export interface RecoveredIdentity {
  everydayPrivateKey: Uint8Array;
  everydayPublicKey: string;
  /** Exists in memory only for the duration of this recovery flow (§7.1, §11.10). Wipe after use. */
  recoveryPrivateKey: Uint8Array;
  recoveryPublicKey: string;
  recoveryCapsuleKey: Uint8Array;
  accountId: string;
  currentRecoveryEvent: NostrEvent;
  currentRecoveryPayload: RecoveryPayload;
  generalRelays: string[];
  dmRelays: string[];
  chainWarning?: string;
  /**
   * True when the everyday key equals the one §11.6 derives from this phrase,
   * so the phrase alone could rebuild it (§17.6). Established by comparing
   * keys, not by reading the capsule's hint (§12.1).
   */
  everydayKeyDerived: boolean;
}

function pickNewestValidEvent(events: NostrEvent[]): NostrEvent | undefined {
  return events
    .filter((e) => verifyNostrEvent(e))
    .sort((a, b) => b.created_at - a.created_at)[0];
}

/** §17.1-§17.4: derives the recovery identity, locates the recovery capsule, and restores relay preferences. */
export async function recoverWithPhrase(
  params: RecoverWithPhraseParams,
): Promise<RecoveredIdentity> {
  if (!isValidRecoveryPhrase(params.phrase)) {
    throw new RecoveryFailedError(
      "This does not look like a valid 12-word BitLogin recovery phrase.",
    );
  }
  const bip39Seed = await recoveryPhraseToSeed(params.phrase);
  const { recoveryPrivateKey, capsuleKey } = deriveRecoveryKeys(bip39Seed);
  const derivedEveryday = deriveEverydayPrivateKey(bip39Seed);
  const derivedEverydayPublicKey = getPublicKeyHex(derivedEveryday);
  // §11.10 -- the 64-byte master seed re-derives every recovery key; it must
  // not outlive this line. The phrase STRING itself is unwipeable (JS strings
  // are immutable), which is exactly why the caller is told to hold it briefly.
  // The derived everyday key was needed only for its public half: the capsule
  // is authoritative for the private key (§7.2).
  wipe(bip39Seed, derivedEveryday);
  const recoveryPublicKey = getPublicKeyHex(recoveryPrivateKey);

  const vaultPool = new RelayPool(params.vaultRelayUrls, {
    authPrivateKey: recoveryPrivateKey,
  });
  let result;
  try {
    // Never a slow or unreached relay read as "no account", so never the rebuild on a guess (2026-11-26). Where this
    // device holds an offline copy, that is weighed below as before.
    const read = async (urls: string[], timeoutMs?: number) => {
      if (urls.length === params.vaultRelayUrls.length) return readRecoveryCapsule(vaultPool, recoveryPublicKey, capsuleKey, timeoutMs);
      const again = new RelayPool(urls, { authPrivateKey: recoveryPrivateKey });
      try {
        return await readRecoveryCapsule(again, recoveryPublicKey, capsuleKey, timeoutMs);
      } finally {
        again.closeAll();
      }
    };
    result = params.offlineRecoveryCapsuleEvents?.length ? await read(params.vaultRelayUrls, params.timeoutMs) : await readAccountCarefully(read, params.vaultRelayUrls, params.timeoutMs);
  } finally {
    vaultPool.closeAll();
  }

  if (params.offlineRecoveryCapsuleEvents?.length) {
    const offlineCandidates: Array<Candidate<RecoveryPayload>> = [];
    for (const event of params.offlineRecoveryCapsuleEvents) {
      if (!verifyNostrEvent(event)) continue;
      try {
        offlineCandidates.push({
          event,
          payload: await decryptRecoveryCapsuleEvent(event, capsuleKey),
        });
      } catch (err) {
        offlineCandidates.push({
          event,
          payload: null,
          error: (err as Error).message,
        });
      }
    }
    const merged = new Map<string, Candidate<RecoveryPayload>>();
    for (const candidate of [...result.candidates, ...offlineCandidates])
      merged.set(candidate.event.id, candidate);
    const candidates = [...merged.values()].sort(
      (a, b) => b.event.created_at - a.event.created_at,
    );
    const best = candidates.find((c) => c.payload !== null) ?? null;
    result = {
      ...result,
      candidates,
      best,
      quorumMet: result.quorumMet || best !== null,
    };
  }

  if (!result.quorumMet) throw new AccountNotFoundError("quorum-not-met");
  if (!result.best) {
    throw new AccountNotFoundError(
      result.candidates.length > 0 ? "no-valid-candidate" : "no-matching-event",
    );
  }
  const payload = result.best.payload!;
  const chainCheck = checkRecoveryChainAcrossCandidates(result.candidates);

  const everydayPrivateKey = base64urlToBytes(payload.operational_private_key);
  const everydayPublicKey = payload.operational_public_key;

  // §17.4 step 4 — restore relay preferences from the user's own public kind 10002/10050 events,
  // searched across the discovery relays plus this capsule's own vault-relay hints.
  const { generalRelays, dmRelays } = await fetchRelayPreferences(
    everydayPublicKey,
    [...params.discoveryRelayUrls, ...payload.vault_relay_hints],
    params.timeoutMs,
  );

  return {
    everydayPrivateKey,
    everydayPublicKey,
    recoveryPrivateKey,
    recoveryPublicKey,
    recoveryCapsuleKey: capsuleKey,
    accountId: payload.account_id,
    currentRecoveryEvent: result.best.event,
    currentRecoveryPayload: payload,
    generalRelays,
    dmRelays,
    chainWarning: chainCheck.consistent ? undefined : chainCheck.warning,
    everydayKeyDerived: everydayPublicKey === derivedEverydayPublicKey,
  };
}

async function fetchRelayPreferences(
  everydayPublicKey: string,
  relayUrls: string[],
  timeoutMs: number | undefined,
): Promise<{ generalRelays: string[]; dmRelays: string[] }> {
  const discoveryPool = new RelayPool([...new Set(relayUrls)]);
  let generalRelays: string[] = [];
  let dmRelays: string[] = [];
  try {
    const relayListQuorum = await discoveryPool.queryQuorum(
      { kinds: [KIND_RELAY_LIST], authors: [everydayPublicKey], limit: 5 },
      timeoutMs,
    );
    const relayListEvent = pickNewestValidEvent(
      relayListQuorum.outcomes.flatMap((o) => o.events),
    );
    if (relayListEvent) generalRelays = parseRelayListEvent(relayListEvent);

    const dmListQuorum = await discoveryPool.queryQuorum(
      { kinds: [KIND_DM_RELAY_LIST], authors: [everydayPublicKey], limit: 5 },
      timeoutMs,
    );
    const dmListEvent = pickNewestValidEvent(
      dmListQuorum.outcomes.flatMap((o) => o.events),
    );
    if (dmListEvent) dmRelays = parseDmRelayListEvent(dmListEvent);
  } finally {
    discoveryPool.closeAll();
  }
  return { generalRelays, dmRelays };
}

// ---- Rebuild from phrase (§17.6) ----

export interface PhraseRebuildParams {
  phrase: string;
  vaultRelayUrls: string[];
  discoveryRelayUrls: string[];
  timeoutMs?: number;
}

export interface PhraseRebuildPreview {
  /** The identity §11.6 derives from this phrase. Only the user can say whether it is theirs. */
  everydayPublicKey: string;
  /** A kind-0 profile signed by that identity exists on a relay. */
  profileFound: boolean;
  /** A kind-10002 relay list signed by that identity exists on a relay. */
  relayListFound: boolean;
}

interface PhraseKeys {
  recoveryPrivateKey: Uint8Array;
  recoveryPublicKey: string;
  capsuleKey: Uint8Array;
  everydayPrivateKey: Uint8Array;
  everydayPublicKey: string;
}

async function derivePhraseKeys(phrase: string): Promise<PhraseKeys> {
  if (!isValidRecoveryPhrase(phrase)) {
    throw new RecoveryFailedError(
      "This does not look like a valid 12-word BitLogin recovery phrase.",
    );
  }
  const bip39Seed = await recoveryPhraseToSeed(phrase);
  try {
    const { recoveryPrivateKey, capsuleKey } = deriveRecoveryKeys(bip39Seed);
    const everydayPrivateKey = deriveEverydayPrivateKey(bip39Seed);
    return {
      recoveryPrivateKey,
      recoveryPublicKey: getPublicKeyHex(recoveryPrivateKey),
      capsuleKey,
      everydayPrivateKey,
      everydayPublicKey: getPublicKeyHex(everydayPrivateKey),
    };
  } finally {
    wipe(bip39Seed);
  }
}

/**
 * A rebuild is only honest when the capsule is known to be gone: a quorum of
 * relays answered, and nothing at the recovery address decrypts. Relays that
 * did not answer prove nothing, and an account whose capsule still exists
 * must go through ordinary recovery, which keeps its vault roots (§17.6).
 * Returns the newest `created_at` seen at the address, so a rebuilt capsule
 * can replace undecryptable leftovers (§24.6).
 */
async function assertNoRecoveryCapsule(
  keys: PhraseKeys,
  vaultRelayUrls: string[],
  timeoutMs: number | undefined,
): Promise<number | null> {
  const pool = new RelayPool(vaultRelayUrls, {
    authPrivateKey: keys.recoveryPrivateKey,
  });
  let read;
  try {
    read = await readRecoveryCapsule(
      pool,
      keys.recoveryPublicKey,
      keys.capsuleKey,
      timeoutMs,
    );
  } finally {
    pool.closeAll();
  }
  if (!read.quorumMet) throw new AccountNotFoundError("quorum-not-met");
  if (read.best) {
    throw new RecoveryFailedError(
      "This account's recovery capsule is still on the relays. Use normal recovery instead of a rebuild.",
    );
  }
  return read.candidates.length > 0
    ? Math.max(...read.candidates.map((c) => c.event.created_at))
    : null;
}

/**
 * §17.6 steps 1-3: what identity this phrase derives, and whether any public
 * trace of it exists. Publishes nothing. The caller must show the result and
 * get the user's explicit confirmation before calling rebuildAccountFromPhrase:
 * for an imported key or a pre-v0.7 account the derived identity is a new,
 * empty one, and only the user can tell.
 */
export async function previewPhraseRebuild(
  params: PhraseRebuildParams,
): Promise<PhraseRebuildPreview> {
  const keys = await derivePhraseKeys(params.phrase);
  try {
    await assertNoRecoveryCapsule(keys, params.vaultRelayUrls, params.timeoutMs);
    const pool = new RelayPool([
      ...new Set([...params.discoveryRelayUrls, ...params.vaultRelayUrls]),
    ]);
    try {
      const found = await pool.queryQuorum(
        {
          kinds: [KIND_PROFILE, KIND_RELAY_LIST],
          authors: [keys.everydayPublicKey],
          limit: 10,
        },
        params.timeoutMs,
      );
      const events = found.outcomes
        .flatMap((o) => o.events)
        .filter(
          (e) => e.pubkey === keys.everydayPublicKey && verifyNostrEvent(e),
        );
      return {
        everydayPublicKey: keys.everydayPublicKey,
        profileFound: events.some((e) => e.kind === KIND_PROFILE),
        relayListFound: events.some((e) => e.kind === KIND_RELAY_LIST),
      };
    } finally {
      pool.closeAll();
    }
  } finally {
    wipe(keys.recoveryPrivateKey, keys.capsuleKey, keys.everydayPrivateKey);
  }
}

/**
 * §17.6 step 4: publishes a fresh generation-0 recovery capsule for the
 * identity this phrase derives, and returns it in the same shape phrase
 * recovery does, so completeRecoveryWithNewCredentials finishes the job.
 *
 * Not restored, because they were random and lived only in the lost capsules:
 * the original account_id and the Connection Vault roots. New ones are minted.
 */
export async function rebuildAccountFromPhrase(
  params: PhraseRebuildParams & { minAcknowledgements?: number; now?: number },
): Promise<RecoveredIdentity> {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const keys = await derivePhraseKeys(params.phrase);
  let handedOver = false;
  try {
    const newestLeftover = await assertNoRecoveryCapsule(
      keys,
      params.vaultRelayUrls,
      params.timeoutMs,
    );
    const payload: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: bytesToBase64url(randomAccountId()),
      recovery_generation: 0,
      previous_recovery_event_id: null,
      operational_private_key: bytesToBase64url(keys.everydayPrivateKey),
      operational_public_key: keys.everydayPublicKey,
      recovery_public_key: keys.recoveryPublicKey,
      connection_vault_root: bytesToBase64url(randomBytes(32)),
      vault_sudo_key: bytesToBase64url(randomBytes(32)),
      created_at:
        newestLeftover === null ? now : nextCreatedAt(newestLeftover, now),
      vault_relay_hints: vaultRelayHints(params.vaultRelayUrls),
      protocol: {
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION,
        ...everydayDerivationField(true),
      },
    };
    const event = await buildRecoveryCapsuleEvent({
      recoveryPrivateKey: keys.recoveryPrivateKey,
      capsuleKey: keys.capsuleKey,
      payload,
    });
    const pool = new RelayPool(params.vaultRelayUrls, {
      authPrivateKey: keys.recoveryPrivateKey,
    });
    let publish: PublishVerificationResult;
    try {
      publish = await publishAndVerify(pool, event, {
        dTag: D_TAG_RECOVERY_CAPSULE,
        minAcks: params.minAcknowledgements,
        timeoutMs: params.timeoutMs,
      });
    } finally {
      pool.closeAll();
    }
    if (!publish.success) {
      throw new RecoveryFailedError(
        "Could not publish the rebuilt recovery capsule to enough relays. Nothing else was changed; please retry.",
      );
    }
    const { generalRelays, dmRelays } = await fetchRelayPreferences(
      keys.everydayPublicKey,
      [...params.discoveryRelayUrls, ...params.vaultRelayUrls],
      params.timeoutMs,
    );
    handedOver = true;
    return {
      everydayPrivateKey: keys.everydayPrivateKey,
      everydayPublicKey: keys.everydayPublicKey,
      recoveryPrivateKey: keys.recoveryPrivateKey,
      recoveryPublicKey: keys.recoveryPublicKey,
      recoveryCapsuleKey: keys.capsuleKey,
      accountId: payload.account_id,
      currentRecoveryEvent: event,
      currentRecoveryPayload: payload,
      generalRelays,
      dmRelays,
      everydayKeyDerived: true,
    };
  } finally {
    if (!handedOver) {
      wipe(keys.recoveryPrivateKey, keys.capsuleKey, keys.everydayPrivateKey);
    }
  }
}

export interface CompleteRecoveryParams {
  recovered: RecoveredIdentity;
  newLoginName: string;
  newPassword: string;
  vaultRelayUrls: string[];
  minAcknowledgements?: number;
  timeoutMs?: number;
  now?: number;
  /** Where this device's rollback high-water mark lives. Passing it is what
   *  stops the recovered account from tripping the rollback alarm on every
   *  later login (the new capsule legitimately restarts at generation 0). */
  store?: KeyValueStore;
}

export interface CompleteRecoveryResult {
  normalizedLoginName: string;
  locatorPublicKey: string;
  credentialEvent: NostrEvent;
  refreshedRecoveryEvent: NostrEvent;
  credentialPublish: PublishVerificationResult;
  recoveryPublish: PublishVerificationResult;
}

/**
 * §17.4 steps 5-6 and §17.5: establishes new login credentials, refreshes the
 * recovery capsule while the phrase is still in memory, and embeds the
 * refreshed recovery event in the new credential capsule.
 *
 * The new credential capsule's `generation` starts at 0: it lives at a brand
 * new locator address (derived from the new password), and generation is a
 * per-address rollback counter (§24.1) — a fresh address has no history to
 * roll back. Account-level continuity across this reset is carried by the
 * unchanged everyday identity and by the recovery_generation hash chain.
 */
export async function completeRecoveryWithNewCredentials(
  params: CompleteRecoveryParams,
): Promise<CompleteRecoveryResult> {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const normalizedLoginName = normalizeLoginName(params.newLoginName);
  const { recovered } = params;

  // §CV13.2 — the vault roots ride the refresh so a phrase-only recovery
  // restores connections, not just identity.
  const recoveryVaultFields =
    recovered.currentRecoveryPayload.connection_vault_root !== undefined
      ? {
          connection_vault_root:
            recovered.currentRecoveryPayload.connection_vault_root,
          vault_sudo_key: recovered.currentRecoveryPayload.vault_sudo_key,
        }
      : {};
  const credentialVaultFields =
    recovered.currentRecoveryPayload.connection_vault_root !== undefined
      ? {
          connection_vault_root:
            recovered.currentRecoveryPayload.connection_vault_root,
        }
      : {};
  const { locatorPrivateKey, capsuleKey } = await derivePasswordKeys(
    params.newPassword,
    normalizedLoginName,
  );
  try {
    const locatorPublicKey = getPublicKeyHex(locatorPrivateKey);

    // §15.6 -- collision refusal is a PRECONDITION for mutating the recovery
    // chain. A failed or occupied locator read must leave the current recovery
    // event untouched so the caller can safely retry with different credentials.
    // As at registration (freeAddress.ts, 2026-11-25): free only where a quorum answered "nothing here" and no relay
    // that connected was left unfinished; the new capsule goes only to the relays that answered.
    const free = await checkAddressFree({
      urls: params.vaultRelayUrls,
      timeoutMs: params.timeoutMs,
      read: async (urls, timeoutMs) => {
        const collisionPool = new RelayPool(urls, { authPrivateKey: locatorPrivateKey });
        try {
          return await readCredentialCapsule(collisionPool, locatorPublicKey, capsuleKey, timeoutMs);
        } finally {
          collisionPool.closeAll();
        }
      },
    });
    if (free.state === "unchecked") {
      throw new RecoveryFailedError(
        `Couldn't check that this login name and password are free: ${UNCHECKED_WORDS[free.why]}. Nothing was changed. Try again in a moment.`,
      );
    }
    let credentialRelayUrls: string[];
    if (free.state === "taken") {
      // What is there may be this same recovery's own earlier write, cut short: that one may be finished.
      const existingPayload = free.result.best?.payload ?? null;
      const resumesPartialCredentialWrite =
        existingPayload !== null &&
        existingPayload.account_id === recovered.accountId &&
        existingPayload.operational_public_key === recovered.everydayPublicKey &&
        existingPayload.recovery_public_key === recovered.recoveryPublicKey &&
        existingPayload.generation === 0 &&
        existingPayload.recovery_capsule_event.id ===
          recovered.currentRecoveryEvent.id;
      if (!resumesPartialCredentialWrite) {
        throw new RecoveryFailedError(
          "Another account is already registered with that login name and password. Pick a different one.",
        );
      }
      credentialRelayUrls = free.answeredUrls;
    } else {
      credentialRelayUrls = free.writeUrls;
    }

    const nextRecoveryGeneration =
      recovered.currentRecoveryPayload.recovery_generation + 1;
    const refreshedPayload: RecoveryPayload = {
      schema: SCHEMA_RECOVERY_V1,
      account_id: recovered.accountId,
      recovery_generation: nextRecoveryGeneration,
      previous_recovery_event_id: recovered.currentRecoveryEvent.id,
      operational_private_key: bytesToBase64url(recovered.everydayPrivateKey),
      operational_public_key: recovered.everydayPublicKey,
      recovery_public_key: recovered.recoveryPublicKey,
      ...recoveryVaultFields,
      created_at: nextCreatedAt(recovered.currentRecoveryEvent.created_at, now),
      vault_relay_hints: vaultRelayHints(params.vaultRelayUrls),
      protocol: {
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION,
        ...everydayDerivationField(recovered.everydayKeyDerived),
      },
    };
    const refreshedRecoveryEvent = await buildRecoveryCapsuleEvent({
      recoveryPrivateKey: recovered.recoveryPrivateKey,
      capsuleKey: recovered.recoveryCapsuleKey,
      payload: refreshedPayload,
    });

    const recoveryPool = new RelayPool(params.vaultRelayUrls, {
      authPrivateKey: recovered.recoveryPrivateKey,
    });
    let recoveryPublish: PublishVerificationResult;
    try {
      recoveryPublish = await publishAndVerify(
        recoveryPool,
        refreshedRecoveryEvent,
        {
          dTag: D_TAG_RECOVERY_CAPSULE,
          minAcks: params.minAcknowledgements,
          timeoutMs: params.timeoutMs,
        },
      );
    } finally {
      recoveryPool.closeAll();
    }
    if (!recoveryPublish.success) {
      throw new RecoveryFailedError(
        "Could not publish the refreshed recovery capsule to enough relays. No new credential was published; please retry.",
      );
    }

    // The recovery event is already authoritative at this point even if the
    // following credential write fails. Advance the caller's pending state
    // immediately so an in-memory retry chains from this durable event rather
    // than creating a same-generation sibling from the stale predecessor.
    recovered.currentRecoveryEvent = refreshedRecoveryEvent;
    recovered.currentRecoveryPayload = refreshedPayload;

    const credentialPayload: CredentialPayload = {
      schema: SCHEMA_CREDENTIAL_V1,
      account_id: recovered.accountId,
      generation: 0,
      operational_private_key: bytesToBase64url(recovered.everydayPrivateKey),
      operational_public_key: recovered.everydayPublicKey,
      recovery_public_key: recovered.recoveryPublicKey,
      recovery_capsule_event: refreshedRecoveryEvent,
      ...credentialVaultFields,
      // A retry may be repairing a credential that reached only one relay.
      // It must replace that partial event deterministically on every relay.
      created_at: free.state === "taken" && free.result.best
        ? nextCreatedAt(free.result.best.event.created_at, now)
        : now,
      vault_relay_hints: vaultRelayHints(params.vaultRelayUrls),
      protocol: {
        password_kdf: PROTOCOL_PASSWORD_KDF,
        capsule_encryption: PROTOCOL_CAPSULE_ENCRYPTION,
        recovery_derivation: PROTOCOL_RECOVERY_DERIVATION,
        ...everydayDerivationField(recovered.everydayKeyDerived),
      },
    };
    const credentialEvent = await buildCredentialCapsuleEvent({
      locatorPrivateKey,
      capsuleKey,
      payload: credentialPayload,
    });
    // Only the relays that answered at this address: none that might hold another account is written over.
    const credentialPool = new RelayPool(credentialRelayUrls, {
      authPrivateKey: locatorPrivateKey,
    });
    let credentialPublish: PublishVerificationResult;
    try {
      credentialPublish = await publishAndVerify(
        credentialPool,
        credentialEvent,
        {
          dTag: D_TAG_PASSWORD_CAPSULE,
          minAcks: params.minAcknowledgements,
          timeoutMs: params.timeoutMs,
        },
      );
    } finally {
      credentialPool.closeAll();
    }

    if (!credentialPublish.success) {
      throw new RecoveryFailedError(
        "Could not publish the new credential capsule to enough relays. Please retry.",
      );
    }

    // Only after both capsules are durable: the recovered account is now
    // authoritatively at generation 0, so the mark must follow it down rather
    // than keep flagging every future login as a rollback (see
    // resetHighWaterMark for why the phrase is entitled to do this).
    if (params.store) {
      await resetHighWaterMark(params.store, recovered.everydayPublicKey, {
        generation: 0,
        recoveryGeneration: nextRecoveryGeneration,
      });
    }

    return {
      normalizedLoginName,
      locatorPublicKey,
      credentialEvent,
      refreshedRecoveryEvent,
      credentialPublish,
      recoveryPublish,
    };
  } finally {
    wipe(locatorPrivateKey, capsuleKey);
  }
}
