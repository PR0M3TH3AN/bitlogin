/** Nostr event kind and `d` tag constants used by BitLogin (§30). */
export const KIND_PROFILE = 0;
export const KIND_CONTACTS = 3;
export const KIND_DELETION_REQUEST = 5; // NIP-09
export const KIND_RELAY_LIST = 10002; // NIP-65
export const KIND_DM_RELAY_LIST = 10050; // NIP-17
export const KIND_AUTH = 22242; // NIP-42
export const KIND_GIFT_WRAP = 1059; // NIP-59 (Phase 2 messaging, not wired up by this MVP)
export const KIND_APP_DATA = 30078; // NIP-78

// Protocol constants retain the `password` naming even though the payload is
// now called the credential capsule (§12, §30) — renaming wire constants for
// cosmetic consistency would be a compatibility hazard with no security value.
export const D_TAG_PASSWORD_CAPSULE = "bitlogin:password:v1";
export const D_TAG_RECOVERY_CAPSULE = "bitlogin:recovery:v1";
export const D_TAG_BOOTSTRAP_RELAYS = "bitlogin:bootstrap-relays:v1";

export const SCHEMA_CREDENTIAL_V1 = "bitlogin.credential.v1";
export const SCHEMA_RECOVERY_V1 = "bitlogin.recovery.v1";
export const SCHEMA_RECOVERY_EXPORT_V3 = "bitlogin.recovery-export.v3";
