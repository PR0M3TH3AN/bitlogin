# Contributing to BitLogin

Thanks for taking a look. BitLogin is a small monorepo — read this before your
first PR, it'll save you a round trip.

## Layout

See `README.md` for the full package breakdown. In short: `packages/core` is
the framework-free protocol implementation (crypto, capsules, Nostr relay
I/O, account flows), `packages/widget` is the `<bitlogin-auth>` custom
element and its crypto Web Worker, and `packages/demo` is the static site
that consumes both.

## Getting started

```bash
npm install
npm test           # runs @bitlogin/core's vitest suite
npm run typecheck  # tsc -b for core, tsc --noEmit for widget
npm run build      # builds core, then widget
```

If you edit `packages/core` and a downstream typecheck seems stale (TS
happily reports success against old `.d.ts` output), delete the incremental
build cache and rebuild:

```bash
rm -f packages/core/tsconfig.tsbuildinfo packages/widget/tsconfig.tsbuildinfo
npm run build -w @bitlogin/core && npm run typecheck -w @bitlogin/widget
```

## Testing without a real Nostr relay

Most sandboxes (and CI) have no route to public Nostr relays. Protocol-level
tests instead run against an in-memory mock relay,
`packages/core/src/test-support/mockRelay.ts` — a minimal WebSocket server
implementing enough of NIP-01 (EVENT/REQ/CLOSE/OK, addressable/replaceable
replacement semantics) for real round trips: register → publish → login from
a "clean device," phrase recovery, password rotation, relay-loss → replica
repair, and so on. New account-flow tests should follow the existing pattern
in `packages/core/src/account/account.e2e.test.ts` — spin up 2-3 `MockRelay`
instances in `beforeEach`, close them in `afterEach` (registration/login
require a 2-of-N acknowledgement quorum by default, so a single mock relay
will fail every write).

For widget/UI changes, there's no equivalent automated browser suite yet —
verify manually against the built widget in a real browser (Chromium is
fine) pointed at a locally started `MockRelay` instance via the
`vault-relays`/`discovery-relays` attributes, since real relays aren't
reachable from most contributor sandboxes either.

## The spec is canonical

`docs/spec.md` (currently v0.6) is the source of truth for the protocol
itself — wire formats, KDF parameters, capsule structure, derivation paths,
threat model. Code comments reference it by section (`§11.2`, `§17.4`, …).

If a change affects anything the spec describes — a new capsule field, a
derivation change, a new recovery path — update `docs/spec.md` in the same
PR, not after the fact. Purely additive widget/UI features that don't touch
wire format or crypto (a new screen, a UX fix) don't need a spec change.
Speculative/future ideas that aren't decided yet belong in a separate doc
(see `docs/second-factor.md` and `docs/future-recovery-options.md` for the
pattern: proposal + pros/cons, explicitly marked as not implemented) rather
than in the spec itself.

## Working on cryptography or key handling

This code touches private keys and password-derived secrets, so changes
here get held to a higher bar than typical UI work:

- Prefer the audited libraries already in use (`@noble/curves`,
  `@noble/hashes`, `@noble/ciphers`, `@scure/bip39`, native WebCrypto,
  `hash-wasm`) over adding a new dependency or hand-rolled primitive.
- Private keys and passwords must never be logged, persisted in plaintext,
  or held in memory longer than the operation needs (`§11.10`). In the
  widget, they must never leave the crypto Web Worker — the main thread
  only ever sees public keys, signed events, and ciphertext.
- If you're changing KDF parameters, encryption modes, or derivation paths,
  explain why in the PR description, not just what — these are exactly the
  kind of change that's cheap to review now and expensive to unwind once
  real accounts depend on it.
- Add or update test vectors (`packages/core/src/crypto/crypto.test.ts`) for
  any primitive-level change.

## Reporting a security vulnerability

Don't open a public issue for a suspected vulnerability in the crypto,
capsule handling, or key custody — see `SECURITY.md` for the private
disclosure process.

## Style

- TypeScript strict mode; `packages/core` stays framework- and DOM-free so
  it can run in Node, a browser, or a worker.
- Comments explain *why*, not *what* — skip a comment if the code's already
  clear without it.
- Match the existing code's structure rather than introducing a new
  abstraction for something only used once.

## Release channels

BitLogin's own site is a sign-in address: people type their password there,
and other sites ask it to sign for them (`docs/sign-in-window.md`). A change
to it reaches everyone who uses it, at once. So there are two channels.

| | Branch | Site | Deploys |
|---|---|---|---|
| Beta | `beta` | `https://bitlogin-beta.vercel.app/` | When someone runs `npm run deploy:beta` |
| Production | `main` | `https://bitlogin.network/` | By itself, when something is merged to `main` |

- **Work lands on `beta`.** Branch from `beta` and open pull requests
  against `beta`. CI runs on both.
- **Beta is a separate sign-in address.** Sessions, approved sites and
  passkeys made there exist only there. Every page says "BETA SITE" (set at
  build time by `BITLOGIN_CHANNEL=beta`; see `packages/demo/build.mjs`). Use
  throwaway accounts on it.
- **`npm run deploy:beta`** refuses unless the checkout is a clean `beta`
  that matches GitHub. It then checks that the live site serves the widget
  that commit builds, that the pages are marked, and that `/signer/` and
  `/connect/` kept their framing rules.
- **Promoting to production** is a pull request from `beta` into `main`,
  merged with a merge commit so both histories are kept. Do it when a piece
  of work is solid, not on a schedule, and say in the pull request what was
  tried on beta. It is the owner's to merge.
- **Before a promotion: the relay probe.** An account lives on the relays
  in `BUILTIN_VAULT_RELAYS`, and a relay that is online is not thereby one
  that keeps an account (`docs/spec.md` §19.1). So before each promotion,
  by hand, on a home connection and not a datacenter or VPN address:

  ```
  npm run build
  node scripts/relay-probe.mjs --json probe.json              # the shipped lists
  node scripts/relay-probe.mjs --discover --json found.json   # candidates from NIP-66 monitors
  # fifteen minutes or more later:
  node scripts/relay-probe.mjs --recheck probe.json
  node scripts/relay-probe.mjs --recheck found.json
  ```

  It publishes throwaway notes of random bytes to public relays, which is
  why it is run by a person and never by CI. It informs and does not
  decide: say in the pull request what it found. A relay is added only
  after it held everything through the re-check on two different days, by
  a reviewed change that records the measurement beside the list. No relay
  is ever removed from the list: older accounts may live only there, and a
  client that stopped asking could not find them. A promotion is not held
  back because a relay was slow that day.
- **After a promotion,** merge `main` back into `beta` if `main` gained
  anything `beta` lacks (a hotfix, a Dependabot update).
- **A fix that cannot wait** may go to `main` directly, by pull request,
  and is then merged back into `beta` the same day.

## Pull requests

- Run `npm test` and `npm run typecheck` before opening a PR; both must
  pass.
- Keep the description focused on *why*, not a restatement of the diff.
- Small, focused PRs review faster than one that bundles unrelated changes.

## AI-assisted contributions

AI-assisted changes are subject to the same testing, security, and review
requirements as any other change; the contributor remains responsible for
understanding what they submit. Do not submit unvalidated generated code,
credentials, or agent-generated trusted memory without evidence and review.
The canonical backlog and planning rules are in `AGENTS.md`; durable agent
plans live under `.agents/plans/`.
