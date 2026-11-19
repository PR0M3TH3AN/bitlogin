# Changelog

Tracks changes to `@bitlogin/core` and `@bitlogin/widget` that matter to a
site with its own vendored copy (see "Updating your integration" in
`README.md`). Not every commit needs an entry — only ones where a site
sitting on an older vendored copy is missing a fix or behavior change it
would plausibly want. Newest first.

## 2026-11-19

**A world is held tighter, and an unknown site is not remembered unless
asked (`docs/sign-in-window.md` §SW11, §SW18).** For sites that sign in
through the window.

- **Three signatures a minute and twenty an hour** for a site that
  declared no permissions, where it was six and sixty. NSWP's kit 0.28.0
  uses the same numbers. An application's own limits (§SW9.6) are as they
  were.
- **Only a site BitLogin knows is remembered for thirty days.** Any other
  is allowed for the visit, and asks again when its page is next loaded,
  unless the user ticks "remember" in the window. `state` says
  `remembered: true` or `false`. A site remembered before this build stays
  remembered until its date.
- **A page at the sign-in address, `/sites/`,** lists the sites allowed
  from this browser. It cannot switch one off: a browser does not let it.
- **`exportHandoff()` takes a fourth argument,** whether "remember" was
  ticked; `FoundSigner.grant()` a third, the same; `FoundSigner.known`
  says whether BitLogin knows the address.

**A world can know its visitor by name (`docs/sign-in-window.md` §SW16).**
For a site that signs in through the window and declared no permissions.

- **`state` carries `name`, `picture` and `about`,** from the person's own
  signed profile. BitLogin's worker fetches and checks it at the sign-in
  address and seals it into the hand-off; the site never supplies it.
- **New request `{ t: "pass", id, session }`.** The reply is NSWP's room
  pass (kind 27300) for the asking site, four hours long, naming that
  session key. The site sends a session public key and nothing else.
- **`sign` still refuses kind 27300.**
- **New on the headless signer:** `loadProfile()`, `roomPass()`, and a
  third argument to `exportHandoff()`: the site the hand-off is for.
- **A site allowed before this build** keeps working, with no picture and
  no profile name until the user is next asked there: its kept grant holds
  no profile.

**The browser can save a new password (`docs/TODO.md` item 11).** The
generated password was shown as text only, so a browser or password manager
had nothing to save from at sign-up, after recovery, or after a rotation,
except in Chromium, which was asked outright.

- **Sign-up, recovery and rotation are real forms now:** the login name
  marked `username`, and the generated password in a field of type
  `password` marked `new-password`. Rotation also keeps the old password
  marked `current-password`, the shape a browser reads as a changed
  password.
- **The field cannot differ from the account's password.** It is put back
  if it is typed in or filled by a password manager's own suggestion.
- **Nothing for an integrator to change.** The saved login belongs to the
  address the form is on: the application's, where the widget is embedded;
  BitLogin's, in the sign-in window.
- **Not verified:** the browsers' own prompts. The forms are checked in
  three engines; whether each browser then offers to save and fill has to
  be looked at by a person.

**The embedded signer remembers a site (`docs/sign-in-window.md` §SW11).**
It held the handed-over key in memory, so every load of the asking site's
page began locked and the window had to be opened again.

- **A site the user allowed stays allowed** for thirty days on that device,
  or until they sign out of it there. Loading the page again asks nothing.
- **What is kept** is a grant for that one site: the key, encrypted at rest
  like the session cache, under names of its own. What is taken up from it
  can only sign.
- **The count is kept with it,** so loading the page again is not a way
  round six a minute and sixty an hour.
- **New on the headless signer:** `keepSignerGrant()`,
  `restoreSignerGrant()`, `touchSignerGrant()`, `forgetSignerGrant()`. Only
  the embedded signer's page has a use for them.
- **A limit to know:** the sign-in address cannot list or take back what
  was kept inside other sites. A grant ends at the site, at its date, or
  with the browser's data.

**The sign-in window and the embedded signer, on BitLogin's own site
(`docs/sign-in-window.md`).** A site no longer has to embed the widget, and
so see the password, to have something signed.

- **Two new pages on the site:** `/signer/`, which other sites embed
  unseen, and `/connect/`, the window a site opens. The password is typed
  on BitLogin's own page, in that window. The site is handed a signer it
  can ask, and never a key.
