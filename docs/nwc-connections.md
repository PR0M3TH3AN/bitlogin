# BitLogin NWC Connections

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

## 1. Summary

This document defines the proposed BitLogin Connection Vault profile for Nostr
Wallet Connect (NWC) credentials.

The profile allows a user to:

- Import an NWC connection once.
- Recover that connection on another BitLogin device.
- Keep separate wallet connections for separate applications.
- Inspect known wallet capabilities, budget information, and expiration.
- Explicitly reveal or broker wallet operations to compatible applications.
- Remove a stored connection without changing the BitLogin identity.

NWC credentials are stored as independent encrypted Connection Vault records.
They are never stored directly in the BitLogin credential or recovery capsule.
See `connection-vault.md` for the common record, encryption, synchronization,
and recovery model.

## 2. Terminology

- **Wallet service:** The NWC wallet endpoint that receives encrypted requests.
- **Client key:** The Nostr private key embedded in the NWC URI and used to sign
  requests to the wallet service.
- **Connection URI:** The complete `nostr+walletconnect://` URI supplied by the
  wallet provider.
- **Application binding:** Optional BitLogin metadata associating one stored
  connection with a particular application origin or Nostr application key.
- **Reveal mode:** BitLogin returns the raw NWC URI to an application.
- **Broker mode:** BitLogin keeps the NWC secret and performs approved NWC
  requests on behalf of the application.

## 3. Security model

An NWC URI is a bearer-style credential containing active signing authority.
Anyone who obtains the client secret can make every request permitted by the
wallet service for that connection.

BitLogin therefore treats the complete NWC URI and its client secret as
sensitive values.

The wallet service remains authoritative for:

- Supported NWC methods.
- Spending budgets.
- Maximum payment size.
- Rate limits.
- Expiration.
- Revocation.
- Any other wallet-side policy.

BitLogin may display cached or declared values, but it must not claim to enforce
wallet policy unless every request is brokered through an isolated BitLogin
execution boundary.

## 4. One connection per application

BitLogin should strongly encourage users and applications to create separate
NWC connections rather than reuse one universal credential.

Recommended arrangement:

```text
BitRoad       -> commerce wallet connection
Satisfied     -> AI inference spending connection
Game          -> low-budget in-game payment connection
Dashboard     -> read-only or reporting connection
```

Separate connections improve:

- Revocation.
- Budget assignment.
- Auditability.
- Application isolation.
- Privacy between unrelated applications.
- Damage containment after credential compromise.

Reusing one client key across applications should be shown as an advanced and
potentially unsafe choice.

## 5. Accepted import format

The initial profile accepts a standard NWC connection URI:

```text
nostr+walletconnect://<wallet-service-pubkey>?relay=<encoded-relay-url>&secret=<client-secret>&lud16=<encoded-lightning-address>
```

Example with non-secret placeholder values:

```text
nostr+walletconnect://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef?relay=wss%3A%2F%2Frelay.example&secret=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&lud16=adam%40example.com
```

The imported URI may include multiple `relay` query parameters. Unknown query
parameters must be retained for lossless export unless they are syntactically
invalid or explicitly prohibited by a later profile version.

The client must never place an imported URI in:

- Browser history.
- A page URL.
- Analytics.
- Logs.
- Error strings.
- Clipboard history without an explicit user copy action.
- Unencrypted local or relay storage.

## 6. Canonical internal credential

After import, BitLogin parses the URI and stores a structured credential object
rather than relying only on the original string.

```json
{
  "schema": "bitlogin.connection.nwc.v1",
  "wallet_service_pubkey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "client_secret": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "relays": [
    "wss://relay.example"
  ],
  "lud16": "adam@example.com",
  "extra_parameters": {},
  "declared_capabilities": [
    "pay_invoice",
    "get_balance"
  ],
  "declared_budget": {
    "amount_msats": 1000000,
    "period": "monthly"
  },
  "expires_at": null,
  "original_uri": null
}
```

Required fields:

- `schema`
- `wallet_service_pubkey`
- `client_secret`
- `relays`

