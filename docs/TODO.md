# BitLogin — open items

Updated: 2026-11-19

## Sign-in window: what shipped, and what is next (2026-11-19)

A site that embeds the widget can read the password as it is typed, and one
BitLogin account is one identity on every site. So the password is now typed
at one address, BitLogin's own, and other sites ask a hidden signer of that
address. Design: `docs/sign-in-window.md`. Asked for by the owner while
building signing inside NSWP worlds; the first asking site is that
repository's flat demo (`docs/plans/signin-demo`).

**Shipped, and live at `https://bitlogin.network`:**

- `/signer/` (embedded unseen by a site) and `/connect/` (the window a site
  opens), with headers of their own (§SW6). Pull requests #31 and #33.
- The key moves from the window to the signer inside the crypto workers
  (§SW4). What arrives can only sign.
- The signer signs a note and a reaction for a site the user allowed, marks
  each with the site's address, and refuses everything else (§SW5).
- It remembers a site for thirty days, encrypted at rest, until the user
  signs out of it there (§SW11).

**Owner decisions taken 2026-11-19:**

- BitLogin's own site is the sign-in address for every BitLogin system,
  BitPortal included. It is the default and must not be the only one
  possible: the site is static and anyone can serve it.
- A password is never typed into an asking site.
- A site the user allowed stays allowed across page loads.
- An optional lock, with a PIN as one way to open it, even though a PIN is
  not a strong gate: some people want one for privacy at home.
- One press for a new site stays for now. Ways to lighten it are to be
  explored (§SW15).
- Several profiles on a device, natively.

