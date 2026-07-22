# BitLogin Connection Vault

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

## 1. Summary

The BitLogin Connection Vault is a proposed encrypted, relay-backed store for
portable application credentials such as:

- Nostr Wallet Connect (NWC) connections
- S3-compatible storage credentials
- Future API tokens, signer grants, and application-specific secrets

The Connection Vault extends BitLogin from portable identity into portable
application authorization:

```text
BitLogin account
    |
    +-- portable Nostr identity
    +-- portable wallet connections
    +-- portable storage connections
    `-- future application credentials
```

The vault does **not** place wallet strings, storage access keys, or other
frequently managed secrets directly inside the credential or recovery capsule.
Instead, the capsules carry only a stable vault root. Each connection is stored
as its own independently replaceable encrypted Nostr record.

This preserves the current capsule design principle: capsules contain only
infrequently changed access material, while ordinary mutable state lives in
separate records.

## 2. Motivation

Nostr applications commonly ask users to repeat setup that should be portable:

- Paste or scan an NWC URI for every wallet-enabled application.
- Re-enter an S3 endpoint, bucket, access-key ID, and secret key on every device.
- Repeat the process after clearing browser data or switching clients.
- Manually remember which application received which credential.

BitLogin already restores the same user-controlled identity on a clean device.
The Connection Vault applies that portability to application connections while
keeping each credential independently revocable and replaceable.

The product goal is:

> Sign in once, connect a service once, and authorize compatible applications
> when needed.

## 3. Goals

The Connection Vault should:

1. Restore connections on a clean device after BitLogin authentication or
   phrase recovery.
2. Keep individual connection records separate to avoid multi-device
   last-write-wins clobbering.
3. Support multiple connections of the same type.
4. Encourage one credential per application or permission profile.
5. Allow credentials to be revoked, replaced, renamed, and exported
   independently.
6. Keep connection types and contents encrypted from relays where practical.
7. Survive everyday Nostr identity rotation.
8. Reuse BitLogin's existing cryptographic primitives, canonical serialization,
   padding, relay quorum, and validation rules.
9. Permit later extension to native applications, browser extensions, remote
   signers, and hardware-backed authorization.

## 4. Non-goals

The Connection Vault is not:

- A wallet.
- An S3 proxy.
- A guarantee that an application obeys a displayed permission request.
- A replacement for provider-side NWC budgets or S3 IAM policies.
- A defense against a malicious BitLogin build or compromised device.
- A mechanism for silently sharing all stored credentials with every app.
- A place to store cryptocurrency seed phrases.

## 5. Relationship to the identity capsules

### 5.1 Secrets do not live directly in the capsules

The credential capsule is replaced wholesale and should be rewritten only for
credential events. The recovery capsule is intentionally minimal and is
written only while the recovery phrase is present.

Putting mutable NWC and S3 credentials directly into either capsule would:

- Expand the highest-value encrypted payload.
- Require a capsule rewrite whenever a connection changes.
- Increase multi-device replacement conflicts.
- Couple ordinary app administration to password and recovery state.
- Make independent deletion and rotation difficult.

Therefore connection records live outside both capsules.

### 5.2 Stable vault root

A future capsule schema may add one new infrequently changed field:

```json
{
  "connection_vault_root": "base64url-32-random-bytes"
}
```

The same 32-byte random value must be present in both the credential and
recovery payloads. It is generated once when the Connection Vault is enabled
and does not change during normal use.

This root is not an application credential. It is key material used to locate,
sign, encrypt, and decrypt the independent connection records.

A stable root is preferred over deriving the vault directly from the everyday
Nostr private key because the everyday identity may be rotated. Wallet and
storage connections should remain recoverable after that rotation.

### 5.3 Existing-account migration

Adding the vault root to an existing account requires the recovery phrase.
A password-only migration is insufficient because it could update the
credential capsule without updating the phrase-recovery path.

The migration flow should be:

```text
User unlocks account
    |
    +-- enters and verifies recovery phrase
    +-- client generates connection_vault_root
    +-- client writes refreshed recovery capsule
    +-- client writes updated credential capsule
    `-- client verifies quorum readback for both
```

A migration must fail closed if either capsule cannot be written and verified.

## 6. Key hierarchy

The following construction is proposed for a future protocol version. Exact
constants and test vectors must be finalized before implementation.

```text
vault_prk = HKDF-Extract(
  salt = SHA256("bitlogin/connection-vault-root/v1"),
  IKM = connection_vault_root
)
```

Derive a Nostr-compatible signing identity:

```text
vault_signing_material = ScalarExpand(
  vault_prk,
  "bitlogin/connection-vault-signing/v1"
)
```

Derive a record encryption key independently for every connection:

