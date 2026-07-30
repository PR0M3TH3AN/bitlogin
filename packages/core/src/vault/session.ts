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
  readonly vaultPublicKey: string;

  constructor(private readonly connectionVaultRoot: Uint8Array) {
    this.vaultPrk = deriveVaultPrk(connectionVaultRoot);
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

  /** Wipes everything this session holds. The session is unusable after. */
  destroy(): void {
    this.endSudo();
    wipe(this.vaultPrk);
  }

  private prkForTier(tier: ConnectionTier): Uint8Array {
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
    return decryptConnectionRecordEvent(event, this.vaultPrk, this.personalPrk ?? undefined);
  }

  /** §CV11 step 3: a NIP-09 deletion request for a replaced record event,
   *  signed by the vault identity. Best-effort by contract — the encrypted
   *  tombstone is the durable part of a deletion, this is the courtesy ask. */
  buildDeletionRequest(eventIdToDelete: string, now?: number): NostrEvent {
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
  }): Promise<{ connections: DecryptedConnectionRecord[]; rollbackWarnings: string[]; quorumMet: boolean }> {
    const fetched = await this.fetchEvents(params);
    const connections: DecryptedConnectionRecord[] = [];
    for (const event of fetched.events.values()) {
      const decrypted = await this.decryptEvent(event);
      if (decrypted) connections.push(decrypted);
    }
    connections.sort((a, b) => b.record.updated_at - a.record.updated_at);
    return { connections, rollbackWarnings: fetched.rollbackWarnings, quorumMet: fetched.quorumMet };
  }
}
