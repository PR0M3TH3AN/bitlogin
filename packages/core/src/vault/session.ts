/**
 * VaultSession — the ergonomic surface a host (the widget, a native client)
 * drives after login. It owns the derived key material and the sudo-window
 * policy so callers cannot get the caching contract wrong by accident:
 *
 * - The vault prk lives for the session (connectable-tier operations are
 *   silent, which is the product).
 * - The personal prk exists ONLY between enableSudo() and endSudo(), and
 *   endSudo() wipes it. Re-entering sudo requires the sudo key again —
 *   which the host can only get by re-decrypting a capsule (a fresh
 *   Argon2id run on the password, or the phrase). enableSudo() wipes the
 *   caller's copy of the sudo key on the way in so exactly one live copy
 *   exists at a time.
 */
import { wipe } from "../crypto/memory.js";
import type { NostrEvent } from "../nostr/event.js";
import { buildDeletionRequest } from "../nostr/nip09.js";
import { KIND_APP_DATA } from "../nostr/kinds.js";
import type { KeyValueStore } from "../storage/interface.js";
import {
  derivePersonalPrk,
  deriveVaultPrk,
  deriveVaultPublicKey,
  deriveVaultSigningKey,
  newConnectionId
} from "./derivation.js";
import {
  buildConnectionRecordEvent,
  decryptConnectionRecordEvent,
  tombstoneRecord,
  type DecryptedConnectionRecord
} from "./record.js";
import { fetchConnectionRecordEvents, publishConnectionRecord, type FetchedConnectionEvents } from "./sync.js";
import type { PublishVerificationResult } from "../account/publish.js";
import { SCHEMA_CONNECTION_V1, type ApplicationBinding, type ConnectionRecord, type ConnectionTier } from "./types.js";

export interface CreateConnectionParams {
  connection_type: string;
  tier: ConnectionTier;
  label: string;
  credential: { schema: string } & Record<string, unknown>;
  application_binding?: ApplicationBinding;
  notes?: string | null;
  now?: number;
}

export class VaultSession {
  private vaultPrk: Uint8Array;
  private personalPrk: Uint8Array | null = null;
  private destroyed = false;
  private readonly connectionVaultRoot: Uint8Array;
  readonly vaultPublicKey: string;

  constructor(connectionVaultRoot: Uint8Array) {
    // A private COPY: the caller's buffer is theirs to wipe on their own
    // schedule, and destroy() must be able to erase this session's copy
    // without reaching into memory it does not own.
    this.connectionVaultRoot = connectionVaultRoot.slice();
    this.vaultPrk = deriveVaultPrk(this.connectionVaultRoot);
    this.vaultPublicKey = deriveVaultPublicKey(this.vaultPrk);
  }

  get sudoActive(): boolean {
    return this.personalPrk !== null;
  }

  /** Opens a sudo window. Consumes (wipes) the caller's sudo key copy. */
  enableSudo(vaultSudoKey: Uint8Array): void {
    this.endSudo();
    this.personalPrk = derivePersonalPrk(this.connectionVaultRoot, vaultSudoKey);
    wipe(vaultSudoKey);
  }

  /** Closes the sudo window and wipes the personal-tier key material. */
  endSudo(): void {
    if (this.personalPrk) wipe(this.personalPrk);
    this.personalPrk = null;
  }

  /**
   * Wipes everything this session holds, permanently.
   *
   * The ROOT is wiped too, not just the derived prk: the root regenerates the
   * prk and (with a sudo key) the personal prk, so leaving it live made
   * "wipes everything" false. And the session is marked destroyed rather than
   * merely zeroed, because a zeroed prk is not inert -- deriveRecordKey and
   * deriveVaultSigningKey over 32 zero bytes are deterministic, WORLD-
   * COMPUTABLE values. A stale reference calling createConnection() after
   * teardown would otherwise seal a wallet secret under a key any observer
   * can derive, sign it with a publicly known identity, and report success.
   * Failing loudly is the only safe behaviour.
   */
  destroy(): void {
    this.endSudo();
    wipe(this.vaultPrk, this.connectionVaultRoot);
    this.destroyed = true;
  }

  private prkForTier(tier: ConnectionTier): Uint8Array {
    if (this.destroyed) {
      throw new Error("This vault session was destroyed; create a new one from the account's root.");
    }
    if (tier === "connectable") return this.vaultPrk;
    if (!this.personalPrk) {
      throw new Error("Personal-tier records require an open sudo window (enableSudo).");
    }
    return this.personalPrk;
  }

  /** Builds a fresh record + its signed event. Purely local; publish separately. */
  async createConnection(params: CreateConnectionParams): Promise<{ record: ConnectionRecord; event: NostrEvent }> {
    const now = params.now ?? Math.floor(Date.now() / 1000);
    const record: ConnectionRecord = {
      schema: SCHEMA_CONNECTION_V1,
      connection_id: newConnectionId(),
      connection_type: params.connection_type,
      tier: params.tier,
      state: "active",
      label: params.label,
      created_at: now,
      updated_at: now,
      credential: params.credential,
      application_binding: params.application_binding ?? { origin: null, app_pubkey: null },
      notes: params.notes ?? null
    };
    const event = await buildConnectionRecordEvent({
      vaultPrk: this.vaultPrk,
      recordPrk: this.prkForTier(params.tier),
      record,
      now
    });
    return { record, event };
  }