- **Two new files in the widget build:** `bitlogin-signer.js`
  (`startEmbeddedSigner()`, the whole of the signer's page) and
  `bitlogin-window.js` (`findEmbeddedSigner()`, for the window's page).
  A deployment that serves its own sign-in address ships both.
- **What the signer signs for a site:** a note and a reaction, once the
  user has allowed that site. Everything else is refused, without saying
  why. Six a minute, sixty an hour, four hours at most.
- **Headers changed for those two pages only** (`vercel.json`): the signer
  may be framed by an https site, and the window keeps its link to the page
  that opened it (no `Cross-Origin-Opener-Policy`). Every other page is as
  it was, and the policy tests pin all three sets.
- **Nothing changes for a site that embeds the widget today.**
- **Not built:** permissions an application declares (a note and a
  reaction are not enough for an app), and a passkey added to an existing
  account.

**A signer hand-off, for a sign-in window (`docs/sign-in-window.md`).** A
site that embeds the widget can read the password as it is typed. The way
out is for the password to be typed at one address the user trusts, and for
other sites to ask a hidden signer of that address. This is the piece of
that which belongs here.

- **The headless signer can hand its key to another of itself on the same
  origin:** `beginHandoff()` and `acceptHandoff()` on the receiving side,
  `exportHandoff()` on the sending side, `isSignerOnly()`. The everyday key
  moves worker to worker, sealed between two throwaway keys; the pages
  carry a public key and ciphertext.
- **What arrives is a session that can only sign.** `getPublicKey` and
  `signEvent` work. Decrypting, encrypting, exporting the key, the vault and
  every account action are refused, and nothing is cached. `getSessionStatus`
  says `signerOnly`.
- **Nothing existing changes.** No wire format, no stored format, no header.
  A site that never calls these is unaffected.
- **Not here, at first:** the sign-in window page and the per-site
  permission list. They followed the same day: see the entry above.

## 2026-11-19 (on `beta` only; not yet on `main`)

- **An application can sign in through the sign-in window and then act in
  the background.** It declares a permission set; the user sees all of it
  once, in the window; after Allow it signs those kinds with no prompt for
  thirty days or until the user signs out of it. New file to vendor:
  `bitlogin-client.js` (`createBitLoginClient`). See
  `docs/sign-in-window.md` §SW8 and §SW9.
- **What an application may and may not have.** Never: wallet and
  remote-signer traffic, NSWP passes and grants, BitLogin's own data. A
  web-request proof is signed only for the application's own origin or one
  it declared. Reading is tied to a signed event of a kind it declared, so
  approval to read one kind is not approval to read another; raw decrypting
  against the user's own key is not offered.
- **Changed for integrators already on the window (worlds):** nothing. A
  site that declares no permissions gets a note and a reaction, as before.
- **A beta channel.** Work lands on the `beta` branch and
  `https://bitlogin-beta.vercel.app/` before production
  (`CONTRIBUTING.md`, "Release channels").

## 2026-11-18

**Relay list (later the same day).** A probe of the eight built-in storage
relays found only about half dependable: two never connect, one connects
about one time in eight, one refuses capsule keys under a web-of-trust rule,
and one acknowledges capsules and then drops half within minutes.

- **A signed, updatable relay list (spec §19.1) is now wired in, switched
  off.** The widget remembers the last signed list it accepted, applies it at
  start, and looks for a newer one in the background. It stays off until a
  maintainer public key is pinned in `packages/core/src/nostr/bootstrap.ts`;
  until then nothing is fetched. A host page that configures its own relays
  is never extended by it. A signed list can add at most one fewer relay than
  the widget pins, so it can never form a read quorum by itself, and a list
  cannot be rolled back to an older version.
- **Five storage relays added, none removed.** `nostr.mom`,
  `relay.nostr.net`, `nostr-01.yakihonne.com`, `relay.nostr.wirednet.jp` and
  `nostr.sathoarder.com` join the built-in list, and `nos.lol` joins the
  lookup list. A live sign-up now lands on 10 of 13 relays, where it landed
  on 3 to 5 of 8 before. Existing accounts are still looked for on every
  relay they were ever written to. Sign-in opens more connections than it
  did.
- **Capsules store at most four relay hints.** They used to store the whole
  relay list, twice, in a fixed-size payload that had only a few dozen bytes
  to spare. Growing the list to thirteen made registration fail outright;
  this was caught by a live run, not by the test suite, which now registers
  against the largest relay list a client can have. Older widgets read the
  shorter hints without change.
- **`scripts/relay-probe.mjs`** tests relays the way BitLogin uses them
  (capsule-shaped events from throwaway keys, read back now and later) and
  can take candidates from NIP-66 monitors. **`scripts/sign-relay-list.mjs`**
  signs and publishes the list.

Spec v0.7. Prompted by a real loss: every relay dropped one account's
capsules, and neither the password nor the recovery phrase could bring the
identity back.

- **New accounts derive their identity key from the recovery phrase.**
  Previously the key was random and the phrase only located a capsule on a
  relay. Now the phrase alone rebuilds the identity when no relay holds
  anything (spec §11.6). This applies to accounts created from this version
  on; existing accounts keep the key they have, and nothing about how they
  sign in changes. The derivation is a frozen contract, pinned in
  `knownAnswer.test.ts`.
- **Rebuild from phrase.** When "Recover account" finds no account on the
  relays, the widget shows the identity the phrase derives and, once the user
  confirms the npub is theirs, republishes a recovery capsule and continues
  to "set a new login" (spec §17.6). Saved wallet connections are not
  rebuilt. For an imported key or an older account the identity shown is not
  theirs, and the screen says so. In core: `previewPhraseRebuild` and
  `rebuildAccountFromPhrase`.
- **Imported keys are told they are different.** An imported `nsec` is not in
  the phrase. After the phrase quiz, an imported-key sign-up shows the key
  with copy and download buttons and grants the session only once the user
  ticks that it is saved. **Integration-visible:** for imported keys only,
  `bitlogin-login` fires one screen later than before.
- **Capsules record where the key came from.** A new optional
  `protocol.everyday_derivation` field in both capsule payloads (spec §12.1).
  Older vendored widgets ignore it, and can read and write these accounts as
  before; if one rewrites a capsule the hint is dropped, which only changes
  what the newer widget says about backups. `LoginResult`, `RegisterAccountResult`
  and `RecoveredIdentity` gain `everydayKeyDerived`.
- **Backup health check on the dashboard.** "Check account backup health"
  asks each vault relay for the two capsules this session holds, verifies
  what comes back, and reports how many relays hold each one. "Re-send my
  account to every relay" republishes both signed events, which restores an
  account that relays have dropped as long as one signed-in device still has
  it. It runs only when the user asks. In core:
  `checkReplicaHealth({ relayUrls, credentialEvent, recoveryEvent })`; in the
  worker: a `checkReplicaHealth` action beside the existing `repairReplicas`.
- **The health screen says why a relay lacks a copy.** After a re-send, each
  relay that still lacks a capsule shows its own reply (a refusal reason, a
  connection error, or "accepted it but does not return it"). Relay text is
  flattened, capped at 140 characters and escaped. In core,
  `rebroadcastCapsules` returns a per-relay `relays` array alongside the
  counts; the worker's `repairReplicas` result carries the same array.
- **Sign-in repairs relays on its own.** After each password or passkey
  sign-in the worker re-sends both capsules to every vault relay in the
  background, so relays dropping an account one at a time are topped up
  before the last copy goes. It is skipped when the sign-in showed a rollback
  or relay disagreement, and it does not run on a restored session. Expect a
  short burst of extra relay connections after sign-in.
- **Standing notice for accounts the phrase can't rebuild.** Imported keys,
  and every account created before this version, see a dashboard notice that
  their key is not in the recovery phrase, with a link to Export identity.
- **The revealed private key no longer lingers.** The Export identity screen
  kept a revealed `nsec` in the element until logout; it is now dropped on
  leaving the screen. That screen also gains "Copy" and "Download key file".

## 2026-11-17

- **A release artifact set with an integrity manifest.**
  `npm run release:artifacts` builds the widget and assembles
  `release/bitlogin-widget-v<version>/`: every file a site deploys side by
  side, plus `integrity.json` (version, source commit, and a sha256 and SRI
  hash per file) and `SHA256SUMS.txt`. Vendor that folder and keep the
  hashes, so you can tell whether your copy still matches a known build.
  Nothing about the build or the widget changed, and nothing is published by
  the script.
- **The build is reproducible, and one of the builds in circulation is now
  identified.** Rebuilding from this commit's source gives byte-identical
  files, and `bitlogin.js` (144,005 bytes, sha256 `33b1affe…281b839a`) matches
  what `login.bitblocks.network` serves. A vendored copy with a different
  hash was built from other source.

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
