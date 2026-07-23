# BitLogin Portable Application State

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

## 1. Summary

Portable Application State allows compatible applications to store encrypted,
user-owned settings and lightweight state through BitLogin so the application
experience follows the user across devices.

Examples include:

- Interface preferences
- Subscription and follow selections
- Block and mute lists
- Draft-editor preferences
- Notification settings
- Upload defaults
- Saved views and filters
- Application-specific bookmarks

The application defines the meaning of its records. BitLogin provides:

- Namespacing
- Local encryption and decryption
- Relay publication and retrieval
- Independent record replacement
- Recovery on a clean device
- Conflict and rollback metadata
- Export and deletion

Portable Application State must not be stored directly inside the BitLogin
credential or recovery capsule.

## 2. Motivation

A portable Nostr identity does not automatically produce a portable application
experience. Users may recover the same `npub` on another device while losing:

- Application preferences
- Locally maintained lists
- Draft settings
- Notification choices
- Saved filters
- Other application state that was never published as standard Nostr events

This causes decentralized applications to feel less coherent than conventional
accounts even when identity recovery works correctly.

The product goal is:

> Compatible applications should feel like the same account on every device
> without placing their private database under a centralized provider.

## 3. Scope

Portable Application State is intended for small, encrypted, user-specific
records that are useful across devices.

Appropriate examples:

```text
BitRoad
├── storefront editor preferences
├── notification settings
└── saved management filters

BitVid
├── playback preferences
├── subscription presentation settings
└── upload defaults

Satisfied
├── analysis display preferences
├── dietary preference settings
└── conversation presentation settings
```

Inappropriate uses include:

- Large binary files
- Video or image storage
- High-frequency telemetry
- Server-authoritative balances
- Payment credentials
- S3 credentials
- NWC credentials
- Cryptocurrency seed phrases
- Data requiring transactional database semantics

Large files belong in user-selected storage such as S3-compatible services.
High-value credentials belong in the Connection Vault.

## 4. Record model

Application state must be divided into independently replaceable logical
records rather than one global application document.

Good:

```text
network.bitroad/preferences/editor
network.bitroad/preferences/notifications
network.bitroad/filters/product-list
```

Avoid:

```text
network.bitroad/everything
```

This reduces multi-device clobbering and allows selective deletion, export, and
permission management.

## 5. Application identifiers

Each application must use a stable identifier. Recommended forms:

```text
network.bitroad
network.bitunlock
network.bitvid
app.satisfied
```

An application identifier must:

- Be lowercase ASCII.
- Contain only letters, numbers, dots, and hyphens.
- Be between 3 and 128 characters.
- Remain stable across deployments and domains.
- Not impersonate another application's identifier.

A future registry or signed application manifest may bind an identifier to one
or more origins and application pubkeys. Until then, users must be shown the
requesting origin whenever an app asks to read or write state.

## 6. State record identifier

Each record has a logical key chosen by the application:

```text
preferences/editor
preferences/notifications
lists/blocked-pubkeys
views/default-product-filter
```

The combination of application ID and record key identifies the replaceable
record.

Requirements:

- UTF-8 text normalized according to the final protocol specification.
- No secrets or personal data embedded in the public identifier.
- Stable for the logical record.
- Limited to a reasonable maximum length.

## 7. Nostr event

Each state record should be stored as its own encrypted NIP-78-style addressable
event under the user's everyday Nostr identity or a future application-state
identity.

Proposed event:

```json
{
  "pubkey": "<everyday-or-app-state-pubkey>",
  "created_at": 1784750000,
  "kind": 30078,
  "tags": [
    ["d", "bitlogin:app-state:<opaque-record-id>"]
  ],
  "content": "<encoded-encrypted-envelope>",
  "sig": "<signature>"
}
```

The public `d` tag should use an opaque deterministic or random identifier so
relays do not learn the application ID or record key.

A possible opaque identifier is:

```text
base64url(
  SHA256(
    "bitlogin/app-state-id/v1"
    || 0x00
    || application_id
    || 0x00
    || record_key
  )
)
```

If deterministic IDs are used, clients must acknowledge that observers who
already know the exact application ID and record key may test guesses. A keyed
identifier derived from an app-state root provides stronger privacy and is
preferred for the final protocol.

## 8. Encryption key hierarchy

The final design should use a stable application-state root that survives
password changes and ordinary identity use.

Two options require evaluation:

1. Derive app-state keys from a dedicated random root stored in both capsules.
2. Derive app-state keys from the Connection Vault root with strict domain
   separation.

The dedicated-root option provides stronger compartmentalization. Reusing the
Connection Vault root reduces capsule expansion but couples settings recovery to
the higher-value credential vault.

A proposed dedicated construction is:

```text
app_state_prk = HKDF-Extract(
  salt = SHA256("bitlogin/app-state-root/v1"),
  IKM = application_state_root
)
```

Then derive one key per application and record:

```text
record_key = HKDF-Expand(
  app_state_prk,
  "bitlogin/app-state-record/v1"
    || 0x00
    || application_id
    || 0x00
    || record_key_name,
  32
)
```

Exact encoding, normalization, and test vectors must be fixed before
implementation.

