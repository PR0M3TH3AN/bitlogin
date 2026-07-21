# BitLogin

login for normies.

A static, relay-backed portable account protocol: a familiar login name and
password that unlocks a portable Nostr identity, plus an independent 12-word
recovery phrase. Encrypted account material lives on public Nostr relays —
no account server, no password-reset email, no database.

This repo implements the protocol from `docs/spec.md` (v0.4) as a modular
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

The `<bitlogin-auth>` element also mirrors `window.nostr` directly on the
element instance (`getPublicKey`, `signEvent`, `nip44Encrypt`, `nip44Decrypt`)
— prefer this over `window.nostr` when your host page holds a reference to
its own widget instance, since `window.nostr` is a single global slot that
whichever provider signed in last currently owns.

**Integration gotcha:** the element's `disconnectedCallback` terminates its
crypto Web Worker (that's the correct cleanup when the element is genuinely
being removed). If your host app re-renders its own DOM by resetting an
ancestor's `innerHTML` — a common pattern in hand-rolled UI without a
framework's reconciler — and the widget happens to be a descendant of that
subtree, this **silently kills the in-progress session**: `getPublicKey()`
already resolved before the render still looks fine, but every call after
that hangs forever, because the worker is gone and nothing ever replies.
Mount `<bitlogin-auth>` into a container that your own re-renders never
replace (toggle visibility with the `hidden` attribute instead of removing
it from the DOM), not into a template string that gets thrown away and
rebuilt. See `packages/demo/public/account.html` for a working single-page
example. The BitRoad project (a sibling Nostr commerce app that embeds
BitLogin as a sign-in option) hit exactly this bug during integration and
fixed it by giving the element a permanent, never-replaced mount point in
its static shell HTML, only toggling `hidden` — see its
`src/nostr/bitloginAdapter.mjs` and the `#bitloginMount` container in its
`index.html` for a worked example of the pattern.

**Another integration gotcha, now fixed:** some NIP-07 browser extensions
install `window.nostr` as a non-configurable, non-writable property
specifically to stop another script from overwriting it. `claimSigner()`
(called automatically after every sign-in) used to do a plain
`window.nostr = ...` assignment with no guard, so on a page where such an
extension is active, that line threw `TypeError: Cannot assign to read only
property 'nostr' of object '#<Window>'` — and since it ran synchronously
before the widget dispatched `bitlogin-login` or moved to the dashboard
screen, this **froze account creation/import at the final "verify your
recovery phrase" step**, with that raw TypeError as the only (confusing)
feedback. `claimSigner()` now catches this, returns `false` instead of
throwing, and every caller proceeds to complete sign-in regardless — a host
page using this element's own methods (as documented above) was never
actually affected by the failed `window.nostr` takeover anyway. The widget's
own dashboard now also shows a plain-language warning in this case ("Another
Nostr signer (browser extension) is active in this browser and couldn't be
replaced...") using the same warning banner already shown for rollback and
relay-disagreement conditions.

### Theming

`<bitlogin-auth>` renders in a shadow root, but its colors, radius, font, and
max-width are all read from CSS custom properties on `:host` — and custom
properties inherit through the shadow boundary, so a host page can override
every one of them from ordinary light-DOM CSS (a rule targeting the element,
or an inline style), without touching the widget's internals:

```css
bitlogin-auth {
  --bl-accent: #3d9bff;       /* primary button / link / focus ring color */
  --bl-accent-hover: #2f86e0; /* primary button hover */
  --bl-accent-fg: #04101f;    /* text color on top of --bl-accent */
  --bl-bg: #12151f;           /* card background */
  --bl-fg: #eaeef6;           /* body text */
  --bl-muted: #98a2b6;        /* secondary text */
  --bl-border: rgba(255, 255, 255, 0.10);
  --bl-input-bg: #1a1e2b;     /* input/credential-box background */
  --bl-danger: #ff6b6b;
  --bl-danger-bg: rgba(255, 107, 107, 0.16);
  --bl-warn: #ff6b6b;
  --bl-warn-bg: rgba(255, 107, 107, 0.16);
  --bl-radius: 14px;
  --bl-font-family: Inter, ui-sans-serif, system-ui, sans-serif;
  --bl-max-width: none;       /* default 380px keeps it a fixed-width card;
                                  override to fill a wider container */
}
```

All of these have defaults (a light theme, with a `prefers-color-scheme:
dark` media-query fallback and a `data-theme="dark"|"light"` attribute
override for host pages with their own theme toggle), so overriding none of
them is a valid choice — the widget just uses its own look. See BitRoad's
`bitlogin-auth { ... }` rule in `src/styles.css` for a real integration that
maps every one of these to its own design tokens.

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
<script type="module" src="https://bitlogin.network/vendor/bitlogin/bitlogin.js"></script>
<bitlogin-auth></bitlogin-auth>
```

`bitlogin.network` and `www.bitlogin.network` are attached to the same
Vercel project as production domains (`bitlogin.vercel.app` keeps working as
the underlying `*.vercel.app` alias regardless). DNS for a domain bought
outside Vercel has to be pointed at it separately — see "Custom domain DNS"
below if you're standing this project up on a new domain yourself.

This is fine for prototyping across multiple projects; for production use in
someone else's app, self-hosting the built files (or a future published npm
package / CDN release) avoids depending on this demo deployment's uptime.

### Custom domain DNS

Vercel doesn't manage DNS for a domain unless its nameservers are delegated
to Vercel; with third-party DNS (this project's domains sit on Cloudflare
nameservers, registrar-agnostic), add these records at whichever provider
actually serves the zone:

```text
A       bitlogin.network         76.76.21.21
A       www.bitlogin.network     76.76.21.21
```

Run `vercel domains inspect bitlogin.network` (from a machine with the
Vercel CLI linked to this project) to confirm the exact records currently
expected — Vercel occasionally changes its recommended anycast IP, and that
command always reflects the live requirement rather than whatever's written
here. If the DNS host proxies through something like Cloudflare, set the
record to DNS-only (grey cloud) rather than proxied — a proxying layer in
front of Vercel's own edge can interfere with certificate issuance and
routing.

## What's implemented

This build covers the protocol's Phase 0 (cryptographic core + test vectors)
and the load-bearing parts of Phase 1 (account MVP), verified two ways:

- **Protocol-level tests** (`npm test`, 77 tests): Argon2id/ScalarExpand/JCS/
  padding/timestamp/NIP-44 unit tests with the spec's exact byte layouts
  (§11), and full end-to-end scenarios — create → clean-device login, phrase
  recovery → new credentials → clean-device login, password change with
  mandatory tombstone + NIP-09 deletion, relay-loss → replica repair
  (including keyless recovery-event rebroadcast), generation-rollback
  detection failing closed by default rather than only warning (§16.2 step
  6), and initial profile/relay-list publication never overwriting an
  existing kind 0/10002/10050 event when the everyday identity is an
  imported nsec (§15.8, §28.1) — run against an in-memory mock relay
  (`packages/core/src/test-support/mockRelay.ts`), since this sandbox has no
  route to public Nostr relays. NIP-44 has additionally been cross-tested
  directly against the `nostr-tools` reference implementation (conversation
  keys, padding at every bucket boundary, and round trips in both directions)
  during the BitRoad integration — see "Changes from v0.3" in `docs/spec.md`.
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

## Contributing

MIT licensed — see `LICENSE`. See `CONTRIBUTING.md` for the dev workflow,
mock-relay testing (no route to public relays in most sandboxes/CI), and
the spec-first process for anything touching wire format or crypto. Found
a security issue? See `SECURITY.md` rather than opening a public issue.
