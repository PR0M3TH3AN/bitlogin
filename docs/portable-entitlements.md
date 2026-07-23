# BitLogin Portable Purchases and Entitlements

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

## 1. Summary

BitLogin should be able to discover, verify, organize, and restore signed records
that prove a user owns or may access a digital product, service, membership, or
application capability.

Examples include:

- Paid BitVid videos
- BitRoad digital purchases
- Software licenses
- Membership access
- Download rights
- AI usage credits
- Game ownership and downloadable content
- Time-limited subscriptions

BitLogin is not the seller, payment processor, or final entitlement issuer. It is
a portable resolver and library for user-owned access records.

```text
Seller or service
        |
        +-- verifies payment or qualification
        +-- issues signed entitlement
        |
BitLogin
        +-- discovers and verifies entitlement
        +-- restores it on new devices
        +-- presents it in the user's library
        |
Compatible application
        `-- grants the specified access
```

## 2. Motivation

Conventional digital purchases are usually tied to a vendor account database.
If the storefront disappears, blocks the user, changes its interface, or loses
its records, the user's access may disappear with it.

Nostr and signed records make a more portable model possible, but users still
need a dependable way to:

- Find their purchase records
- Verify who issued them
- Understand what rights they grant
- Detect expiration or revocation
- Restore them on another device
- Open the correct compatible application

The product goal is:

> A user's digital ownership should follow the user rather than remain trapped
> inside one storefront account.

## 3. Roles

### 3.1 Issuer

The issuer signs the entitlement. It may be:

- A seller
- A creator
- BitUnlock acting under a seller-defined policy
- A membership organization
- A software publisher
- A service provider

The issuer is authoritative for what was granted, subject to the issuer policy
and any revocation mechanism defined by the entitlement.

### 3.2 Subject

The subject is the identity or private recipient for whom the entitlement was
issued.

The subject may be represented by:

- The user's everyday Nostr public key
- A pairwise or application-specific public key
- An encrypted recipient binding
- A transferable bearer secret, when explicitly supported

Publicly binding purchases to the user's social identity may reveal sensitive
commercial activity. Private recipient binding should be preferred.

### 3.3 Resolver

BitLogin discovers, validates, indexes, and displays entitlements. It does not
create rights by itself.

### 3.4 Consumer

A compatible application reads a verified entitlement and decides whether to
grant access to the named resource or capability.

## 4. Entitlement model

A portable entitlement should answer:

- Who issued it?
- Who may use it?
- What product or resource does it concern?
- Which rights were granted?
- When was it issued?
- Does it expire?
- Can it be revoked or replaced?
- Which application or protocol can consume it?

Conceptual plaintext:

```json
{
  "schema": "bitlogin.entitlement.v1",
  "entitlement_id": "opaque-random-id",
  "issuer": "<issuer-pubkey>",
  "subject": {
    "type": "nostr-pubkey",
    "value": "<buyer-pubkey>"
  },
  "product": {
    "issuer_namespace": "network.bitroad",
    "product_id": "brushforge-pro"
  },
  "rights": [
    "download",
    "updates"
  ],
  "issued_at": 1784750000,
  "not_before": 1784750000,
  "expires_at": null,
  "revocation": {
    "mode": "replaceable-status-event"
  },
  "consumer_hints": [
    "network.bitroad",
    "app.brushforge"
  ],
  "metadata": {
    "display_name": "BrushForge Pro"
  }
}
```

The final wire format may be a dedicated Nostr event, an encrypted NIP-44
delivery, or a durable signed object referenced by another event. The important
property is that the issuer's signature remains independently verifiable.

## 5. Rights

Rights must be explicit strings interpreted within the product or issuer
namespace.

Examples:

```text
stream
download
updates
commercial-use
member-access
inference-credit
multiplayer-access
```

A right name alone is not globally authoritative. Consumers must interpret it in
combination with:

- Issuer
- Product namespace
- Product ID
- Schema version
- Optional parameters

Parameterized rights may include limits:

```json
{
  "name": "inference-credit",
  "amount": 50000,
  "unit": "tokens"
}
```

Server-authoritative consumable balances should not be inferred solely from a
static entitlement unless the protocol defines a signed balance-update or
spend-proof mechanism.

## 6. Privacy modes

### 6.1 Public entitlement

The entitlement publicly names the buyer's Nostr pubkey. This is simple but may
reveal purchases, memberships, or viewing history.

### 6.2 Encrypted entitlement

The issuer encrypts the signed entitlement to the buyer. Relays can see an event
but not its product or recipient details.

### 6.3 Pairwise recipient

The entitlement names an app-specific or seller-specific identity rather than
the user's public social identity.

### 6.4 Bearer entitlement

Possession of a secret grants access. This supports transferability but behaves
more like a redeemable ticket and requires strong protection against copying.

The default BitLogin experience should prefer encrypted, non-transferable
entitlements bound to a user-controlled key.

## 7. Discovery

BitLogin may discover entitlements from:

- The user's encrypted inbox
- Seller or issuer outbox relays
- BitUnlock fulfillment records
- BitRoad purchase records
- A user-selected entitlement relay
- An encrypted account export
- Direct file or QR-code import
- Application-provided entitlement references

Discovery should not rely on one centralized BitLogin index.

The client should maintain local cursors and issuer trust metadata so repeated
syncs are efficient.

## 8. Verification

Before displaying an entitlement as valid, BitLogin must verify:

1. The event or object signature is valid.
2. The declared issuer matches the signing key.
3. The schema version is supported.
4. The subject matches the active BitLogin account or an authorized identity.
5. The entitlement ID and product identifiers are well formed.
6. `not_before` and `expires_at` are satisfied.
7. The entitlement has not been replaced, revoked, or superseded according to
   its declared revocation model.
8. Required issuer-policy information is available.
9. The record is not a known rollback below the local high-water mark.
10. Unknown mandatory fields cause validation to fail closed.

A valid signature proves who issued the record. It does not prove that the
issuer is trustworthy or that the product description is honest.

## 9. Issuer trust

BitLogin should distinguish cryptographic validity from user trust.

Possible issuer states:

```text
verified by user
recognized from purchase context
recognized application issuer
unknown
blocked
```

The interface should show:

- Issuer identity
- Product namespace
- How the entitlement was discovered
- Whether the issuer is recognized
- Whether the entitlement is current, expired, or revoked

BitLogin must not label an unknown issuer as verified merely because its
signature is valid.

## 10. Revocation and replacement

Different products require different policies.

Supported models may include:

```text
none
issuer replacement event
issuer revocation list
per-entitlement status event
expiration only
consumed-once receipt
```

Revocation must be defined when the entitlement is issued. BitLogin must not
invent revocation authority after the fact.

For durable purchases, irrevocable or narrowly revocable rights may be desirable.
For subscriptions, memberships, or fraud response, issuer-controlled expiration
and revocation may be necessary.

The user interface should state the applicable policy clearly.

## 11. Local entitlement index

BitLogin may maintain an encrypted local index optimized for the user's library.

Example:

```json
{
  "entitlement_id": "opaque-random-id",
  "issuer": "<pubkey>",
  "product_id": "brushforge-pro",
  "status": "active",
  "rights": ["download", "updates"],
  "expires_at": null,
  "source_event_id": "<event-id>",
  "last_verified_at": 1784750000
}
```

The index is a cache, not the source of authority. It must be rebuildable from
signed entitlement records and status events.

Indexes must be namespaced by BitLogin account.

## 12. User library

Suggested interface:

```text
Your Library

