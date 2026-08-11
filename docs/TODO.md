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

Third-pass response (same day): BL-25 — live subscriptions now carry a
bounded already-seen id cache (2048, FIFO eviction; a replayed retained
event costs one verification and one delivery, ever) and a fixed-window
verification budget (100 per 10s; distinct-event spray is quarantined for
the window). BL-26 — teardown order inverted: the courtesy logout event is
pre-signed, then close() IMMEDIATELY rejects every in-flight request and
wipes keys, then the pre-signed event is delivered asynchronously and
bounded — nothing can resolve after logout begins (regression-tested).
BL-27 — a nostrconnect listen failing naturally (timeout, unreachable
relays) now discards the pending ephemeral key in a guarded catch instead
of orphaning it. BL-28 — the hosted verify job installs the pinned Semgrep
before running security:ci (it was red at the previous HEAD, skipping SBOM
and checksums). Informational — bunker URIs are bounded: 4096 chars total,
256-char secret, 512-char relay URLs (oversized relays filtered, oversized
URI/secret rejected).

Owner action items:

1. **Live-fire the NIP-46 QR with Amber** on bitlogin.network (flow was
   verified against a fake bunker in tests, not yet against a real phone
   signer end-to-end).
2. **Live-fire passkey sign-in on a real device.** *Partly discharged
   2026-08-04:* `packages/widget/src/e2e/passkey.e2e.test.ts` drives real
   headless Chromium through the real WebAuthn ceremonies with a CDP
   virtual authenticator (`hasPrf: true`), against the built demo and
   in-process mock relays — create passkey → register → dashboard npub →
   capsules verified on the relays → logout → sign in with the same passkey
   → same npub; plus a second passkey deriving a different account. Runs in
   `npm test`, skips automatically without `npx playwright install
   chromium`. What that still does NOT cover: a real platform authenticator
   (Google Password Manager, iCloud Keychain, Bitwarden, a hardware key)
   and the create-time-PRF-absent fallback path, which Chromium's virtual
   authenticator does not exercise (it returns PRF results at creation).
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

## Additive browser distribution and integrator API roadmap

These are additive compatibility goals. The existing multi-file build,
`<bitlogin-auth>` behavior, `window.nostr` provider, derivation chain, session
formats, and current consuming applications are compatibility contracts. Do
not replace or silently alter them while adding standalone distribution or a
new public API. Every release must continue to produce and test the standard
build before the standalone build is considered successful.

### Priority 1 — Distribution

- [ ] Add a standalone browser build target: `npm run build:standalone`.
- [ ] Produce one self-contained `bitlogin.js` for standalone consumers.
- [ ] Keep the standard multi-file build unchanged and available alongside it:
      `dist/standard/` and `dist/standalone/`.
- [ ] Remove standalone runtime dependence on external `cryptoWorker.js`,
      hashed shared chunks, or other sibling files; preserve Web Worker
      isolation internally where possible using a Blob/module worker.
- [ ] Support this minimal static-site integration:
      `<script type="module" src="./bitlogin.js"></script>` and
      `<bitlogin-auth></bitlogin-auth>`.
- [ ] Verify standalone hosting from arbitrary static HTTPS origins, including
      GitHub Pages, Cloudflare Pages, Netlify, Vercel, and ordinary nginx.
- [ ] Verify localhost development usage.
- [ ] Document `file://` limitations clearly, including the recommended local
      HTTPS or local development-server path.
- [ ] Define CSP requirements for standalone Blob/module workers and report
      incompatible policies instead of silently degrading crypto isolation.

### Priority 2 — Developer API

- [ ] Define and document one canonical signer interface with capability-based
      methods: `getPublicKey()`, `signEvent()`, `getRelays()`, and supported
      `nip04.encrypt/decrypt`, `nip44.encrypt/decrypt`, and NWC operations.
- [ ] Keep `window.nostr` compatibility, including its existing NIP-07-shaped
      behavior, as an adapter over the canonical signer rather than a breaking
      replacement.
- [ ] Expose a clean additive `window.bitlogin` API, including
      `activeSession()`, `login()`, `logout()`, and `getSigner()`.
- [ ] Add and document stable lifecycle event aliases: `bitlogin:ready`,
      `bitlogin:login`, `bitlogin:logout`, and `bitlogin:error`. Preserve the
      existing hyphenated events (`bitlogin-login`, `bitlogin-logout`, and
      related current event names) for compatibility; the colon-named events
      must be additive and must not replace them silently.
- [ ] Version and test event payloads; preserve existing event names and
      payload fields used by current apps while adding new fields additively.
- [ ] Expose capability detection, for example `signer.capabilities()`, for
      `signEvent`, `nip04`, `nip44`, `nip46`, `nwc`, and `passkey`.