  /** Replaces a record's content. The tier is immutable — moving a secret
   *  between tiers is a delete-and-recreate, never a silent re-encryption. */
  async updateConnection(
    current: DecryptedConnectionRecord,
    changes: Partial<Pick<ConnectionRecord, "state" | "label" | "credential" | "application_binding" | "notes">>,
    now?: number
  ): Promise<{ record: ConnectionRecord; event: NostrEvent }> {
    const at = now ?? Math.floor(Date.now() / 1000);
    const record: ConnectionRecord = {
      ...current.record,
      ...changes,
      tier: current.record.tier,
      connection_id: current.record.connection_id,
      created_at: current.record.created_at,
      updated_at: at
    };
    const event = await buildConnectionRecordEvent({
      vaultPrk: this.vaultPrk,
      recordPrk: this.prkForTier(record.tier),
      record,
      previousCreatedAt: current.event.created_at,
      now: at
    });
    return { record, event };
  }

  /** §CV11 step 2: the encrypted tombstone replacement. */
  async deleteConnection(
    current: DecryptedConnectionRecord,
    now?: number
  ): Promise<{ record: ConnectionRecord; event: NostrEvent }> {
    const at = now ?? Math.floor(Date.now() / 1000);
    const record = tombstoneRecord(current.record, at);
    const event = await buildConnectionRecordEvent({
      vaultPrk: this.vaultPrk,
      recordPrk: this.prkForTier(record.tier),
      record,
      previousCreatedAt: current.event.created_at,
      now: at
    });
    return { record, event };
  }

  /** Trial-decrypts one event; personal-tier records resolve only inside a sudo window. */
  decryptEvent(event: NostrEvent): Promise<DecryptedConnectionRecord | null> {
    if (this.destroyed) {
      return Promise.reject(new Error("This vault session was destroyed; create a new one from the account's root."));
    }
    return decryptConnectionRecordEvent(event, this.vaultPrk, this.personalPrk ?? undefined);
  }

  /** §CV11 step 3: a NIP-09 deletion request for a replaced record event,
   *  signed by the vault identity. Best-effort by contract — the encrypted
   *  tombstone is the durable part of a deletion, this is the courtesy ask. */
  buildDeletionRequest(eventIdToDelete: string, now?: number): NostrEvent {
    if (this.destroyed) {
      throw new Error("This vault session was destroyed; create a new one from the account's root.");
    }
    return buildDeletionRequest({
      privateKey: deriveVaultSigningKey(this.vaultPrk),
      eventIdToDelete,
      deletedEventKind: KIND_APP_DATA,
      createdAt: now ?? Math.floor(Date.now() / 1000)
    });
  }

  publish(params: {
    event: NostrEvent;
    connectionId: string;
    relayUrls: string[];
    store: KeyValueStore;
    minAcknowledgements?: number;
    timeoutMs?: number;
  }): Promise<PublishVerificationResult> {
    return publishConnectionRecord({ vaultPrk: this.vaultPrk, ...params });
  }

  fetchEvents(params: {
    relayUrls: string[];
    store: KeyValueStore;
    timeoutMs?: number;
  }): Promise<FetchedConnectionEvents> {
    return fetchConnectionRecordEvents({ vaultPrk: this.vaultPrk, ...params });
  }

  /**
   * Fetches and decrypts everything decryptable right now. Outside a sudo
   * window the personal tier is simply absent from the result — invisible,
   * not erroring, exactly like the app-facing API contract.
   */
  async listConnections(params: {
    relayUrls: string[];
    store: KeyValueStore;
    timeoutMs?: number;
    /** Accept a below-quorum answer anyway. Off by default: a partial view
     *  of a credential store reads as authoritative and isn't. */
    acknowledgeIncompleteQuorum?: boolean;
  }): Promise<{
    connections: DecryptedConnectionRecord[];
    rollbackWarnings: string[];
    /** Event ids that failed to decrypt or validate. Surfaced, never silent. */
    unreadable: string[];
    /** True when the relay page filled, so records may be missing. */
    truncated: boolean;
    quorumMet: boolean;
  }> {
    const fetched = await this.fetchEvents(params);
    if (!fetched.quorumMet && !params.acknowledgeIncompleteQuorum) {
      // Failing closed matters more here than for a read of public data: a
      // short listing looks identical to "you have no connections", and a
      // single relay deciding that is how a revoked-looking vault gets
      // re-populated or a live credential gets hidden.
      throw new Error(
        "Not enough vault relays answered to list your connections reliably. Check your connection and retry."
      );
    }
    const connections: DecryptedConnectionRecord[] = [];
    const unreadable: string[] = [];
    for (const event of fetched.events.values()) {
      // Per-record isolation. decryptConnectionRecordEvent THROWS on a bad
      // signature, wrong author, malformed d-tag, id mismatch, or tier
      // mismatch -- all correct strictness -- but without this catch a single
      // malformed or future-version record made every OTHER connection,
      // including working wallet credentials, unlistable on every device.
      try {
        const decrypted = await this.decryptEvent(event);
        if (decrypted) connections.push(decrypted);
      } catch {
        unreadable.push(event.id);
      }
    }
    connections.sort((a, b) => b.record.updated_at - a.record.updated_at);
    return {
      connections,
      rollbackWarnings: fetched.rollbackWarnings,
      unreadable,
      truncated: fetched.truncated,
      quorumMet: fetched.quorumMet
    };
  }
}