BrushForge Pro
Lifetime download and updates
Issued by PR0M3TH3AN
[Open] [View proof]

The Bitcoin Reformation
Streaming access
Issued by Example Creator
[Watch] [View proof]

Community Membership
Expires August 22, 2026
Issued by Example Community
[Open] [View status]
```

Filters may include:

- Active
- Expired
- Revoked
- Downloads
- Videos
- Memberships
- Software
- Unknown issuer

## 13. Application API

Conceptual API:

```javascript
const entitlements = await bitlogin.entitlements.query({
  product: {
    issuerNamespace: "network.bitroad",
    productId: "brushforge-pro"
  },
  status: "active"
});

const result = await bitlogin.entitlements.verify({
  entitlementId: entitlements[0].id
});
```

Applications should receive the minimum proof necessary. BitLogin should not
expose unrelated purchase history to an application.

Permission scopes may include:

```text
entitlements:query-own-products
entitlements:verify
entitlements:open
```

An app should be restricted to its own issuer or product namespace unless the
user grants broader library access.

## 14. BitRoad and BitUnlock integration

A natural project flow is:

```text
BitRoad
  creates the product and purchase intent

BitUnlock
  verifies payment or access conditions
  issues buyer-specific fulfillment and entitlement

BitLogin
  discovers, validates, stores, and restores the entitlement

BitVid or another compatible app
  verifies the entitlement and grants access
```

BitLogin should verify issuer signatures directly rather than trusting a claim
from the consuming application.

## 15. Export and recovery

Encrypted BitLogin exports should include:

- Signed entitlement records
- Encrypted delivery events where needed
- Latest revocation or replacement records
- Issuer metadata selected by the user
- Local verification high-water marks

A clean device should be able to rebuild the user's library from relays and the
export without relying on the original browser database.

Decrypted human-readable export should require explicit confirmation because it
may expose sensitive purchase history.

## 16. Account switching

Each BitLogin account has an independent entitlement library.

Switching accounts must atomically switch:

- Subject identity
- Decryption keys
- Entitlement index
- Relay cursors
- Trusted and blocked issuer settings
- Visible library

An application must never receive an entitlement belonging to the previously
active account after a switch.

## 17. Security considerations

Entitlements can reveal purchases, affiliations, medical interests, media
consumption, and financial behavior.

Implementations must:

- Prefer encrypted delivery.
- Minimize public recipient linkage.
- Never place purchase history in analytics or logs.
- Scope app queries to relevant products.
- Distinguish valid signatures from trusted issuers.
- Detect stale revocation state where possible.
- Treat imported entitlement files as untrusted input.
- Avoid granting access based on display metadata alone.
- Keep issuer and product identifiers stable and versioned.

A compromised issuer key may allow fraudulent entitlements or revocations. Key
rotation and issuer-transition mechanisms will require a separate specification.

## 18. Acceptance criteria

The initial entitlement resolver is complete when:

1. BitLogin can import or discover a signed entitlement.
2. It verifies issuer, recipient, schema, dates, and signature.
3. It displays the entitlement separately from unverified claims.
4. A clean device can restore the entitlement from relays or encrypted export.
5. A compatible app can query only entitlements relevant to its product scope.
6. Expiration and at least one revocation model are supported.
7. Account switching completely isolates entitlement libraries.
8. Unknown issuers are labeled accurately.
9. The local library index is rebuildable from signed records.
10. Invalid, malformed, stale, or wrong-recipient records fail closed.

## 19. Recommended implementation order

1. Finalize the signed entitlement schema and privacy modes.
2. Implement local import and signature verification.
3. Add an encrypted entitlement index and library interface.
4. Integrate one BitUnlock-issued entitlement end to end.
5. Add relay discovery and clean-device restoration.
6. Add expiration and revocation resolution.
7. Add application-scoped query APIs.
8. Add BitRoad and BitVid integrations.
9. Publish test vectors and an independent verification example.
