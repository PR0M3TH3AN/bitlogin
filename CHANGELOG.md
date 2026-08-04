# Changelog

Tracks changes to `@bitlogin/core` and `@bitlogin/widget` that matter to a
site with its own vendored copy (see "Updating your integration" in
`README.md`). Not every commit needs an entry — only ones where a site
sitting on an older vendored copy is missing a fix or behavior change it
would plausibly want. Newest first.

## 2026-08-04 (security-audit response, same day)

- **External signers are now verified, not trusted.** NIP-07 and NIP-46
  `signEvent` results are checked for a valid signature, the session's
  identity, and field-for-field equality with the requested event; NIP-46
  `auth_url` is surfaced only as a validated https URL with its hostname
  shown. Relay queries enforce `filter.limit` locally, drop replayed
  duplicates, cap buffering, and can no longer be stranded by a relay dying
  mid-query. Passkey PRF fallback assertions are pinned to the
  just-created credential. If your integration relied on an extension
  returning altered events, that now errors — by design.

## 2026-08-04

- **CSP fix every self-hosting site needs: add `'wasm-unsafe-eval'` to
  `script-src`.** Argon2id (hash-wasm) compiles a WASM module in the crypto
  worker; a `script-src 'self'` policy without that keyword blocks
  `WebAssembly.compile` and breaks every password flow. The keyword permits
  WASM compilation only — JS `eval` stays banned. Related: if your service
  worker precaches the widget, fetch with `cache: "reload"` during install —
  an asset revalidating to a 304 keeps its OLD stored headers, and a worker
  script cached with a stale CSP runs under that stale policy (this shipped
  once; see the demo's `sw.js` for the pattern).
- **One login surface, four methods.** Behind a collapsed "More sign-in
  options" menu (password stays primary): NIP-07 extension delegation,
  NIP-46 remote signers (bunker:// paste + a dot-style nostrconnect QR;
  NIP-44 transport only; memory-only sessions), and passkey sign-in
  (WebAuthn PRF derives the account credential under a frozen contract —
  zero site setup). Alternative-method sessions are signer-only: no vault
  (`requestNwcConnection` resolves null), no persistence.
- **Host API additions.** `bitlogin-login` now carries `detail.method` and
  `detail.capabilities` (existing `detail.publicKey` unchanged);
  `window.bitlogin` gains `activeMethod()` / `activeSession()` — use these
  for session state, NOT `isActiveSigner()`, which stays a window.nostr
  ownership check and is deliberately false during NIP-07 sessions.
  `window.nostr` is now an element-routed provider that follows the active
  signer.
- **UI polish.** Screen headers with icon back buttons, right-aligned
  "Forgot password?", icon+description option rows with 56px touch targets.
- New widget dependency bundled in: `qrcode-generator` (QR for
  nostrconnect). File count and deployment layout unchanged.

## 2026-07-30

- **Widget: `requestNwcConnection()` — the Connection Vault authorization
  layer (reveal mode).** Apps ask for a wallet; the widget owns sign-in,
  one-tap approval for an origin-bound connection, or guided import via
  Bitcoin Connect's chooser (lazy chunks — never downloaded unless the flow
  opens) or a pasted URI, stored as an encrypted vault record. Dashboard
  gains a "Wallet connections" management screen (revoke app access vs
  remove-from-BitLogin, honestly distinguished). The vault root now rides
  the encrypted session cache, so restored sessions can use connections
  without re-login; the sudo key is never cached. New deploy note: the
  widget now ships FIVE files (two extra lazy chunks) that must travel
  together, and hosts using the wallet flow need `style-src-attr
  'unsafe-inline'` in their CSP.
- **Widget: `offerNwcConnection()` — offer-to-save for app-obtained
  wallets.** The inverse of `requestNwcConnection`: an app that got an NWC
  URI through its own chooser or paste box can offer the user a portable
  copy. Consent-gated in the widget's own UI, never silent (the write goes
  to the user's account); duplicates by wallet+secret resolve
  `already-saved` with a silent origin-binding refresh and no UI, so apps
  can fire it after every successful connect.
- **Connection Vault protocol layer in `@bitlogin/core`** (`src/vault/`):
  encrypted per-connection records signed by a derived vault identity, the
  finalized §CV6 key hierarchy with pinned test vectors, the NWC credential
  profile (lossless URI parse/export), relay sync with quorum readback and
  per-record rollback detection, and the two-tier model — connectable
  records vs sudo-gated personal records (`connection-vault.md` §18).
