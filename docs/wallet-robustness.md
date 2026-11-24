# What "Robust" Has to Mean for the Wallet

**Date:** 2026-11-24
**Asked by the owner,** with 20 sats in his wallet and the screen saying it
couldn't be opened: "We gotta make sure the wallets are robust." This says
what that has to mean, how much of it holds today, and what is missing.
What gets built is his to order.

## What robust has to mean

1. **Sats are never lost to a fault that isn't the mint's.** Not to a relay
   going down, a crash, a closed tab, a cleared browser or a new device.
2. **The wallet always opens** when anything holds it, and shows what it
   holds. When it can't open, it says why and offers to try again.
3. **What it holds can be got back from the key alone,** on any device.
4. **A mint that goes away costs only what was kept there,** and the person
   was told that risk before keeping sats there.

## How much holds today

| When | What happens today |
|---|---|
| A relay is gone | Each record is counted saved only once two relays have it; until then it is kept in this browser and sent again at every opening. Any one relay that still answers is enough to open the wallet. |
| Every relay is gone | The wallet opens from this browser's copy and says so. It can still be spent. |
| Relays read but don't confirm writes | Was the owner's fault (2026-11-24): every unsaved record was sent again one at a time, and the opening ran out of time. **Mended on beta:** one sending, all at once. |
| A mint is gone | The sats kept at that mint are gone with it. This is how ecash works. The wallet says so where a mint is chosen. |
| This browser's storage is cleared | Everything relays hold comes back at the next sign-in. **What was still unsaved on relays is lost.** The wallet now says how many sats are in that state. |
| A crash between the mint issuing sats and the save | Lost: a few milliseconds' window (`ecash.md` EC7). |
| Another device, or the key alone | The wallet record (its mints and its own key) and every saved record are sealed to the account's key on relays, so they come back. But only while relays keep them. |
| A payment whose answer never came | Nothing is dropped on a guess. The mint is asked which sats are spent, each time the wallet is opened. |

## What is missing

- **Sats that can be restored from the mint.** Cashu lets a wallet make its
  secrets from a seed (NUT-13), so a mint can hand back whatever it still
  owes, with no relay at all. Not built. Today the wallet comes back from
  relays only. This is the one gap that can lose sats to a relay fault.
- **A warning when records stay unsaved:** built on beta (2026-11-24). The
  wallet now says how many sats are kept only in this browser, and not to
  clear the site's data there until relays have them. A relay list changed
  in another app is used at the next opening. Still missing: a way to see
  which relays refuse wallet records, and to change the list in BitLogin.
- **The browser's copy forgot what relays didn't return.** Mended on beta
  (2026-11-24): a saved record the answering relays lacked, and didn't
  delete or replace, is kept until a mint says its sats are spent.
- **The wallet straight after the lock's PIN** used to say "Sign in first"
  (found 2026-11-24). Mended on beta: the panel asks for the PIN itself,
  then opens the wallet. The sats were never touched.
- **One relay that takes wallet records is counted as no relay.** Records
  then wait in this browser and are sent again each time, piling up copies
  on that one relay. Copies are harmless but wasteful.
- **No export or backup** of the wallet a person can keep apart from
  relays.
- **No restore check against other NIP-60 wallets.** Opening a wallet made
  by another app has not been tried. Nor has making sure BitLogin never
  replaces another app's wallet record.
- **Not tried with real sats, real relays or real mints,** beyond what
  people have used themselves.
