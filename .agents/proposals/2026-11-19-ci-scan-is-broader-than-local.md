# Proposal: CI's static analysis is broader than the local scan

**Kind:** lesson
**Proposed:** 2026-11-19
**Status:** proposed

## What

`npm run security:semgrep` runs the repository's own three rules
(`.semgrep.yml`). CI's `static-analysis` job also runs
`semgrep scan --config auto --error --timeout 0 packages`, about 230 rules.
A change can pass `npm run security:ci` locally and fail CI.

Run both before pushing:

```bash
npm run security:semgrep
semgrep scan --config auto --error --timeout 0 packages
```

## Evidence

- Pull request #31 (2026-11-19): `security:ci` passed locally; CI's
  `static-analysis` failed on `wildcard-postmessage-configuration` in
  `packages/widget/src/embedded/signer.ts`. Fixed by never posting to an
  unknown origin, not by silencing the rule.
- The same job had been failing on `main` since 2026-11-18 on
  `detect-insecure-websocket` in `packages/core/src/nostr/nostr.test.ts`: a
  fixture that lacked the `nosemgrep` note its siblings carry. Fixed in #32.
- `.github/workflows/security.yml`, job `static-analysis`.

## Also worth keeping

The repository's own rule `bitlogin-no-crypto-fallback` matches
`crypto.getRandomValues` anywhere inside a `try`. Ask for randomness before
the `try`, so that its absence throws instead of being caught
(`packages/widget/src/worker/signerGrant.ts`).

## Why it is durable

It follows from how the workflow is written, not from one change: it holds
until `security.yml` or `package.json`'s `security:ci` is changed, and the
cost of not knowing it is a failed check after a push that has already
made a preview deployment.