**Where the work happens (owner's decision, 2026-11-19).** On the `beta`
branch and the beta site, `https://bitlogin-beta.vercel.app/`, a second
sign-in address with the same pages and headers. `main` is promoted from
`beta` once a piece is solid, and only then does `bitlogin.network` change.
How: `CONTRIBUTING.md`, "Release channels".

**What an approved app must be able to do (owner, 2026-11-19).** Once a user
has approved an app, it signs and sends in the background, with no prompt,
as apps do with the embedded widget today. The design allows this; as built
it covers only a note and a reaction. Item 1 is what extends it.

**Next, in this order.** None is started. The order was changed on
2026-11-19 from the one in pull request #34; the reasons are under each item
that moved.

- [ ] **1. What an application declares (§SW9).** **Built on `beta`
  2026-11-19, not promoted.** The owner's five decisions are taken and
  built (§SW9.10). Still to do before it is promoted: move one real
  application onto it (Tessera is the
  smallest: six kinds, one service key, no background signing outside a
  purchase); try it by hand on the beta site; and a wallet connection
  through the window (§SW9.9), which bitunlock and Satisfied need. Moved
  from fourth to first. Until it exists no real app can use the window, so every app stays
  on the embedded widget, which is the path this work exists to retire; the
  lock would be polishing a flow nobody is on. From a read of their code on
  2026-11-19: bitunlock asks its signer for web-request proofs, private
  messages and a wallet connection; bitvid for video events, lists, reposts,
  deletions, zap requests, application data, and encrypting and decrypting.
  BitPortal's own `/account/` sign-in waits on this too (its `AGENTS.md`).
  The design has to settle:
  - A permission set the app declares and the user sees once, in the window.
    The signer then signs those kinds in the background and nothing else.
  - Application data (kind 30078) for an app's own settings, with the
    addresses BitLogin keeps capsules at never writable by any app.
  - Encrypting and decrypting for an approved app. A handed-over session
    refuses both today, on purpose (§SW4).
  - Limits that fit an app. Six signatures a minute throttles one that signs
    in bursts; a limit per permission, not one number for every site.
  - Which kinds still ask every time. A deletion or a profile change that
    prompts each time is a visible change from how the apps work now.
  - How broad a silent permission may be before "approved" means "has the
    identity". This is where the model holds or fails.
- [ ] **2. Find out what browsers keep for an embedded signer.** Moved up
  from the owner's list, because it decides how everything above feels:
  Safari, Brave, a phone, and the Quest browser. Where an embedded page gets
  no lasting storage, "approved for thirty days" becomes "asked on every
  visit". In a headset that is worse than an annoyance (see "In a headset").
- [ ] **3. The optional lock (§SW12).** Off by default. Opened by a
  BitLogin PIN or by the device's own unlock through a passkey used only as
  a wrapping key. Covers what the signer remembers for each site.
  - Starts in `spec.md` §21: it is key handling at rest.
  - The PIN wrap needs both the device key and an Argon2id-stretched key. A
    count of wrong tries removes the record. The PIN is never a credential.
  - The device's unlock makes no account and no capsule, and leaves the
    derivation chain alone (see "Standing rule" below).
  - The device's unlock is the more important of the two, not only the
    stronger. A site can open a look-alike window and a typed password or
    PIN does not resist that; a passkey prompt is bound to the real address.
  - The embedded signer's page gains a small panel for this one thing: its
    policy (§SW6), the policy tests, and the site-to-signer messages change
    with it. The NSWP kit must show the frame and allow it the passkey
    prompt.
  - Say in the interface what a PIN does not protect against, where it is
    turned on.
  - Decide: how long unused before it locks (fifteen minutes suggested), and
    how many wrong tries (eight suggested).
  - Browser test: lock, unlock by each way, wrong tries, a reload, and that
    a site can read none of it.
- [ ] **4. The same lock on the sign-in address's own session (§SW13).**
  Then a new site is: the window, unlock, Allow, with no password.
- [ ] **5. Several profiles.** `docs/account-switching.md` first (a design,
  not built), then the picker in the window and a profile per remembered
  site (§SW14). **Decide before building:** whether each profile is a whole
  account with its own password and phrase, as that design says, or whether
  several profiles come from one recovery phrase. Since v0.7 a new account's
  key is derived from its phrase (`spec.md` §11.6), so a second profile
  could be a second derivation label. One phrase to back up for all of them
  answers the failure that started the relay-loss work; the cost is that one
  leaked phrase exposes every profile, and that profiles made that way are
  provably the same person to anyone holding the phrase.
- [ ] **6. Explore fewer presses for a new site (§SW15).** The browser's
  storage-access permission, and its federated sign-in. Neither is tried.
  The one deliberate act stays; the window is what might go.
- [ ] **7. One place to see and take back the sites allowed.** Not
  possible as built: a browser does not let the sign-in address see what
  was kept for it inside other sites (§SW11). Needs a design, perhaps a
  record on relays every signer checks.
- [ ] **8. Names of BitLogin's own.** The messages and the tag are NSWP's
  (`nswp-signer`, `nswp-handoff`, `nswp:world`), kept so that kit worked
  unchanged. Decide BitLogin's with the version item 1 needs.
- [ ] **9. A check that the live sign-in address is a reviewed build.** One
  address now holds every user's sign-in, where the vendored widget was
  designed so that one bad deploy could not reach every site at once
  (`.agents/memory/architecture.md`). Beta-then-promote narrows that; it
  does not close it. Wanted: after each production deploy, compare the live
  files with `npm run release:artifacts` for the same commit, and say so
  somewhere a user could look.

- [ ] **10. BitLogin as the relay broadcaster** (asked for by the owner,
  2026-11-19). Design: `docs/relay-broadcast.md`. An application hands over a
  signed note and BitLogin sends it to the author's write relays, the read
  relays of whoever it tags, and the best relays this device has seen when
  the author's own list is thin. Not started. Five decisions are the owner's
  (§RB10). Found while writing it: every account BitLogin creates is given a
  public relay list of all thirteen vault relays, several of which do not
  work (§RB1, §RB8).
- [ ] **11. The browser's own password prompt** (asked for by the owner,
  2026-11-19). The browser should offer to save the login name and password,
  and fill them in later, both at BitLogin's own address and in an
  application that embeds the widget.
  - [x] Sign-up, recovery and rotation put the login name and the generated
    password in real, `autocomplete`-marked fields of the form that is
    submitted. Sign-in already did. Checked in Chromium, Firefox and WebKit
    (`passkey.e2e.test.ts`). On beta 2026-11-19.
  - [ ] **Owner: look at the prompt itself** in Chrome, Firefox and Safari,
    on a computer and a phone. No test harness sees a browser's own save
    prompt or fill menu. Two things to watch for: whether Safari offers to
    save when the form is submitted and no page loads after it, and whether
    Safari and phone browsers fill fields inside the widget's shadow root.
    If either fails, the fix is a save step that loads a page, or the
    fields moved out of the shadow root.

