# BitLogin Documentation

BitLogin is a static, relay-backed portable account protocol that gives users a
familiar login name and password while preserving a user-controlled Nostr
identity and independent phrase recovery.

This directory contains the core protocol specification, implementation notes,
and experimental designs for expanding BitLogin into a portable account layer
for compatible applications.

## Core protocol

- [`spec.md`](./spec.md) — canonical BitLogin protocol specification
- [`second-factor.md`](./second-factor.md) — second-factor design notes

## Portable account layer

These documents describe proposed capabilities that build on BitLogin's core
identity and recovery model.

- [`account-switching.md`](./account-switching.md) — multiple independent
  accounts on one device, fast switching, locking, logout, and account-aware
  signer behavior
- [`portable-app-state.md`](./portable-app-state.md) — encrypted, user-owned
  application settings and lightweight state that follow the account across
  devices
- [`portable-entitlements.md`](./portable-entitlements.md) — discovery,
  verification, recovery, and presentation of purchases, licenses,
  memberships, and access rights
- [`relay-and-messaging-portability.md`](./relay-and-messaging-portability.md) —
  relay-role management, DM inbox and outbox synchronization, sent-message
  recovery, and conversation reconstruction

## Connection Vault

The Connection Vault is an experimental design for portable application
credentials. It deliberately stores mutable credentials outside the core
identity capsules as independently encrypted records.

- [`connection-vault.md`](./connection-vault.md) — overall vault architecture,
  key hierarchy, relay storage, authorization, recovery, and deletion
- [`nwc-connections.md`](./nwc-connections.md) — Nostr Wallet Connect credential
  profile
- [`s3c-format.md`](./s3c-format.md) — portable `s3c1:` format for S3-compatible
  storage connections

## How the pieces fit together

```text
BitLogin account
├── Identity and recovery
│   ├── Credential capsule
│   ├── Recovery capsule
│   └── Everyday Nostr identity
│
├── Accounts and sessions
│   └── Multiple-account switching
│
├── Communication
│   ├── Relay preferences
│   ├── DM inbox synchronization
│   ├── DM outbox and sent-message recovery
│   └── Conversation reconstruction
│
├── Portable application experience
│   ├── App settings
│   ├── Saved state
│   └── Per-app authorization
│
├── Ownership
│   ├── Purchases
│   ├── Licenses
│   ├── Memberships
│   └── Access entitlements
│
└── Connection Vault
    ├── NWC wallet connections
    ├── S3-compatible storage connections
    └── Future service credentials
```

## Status terminology

Documents use these labels:

- **Implemented** — available in the current codebase
- **Partially implemented** — some required primitives or flows exist, but the
  complete user-facing feature does not
- **Experimental design** — documented for review and future implementation;
  wire formats and APIs may change

Experimental documents are not part of the stable BitLogin protocol until their
schemas, security properties, migrations, and test vectors are finalized.

## Recommended product sequence

A practical development sequence is:

1. Complete the core account and messaging foundations.
2. Add independent multi-account sessions and switching.
3. Add relay management, inbox synchronization, and sent-message recovery.
4. Add portable application state and per-app permissions.
5. Add entitlement discovery and a portable ownership library.
6. Implement the Connection Vault and its NWC and S3 profiles.
7. Move high-value authorization into stronger extension, native, or
   cross-origin execution boundaries.

## Design principle

> BitLogin should coordinate portable identity, state, ownership, and service
> access without becoming the centralized custodian of the user's identity,
> money, files, messages, or purchases.