- [ ] Ensure capability reporting describes the active session and never
      implies support for a method that the active signer cannot perform.

### Priority 3 — Embedding and UI

- [ ] Support a headless mode so applications can use BitLogin without
      rendering `<bitlogin-auth>`.
- [ ] Keep `<bitlogin-auth>` as the default easy-to-integrate UI.
- [ ] Allow applications to open the login dialog programmatically, including
      `await bitlogin.login()`.
- [ ] Allow configurable login methods, for example
      `<bitlogin-auth methods="passkey,password,nip07,nip46"></bitlogin-auth>`.
- [ ] Add basic theming hooks: CSS custom properties, light/dark support,
      accent color, and compact mode.
- [ ] Expose supported configuration through documented attributes/options;
      do not require integrators to reach into widget internals or private DOM.
- [ ] Preserve current login-method defaults and existing method ordering unless
      an explicit versioned compatibility decision says otherwise.

### Priority 4 — Build, versioning, and releases

- [ ] Give browser artifacts predictable filenames: `bitlogin.js` and,
      if useful, `bitlogin.min.js`.
- [ ] Expose version information through `window.bitlogin.version` and the
      module/API surface where applicable.
- [ ] Emit integrity/hash manifests for releases and document exactly which
      artifact each hash covers.
- [ ] Create downloadable release artifacts: `bitlogin-standard.zip` and
      `bitlogin-standalone.js`.
- [ ] Publish release notes specifically for integrators, including changed
      browser requirements, CSP requirements, API additions, and compatibility
      notes.
- [ ] Evaluate public package exports for the widget, standalone entry point,
      and core package (for example `@bitlogin/widget`,
      `@bitlogin/widget/standalone`, and `@bitlogin/core`) without exposing
      unsupported private paths or weakening package encapsulation.

### Priority 5 — Integration and compatibility testing

- [ ] Add a minimal vanilla HTML integration test for both standard and
      standalone builds.
- [ ] Test standalone flows for password account, passkey account, recovery
      phrase, NIP-07 extension, and NIP-46 bunker.
- [ ] Test `getPublicKey()`, `signEvent()`, `logout()`, and session restore
      through both the canonical signer and the compatibility adapter.
- [ ] Test signed kind-1 publication against real or mock relays.
- [ ] Test multiple BitLogin-enabled applications on separate origins and
      confirm origin-scoped storage/session behavior remains isolated.
- [ ] Test CSP compatibility, including the documented Blob/module-worker
      requirements and a fail-closed result when a required policy is absent.
- [ ] Test Blob Worker behavior across Chromium, Firefox, and Safari.
- [ ] Test passkeys on real platform authenticators in addition to the existing
      virtual-authenticator coverage.
- [ ] Run the existing derivation-chain known-answer tests and regression suite
      unchanged; never update expected values to make a compatibility failure
      pass.
- [ ] Verify current consuming applications (including AdZap, Satisfied,
      BitUnlock, BitRoad, and Bitvid where their checkouts are available) still
      load the standard artifact and retain login, signing, logout, and session
      restore behavior.
- [ ] Add a release gate that builds/tests the standard artifact before and
      after standalone bundling, proving standalone work cannot replace or
      mutate the standard output accidentally.

### Priority 6 — Documentation

- [ ] Put a "30-second integration" section at the top of the README.
- [ ] Provide a complete single-page standard and standalone example.
- [ ] Provide a headless example.
- [ ] Provide a Nostr publishing example:
      `const signer = await bitlogin.getSigner();` followed by
      `const event = await signer.signEvent(...);`.
- [ ] Provide a migration guide from the standard build to the standalone
      build, with a rollback path that requires no application-code rewrite.
- [ ] Clearly explain the security tradeoff between the standard worker/chunk
      build and the standalone bundled build.
- [ ] Clearly state that standalone is a distribution convenience, not a
      stronger security boundary; an embedding host remains trusted and
      same-origin with the widget unless a separate isolation architecture is
      used.

### Definition of done

A developer can download one JavaScript file, add approximately 3–5 lines of
HTML/JavaScript, and obtain a real BitLogin-backed Nostr signer without npm,
Vite, React, or a backend. Existing standard-build consumers continue to work
without source changes, and the compatibility and security claims above are
backed by automated tests and release artifacts.

### Context warnings to resolve

- [ ] Replace unresolved package references such as `@file:bitlogin/widget`,
      `@file:bitlogin/widget/standalone`, and `@file:bitlogin/core` with actual
      documented package paths or mark them as examples only; do not publish
      links to files or exports that do not exist.

## BitBlocks App Kit compatibility layer

Do this only after BitLogin, BitGate, and BitFeed each have clean standalone
APIs. BitBlocks is an optional integration layer, not a replacement for any of
the three libraries. It must not merge their implementations or make an app
depend on the kit when it only needs BitLogin.

