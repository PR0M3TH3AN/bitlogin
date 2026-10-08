/**
 * Host-facing identity fields (BitBlocks API conventions D1).
 *
 * Canonical name is `pubkey` (lowercase 64-hex). `publicKey` is a deprecated
 * alias with the identical value, kept so existing listeners and session
 * readers keep working. NIP-07 method names (`getPublicKey`) are a different
 * contract and are not renamed.
 */
export interface IdentityFields {
  /** Canonical identity: 64-char lowercase hex. */
  pubkey: string;
  /**
   * @deprecated Use `pubkey`. Identical value; kept as a compatibility alias.
   */
  publicKey: string;
}

/** Returns `pubkey` and the deprecated `publicKey` alias, always equal. */
export function identityFields(hex: string): IdentityFields {
  const pubkey = hex.toLowerCase();
  return { pubkey, publicKey: pubkey };
}