## 9. Plaintext schema

```json
{
  "schema": "bitlogin.app-state.v1",
  "application_id": "network.bitroad",
  "record_key": "preferences/editor",
  "generation": 7,
  "created_at": 1784700000,
  "updated_at": 1784750000,
  "content_type": "application/json",
  "data": {
    "compactMode": true,
    "defaultCurrency": "sat"
  }
}
```

Required fields:

- `schema`
- `application_id`
- `record_key`
- `generation`
- `created_at`
- `updated_at`
- `content_type`
- `data`

Initial supported content type:

```text
application/json
```

Binary content and arbitrary executable code are prohibited.

## 10. Encryption and padding

Records should reuse BitLogin's audited primitives where possible:

- RFC 8785 canonical JSON serialization
- AES-256-GCM
- Fresh random 96-bit nonce per publication
- Context-bound associated data
- Fixed-size plaintext buckets

Proposed associated data:

```text
bitlogin|app-state|v1|<author-pubkey>|30078|<d-tag>
```

The app-state specification may require larger buckets than the identity
capsules. Relay limits must be checked before publication.

## 11. Reading and writing

Conceptual application API:

```javascript
const state = await bitlogin.appState.get({
  applicationId: "network.bitroad",
  recordKey: "preferences/editor"
});

await bitlogin.appState.put({
  applicationId: "network.bitroad",
  recordKey: "preferences/editor",
  data: {
    compactMode: true,
    defaultCurrency: "sat"
  }
});
```

The host application must not receive keys for other applications' namespaces.

## 12. Authorization

An application should receive permission to access only its own namespace by
default.

Suggested permission screen:

```text
BitRoad wants to:

✓ Read BitRoad settings stored through BitLogin
✓ Update BitRoad settings
✗ Read settings belonging to other applications

[Not now] [Allow]
```

Optional scopes:

```text
app-state:read
app-state:write
app-state:delete
app-state:export
```

Permissions should bind to:

- Application ID
- Requesting origin
- Optional application pubkey
- Allowed record-key prefixes
- Expiration or persistence choice

## 13. Conflict handling

Nostr addressable events use last-write-wins replacement. BitLogin should reduce
surprise by including:

- Monotonic `generation`
- Monotonic event timestamps
- Local high-water marks
- Previous-event ID where useful
- Optional application-level merge metadata

When two devices update the same record concurrently, BitLogin may:

1. Accept the newest valid event.
2. Surface a conflict to the application.
3. Preserve the losing plaintext locally long enough for user recovery.
4. Allow the application to merge records and publish a new generation.

BitLogin must not attempt semantic merging of arbitrary application data.

## 14. Local cache

Decrypted app state may be cached locally for performance, namespaced by:

```text
account -> application -> record
```

Cache entries must be cleared when:

- The account logs out.
- The account is removed from the device.
- The user deletes the record.
- The application's permission is revoked, when configured to clear local data.

Applications should receive immutable copies rather than references to shared
internal state.

## 15. Deletion

Deleting a state record should:

1. Publish an encrypted tombstone for the addressable record.
2. Publish a NIP-09 deletion request for the prior event where appropriate.
3. Retain a local deletion high-water mark.
4. Clear decrypted local cache.
5. Notify the application.

Deletion from BitLogin does not guarantee every relay or third-party app has
deleted prior copies.

## 16. Export and migration

Users should be able to export:

- All encrypted app-state events
- Records for one application
- One logical record
- A user-readable decrypted export after explicit confirmation

Encrypted BitLogin recovery exports should include the latest state events and
tombstones so the user's app experience can be restored even if relays lose the
records.

## 17. Privacy and security

Application state may reveal sensitive preferences, subscriptions, block lists,
health-related choices, or private workflow information.

Implementations must:

- Encrypt all non-public state locally.
- Avoid application IDs and record names in public tags where practical.
- Never include plaintext state in logs or analytics.
- Prevent one app from reading another app's namespace.
- Show the requesting account and origin during authorization.
- Treat HTML, scripts, and executable payloads as untrusted data.
- Enforce size and nesting limits before parsing.
- Clear decrypted state when sessions lock or permissions are revoked.

A malicious BitLogin client or compromised device can still read all state
available in that session.

## 18. Acceptance criteria

The feature is complete when:

1. A compatible app can write at least two independent encrypted records.
2. A clean device can restore those records after BitLogin login or recovery.
3. Updating one record does not replace another record.
4. One application cannot read another application's state through the public
   API.
5. Conflicting generations are detected and surfaced.
6. Deleted records do not silently reappear from stale relay results on a device
   with a newer high-water mark.
7. App-state events are included in encrypted account exports.
8. Switching BitLogin accounts switches the entire visible app-state namespace.
9. Relay-visible metadata does not expose plaintext application content.
10. Invalid, oversized, or unsupported records fail closed.

## 19. Recommended implementation order

1. Finalize the key root and opaque record-ID design.
2. Implement local encrypted records and validation.
3. Add per-application namespace authorization.
4. Add relay synchronization and quorum readback.
5. Add rollback and conflict detection.
6. Add export, deletion, and account-switch integration.
7. Publish test vectors and a minimal example application.