- [x] **12. Who a visitor is, in a world (§SW16).** **Built on `beta`
  2026-11-19.** Passed on from the BitPortal / NSWP session; the owner said
  yes to both parts the same day.
  - [x] The signer's `state` reply carries `name`, `picture` and `about`
    from the person's own signed profile, fetched and checked by BitLogin's
    worker in the sign-in window and sealed into the hand-off.
  - [x] A room pass through a request of its own, `{ t: "pass", id,
    session }`. The site supplies a session key; the worker builds the rest.
    `sign` still refuses kind 27300. Accepted by NSWP's `verifyRoomPass`.
  - [ ] The kit side is the NSWP session's: ask for a pass after unlock,
    check it, join by name, and read `picture` and `about`.
  - [ ] Not available to an application that declared permissions. Add a
    declared permission for it if one ever needs it.
  - [ ] A profile is as it was when the site was allowed: it is not fetched
    again until the user is next asked. Decide whether that is fresh enough.

- [ ] **13. Four tightenings relayed by the NSWP session** (2026-11-19).
  The owner said yes to all four the same day.
  - [x] **Slower limits for a world:** 3 a minute and 20 an hour, the same
    as NSWP's kit 0.28.0. A room pass counts. On `beta`.
  - [x] **Remembering (§SW11),** as the owner settled it later the same
    day through the NSWP session: on unless unticked, for every site;
    thirty days for a site on `KNOWN_APPS`, seven for any other. The first
    rule (unknown sites for one visit unless ticked) was built and
    withdrawn. On `beta`.
  - [x] **A room pass is counted apart from notes:** two a minute and ten
    an hour, NSWP's numbers. On `beta`.
  - [x] **The list of sites allowed (§SW18):** `/sites/` at the sign-in
    address. On `beta`. It cannot switch a site off or show how often one
    signed: a browser does not let it.
  - [x] **A real "remove"** (`docs/take-back.md`). "Take it back" and
    "Sign out of every site" at `/sites/` publish a sealed record on the
    user's relays; every embedded signer reads it on its first page load
    and then daily, and forgets its site. The signer's page may now contact
    relays (`connect-src 'self' wss:`), by the owner's decision. On `beta`.
  - [ ] **Two follow-ups to the take-back check** (`take-back.md` §TB10):
    a relay client in a worker that holds no key, and asking a handful of
    relays where it asks up to twelve.
  - [x] **A take-back tried on public relays** (2026-11-19, one run): it
    worked, and ten of thirteen built-in relays held the record. The three
    that did not are the three that never connect.
  - [ ] **Check after some days whether relays still hold a take-back
    record.** One run says nothing about how long they keep it.
  - [ ] **Keep a user's relay list alive** (item 10): the take-back check
    follows their NIP-65 list, and nothing yet repairs a list that has
    gone stale or looks for live relays (NIP-66).
  - [x] **The lock (§SW12, `spec.md` §21.5):** a PIN, the device's own
    unlock offered first where it was added, five tries, "Lock now", off by
    default. On `beta`. While it is on, no site is remembered.
  - [ ] **OWNER'S DECISION: the lock inside a site.** The panel in the
    embedded signer (§SW12) is not built; with the lock on, sites are
    allowed per visit instead. Building the panel changes §SW6 and needs
    the NSWP kit to show the frame.
  - [ ] **Try the lock on real devices:** a fingerprint or face reader,
    Safari, a phone.
- [ ] **14. One Allow for a family of sites** (asked for by the owner
  through the BitPortal session, 2026-11-19). Design: `docs/site-family.md`.
  One tick at Allow covers every site under one registrable domain, such as
  every world at `bitblocks.network`, for notes, reactions and room passes
  only, with counts shared across the family. Not started. Four decisions
  are the owner's (§SF9).

**In a headset** (read from BitPortal's `AGENTS.md` and the NSWP plans
`signing-in-worlds.md` and `in-game-identity.md`, 2026-11-19). These bound
the items above; none is BitLogin's to decide alone.

- During a headset session no window can open and nothing but the world can
  draw. So the sign-in window, the Allow press and the lock's PIN panel
  cannot appear there. A visitor approves a world on the flat browser first.
- That makes the remembered approval (§SW11) the whole of signing in VR: it
  is what lets a world sign in the background once the visitor is inside.
  Item 2 has to include the Quest browser for this reason.
