# Changelog

Tracks changes to `@bitlogin/core` and `@bitlogin/widget` that matter to a
site with its own vendored copy (see "Updating your integration" in
`README.md`). Not every commit needs an entry — only ones where a site
sitting on an older vendored copy is missing a fix or behavior change it
would plausibly want. Newest first.

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