Optional fields:

- `lud16`
- `extra_parameters`
- `declared_capabilities`
- `declared_budget`
- `expires_at`
- `original_uri`

`original_uri` should ordinarily be null. It may be retained only when lossless
round-trip compatibility cannot otherwise be achieved. When present, it is as
sensitive as the client secret.

## 7. Validation

An NWC import must fail if:

1. The scheme is not exactly `nostr+walletconnect`.
2. The wallet-service public key is not exactly 32 bytes encoded as 64 lowercase
   or uppercase hexadecimal characters.
3. The client secret is not exactly 32 bytes encoded as 64 hexadecimal
   characters or is not a valid secp256k1 private scalar.
4. No relay is present.
5. A relay URL does not use `wss://`, except for explicitly enabled local
   development using `ws://localhost` or loopback addresses.
6. A relay URL contains credentials.
7. The total URI or decoded metadata exceeds implementation limits.
8. Duplicate parameters conflict in a way the profile cannot interpret.
9. Percent encoding is malformed.

The parser should normalize:

- Hexadecimal keys to lowercase.
- Relay URL host casing according to URL rules.
- Duplicate identical relay URLs into one entry while preserving first-seen
  order.
- Empty optional parameters to null or omission.

The parser must not silently repair a malformed secret or wallet public key.

## 8. Complete Connection Vault record