- Of the lock's two ways in, only the device's unlock could work during a
  session, and whether its prompt can appear there is untested (the NSWP
  plan's test C). If it cannot, the NSWP plan links a headset once, from the
  visitor's own BitPortal room, by a code approved on a phone; that needs a
  protocol change there, and from BitLogin a way to approve from another
  device. The older request in this file, "Pair a device without a QR or a
  long paste", is the same need.
- BitPortal names `https://bitlogin.network/` as the signer in every
  arrival (`INSTANCE.signer`). To try the beta address from BitPortal that
  value has to point at it, in a BitPortal build made for the purpose; it
  is the owner's to change.
- BitPortal never frames its own sign-in page and never draws BitLogin in a
  canvas or a headset session. Nothing here should ask it to.

**Owner action items:**

- [ ] Try the live flow with your own account, including a reload:
  `?at=live` on the NSWP flat demo. Tried so far only with throwaway
  accounts in the browser test.
- [ ] Point `beta.bitlogin.network` at the beta site, if a `vercel.app`
  address is not what you want testers to see. The domain's DNS is not on
  Vercel, so it needs a record added where the domain is managed, and then
  `vercel domains add beta.bitlogin.network bitlogin-beta`. Sessions and
  passkeys belong to an address, so changing it later signs beta testers out
  once.
- [ ] Confirm `bitlogin.network` as the sign-in address for good before
  item 1 ships. A device-unlock passkey is bound to the address it was made
  at. Changing the address later costs each user one ordinary sign-in, not
  an identity, but it should be chosen on purpose.

**Notes for whoever builds this:**

- CI's `static-analysis` job runs `semgrep scan --config auto`, which is
  broader than `npm run security:semgrep`. Run both before pushing. Two
  things it caught on 2026-11-19: a message posted to any origin, and
  randomness asked for inside a `try`.
- Pushing a branch other than `beta` makes a preview deployment and merging
  to `main` makes a production one. `beta` deploys only when someone runs
  `npm run deploy:beta`. Vercel's free plan allows 100 deployments a day
  across every project, and that limit was reached on 2026-11-18. `vercel curl <path> --deployment <url> -- -sI` reads a
  protected preview's headers.
- The browser tests need the demo built first (`npm run build:demo`).
- Nothing here signs anyone in from automation: the browser tests make
  throwaway accounts against the mock relays.


## Relay-loss response (2026-11-18)

The owner's own account was dropped by every vault relay. The password and
the recovery phrase both failed; only a separately stored `nsec` saved the
identity. Shipped in response as spec v0.7 (see CHANGELOG): new accounts
derive the everyday key from the recovery phrase (§11.6), a lost account can
be rebuilt from the phrase alone (§17.6), imported keys get a blocking
private-key backup step (§15.7), and the dashboard has a replica health check
with one-tap repair (§24.4).

Owner decisions taken 2026-11-18: derive from the seed for generated accounts;
imported keys stay as they are and are told they differ. The owner had no
preference on the derivation, so it is BitLogin-specific
(`ScalarExpand(recovery_prk, "bitlogin/everyday-identity/v1")`) rather than
NIP-06: no new dependency in the key path, and the phrase stays BitLogin-only.
The cost is that a BitLogin phrase does not restore the identity in other
Nostr apps; the `nsec` export does.

**The new derivation is now part of the standing rule below.** Its vector in
`knownAnswer.test.ts` is never updated.

Open:

- [x] **Live run against the built-in public relays, 2026-11-18.** Throwaway
  accounts, from core (Node) and from the built widget in headless Chromium:
  sign-up, health check, repair, sign-in, phrase recovery on a clean browser
  profile, and a rebuild from a phrase with no capsule on any relay all
  worked and returned the expected identity. Not covered: a real device or
  platform passkey, and the deployed site's CSP.
- [x] **Relay findings from that run, explained 2026-11-18.** Measured with
  `scripts/relay-probe.mjs` from the same machine (a VPN may have been
  active): `nostr.bitcoiner.social` and `offchain.pub` intermittently refuse
  capsule keys ("pubkey is not in our web of trust"), `offchain.pub` also held
  only half of the capsules it had acknowledged a few minutes later,
  `relay.mostr.pub` and `nostr-pub.wellorder.net` never connect, and
  `relay.damus.io` connects about one time in eight. Five relays that stored
  everything were added; nothing was removed. Raw results for the final list
  are in `release/relay-probe-2026-11-18.json` (untracked); re-read them with
  `node scripts/relay-probe.mjs --recheck release/relay-probe-2026-11-18.json`.
- [ ] **Owner: pin a maintainer key to switch the signed relay list on.** The
  channel is built and off (`MAINTAINER_PUBLIC_KEY_HEX` is `null`). Choose a
  key kept offline, get its public key with
  `BITLOGIN_MAINTAINER_NSEC=... node scripts/sign-relay-list.mjs --pubkey`,
  pin it in `packages/core/src/nostr/bootstrap.ts`, and release. After that,
  relay changes are `sign-relay-list.mjs list.json --publish` and need no
  re-vendoring. Until then every relay change is a client release.
- [ ] **Retention is only measured over minutes.** The five added relays kept
  every test event across two re-reads minutes apart. Re-run the recheck
  after a day and after a week, and replace any that dropped events.
- [ ] **Dead built-in relays still count against the read quorum.** Three of
  the thirteen never or rarely answer, so 10 of 13 respond against the 7 a
  read needs. They cannot be dropped from reads without risking accounts that
  live only on them. A way to stop COUNTING a relay without ceasing to ask it
  needs a spec decision.
- [ ] **The credential capsule is close to its size ceiling.** With four
  relay hints it has a little over a hundred bytes to spare in the 4096-byte
  bucket. Any new field in that payload needs the size test in
  `seedDerived.e2e.test.ts` extended first.
- [ ] **Accounts created before v0.7 are no safer than before.** Their key is
  random, so only a saved `nsec` or a recovery export survives total relay
  loss. They now get a standing dashboard notice saying so, the health check,
  and background repair at each sign-in. The dismissible §27.6 reminder is
  still unimplemented; it needs a place to remember "saved" that is not the
  element (which must stay storage-free). Rotating such an account onto a derived key would change its
  npub, so there is no silent migration.
- [ ] **A rebuild cannot tell whose phrase it has.** With no capsule left,
  nothing distinguishes a derived account from an imported or pre-v0.7 one,
  so the rebuild screen shows the derived npub and relies on the user
  recognising it. If the wrong user confirms, a capsule for an empty identity
  is published at their recovery address and outranks an older genuine
  capsule from a recovery export. Worth an external look.
- [ ] **Connection Vault roots are still random.** A rebuild mints new ones,
  so stored wallet connections are lost unless a recovery export kept the old
  capsule. Deriving them from the phrase is possible but touches the vault's
  security model, which is gated on the external review.
- [ ] **Health check for the Connection Vault records**, which live at other
  addresses and are not covered.

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
seed, the recovery signing and capsule keys for a phrase, the everyday key a
phrase derives (v0.7), base64url framing, and JCS ordering.

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
- [x] Emit integrity/hash manifests for releases and document exactly which
      artifact each hash covers. **Done 2026-11-17:** `npm run
      release:artifacts` writes `release/bitlogin-widget-v<version>/` with
      `integrity.json` and `SHA256SUMS.txt` (see CHANGELOG). Still open: tag
      a version and attach the folder to a GitHub Release, which is the
      owner's call.
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
- **[DONE 2026-08-11] A headless session-restore API.** Shipped
  `@bitlogin/widget/headless` (`bitlogin-headless.js`): `createHeadlessSigner()`
  → `restore()` / `getPublicKey()` / `signEvent()` / `nip44Encrypt|Decrypt` /
  `isUnlocked()` / `logout()` / `destroy()`, a DOM-free wrapper over the crypto
  worker. It restores the cached session and signs with no custom element and no
  `window.nostr`; it deliberately can't interactively log in (`restore()`
  returns null when nothing is cached → mount `<bitlogin-auth>` once). Covered by
  `headless.test.ts` (scripted-worker); also re-exported from `@bitlogin/widget`;
  README "Signing without the widget (headless)". Deploy alongside
  `cryptoWorker.js` + shared chunks.

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
- **[DONE 2026-08-11] Styling hooks / CSS parts.** The widget renders in a
  shadow root, so a host could recolor it via the `:host` custom properties but
  couldn't restyle structure. **Shipped:** a stable set of `::part()` hooks —
  `card`, `button` (+`button-primary`/`button-secondary`), `link`, `input`,
  `checkbox`, `heading`, `text`, `notice` (+`notice-warn`/`-info`/`-error`) —
  stamped centrally per render in `element.ts` `exposeParts()` (mapped by class
  so new elements stay exposed without drift). Documented as a contract in the
  README "Theming" section. Verified in-browser that
  `bitlogin-auth::part(...)` matches through the shadow boundary. Custom
  properties remain the first tool for color/radius/font; parts are the escape
  hatch for structure (padding/border/shadow/shape).
