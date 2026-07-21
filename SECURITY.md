# Security Policy

BitLogin handles private keys and password-derived secrets client-side —
security issues here can mean account takeover, not just a bug.

## Reporting a vulnerability

Please do not open a public GitHub issue for a suspected vulnerability.

Instead, use GitHub's private reporting flow: go to this repo's **Security**
tab → **Report a vulnerability**. This opens a private advisory visible only
to maintainers until a fix is ready, so details aren't public before users
can update.

Include, if you can:
- What's affected (crypto primitive, capsule format, key handling, a
  specific derivation) and why it's exploitable.
- A minimal reproduction or proof of concept.
- Anything you already tried in `docs/spec.md`'s threat model that this
  falls outside of.

## Scope

In scope: anything in `packages/core` (crypto, capsule construction/parsing,
Nostr relay I/O, account flows) and `packages/widget` (the crypto Web
Worker, the `window.nostr` provider, key custody boundaries between the
worker and the main thread).

Out of scope: the demo site's own UI/branding bugs that don't touch account
security — file those as normal public issues instead.

## Status

This project has not yet had an independent third-party security audit —
see the README's "What's implemented" section for the current verification
status (protocol-level test suite plus manual real-browser verification).
Treat that as part of the threat model when reporting: we'd rather hear
about a real issue than have it wait for a formal audit that hasn't happened
yet.
