# Guest accounts in BitLogin

**Date:** 2026-11-25. **Status:** agreed by the owner ("Yes to both": a guest's bag with no press; a world may
refuse guests). Built on `release/guest-accounts`, part one: the guest made, kept and served, its bag, the pass,
the client's `guest`. Part two, still to build: the panel's guest line and "Secure this account" (G6, G8).

For NSWP `docs/backlog/guest-accounts.md` (the owner's decisions of 2026-11-23) and the owner's ask of
2026-11-25: "the bag is still locked behind a signing. It should be available with our starter items to any guest".

## G1. What a guest is

An account BitLogin made for a visitor who arrived signed out, not yet secured. It has a key and a recovery
phrase like any account, and nothing else: no login name, no password, no passkey, no capsules on relays.

## G2. How the key is made, and where it is kept

- **Made in BitLogin's worker**, inside BitLogin's embedded signer frame, never by a world or a client page, and
  never shown. It is made from a fresh recovery phrase, exactly as a new account's everyday key is (§11.6), so
  that securing it later gives an ordinary account whose phrase rebuilds it, not an "imported" one.
- **Kept where the family grant is kept**: the embedded signer's own storage at `bitlogin.network`, as a sealed
  record (AES-GCM under the non-extractable device key, as `signerGrant.ts` does), filed under the family
  (`https://*.bitblocks.network`) with a mark that it is a guest. The phrase is sealed beside it.
- **Which browser storage that is, said plainly.** A frame's storage is kept by the browser per top-level site.
  BitLogin's frames on any `*.bitblocks.network` page (the portal, a world framed in it, or a world opened by its
  own address) share one store. So:
  - one browser profile has one guest for all of BitPortal, wherever they enter it;
  - BitLogin opened by itself (`bitlogin.network` in its own tab) does not see that guest; nor does any other
    domain;
  - clearing this site's data (bitblocks.network, or all data) loses the guest for good: no copy exists
    anywhere else. A guest that was never secured can't be got back;
  - Brave by default keeps a framed site's storage only until the browser is closed: a new guest each time
    (until secured). Safari may clear it after some days without a visit. Chrome, Firefox and Edge keep it.
- **Only for a family BitLogin knows** (today `bitblocks.network`). Elsewhere a signed-out visitor stays as now.

## G3. Served with no press

- A client asks for it as it asks for its family: `createBitLoginClient({ family, guest: true })`, or a world's
  `{ t: "want", family, guest: true }`. Only for the asking site's own known family, as SF4a.
- **The embedded signer**, finding no grant for the site or its family, and asked for a guest, makes one (G2)
  and is unlocked as it at once. A second world of the family finds the same record (the family's) and is
  unlocked as the same guest. Nothing is pressed, nothing is shown.
- **The panel** (BitLogin's page framed by the portal) reads the same store, so it knows the visitor is a guest:
  it shows "You're a guest on this device" with one row: "Secure this account".
- Signing in to a real account here replaces the guest for this browser (the guest record is kept, sealed, so
  "Use the guest account again" can be offered until it is forgotten; see G6).

## G4. What a guest may do, and the bag

- **What every account gets in the family (SF5):** who they are, a room pass, a note and a reaction.
- **And the bag, for a guest only, without a press:** kind 37308 (the bag), with the bag's own `d`, signed for any
  site of the family, counted as notes are. This is the one place a guest is let act without being asked, at the
  owner's word: a guest has nothing of value to lose, and a press in BitLogin's window before a guest's first bag
  would be the sign-in the owner wants gone. Paying, messages, reading anything private, and every other kind
  are still asked at first use; a guest has no wallet at all (G5).
- **The starter items.** BitPortal writes the guest's first bag with the curator's starter set it already
  bundles: a plain `sign` of kind 37308 through the signer, allowed by the rule above, the moment the guest is
  made. BitLogin does not know or choose items.
- **Once secured**, the guest rule ends: the bag is asked at first use, as for every account.

## G5. Nothing of value while a guest

- No ecash wallet, no Files, no purchases, no lists a keeper keeps: these say "Secure this account first". The
  screen says plainly: "This account lives in this browser only. Clearing this site's data loses it."

## G6. Securing it

- In the panel, "Secure this account": a login name and a generated password (or a passkey where the frame may
  make one), then the recovery phrase shown to be written down, as signing up is today. `registerAccount`
  wraps the guest's key, with its phrase (a small change in core: the phrase a guest was made from may be
  passed in, so the capsules record a derived key, not an imported one).
- The same key: every world keeps who they are, their bag, a keeper's lists. Nothing moves between sites.
- After it: an ordinary account and an ordinary family grant (30 days, a sign-out anywhere ends it). The guest
  record is deleted.
- A guest never secured is kept as long as the browser keeps it; nothing is published for it that BitLogin
  would have to forget.

## G7. What a world is told

- `state`: `{ unlocked: true, pubkey, guest: true }`.
- The room pass carries `["nswp:guest", "1"]` beside `nswp:session` and `nswp:origin`, so a world, a keeper or
  an item's maker can treat guests differently (a world may refuse them; `items-for-guests` reads it).
- After securing, neither says guest.
- No secret key ever reaches a world, and a world can't tell a guest's key from an account's except by the pass.

## G7a. Abuse, and the bounds

- **One guest per browser profile per family.** The signer makes a guest only where its store holds no guest
  and no grant for the family; while one exists it is used, never another made. A script on a page can't ask
  for a second: the want is `guest: true`, not "make one".
- **What a bot can do** is what clearing data does: a new store, a new guest. That costs it nothing, as a new key
  does anywhere. Each guest's bag note is held to a note's size and rate (counted as notes are, per family), so
  one guest can't flood relays.
- **What a world sees of a fresh guest:** only the pass's `nswp:guest` and a key with no history. A keeper's
  lists, a world's "no guests" and an item's "not for guests" act on that; a block holds until the guest's
  browser data is cleared.
- **An account wins.** Where this browser already holds a real account's grant for the site or its family, the
  signer is that account and never makes a guest. A guest is made only where nobody is signed in here.

## G8. Said to visitors

- The panel's guest line and the You tab: "You're a guest. Every world in BitPortal knows it's the same guest.
  This account lives in this browser only."
- Signing in or securing says the same of accounts: every world you reach through BitPortal knows it is you.
- **Brave**, the owner's everyday browser: its default shields keep a framed site's storage only until the
  browser closes. A page can tell it is Brave (`navigator.brave`), not whether shields are up for this site. So
  in Brave the panel always says to a guest: "This browser forgets guests when it closes. Secure this account to
  keep it." (In other browsers: "This account lives in this browser only. Clearing this site's data loses it.")

## G9. What changes where

- BitLogin: the guest record and its rule (worker, `signerGrant.ts`), the signer's `guest` want, the pass tag,
  the panel's guest line and "Secure this account", core's `registerAccount` taking a phrase. Tests failing
  first, in Chromium, with routed `bitblocks.network` pages.
- Kit: reads `guest` from state and the pass; the Bag for guests; a world's "guests may use items".
- BitPortal: asks with `guest: true` and its family; writes the starter bag once a guest is made.

## Decided by the owner, 2026-11-25

1. A guest's bag changes with no press at all (starter items in, things taken and put back): yes.
2. A world may choose to refuse guests: yes (by the pass's `nswp:guest`; the kit's half).