```text
record_key = HKDF-Expand(
  vault_prk,
  "bitlogin/connection-record-encryption/v1"
    || 0x00
    || connection_id_bytes,
  32
)
```

The same raw material must never be used directly for both signing and
content encryption.

## 7. Connection identifiers

Each connection receives a random 128-bit identifier encoded as unpadded
base64url:

```text
Vx7LgdZCsVbT_2uvB0YoGA
```

Requirements:

- Generated with a cryptographically secure random generator.
- Exactly 16 random bytes before encoding.
- Never derived from an endpoint, wallet pubkey, application origin, label, or
  secret.
- Stable for the lifetime of the logical connection.
- Regenerated when importing as a distinct copy unless the user explicitly
  chooses to replace an existing connection.

The identifier is not a secret, but it must not contain meaningful metadata.

## 8. Nostr record format

### 8.1 Event

Each connection is stored as its own NIP-78-style addressable event:

```json
{
  "pubkey": "<connection-vault-public-key>",
  "created_at": 1784750000,
  "kind": 30078,
  "tags": [
    ["d", "bitlogin:connection:Vx7LgdZCsVbT_2uvB0YoGA"]
  ],
  "content": "<encoded-encrypted-envelope>",
  "sig": "<vault-signature>"
}
```

The `d` tag deliberately contains only the generic BitLogin connection prefix
and an opaque identifier. It does not reveal whether the record contains NWC,
S3, or another credential type.

The event is signed by the derived Connection Vault identity, not the user's
public everyday identity. This reduces direct linkage between the public
profile and the existence or timing of stored application credentials.

### 8.2 Encrypted envelope

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "nonce": "<base64url-12-random-bytes>",
  "ciphertext": "<base64url>"
}
```

The plaintext is canonically serialized using RFC 8785 JCS, padded using the
same fixed-bucket method as BitLogin capsules, and encrypted with the
connection-specific `record_key`.

Associated data:

```text
bitlogin|connection-record|v1|<vault-pubkey>|30078|<d-tag>
```

A fresh random 96-bit nonce is required for every publication. A nonce must
never be reused with the same record key.

### 8.3 Common plaintext record

```json
{
  "schema": "bitlogin.connection.v1",
  "connection_id": "Vx7LgdZCsVbT_2uvB0YoGA",
  "connection_type": "nwc",
  "state": "active",
  "label": "Satisfied spending wallet",
  "created_at": 1784750000,
  "updated_at": 1784750000,
  "credential": {
    "schema": "bitlogin.connection.nwc.v1"
  },
  "application_binding": {
    "origin": "https://satisfied.example",
    "app_pubkey": null
  },
  "notes": null
}
```

Required common fields:

- `schema`
- `connection_id`
- `connection_type`
- `state`
- `created_at`
- `updated_at`
- `credential`

Allowed states:

```text
active
suspended
deleted
```

The credential object is defined by a connection profile such as
`nwc-connections.md` or `s3c-format.md`.

## 9. Per-record replacement

A connection update replaces only the event with the corresponding `d` tag.
No global array of connections is rewritten during ordinary use.

This means two devices editing different connections do not clobber each
other. Two devices editing the same connection still race according to Nostr
addressable-event replacement rules.

Clients must use BitLogin's monotonic replacement timestamp rule:

```text
new_created_at = max(current_time, previous_created_at + 1)
```

Clients should also keep a per-connection local generation or event-ID
high-water mark and warn or fail closed on a detected regression.

## 10. Discovery

A client derives the vault public key after login and queries configured vault
relays for:

```text
kind: 30078
author: <vault-pubkey>
```

It then selects events whose `d` tag begins with:

```text
bitlogin:connection:
```

Because Nostr relay filters generally match exact tag values rather than
prefixes, the client may need to retrieve the vault identity's kind-30078
events and filter locally.

The initial design deliberately avoids a single mutable index event. A global
index would recreate the multi-device clobbering problem that separate records
are intended to solve.

A future optimization may add a rebuildable encrypted index, but the index
must never be the sole source of truth.

## 11. Deletion and revocation

Deleting a BitLogin record does not revoke the underlying wallet or storage
credential.

A safe deletion flow is:

1. Offer or perform provider-side revocation first when supported.
2. Replace the record with an encrypted tombstone using `state: "deleted"`.
3. Publish a NIP-09 deletion request for the previous event ID.
4. Remove decrypted local copies and clear relevant grants.
5. Retain the tombstone high-water mark so stale relay replicas are not
   silently resurrected.

The interface must distinguish:

- **Remove from BitLogin** — deletes the portable record only.
- **Revoke credential** — invalidates authority at the wallet or storage
  provider.

## 12. Application authorization

### 12.1 Default behavior

BitLogin must not expose every stored credential automatically after login.
An application requests access to a particular connection or capability, and
the user approves or denies it.

Conceptual API:

```javascript
const connections = await bitlogin.connections.list({
  type: "nwc"
});

