export * from "./random.js";
export * from "./encoding.js";
export * from "./memory.js";
export * from "./hkdf.js";
export * from "./scalarExpand.js";
export * from "./secp256k1.js";
export * from "./aesGcm.js";
export * from "./argon2id.js";
export * from "./bip39.js";
export * from "./padding.js";
export * from "./jcs.js";
// Explicit rather than `export *` so the nonce/IV-taking helpers stay off the
// package surface (§11.1). `encryptWithNonce` and `encryptWithIv` are exported
// from their modules only so ./testing.js can reach them; re-exporting them here
// would put "encrypt with a nonce you chose" one autocomplete away from
// application code, which for ChaCha20 and AES-CBC is the whole risk.
export {
  MAX_NIP44_BROWSER_PLAINTEXT_LEN,
  MAX_NIP44_ENCODED_PAYLOAD_LEN,
  getConversationKey,
  nip44Encrypt,
  nip44Decrypt,
} from "./nip44.js";
export { getSharedSecret, nip04Encrypt, nip04Decrypt } from "./nip04.js";
