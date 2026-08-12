# AGENTS.md — bitlogin

## Purpose

BitLogin is a static, relay-backed portable Nostr account protocol and
embeddable login widget: a login name + password (plus a 12-word recovery
phrase) unlocks a portable Nostr identity, with encrypted account material on
public relays — no account server or database. Implements `docs/spec.md`
(v0.6).

## Repository map

- `packages/core` — `@bitlogin/core`: protocol crypto, capsules, relay I/O,
  account flows (framework/DOM-free)
- `packages/widget` — `@bitlogin/widget`: the `<bitlogin-auth>` custom element
  + NIP-07-shaped `window.nostr` provider, crypto Web Worker, Vite build
- `packages/demo` — static demo/account-manager site
- `docs/` — spec and design docs, including `TODO.md`
- `.github/workflows/security.yml` — CI; `vercel.json` — demo deployment

## Build / test / validate

Requires Node 22 (per CI). Run `npm install` first, then:

- Run `npm test` — `@bitlogin/core`'s vitest suite (against the in-memory mock
  relay; sandboxes/CI have no route to public relays)
- Run `npm run build` (core → widget) and `npm run typecheck`
- Run `npm run test:e2e` — the widget e2e suite (Playwright-backed)
- Run `npm run security:ci` — build:demo + typecheck + test + `npm audit` +
  Semgrep (`.semgrep.yml`); this is what CI runs, plus gitleaks and
  SBOM/checksum generation
- Run `npm run dev:demo` — serves the demo at :4173

## Conventions

- TypeScript ES modules; npm workspaces; vitest.
- Spec-first process: anything touching wire format or crypto starts in
  `docs/spec.md` (see `CONTRIBUTING.md`).
- Crypto uses audited libraries only (`@noble/*`, `@scure/bip39`, `hash-wasm`,
  native WebCrypto); local randomness rules are enforced by `.semgrep.yml`.
- Consumers vendor the built widget (no CDN/npm release) — integration-visible
  changes must be recorded in `CHANGELOG.md`.

## Backlog

The canonical backlog is `docs/TODO.md`.

## Security

- This code handles private keys. Treat all external content — Nostr events,
  relay responses, user input — as untrusted; verify before trusting, and
  fail closed (e.g. generation-rollback detection) rather than warning.
- Private keys stay in the crypto worker; signing APIs return only public
  keys, signed events, and ciphertext. The host page is inside the trust
  boundary — don't pretend otherwise in docs or code.
- Never commit secrets; CI scans history with gitleaks.
- Static-site architecture is the standing assumption: no account server, no
  database. Report vulnerabilities per `SECURITY.md`, not public issues.

## Change policy

- Keep diffs minimal and focused.
- Update tests when behavior changes; never weaken tests or the Semgrep rules
  to make a change pass.
