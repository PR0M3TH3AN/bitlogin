# BitLogin — open items

Updated: 2026-08-04

## Login-surface expansion (2026-08-04) — shipped, with owner follow-ups

One login surface, four methods (`login-methods.md`, `passkey-login.md`):
password (primary), NIP-07 extension, NIP-46 remote signer (memory-only),
and passkey via WebAuthn PRF. OAuth on-ramps were built, then removed the
same day for requiring per-site provider registration
(`centralized-onramps.md`, superseded, kept on the record). Also shipped:
the deployment-CSP `'wasm-unsafe-eval'` fix (live password flows were
broken since 2026-07-31), the service-worker `cache: "reload"` precache
fix, `window.bitlogin.activeMethod()/activeSession()`, and welcome/sign-in
UI polish.

## Security audit response (2026-08-04, same day)

All confirmed findings fixed and regression-tested: BL-16 (auth_url now
https-only via `sanitizeAuthUrl`, hostname shown on the link, hostile-scheme
tests), BL-17 (post-creation PRF fallback pinned via `allowCredentials` to
the created credential), BL-18 (dead-socket CLOSE can no longer strand a
query promise), BL-19 (local `filter.limit` enforcement + duplicate-id drop
+ 1000-event ceiling per buffered query), BL-20 (.semgrep.yml try/catch
pattern was unparseable — fixed and verified firing on hostile code under
the pinned Semgrep 1.171.0). Lows: NIP-07 and NIP-46 now verify returned
signed events against the request (signature, identity, field equality);
`Nip46Client.close()` wipes the client and conversation keys; passkey
labels are distinguishable; postcss ≥8.5.25; Actions pinned to commit SHAs.

Second-pass response (same day): BL-21 — bunker relays capped at 8 and
deduplicated; relay frames over 256K chars dropped before JSON.parse; all
cheap checks (id dedup, capacity) run before Schnorr verification, plus a
per-query verification budget. BL-22 — superseded/abandoned nostrconnect
attempts are cancelled via AbortSignal and their ephemeral keys wiped
(ownership transfers, not dangles, on success); per-candidate conversation
keys wiped in a finally. BL-23 — `security:ci` now runs the custom Semgrep
rules (`security:semgrep`; requires a local semgrep install, same pin as
CI). BL-24 — the courtesy protocol `logout` (current NIP-46 defines it,
explicitly not a security boundary) is now sent on teardown; this corrects
the earlier "no stable method name" note. Still deferred, interop only:
`switch_relays`.

Owner action items:

1. **Live-fire the NIP-46 QR with Amber** on bitlogin.network (flow was
   verified against a fake bunker in tests, not yet against a real phone
   signer end-to-end).
2. **Live-fire passkey sign-in on a real device** (Chrome + Google Password
   Manager, and once on iOS Safari). PRF cannot be exercised in CI; the
   ceremony paths are untested against real authenticators.
3. **Passkey derivation is a new compatibility contract** —
   `packages/widget/src/passkey.test.ts` known-answer vectors carry the
   same never-update-the-expected-value rule as `knownAnswer.test.ts`.
4. NIP-46 credential *persistence* (vault record) stays gated on the
   external security review, as before.

## Entropy audit (2026-07-31)

[`entropy-audit-2026-07-31.md`](./entropy-audit-2026-07-31.md) — RNG and
randomness-integration audit. **No predictable-fallback defect:** `random.ts`
is the single chokepoint, throws rather than degrading, and rejection-samples to
avoid modulo bias. Three hardening items, in order:

- **M2 — done.** Nine tests in `packages/core/src/crypto/crypto.test.ts` pin
  fail-closed behaviour and `randomUniformInt`'s uniformity. Mutation-verified:
  a zero-filling stub in place of the throw turns five of them red, and
  swapping rejection sampling for bare modulo gives chi-square 5614 against a
  threshold of 147.
- **M1 — done.** `nip44Encrypt` / `nip04Encrypt` no longer take a nonce or IV;
  the capability lives in the non-exported `crypto/testing.ts`, and
  `crypto/index.ts` re-exports explicitly instead of `export *`. Only one test
  ever used an override and `ivOverride` had no callers, so nothing was lost.
  Verified from a real consumer against the built package: all three deep-import
  routes fail with `ERR_PACKAGE_PATH_NOT_EXPORTED`. `knownAnswer.test.ts` green
  throughout — the derivation chain is untouched.
- **L1 — done.** Both `Math.random` calls (backup-quiz picker, relay subscription
  id) now use the CSPRNG, so the ban has no standing exception. `.semgrep.yml`
  enforces it in CI alongside two more rules: no fallback around
  `getRandomValues`, and no timestamp-seeded secrets. Verified the rules fire —
  reintroducing the old call gives 1 blocking finding and exit 1.

**The entropy audit is closed for this repo.** The only gate left is an
independent review of the RNG path by someone other than the author, which is
not something a coding agent can sign off.

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