- **[RESOLVED — already the behavior] Session-change event on restore.**
  Confirmed: `bitlogin-login` already fires on silent session restore across a
  page load, not just interactive login, so a host listener needn't distinguish
  the two (README "Sessions persist across a page reload"). No new event needed.
  For pages that don't mount the widget at all, use `readCachedSession()` above.

### Small

- **[DONE 2026-08-11]** Ship a `.d.ts` (or documented event/method surface) for
  the element. **Shipped:** the widget now emits type declarations from source
  (`tsconfig.types.json` → `dist-types/`, wired via `build:types` and the
  package `types`/`exports` conditions for both `@bitlogin/widget` and
  `@bitlogin/widget/session`) — zero-drift because they're generated, not
  hand-written. Added the type surface integrators actually want: a
  `HTMLElementTagNameMap["bitlogin-auth"]` augmentation (typed
  `querySelector`/`createElement`), typed `addEventListener` overloads via a
  declaration-merged interface, and exported event-detail types
  (`BitLoginLoginEventDetail` etc. + `BitLoginEventMap`) in `src/events.ts`.
  Verified with a consumer conformance typecheck; README "TypeScript" section
  added.

## Requests from BitPortal / NSWP (2026-11-17)

BitPortal is a proposed spatial-web directory built on the four blocks
(`PR0M3TH3AN/Nostr-Spatial-Web-Protocol--NSWP-`, `spec.md` v0.3 §13, §13.1,
§21.1). It is a spec only; nothing consumes BitLogin yet. These are the gaps
found while writing it. None is approved work, and each needs the owner's
go-ahead.

