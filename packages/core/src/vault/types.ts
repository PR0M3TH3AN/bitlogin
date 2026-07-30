/** Connection Vault record schemas (connection-vault.md §8.3, §14). */

export const SCHEMA_CONNECTION_V1 = "bitlogin.connection.v1";
export const SCHEMA_CONNECTION_NWC_V1 = "bitlogin.connection.nwc.v1";

export type ConnectionState = "active" | "suspended" | "deleted";

/**
 * The sensitivity tier decides which key hierarchy encrypts the record and
 * what the client may do with it:
 *
 * - `connectable`: grantable to application origins through the consent flow
 *   (budget-capped NWC, scoped S3). Keys derive from the vault root alone,
 *   so daily use never re-prompts.
 * - `personal`: stored passwords and secure notes. Keys additionally require
 *   the sudo key (derivation.ts), and the app-facing API must be
 *   structurally blind to this tier — an embedded widget cannot do
 *   exact-origin matching, and revealing one site's password to another
 *   site's page is a phishing machine with a consent screen.
 */
export type ConnectionTier = "connectable" | "personal";

export interface ApplicationBinding {
  /** The web origin this connection is bound to, or null when unbound. */
  origin: string | null;
  /** Optional Nostr application key binding (§CV16.4, still open). */
  app_pubkey: string | null;
}

export interface ConnectionRecord {
  schema: typeof SCHEMA_CONNECTION_V1;
  connection_id: string; // base64url, 128-bit random (§CV7)
  connection_type: string; // "nwc", "s3", "password", ...
  tier: ConnectionTier;
  state: ConnectionState;
  label: string;
  created_at: number;
  updated_at: number;
  /** Profile-defined payload; `schema` names the profile. A tombstone keeps
   *  only the schema field (§CV11: secrets are wiped, the slot remains). */
  credential: { schema: string } & Record<string, unknown>;
  application_binding: ApplicationBinding;
  notes: string | null;
}

/** Canonical NWC credential (nwc-connections.md §6): the parsed URI, stored
 *  structured so export is lossless and display never needs the secret. */
export interface NwcCredential {
  schema: typeof SCHEMA_CONNECTION_NWC_V1;
  wallet_pubkey: string; // lowercase hex
  relays: string[]; // at least one, wss:// or ws://
  secret: string; // lowercase hex, 32 bytes — the bearer client key
  lud16: string | null;
  /** Unknown query parameters retained verbatim for lossless export (§5). */
  extra_params: Array<[string, string]>;
}