Example decrypted record:

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
    "schema": "bitlogin.connection.nwc.v1",
    "wallet_service_pubkey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "client_secret": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "relays": [
      "wss://relay.example"
    ],
    "lud16": "adam@example.com",
    "extra_parameters": {},
    "declared_capabilities": [
      "pay_invoice",
      "get_balance"
    ],
    "declared_budget": {
      "amount_msats": 1000000,
      "period": "monthly"
    },
    "expires_at": null,
    "original_uri": null
  },
  "application_binding": {
    "origin": "https://satisfied.example",
    "app_pubkey": null
  },
  "notes": null
}
```

Labels, application bindings, declared capabilities, and declared budgets are
BitLogin metadata. They do not alter the actual authority granted by the wallet
service.

## 9. Capability discovery

After import, BitLogin may connect to the wallet service and request supported
NWC methods according to the current NWC protocol.

The result may be cached as `declared_capabilities`, but the interface must make
clear that:

- Wallet capabilities can change.
- A listed method may still fail.
- A missing cached method does not necessarily prove the wallet no longer
  supports it.
- Wallet-side policy is authoritative.

Capability refreshes update only the relevant NWC record.

## 10. Budgets and expiration

When the wallet service communicates budget or expiration information, BitLogin
may store a display-oriented snapshot:

```json
{
  "declared_budget": {
    "amount_msats": 1000000,
    "period": "monthly"
  },
  "expires_at": 1787356800
}
```

`expires_at` is a Unix timestamp in seconds.

These fields are descriptive unless BitLogin broker mode independently limits
all outgoing operations. Reveal mode necessarily gives the application the raw
credential, after which BitLogin cannot enforce its own budget.

## 11. Export

### 11.1 Reconstructed NWC URI

BitLogin may reconstruct a standard URI for explicit export:

```text
nostr+walletconnect://<wallet-service-pubkey>?relay=<relay>&secret=<client-secret>&lud16=<lud16>
```

Rules:

- Include one `relay` parameter per relay.
- Percent-encode all query values.
- Preserve unknown parameters from `extra_parameters`.
- Never include BitLogin-only labels, notes, budgets, or application bindings.
- Require user confirmation immediately before reveal or copy.
- Clear the displayed URI after the shortest practical interval.

### 11.2 Encrypted BitLogin export

A normal BitLogin account export includes the encrypted signed Connection Vault
record, not a plaintext NWC URI.

A plaintext export must be separately selected and prominently marked as
sensitive.

## 12. Application API

### 12.1 Listing metadata

An application may request non-secret connection metadata:

```javascript
const wallets = await bitlogin.wallet.list();
```

Possible result:

```json
[
  {
    "id": "Vx7LgdZCsVbT_2uvB0YoGA",
    "label": "Satisfied spending wallet",
    "lud16": "adam@example.com",
    "capabilities": ["pay_invoice", "get_balance"],
    "expiresAt": null
  }
]
```

The result must not include the client secret or full URI.

### 12.2 Access request

```javascript
const grant = await bitlogin.wallet.requestAccess({
  connectionId: "Vx7LgdZCsVbT_2uvB0YoGA",
  methods: ["pay_invoice", "get_balance"],
  reason: "Pay for AI inference",
  mode: "broker"
});
```

The user-facing prompt should display:

- Requesting origin or application identity.
- Selected wallet label.
- Requested methods.
- Requested maximum amount when relevant.
- Whether the raw credential will be revealed.
- Whether approval is once, for the session, or persistent.

### 12.3 Brokered execution

Conceptual API:

```javascript
const result = await bitlogin.wallet.execute({
  grantId: grant.id,
  method: "pay_invoice",
  params: {
    invoice: "lnbc..."
  }
});
```

A broker should reject:

- Methods not present in the grant.
- Expired grants.
- Requests from a different origin or application identity.
- Payment amounts above the approved BitLogin-side ceiling.
- Requests after the connection is suspended, deleted, expired, or revoked.

This BitLogin-side check is additive. The wallet service must still enforce its
own policy.

### 12.4 Reveal mode

Conceptual API:

```javascript
const uri = await bitlogin.wallet.revealConnection({
  connectionId: "Vx7LgdZCsVbT_2uvB0YoGA",
  reason: "Connect this wallet to the application"
});
```

Before returning the URI, BitLogin must warn:

> This application will receive a wallet credential. It can perform every
> action permitted by that connection until you revoke it at the wallet.

Reveal approval should not silently become a permanent grant.

## 13. Browser integration limitations

A same-origin embedded widget cannot keep an NWC URI secret from its host page
while simultaneously returning that URI to the host page.

For meaningful broker isolation, NWC signing and relay communication should run
inside:

- A BitLogin browser extension.
- A native BitLogin client.
- A cross-origin authorization window or iframe.
- A remote signer or broker with an authenticated protocol.

The initial widget may support metadata listing and explicit reveal mode, but it
must not present same-origin JavaScript isolation as a strong security boundary.

## 14. Revocation and deletion

BitLogin cannot generally revoke an NWC connection merely by deleting its local
or relay record. The connection must be revoked by the wallet service.

The user interface should provide:

1. **Open wallet to revoke** when a provider URL or supported mechanism exists.
2. **Mark suspended** to prevent BitLogin from offering the connection.
3. **Remove from BitLogin** to tombstone and delete the portable record.

After provider-side revocation, BitLogin should mark the connection deleted or
revoked and clear any persistent application grants.

A future provider-specific adapter may automate revocation, but the profile must
not assume all NWC wallet services support a common revocation API.

## 15. Privacy considerations

A Connection Vault record is authored by a dedicated vault identity rather than
the public everyday Nostr key. Nevertheless, correlation remains possible
through:

- Relay selection.
- IP address.
- Connection timing.
- Record publication timing.
- Wallet relay traffic.
- Reused NWC client keys.
- Reused wallet service pubkeys.

Clients should avoid fetching public profile data and private Connection Vault
records over the same relay connection where practical.

Users seeking stronger compartmentalization should use separate NWC connections
for separate applications.

## 16. Test vectors

Before implementation, the project should publish test vectors covering:

- Parsing one and multiple relay parameters.
- Percent-encoded `lud16` values.
- Unknown parameter preservation.
- Uppercase-to-lowercase hex normalization.
- Invalid public keys and client secrets.
- Invalid secp256k1 scalars.
- Insecure and malformed relay URLs.
- Canonical credential serialization.
- Encrypted Connection Vault event construction.
- Exported URI reconstruction.
- Tombstone replacement.

All examples in this document use non-production placeholder secrets and must
never be interpreted as usable wallet credentials.
