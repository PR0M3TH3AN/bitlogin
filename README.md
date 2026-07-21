# BitLogin

login for normies.

A static, relay-backed portable account protocol: a familiar login name and
password that unlocks a portable Nostr identity, plus an independent 12-word
recovery phrase. Encrypted account material lives on public Nostr relays —
no account server, no password-reset email, no database.

This repo implements the protocol from `docs/spec.md` (v0.3) as a modular
system any static site can embed for login and Nostr signing.

## Layout

```
packages/
  core/    @bitlogin/core   — protocol implementation: crypto, capsules, Nostr
                              relay I/O, account flows. Framework- and DOM-free,
                              runs in Node or a browser/worker.
  widget/  @bitlogin/widget — <bitlogin-auth> custom element + a NIP-07-shaped
                              window.nostr provider, backed by a dedicated
                              crypto Web Worker. Built with Vite into two
                              static files any site can <script> in.
  demo/    @bitlogin/demo   — plain static site (no build step of its own)
                              consuming the widget: a landing/branding page,
                              an integration guide, and an account-manager
                              page (create/login/recover, password rotation,
                              identity export).
```

## Quick start

```bash
npm install                       # installs all three workspaces
npm test                          # runs @bitlogin/core's test suite (vitest)
npm run build                     # builds core, then widget
npm run dev:demo                  # assembles + serves the demo at :4173
```

`@bitlogin/demo`'s `npm run build` copies the built widget into
`packages/demo/dist/vendor/bitlogin/` alongside the static HTML — the result
in `packages/demo/dist/` is a complete, ready-to-host static site.

## Embedding BitLogin in your own static site

```html
<script type="module" src="/vendor/bitlogin/bitlogin.js"></script>
<bitlogin-auth
  vault-relays="wss://relay-one.example,wss://relay-two.example,wss://relay-three.example"
  discovery-relays="wss://discovery-one.example,wss://discovery-two.example">
</bitlogin-auth>
```

`bitlogin.js` and `cryptoWorker.js` (plus the shared chunk they both import)
must be deployed side by side — the main script resolves the worker's URL at
runtime relative to its own location, so this works from any path, not just
the site root.

Once a user signs in, `window.nostr` is installed with the de facto NIP-07
shape (`getPublicKey`, `signEvent`, `getRelays`, `nip44.encrypt/decrypt`), so
existing Nostr web apps work against it unmodified. Private keys never leave
the worker; the main thread only ever sees public keys, signed events, and
ciphertext. See `packages/demo/public/docs.html` for the full integration
guide, and `packages/demo/public/account.html` for a working example
(create → confirm recovery phrase → sign an event → rotate password →
export identity).

## Deployment

The demo site deploys to Vercel: `vercel.json` at the repo root sets the
build command (core → widget → demo) and output directory, so importing this
repo at [vercel.com/new](https://vercel.com/new) needs no manual
configuration. GitHub Pages was evaluated but dropped — Pages requires a paid
plan for private repositories, whereas Vercel's free tier deploys a private
repo without that restriction.

Because the deployed demo serves the built widget files as plain static
assets at `/vendor/bitlogin/`, **any other site can point directly at the
Vercel deployment today** without installing anything locally:

```html
<script type="module" src="https://bitlogin.vercel.app/vendor/bitlogin/bitlogin.js"></script>
<bitlogin-auth></bitlogin-auth>
```

This is fine for prototyping across multiple projects; for production use in
someone else's app, self-hosting the built files (or a future published npm
package / CDN release) avoids depending on this demo deployment's uptime.

## What's implemented

This build covers the protocol's Phase 0 (cryptographic core + test vectors)
and the load-bearing parts of Phase 1 (account MVP), verified two ways:

- **Protocol-level tests** (`npm test`, 49 tests): Argon2id/ScalarExpand/JCS/
  padding/timestamp unit tests with the spec's exact byte layouts (§11), and
  full end-to-end scenarios — create → clean-device login, phrase recovery →
  new credentials → clean-device login, password change with mandatory
  tombstone + NIP-09 deletion, relay-loss → replica repair (including
  keyless recovery-event rebroadcast), rollback-warning and
  relay-disagreement detection — run against an in-memory mock relay
  (`packages/core/src/test-support/mockRelay.ts`), since this sandbox has no
  route to public Nostr relays.
- **Real-browser verification**: the same flows were driven end-to-end in
  actual Chromium against the built widget, confirming the crypto worker,
  IndexedDB storage, and `window.nostr` provider work together outside the
  test harness.

Implemented: registration (§15), any-device password login with rollback and
relay-disagreement detection (§16), phrase recovery with recovery-capsule
refresh (§17), known-password change with mandatory tombstone + NIP-09
deletion (§18), replica repair (§24.4), recovery export (§19.5), NIP-19
nsec/npub encoding, importing an existing Nostr `nsec` as the everyday
identity (§28.1, §SF10 — with a preview-before-commit UI step), a NIP-44 v2
implementation for the `window.nostr.nip44` surface, bootstrap/discovery
relay list plumbing (§19), and the full crypto stack from §11 (Argon2id,
HKDF, ScalarExpand, AES-256-GCM, JCS, fixed padding buckets).

**Deferred / not in this pass:**
- Phase 2 messaging (NIP-17 inbox/compose) — the NIP-44 primitive is built
  and tested, but no conversation UI is wired up.
- Phase 3 application redirect-auth flow (§26.3) and NIP-46/NIP-07 browser
  extension interop beyond the `window.nostr` shim.
- NIP-49 `ncryptsec` export (§28.2) — deliberately left out rather than
  shipped unverified against official test vectors; plain `nsec`/`npub`
  (NIP-19) export is implemented instead.
- The maintainer-signed bootstrap relay-list channel (§19.1) has the
  verify/merge logic implemented but ships with a placeholder maintainer
  public key — a real deployment needs to swap in a real one.
- Native clients, hardware-backed recovery, independent second
  implementation, and formal security audit (Phase 4).

## Development notes

- Crypto primitives use audited libraries: `@noble/curves` (secp256k1
  Schnorr), `@noble/hashes` (SHA-256, HKDF, HMAC), `@noble/ciphers`
  (ChaCha20 for NIP-44), `@scure/bip39` (BIP-39), native WebCrypto
  (AES-256-GCM), and `hash-wasm` (Argon2id).
- The Argon2id profile (`bitlogin-argon2id-v1`) uses parallelism 1 rather
  than RFC 9106's recommended 4, for reasons documented in
  `packages/core/src/crypto/argon2id.ts` (§11.2 of the spec).
- Passphrases are generated from the EFF long Diceware wordlist
  (`diceware-wordlist-en-eff`), matching the spec's ~12.9-bits/word,
  six-word/~77-bit default (§9.2).
