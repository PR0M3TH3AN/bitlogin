# SeedPass interop — managed accounts groundwork

Status: pointer / pre-work — 2026-08-18. Nothing in this repo implements it yet.

## Where the shared spec lives (and why not here)

The **SeedPass Vault & Identity Specification** is the format contract for the
planned managed-accounts direction: one deterministic BIP-85 account tree that
SeedPass (the sovereign superset) and BitLogin (an identity-management subset
client) operate together, without requiring each other.

Canonical location:

> `SeedPass/docs/seedpass_vault_identity_spec.md`
> (branch `port/typescript-web-extension` until PR #989 merges, then `main`)

It deliberately lives in the SeedPass repo, not here, because that is where
its **conformance oracle** lives: the spec is extracted from working code, and
`scripts/cross_impl_check.py` (38 checks) plus the Python-generated fixtures
in `js/packages/test-vectors/` are what a conforming implementation tests
against. The spec's own change-control section says that where the document
and the code disagree, the code and the cross-impl suite win. A copy here
would drift — the exact failure the spec's preservation rules exist to
prevent. Do not vendor it; link it.

## The load-bearing rules (summary, not a substitute for reading it)

- **Entry index = permanent cryptographic coordinate.** "Alice is managed
  account #184" regenerates the same identity forever. Allocation is
  watermark-based and ids are never reused, even across sync deletion
  (spec §7).
- **No shadow account numbers** (§8.4): BitLogin must never keep its own
  mapping of account numbers to derivation indexes. The entry id is the
  account number.
- **Namespaced metadata** (§8.3): BitLogin's own data (roles, permissions,
  org records) goes in `bitlogin:`-namespaced fields or `bitlogin_*` record
  kinds. Both SeedPass implementations already carry unknown kinds through
  byte-for-byte (enforced by cross-impl Phase L).
- **Rank and independence rules for capsule unlock** (§11.1): a managed
  identity must never be able to unlock the root that provisioned it, and an
  unlocking key must not derive from the vault it unlocks. Normative — design
  against them from the start.
- **Subset writing** (§8.5): implement `managed_account` + `nostr` + your own
  namespaced kinds; never create kinds you cannot correctly derive.

## What this repo would consume

- **`@seedpass/core`** (TypeScript, browser-safe: WebCrypto + noble/scure) —
  the same library the SeedPass CLI uses. Importing it makes derivation
  agreement true by construction rather than by re-implementation; the
  Python implementation remains the independent cross-check.
- **The fixtures + cross-impl suite** as the conformance test: any vault
  BitLogin touches must survive a SeedPass open-and-save round trip
  unchanged, and vice versa (spec §8.6).

## Relationship to `docs/spec.md` (BitLogin v0.6)

This repo's existing spec covers the current product: portable Nostr accounts
(login name + password + recovery phrase, encrypted capsules on relays).
The SeedPass interop is a **future layer**, not a replacement — managed
accounts would make BitLogin an interface to a SeedPass-rooted deterministic
tree, per the rules above. Reconciling the two specs (in particular: this
repo's capsule format vs SeedPass §11.1 capsule unlock, and whether a
BitLogin account's keypair can be a SeedPass-derived child) is the first
design task when that work starts.

## Preconditions before building on this

1. SeedPass PR #989 (independent security review of the TypeScript core)
   lands and merges. Everything above sits on `@seedpass/core`; do not build
   an identity product on it before that review.
2. `@seedpass/core` is published (or vendored by commit pin) — it is not on
   npm yet.