- **Capsules gained paired optional fields** `connection_vault_root` and
  `vault_sudo_key` (both or neither; validated). Registration mints them for
  new accounts; `enableConnectionVault` is the phrase-gated, fail-closed,
  idempotent migration for existing accounts. Login, password change, and
  phrase recovery all carry them forward.
  **Integration caveat:** a site on an OLDER vendored widget that performs a
  password change will rebuild the credential capsule WITHOUT these fields,
  stranding connectable records until a phrase ceremony repairs them —
  update vendored copies before enabling the vault for users.

## 2026-07-21

- **Fix: registration/login could fail quorum if a single built-in relay was
  down.** `BUILTIN_VAULT_RELAYS` had only 3 relays and `BUILTIN_DISCOVERY_RELAYS`
  only 2, sharing `relay.nostr.band` between both lists. `publishAndVerify()`
  requires a fixed `minAcks`/`minReadbacks` of 2 regardless of relay count, so
  losing that one relay left zero margin — surfacing as "Registration did not
  reach the required relay acknowledgement and readback quorum." Added
  `nostr.wine` and `relay.snort.social` to the vault list, and
  `nostr-pub.wellorder.net` to discovery. (`681f622`)
  **Re-vendor if:** your site uses the default built-in relay list (i.e. you
  don't pass your own `vault-relays`/`discovery-relays` attributes). If you
  already pass your own relay list, this doesn't affect you.

- **Fix: widget completely unstyled (giant logo, unstyled buttons) under a
  strict `style-src` CSP.** `element.ts` injected its CSS as an inline
  `<style>` tag inside the shadow root on every render. A host with
  `style-src 'self'` and no `'unsafe-inline'` silently drops an inline
  `<style>`'s rules entirely — visible as the brand SVG rendering at its raw
  ~590×119px intrinsic size instead of the intended 20px-tall lockup, with
  every other shadow-DOM element similarly falling back to unstyled browser
  defaults. Switched to building the stylesheet once as a `CSSStyleSheet` and
  assigning it via `adoptedStyleSheets`, which isn't subject to `style-src`.
  (`e8712f9`)
  **Re-vendor if:** your site's CSP sets `style-src` without `'unsafe-inline'`
  (check your CSP header/meta tag). If your `style-src` already includes
  `'unsafe-inline'`, or you have no CSP, this was invisible to you either
  way, but re-vendoring is still a good idea (this fix also drops needless
  per-render CSS reparsing).

- **Feature: NIP-04 support, for drop-in parity with a real NIP-07
  extension.** `window.nostr.nip04` (and the element-scoped
  `nip04Encrypt`/`nip04Decrypt`) didn't exist at all before this — only
  NIP-44 was implemented. A site (or its own legacy DM code path) calling
  `window.nostr.nip04.encrypt(...)` while BitLogin was the active signer got
  `Cannot read properties of undefined` instead of a working call. (`2838402`)
  **Re-vendor if:** your site (or any third-party code running on it) uses
  `window.nostr.nip04` — a real NIP-07 extension always has it, so anything
  written against "whatever `window.nostr` provides" may already assume it's
  there. No attribute/config changes needed; this is purely additive.

## 2026-07-22

- **Feature: sessions persist across a page reload.** Previously every reload
  destroyed the crypto worker, requiring the full login-name + password flow
  again — re-running Argon2id and a relay quorum read on every navigation,
  not just the first sign-in. After a successful register/login/recover/
  changePassword, the everyday private key and active capsule events are now
  cached in IndexedDB; `connectedCallback()` tries to restore that cache
  before ever showing the welcome screen, firing `bitlogin-login` exactly as
  a fresh login would if one is found. Logout clears it. (`9e3787d`)
  **Security note:** this means the decrypted everyday private key now sits
  in the browser's IndexedDB for that origin until logout — the same
  tradeoff every NIP-07 extension and crypto wallet already makes for the
  same "don't ask for the password every navigation" reason, scoped by
  IndexedDB's own per-origin isolation. The recovery phrase and login
  name/password are never cached.
  **Re-vendor if:** you want this — it's the reason to re-vendor this entry.
  No attribute/config or host-integration changes needed; a host page's
  existing `bitlogin-login` listener (see "Embedding BitLogin" below) fires
  the same way whether the sign-in was just typed or silently restored.