- [ ] Create a tiny optional BitBlocks integration layer.
- [ ] Keep BitLogin, BitGate, and BitFeed as separate replaceable libraries;
      the App Kit must compose them rather than absorb them.
- [ ] Provide shared initialization, for example:

      const app = await BitBlocks.create({
        login: {},
        gate: {},
        feed: {},
        relays: [...]
      });

- [ ] Standardize the viewer context exchanged between the components without
      changing BitLogin's signer/session contract.
- [ ] Centralize optional common Nostr plumbing in the kit: relay connections,
      subscriptions, EOSE handling, reconnects, deduplication, timeouts,
      publishing, OK responses, profile lookup, follow-list lookup, and
      mute-list lookup.
- [ ] Expose `app.viewer`, `app.signer`, `app.relays`, `app.gate`, and
      `app.feed` through documented interfaces.
- [ ] Keep each underlying library independently usable and independently
      versioned.
- [ ] Do not make applications depend on BitBlocks when they use only
      BitLogin's identity/signing capabilities.
- [ ] Add integration tests proving the kit is an adapter over the standalone
      APIs, not a second implementation of identity, policy, or feed logic.

### BitBlocks definition of done

A developer or AI agent can take `bitlogin.js`, `bitgate.js`, `bitfeed.js`, and
`bitblocks.js` and build a functional static Nostr application with almost no
infrastructure or integration boilerplate, while each individual library
remains usable without BitBlocks.

## Feedback from integrating into Tessera (2026-08-11)

Notes from embedding `@bitlogin/widget` in the Tessera static site. Grouped by
how much they cost.

### High-value

- **[DONE 2026-08-11] Lightweight session-state read without the full widget.**
  The single biggest cost: to know *whether a user is signed in* on a page, you
  used to have to mount the whole widget (bitlogin.js + crypto worker + wasm,
  ~1.6MB) because it was the only thing that restored the per-origin session.
  **Shipped:** the widget now writes a cleartext, public-only record
  (`{ pubkey, npub, name? }` — never key material) beside its encrypted session
  in IndexedDB and clears it on logout, and a new `@bitlogin/widget/session`
  entry point (`bitlogin-session.js`, ~1 KB gzip, zero deps, no worker/wasm)
  exposes `readCachedSession(): Promise<{ pubkey, npub, name? } | null>`. The
  same call is mirrored on `window.bitlogin.readCachedSession()` for pages that
  already load the full widget. See `src/publicSession.ts`, `src/session.ts`,
  and the README "Reading who's signed in without loading the widget" section.
  Remaining polish: have the widget also record the profile display `name` once
  fetched (currently `name` is only set when the caller supplies it), and add an
  `@bitlogin/widget/session` `.d.ts` (tracked under the Small item below).
- **A headless session-restore API.** Related: expose session restore +
  `getPublicKey`/`signEvent` without the custom element, so a host app can wire
  its own UI and only load the visual widget for login/management. Right now the
  element is the only entry point.

### Medium

- **[DONE 2026-08-11] The unmount-kills-the-worker footgun now has a guardrail.**
  The docs warned that removing `<bitlogin-auth>` tears down the crypto worker
  and hangs every later signing call with no error. **Shipped both asks:**
  (a) `disconnectedCallback` now logs a `console.error` when the element is
  removed while a session is active, naming the unmount and pointing at the
  README "Integration gotcha"; and (b) `WorkerClient.terminate(reason)` records
  the reason and `signEvent`/`getPublicKey`/etc. — whether in-flight at teardown
  or issued afterward — reject with that message instead of hanging (the
  `dead`-flag path already prevented the infinite hang; this makes the *cause*
  legible and unifies the message). Covered by `worker/workerClient.test.ts`;
  README gotcha paragraphs updated to say "rejects loudly," not "hangs forever."
- **Styling hooks / CSS parts.** The widget renders in a shadow root, so a host
  can only frame it, not theme it. A few `::part()` hooks (button, panel, text)
  would let it match a host design system instead of looking pasted in. Tessera
  worked around this by wrapping it in a bordered panel with its own header.
- **[RESOLVED — already the behavior] Session-change event on restore.**
  Confirmed: `bitlogin-login` already fires on silent session restore across a
  page load, not just interactive login, so a host listener needn't distinguish
  the two (README "Sessions persist across a page reload"). No new event needed.
  For pages that don't mount the widget at all, use `readCachedSession()` above.

### Small

- Ship a `.d.ts` (or documented event/method surface) for the element:
  `getPublicKey`, `signEvent`, `nip44Encrypt/Decrypt`, and the event
  `detail` shapes. Integrators currently read the demo to learn the API.