const grant = await bitlogin.connections.requestAccess({
  connectionId: connections[0].id,
  operations: ["pay_invoice", "get_balance"],
  reason: "Pay for AI inference"
});
```

### 12.2 Reveal versus broker

There are two authorization modes:

1. **Reveal:** BitLogin returns the raw credential to the requesting app.
2. **Broker:** BitLogin keeps the credential and performs approved operations
   on the app's behalf.

Brokered access is preferred because the application never receives the
long-lived secret. Reveal mode is simpler but transfers all authority granted
by the underlying credential to the host application.

### 12.3 Browser security boundary

An embedded same-origin web component is not a security boundary against its
host page. A malicious page can inspect values returned to it and may be able
to interfere with same-origin execution.

Strong brokered isolation therefore requires one of:

- A cross-origin BitLogin authorization window or iframe with a carefully
  designed message protocol.
- A BitLogin browser extension.
- A native signer or credential broker.
- A NIP-46-style remote authorization service.

The initial static widget may implement reveal mode, but the interface must
state that the requesting origin receives the credential.

## 13. Recovery and export

### 13.1 Password login

The credential capsule restores the stable `connection_vault_root`, allowing
the client to derive the same vault identity and decrypt connection records.

### 13.2 Phrase recovery

The recovery capsule restores the same root. A clean device can therefore
recover connections without requiring the old password or prior browser data.

### 13.3 Everyday identity rotation

The Connection Vault root does not change when the public everyday Nostr
identity rotates. Connection records remain at the same vault identity and do
not require re-encryption solely because the public identity changed.

### 13.4 Account export

A full BitLogin recovery export should include:

- The encrypted credential and recovery capsules.
- Signed Connection Vault events.
- The latest encrypted tombstones.
- Vault relay hints and readback metadata.

The export must not contain decrypted NWC, S3, or other application credentials
unless the user explicitly selects a plainly labeled dangerous plaintext
export.

## 14. Connection profiles

Initial proposed profiles:

- `bitlogin.connection.nwc.v1` — Nostr Wallet Connect
- `bitlogin.connection.s3.v1` — S3-compatible object storage

Profiles define:

- Required credential fields.
- Import and export formats.
- Validation rules.
- Provider verification behavior.
- Revocation behavior.
- App-facing operations.
- Profile-specific security warnings.

## 15. Implementation phases

### Phase A: specification and test vectors

- Finalize capsule schema migration.
- Finalize key-derivation constants.
- Publish JCS, padding, encryption, and signed-event test vectors.
- Define valid and invalid profile fixtures.

### Phase B: local Connection Vault

- Add, edit, list, and remove connections locally.
- Encrypt records with the vault root.
- Add encrypted export and import.

### Phase C: relay synchronization

- Publish records to multiple vault relays.
- Require quorum readback.
- Add per-record rollback detection and replica repair.

### Phase D: application authorization

- Add permission prompts and connected-app management.
- Support explicit credential reveal.
- Add brokered operations where a safe execution boundary exists.

### Phase E: hardened clients

- Browser extension and native client.
- Cross-origin authorization protocol.
- Hardware-backed vault root where available.
- Independent security review.

## 16. Open decisions

The following require implementation review before the design becomes stable:

1. Exact new capsule schema identifiers and migration rules.
2. Whether Connection Vault records should reuse the capsule padding buckets or
   define larger buckets for storage-provider metadata.
3. Relay discovery and archival policy for the derived vault identity.
4. The precise app-origin and app-pubkey binding model.
5. Whether a rebuildable encrypted index is worthwhile.
6. How brokered grants are represented and revoked.
7. Whether the standalone S3C format should move to its own repository after a
   second independent implementation exists.

## 17. Security summary

The Connection Vault reduces setup friction, but it also concentrates valuable
bearer credentials behind one account. Implementations must treat it as a
high-value secret manager.

At minimum:

- Never log decrypted credentials.
- Never place credentials in analytics, exceptions, URLs, or application state.
- Clear secret-bearing DOM fields immediately after import.
- Keep plaintext values inside the crypto or broker worker for the shortest
  practical lifetime.
- Require explicit approval before reveal or export.
- Prefer separately scoped credentials for every application.
- Prefer temporary credentials, budgets, prefixes, and provider-side policy.
- Clearly distinguish BitLogin record deletion from provider-side revocation.
- Assume a malicious or compromised client can steal all secrets available in
  that session.