### New asks (not tracked elsewhere in this file)

- [ ] **Pair a device without a QR or a long paste.** A standalone VR headset
  can't use either NIP-46 path: a phone can't scan a `nostrconnect` QR shown
  inside the headset, and pasting a `bunker://` URI with controllers isn't
  practical. Wanted: the new device shows a short code and the user approves it
  on a device where they are already signed in. A short code alone is guessable,
  so this needs a password-authenticated key exchange or an equivalent; it is a
  design task before it is a build task (NSWP spec Q12). The same flow would
  help TVs and consoles.
- [ ] **An opt-in headset profile for method order.** The widget is
  password-first (`docs/login-methods.md` §LM9.1), which means a virtual
  keyboard in VR. Wanted: a way for the host to lead with whichever methods need
  no typing. It must stay opt-in, because "Preserve current login-method
  defaults and existing method ordering" is already a rule in Priority 3 above.
  Related: the unchecked `methods` attribute item in Priority 3.
- [ ] **Test passkey (PRF) login on headset browsers.** `docs/passkey-login.md`
  calls PRF support uneven and lists no headset browser. BitPortal's Phase 2
  will run this matrix; results belong in that document.

### Already tracked here, now with a second consumer waiting

- One official tagged release with an integrity manifest (Priority 1 and
  Priority 4). Blocks BitPortal Phase 2.
- `pubkey` in event details, colon event aliases, `getSigner()` /
  `capabilities()` (Priority 2). BitPortal can use an adapter until these ship.
- NIP-46 credential persistence (gated on the external vault review, see
  "Security audit response"). Without it a paired headset loses its session on
  every reload.
- Multi-account switching (`docs/account-switching.md`, not implemented).
  BitPortal's "enter this world as an alternate identity" is sign-out and
  sign-in until it exists.

### Not requested

- Per-world derived keys. They would touch the derivation chain, which is a
  compatibility contract (see "Standing rule"). The NSWP spec lists this as an
  open question (Q1) and does not ask for it.

## Design review — external critique (2026-08-11)

From an outside review of the BitBlocks stack. BitLogin was called the highest
upside AND highest risk in the stack.

- **[agree] Highest assurance bar.** A BitLogin failure is identity compromise,
  not "the feed looked weird." Keep promotion conservative and the
  alpha/unaudited labeling prominent until an outside cryptographic/security
  review. Treat an external audit as a **gate** before any "use this for real"
  positioning — this is the one block where marketing must trail assurance.
- **[agree] No impossibility claims in copy.** Relay retention is best-effort;
  our own docs already say to keep the recovery export. Keep the site's language
  on "portable / no single operator controls," never "cannot be deleted." (See
  the umbrella claim-precision note.)
- The choices the review praised — high-entropy passphrase (not raw human
  passwords), Argon2id + AES-256-GCM, `window.nostr` compatibility so Nostr
  "disappears into the background" — are the right ones. Hold that line; don't
  soften the passphrase-entropy stance for UX.
