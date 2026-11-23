# Vendoring BitLogin `ab13cad` into every app

**Date:** 2026-11-19
**Source:** BitLogin `main` at `ab13cad` (PR #36), the build bitlogin.network
serves. `bitlogin.js` sha256 begins `f8056a43c9ac`.
**Order, as the owner set it:** COMBATRIG, Satisfied, the BitBlocks apps,
Bitvid, then the rest. Every live branch: `main`/`master`, `beta`,
`unstable`.

## What an app gets

Nothing an app must change in its own code. The widget gains: browser
password-manager forms, the optional lock (PIN, device unlock, "Lock now"),
and the check that turns a remembered sign-in back off when the user takes a
site back. An app that turns the lock on sees `bitlogin-logout` on lock and
`bitlogin-login` on unlock, as for signing out and in.

The new network rule (`connect-src 'self' wss:`) is for BitLogin's own
signer page, not for apps.

## BitLogin's own release, before any app is vendored

Each time `main` moves (added 2026-11-23, after BitPortal found the
`release/` folder still at 6bb9673 when main was at 1e1fd01):

1. Merge to `main` only on the owner's word, with the PR's head pinned.
2. In `~/Documents/GitHub/bitlogin-main` (a worktree on `main`):
   `git pull --ff-only`, then `npm run build:demo` **and**
   `npm run release:artifacts`.
3. Check `release/bitlogin-widget-v0.1.0/integrity.json` names the merge
   commit, `SHA256SUMS.txt` checks, and every file in it is byte-identical
   to `packages/demo/dist/vendor/bitlogin/`: the build compared with the
   live site.
4. Compare the demo's `dist` with bitlogin.network, file by file.

An app vendors exactly that `release/` folder: the bytes built and tested
here, not a build of the same source made elsewhere (a bundler names chunks
differently from one machine to another).

## The steps, for each app and each live branch

1. A clean worktree off `origin/<branch>`, so nobody's work in progress is
   touched.
2. The app's own vendor command, with the BitLogin checkout on `main` at
   `ab13cad`.
3. The app's own checks (tests, the integrity check).
4. Commit "Re-vendor BitLogin at ab13cad", push the branch.
5. Deploy the way that branch deploys, then check the live `bitlogin.js`
   hash against `f8056a43c9ac`. Nothing is recorded as deployed before that
   check.

## Where each app stands, and how it goes

| # | App | Repo | Live branches | Has now | Vendor | Deploy |
|---|---|---|---|---|---|---|
| 1 | COMBATRIG | `COMBATRIG` | `main` (+ worktrees) | `1a4aa0e` | its own script | **its AI Session Manager** |
| 2 | Satisfied | `satisfied` | `beta` → beta.imsatisfied.app; `master` → imsatisfied.app | `1a4aa0e` | `node scripts/vendor-bitlogin.mjs --update` | beta: push; production: merge to `master`, `npx vercel --prod` |
| 3 | BitPortal | `bitportal` | `main` → portal.bitblocks.network | `1a4aa0e` | `scripts/vendor.mjs` | `npm run deploy` |
| 4 | Tessera | `tessera` | `main` → tessera.bitblocks.network | `1a4aa0e` | `scripts/sync-vendor.js` | Vercel, on push to `main` |
| 5 | Bitvid | `bitvid` | `main`, `beta`, `unstable` | `1a4aa0e` in git; main and beta **live** still on `249cc9e` | `node scripts/build-bitlogin-widget.mjs` | Vercel, per branch |
| 6 | BitUnlock | `bitunlock` | `main` (Worker); `site/*` (Vercel site) | `1a4aa0e` in git | `node scripts/build-bitlogin-widget.mjs` | site: Vercel CLI from a `site/bitlogin-<commit>` branch; log in `docs/OPERATIONS.md` |
| 7 | BitRoad | `bitroad` | `main` | `1a4aa0e` | `node scripts/build-bitlogin-widget.mjs` | per its docs |
| 8 | AdZap | `AdZap` | `main` | `1a4aa0e` | into `worker/public/vendor` | `npm run deploy` in `worker/` (Wrangler) |

Not included: **BitFeed** (`packages/bitlogin` is an adapter with no
vendored widget), **NSWP**, **bitblocks**, **bitdrive** (no BitLogin).

Tessera's `bitlogin-window` branch vendors the sign-in-window client and
points at `bitlogin-beta.vercel.app`. It stays as it is until moving Tessera
to the window is taken up again.

Feature worktrees (COMBATRIG's, Bitvid's `area/*`, BitUnlock's) are not
re-vendored one by one. They take the new build when they merge their
branch's base.

## COMBATRIG

Handed to its AI Session Manager, which updates `main` and its worktrees
itself. What it needs:

> BitLogin has a new release: `main` at `ab13cad` (PR #36), live on
> bitlogin.network. Please re-vendor it into COMBATRIG `main` and every
> worktree, and deploy. Build from a BitLogin checkout on `main` at
> `ab13cad`; `bitlogin.js` sha256 should begin `f8056a43c9ac`. Nothing in
> COMBATRIG's own code needs to change. New in the widget: browser
> password-manager forms, an optional lock, and remembered sign-ins that end
> when the user takes a site back. What changed: BitLogin `CHANGELOG.md`,
> 2026-11-19.

## Record

Every live site below was checked after deploying: its `bitlogin.js`
sha256 begins `f8056a43c9ac`.

| App | Branch | Commit | Deployed by | Live |
|---|---|---|---|---|
| COMBATRIG | `main` | — | its AI Session Manager | **not done** (2026-11-19: the session could not be reached from here) |
| Satisfied | `beta` | `ff792e2` | push | beta.imsatisfied.app ✓ |
| Satisfied | `master` | `688826a` (promotion merge) | `npx vercel --prod` | imsatisfied.app ✓ |
| BitPortal | `main` | `cc4230e` (PR #87) | `npm run deploy` | portal.bitblocks.network ✓ |
| Tessera | `main` | `0ad732b` | push | tessera.bitblocks.network ✓ |
| Bitvid | `unstable` | `72d6a80b` | push | unstable.bitvid.network ✓ |
| Bitvid | `beta` | promotion merge, tree equal to `unstable` | `vercel deploy --prod` (bitvid-beta) | beta.bitvid.network ✓ |
| Bitvid | `main` | `4e3513a3`, tree equal to `unstable` | `vercel deploy --prod` (bitvid) | bitvid.network ✓ |
| AdZap | `main` | `5816dfc`, reproduced byte for byte | `npm run deploy` (Wrangler) | adzaps.net ✓ |
| BitRoad | `main` | `3de38e7` | push | bitroad.network ✓ |
| BitUnlock | `main` | `86d907c` | — (Worker unchanged) | — |
| BitUnlock | `site/bitlogin-ab13cad` | `71f7d27` = live site + the re-vendor | `vercel deploy --prod` | bitunlock.network ✓, logged in `docs/OPERATIONS.md` |

Notes from the run:

- Bitvid main and beta had still been serving BitLogin `249cc9e`: the
  `1a4aa0e` deploy of 2026-11-18 hit Vercel's daily limit. BitUnlock's
  site likewise; `site/bitlogin-1a4aa0e` was never deployed.
- BitUnlock's `main` failed `format:check` on its own operations log (an
  entry written on 2026-11-18). Reformatted.
- Satisfied's vendor script refuses a BitLogin checkout with uncommitted
  changes. Vendor from a clean checkout on `main`.
- BitPortal's vendor script takes BitLogin's `release/` folder, so run
  `npm run release:artifacts` in BitLogin first.
- Not done: an interactive sign-in on any app. Feature worktrees keep the
  old build until they merge their base.

---

# Vendoring BitLogin `03af915` into every app (2026-11-20)

**Source:** BitLogin `main` at `c89cf7f` (PR #44), live on bitlogin.network;
`03af915` on `beta` is the same tree and is the commit each record names.
`bitlogin.js` sha256 begins `768bb898acdc`. Asked for by the owner: "work in
each of our projects one at a time to revendor them with the latest and
greatest bitlogin". Each app was done from a clean worktree off its live
branch, so nobody's work in progress was touched.

| App | Branch | Commit | Deployed by | Live |
|---|---|---|---|---|
| COMBATRIG | `chore/bitlogin-revendor-1120b` → `main` | `69d6b250e9`, landed on `main` as `ffb5577993` (full battery green) | its AI Session Manager | not yet: combatrig.net still serves `adf754e312` (BitLogin `4eb99aa`); goes live with its next deploy |
| BitPortal | `main` | `efb0ac3` | its own session | vendored; deploy is the owner's, with that session |
| Satisfied | `beta` | `3f99d5e` | push | beta.imsatisfied.app ✓ |
| Satisfied | `master` | `f921853` (promotion merge, tree = beta) | `npx vercel --prod` | imsatisfied.app ✓ |
| Tessera | `main` | `f87ce7d` | push | tessera.bitblocks.network ✓ |
| Bitvid | `unstable` | `8d21b195` | push | unstable.bitvid.network ✓ |
| Bitvid | `beta` | `b0cbcd85` (promotion, tree = unstable) | `vercel deploy --prod` (bitvid-beta) | beta.bitvid.network ✓ |
| Bitvid | `main` | `12e10dd9` (promotion, tree = unstable) | `vercel deploy --prod` (bitvid) | bitvid.network ✓ |
| BitUnlock | `main` | `9b37952`, ops log `2a7758d` | — (Worker unchanged) | — |
| BitUnlock | `site/bitlogin-03af915` | `9d82741` = live site + the re-vendor | `vercel deploy --prod` | bitunlock.network ✓, all 45 files match the build |
| BitRoad | `main` | `72a3f48` | push | bitroad.network ✓ |
| AdZap | `main` | `18e1826`, reproduced byte for byte | `npm run deploy` (Wrangler) | adzaps.net ✓ |

Notes from the run:

- **BitUnlock's site must be built with its own locked dependencies.** A first
  build that borrowed `node_modules` from BitUnlock's main checkout put a
  newer `nostr-tools` into four of the site's own bundles. It was caught by
  comparing the build with the live site, and not deployed. `npm ci` in the
  worktree fixed it.
- **Tessera, for whoever merges `agent/harden-security-and-user-readiness`:**
  that branch adds `scripts/check-bitlogin-vendor.mjs` and a
  `PROVENANCE.json` recording the hash of every BitLogin file. Its record
  describes older files than `main` now carries, so the check will fail
  after the merge until the record is rebuilt (for example with BitLogin's
  `scripts/vendor.mjs --set widget`, adjusted to that file's name).
- **Satisfied's own checkout** has six files of someone's unfinished work on
  `beta`; it was left alone.
- **Found for BitLogin, and done:** the import warning was long on a phone
  before reaching "Create a fresh account instead" (now first); every app
  copied BitLogin its own way, and two by hand (now `scripts/vendor.mjs`).
- Not done: an interactive sign-in on any app.
