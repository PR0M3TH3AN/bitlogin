# Architecture

Durable architectural decisions and constraints for this repository.

## Key custody in the crypto Web Worker

Private keys, passwords, and derived secrets are confined to the widget's
dedicated crypto Web Worker: they live in the worker's WASM linear memory or
`ArrayBuffer`s, and the UI thread receives only public keys, signed events,
and ciphertext/decrypted display content. The spec deliberately frames this
as lifetime-and-surface minimization, not an absolute boundary — a Web Worker
compartmentalizes but is not a security boundary against malicious
same-origin code, and the host page is inside the trust boundary. Do not
overstate the containment in code or docs.

Authoritative source:
- docs/spec.md §11.10, §22.4, §33
- AGENTS.md "Security" section

## Vendored widget distribution — no CDN, no npm release

Consuming sites vendor the built output of `packages/widget/dist/` into
their own origin; there is deliberately no npm package or auto-updating CDN
release. Rationale: a shared live-loaded script would let a single bad or
compromised deploy of this repo break or compromise every consuming site at
once with no per-site review window, and cross-origin workers are rejected
by browsers anyway. Updates therefore reach integrations only through a
reviewed re-vendor step (hash-recorded in `bitlogin.integrity.json`), which
is why integration-visible changes must be recorded in `CHANGELOG.md`.

Authoritative source:
- README.md "Updating your integration" and "Deployment" sections
- AGENTS.md "Conventions" section; CHANGELOG.md preamble

## Static, relay-backed system — no account server

The standing architectural assumption is a static site with encrypted
account material on public Nostr relays: no account server, no database.
Consequences that recur across the spec: no single relay is authoritative,
reads require a quorum, and no purely static system can prove a brand-new
client has found the globally newest event — the interface must not imply
otherwise.

Authoritative source:
- docs/spec.md §12.3, §16.2
- AGENTS.md "Purpose" and "Security" sections
