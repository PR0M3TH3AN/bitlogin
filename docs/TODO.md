# BitLogin — open items

Updated: 2026-07-31

## Entropy audit (2026-07-31)

[`entropy-audit-2026-07-31.md`](./entropy-audit-2026-07-31.md) — RNG and
randomness-integration audit. **No predictable-fallback defect:** `random.ts`
is the single chokepoint, throws rather than degrading, and rejection-samples to
avoid modulo bias. Three hardening items, in order:

- **M2** — nothing tests that the RNG fails closed. Do this first; it is
  additive, cannot touch the derivation chain, and it is what stops M1's fix
  from regressing later.
- **M1** — `nonceOverride` / `ivOverride` are reachable from the public
  `@bitlogin/core/crypto` surface. Move behind a non-exported test module.
- **L1** — `Math.random` in the backup-quiz word picker (`element.ts:1471`).
  Not a secret, but it forces a standing exception in any `Math.random` ban rule.

## Owner action items

1. **Close the Dependabot PR on
   `dependabot/npm_and_yarn/npm-security-and-maintenance-83024bc549`.** It
   bundles seven major bumps into one change (`@noble/hashes` 1.8→2.2,
   `@noble/curves` 1.9→2.2, `@scure/base` 1.2→2.2, `@scure/bip39` 1.6→2.2,
   TypeScript 5→7, Vite 6→8, Vitest 3→4) and fails the build: noble v2 dropped
   the extensionless subpath exports this code imports. It should be closed,
   not merged or fixed — `.github/dependabot.yml` now groups only minor/patch
   and ignores majors of the derivation chain, so this PR will not recur.

   The four `dependabot/github_actions/*` PRs are unaffected and fine to merge.

2. **Decide whether the manual-password removal is final.** User-chosen
   passwords were removed entirely (not merely discouraged) in the 2026-07-31
   hardening, and `packages/widget/src/securityPolicy.test.ts` pins that. The
   security argument is sound — a user-chosen password against a downloadable
   capsule is offline-guessable forever — but it is a product decision that
   changes what users can do, and it is now enforced by a test rather than by
   preference.

## Standing rule: the derivation chain is a compatibility contract

Account capsules live on public relays. The login name plus password derive the
locator, signing scalar and capsule key deterministically, so those outputs are
a contract with every account that already exists — change them and users are
locked out permanently, with no server-side record to migrate from.

`packages/core/src/crypto/knownAnswer.test.ts` pins HKDF-Extract, HKDF-Expand,
ScalarExpand (scalar, counter, and resulting public key), BIP-39 phrase and
seed, base64url framing, and JCS ordering.

**A failure there is never "update the expected value".** It means the change
being attempted is account-breaking and needs a migration plan or rejection.
The rest of the crypto suite only checks self-consistency — same input, same
output within one run — which stays green through exactly the kind of upgrade
that would lock everyone out.

## Deferred hardening

Carried from the 2026-07-30 audit; none are live defects.

- **Tier 2** — `packages/widget/src/element.ts` is ~1,600 lines with no direct
  test coverage. `securityPolicy.test.ts` now asserts a few properties of its
  source text, which is a start, not coverage.
- **Tier 3** — compare-and-swap on capsule writes (relays offer no atomic
  primitive, so this needs a protocol-level answer), and an encrypted
  high-water-mark store.
- **Tier 4** — moving high-value authorization into a cross-origin or extension
  boundary. An embedded widget is same-origin with its host page, so a
  compromised host can reach the worker directly. Documented honestly in
  `llms.txt` and the README rather than papered over.

## Gates still in force

- **External security review before the vault holds anything beyond a
  budget-capped NWC connection.** The S3 and password profiles stay designs
  until then.
- Personal-tier UI was gated on the sudo key leaving the credential capsule.
  That gate is now **met** — the sudo key lives only in the phrase-gated
  recovery capsule — but the UI still needs a separately reviewed key
  ceremony before it ships.
