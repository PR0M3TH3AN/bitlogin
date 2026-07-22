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
