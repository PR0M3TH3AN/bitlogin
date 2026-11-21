# Paying for Things: Tips, Purchases and Receipts

**Date:** 2026-11-21
**Status:** Built on `beta`. Not on `main`, not deployed. Tried against a
pretend selling service with real signatures, and a mock mint. **Not tried
against BitUnlock itself, and not with real money.** Experimental, and
marked so in the interface.

Asked for by the owner on 2026-11-21: BitLogin's part of the plan that
joins BitPortal, BitLogin and BitUnlock for paid things
(`Nostr-Spatial-Web-Protocol--NSWP-/docs/plans/paying-for-things.md`,
section 11.3). That plan says why. This says what BitLogin does, and the
exact words a site and the signer exchange.

## PY1. The rule everything follows from

A site names **what it wants** and never **where the money goes** or **who
is buying**:

- For a tip it names a person (or itself) and an amount. BitLogin finds the
  lightning address.
- For a purchase it names a listing. BitLogin fetches the listing, signs as
  the buyer, pays, and keeps the receipt.

So a site can't call a payment to itself a tip to somebody else, can't sign
as the buyer, and never sees the wallet. Everything is shown and pressed on
BitLogin's own page: the sign-in window, or the panel.

## PY2. What a site and the signer say

These join the "asking" family of `sign-in-window.md` §SW20: answered
`asking` at once, and later under the same `id`. One question waits at a
time, for five minutes. Each kind of question is counted apart: two a
minute, ten an hour. An application the person approved may ask them too.

| The site sends its signer | Answered at once | And later, under the same id |
|---|---|---|
| `{ t: "tip", id, to: "<64-hex pubkey>", sats }` | `asking` | `{ t: "paid", id, preimage? }` or `refused` |
| `{ t: "tip", id, sats }` (to the site itself) | `asking` | the same |
| `{ t: "buy", id, listing: "30078:<seller>:<d>" }` | `asking` | `{ t: "bought", id, receipt, delivery? }` or `refused` |
| `{ t: "have", id, listing }` | `{ t: "receipt", id, receipt }` or `{ t: "none", id }` | nothing: no question is put |

- `sats` is a whole number from 1 to 1,000,000. Anything else is not a
  request, and gets no answer.
- `receipt` is the selling service's signed note, whole and unchanged.
- `delivery` is what the purchase released, as text of at most 20,000
  characters, where the listing delivers something (a key for a sealed
  world). Left out otherwise.
- `refused` never says why: over the limit, said no, no lightning address,
  a listing that couldn't be checked, and a timeout all look the same.
- `pay` (an invoice the site made) is unchanged in the messages. Its page
  now says "A payment to this site" and "No receipt: nothing will be
  recorded as yours", and it is held to the limit below.

The application client has the same three: `client.tip({ to?, sats },
{ show })`, `client.buy(listing, { show })` and `client.have(listing)`.
`buy` and `have` check the receipt before they return it.

## PY3. A tip

1. The amount is held against the person's limit (PY5) before anything is
   looked up.
2. **To a person:** BitLogin's worker reads that key's newest signed
   profile (kind 0) and takes `lud16`. **To the site:** the page fetches
   `https://<the asking origin>/.well-known/nswp.json` and takes `tip`.
   The file must allow cross-origin reads, as it already does.
3. The page asks the address for an invoice (LUD-06, LUD-16) for exactly
   that amount. The invoice's amount is read from the invoice itself, and
   again by the mint: both must equal `sats`, or nothing is shown.
4. It shows whom the tip is for, by the name in their profile, **and the
   lightning address beside it**, since a name is anyone's to claim. Then
   the amount, the routing fee at most, and "No receipt".
5. On a press, the ecash wallet pays. The site hears `paid`, and nothing
   of where it went.

No note is sent with the payment yet. How the person tipped is told is
still open in the plan.

## PY4. A purchase

All of it runs on BitLogin's page, as the buyer:

1. **Already held?** The account's receipts are read first. A good receipt
   for this listing is handed back and nothing is charged. If the listing
   is the site's own (PY6) that needs no press; otherwise the person is
   asked "Show this site your receipt for it?".
2. **The service's policy** is fetched from each service BitLogin knows
   and checked to be that service's own signed word. It names the relays
   listings are on.
3. **The listing** is fetched by the worker and checked: signed by the
   seller its coordinate names, `status` `active`, and naming a service on
   BitLogin's list by address and key. Its title is shown as text.
4. **The service's own record** of this account's receipts is asked, so
   something bought on another device is found, kept, and not sold twice.
5. **An unfinished order** for this listing, paid in part or whole, is
   taken up again. Otherwise a quote is asked for.
6. **The plan is believed only as far as it matches:** this listing, this
   buyer, parts that add up, a total no more than the listed price, and
   for each part a Lightning invoice for exactly that part. Then the mint
   quotes each part.
7. **The page shows:** what it is, the seller's name and whole key, the
   price, each part and who it goes to, the routing fees at most, which
   mint pays, and what the person holds.
8. **On a press** each unpaid part is paid once, the service is asked
   after each payment before the next, and the order is unlocked. What it
   delivers is opened with the buyer's key and checked to be this order's.
9. **The receipt** is checked (PY6), kept with the account, and handed to
   the site.

A purchase has no limit of its own. The price is shown before the press,
and it leaves a receipt.

Not shown before paying: how long it lasts, unless the listing says so in
a `nswp:term` tag (seconds). BitUnlock's listings don't carry the term
publicly yet. The receipt says, and the page reads it out afterwards.

## PY5. The limit on a payment with no receipt

- One limit for `pay` and `tip` together: **1,000 sats** in one payment,
  unless the person changes it.
- Changed in the wallet, under "Payments that leave no receipt". Not on
  the screen where a site is asking: a site can't walk someone through
  raising it.
- Kept in the browser, for each account. Another browser starts at 1,000.
- Over it, nothing is looked up or spent, the page says what the limit is,
  and the site hears `refused`.

## PY6. Receipts

**What one is.** BitUnlock's entitlement note: kind 30078, signed by the
service, `d` = `bitunlock:entitlement:v1:<fulfillment>`, its words naming
the listing, the buyer, the seller, the order and how long it lasts.

**The services BitLogin knows** are pinned by key in
`packages/widget/src/pay/listing.ts`: `https://api.bitunlock.network`,
`66be61cf…787d` (checked against its live `/.well-known/bitunlock.json` on
2026-11-21). A listing naming any other service is not bought. A receipt
any other key signed is not one. A visitor's own list of issuers is later.

**Where they are kept.** In the browser first, then on the account's
relays: one record per receipt (kind 30078, `d` =
`bitlogin-receipt:<receipt id>`), sealed to the account's own key. Beside
the receipt: what the listing was called, and which site it was bought
through. A record no relay took is sent again when the list is next
opened. This is the first, small part of `portable-entitlements.md`.

**What a site's signer holds, and `have`.** The signer inside a site can
reach no selling service and never signs a buyer's note. So BitLogin's
page hands it receipts, by message, the way it hands over the session:

- at sign-in, once the person presses Allow, and after each purchase;
- only receipts for **that site's own listings**: sold by a key in the
  site's own `/.well-known/nswp.json` `publishers`, or bought through that
  site. A site is never told what was bought elsewhere;
- each is checked by the signer again: a known service's signature, and
  this account as the buyer;
- kept by the worker beside the site's grant, where the site is
  remembered, so a page loaded again still knows what its visitor holds.
  Dropped when the site is signed out of, and written over when another
  account signs in. A site allowed for one visit holds them in memory
  only. This is two more things a handed-over session may ask of the
  worker (`signerHold`, `signerHeld`), each only for the site its
  hand-off was sealed for. Added with the owner's say on 2026-11-21.

`have` is answered from those, with no question and no network. One that
has run out is not one. **Whether a receipt was taken back is the selling
service's to say**: a site that cares asks it (the plan has the kit do
this, and remember the answer for a day).

A person can turn the hand-over off, under Purchases: "Tell a world what I
bought from it, without asking me each time". Then `have` says `none`, and
`buy` asks before it shows a receipt.

An account that has never bought anything in this browser has nothing
looked up at sign-in, so sign-in is no slower for it. The cost: a receipt
bought on another device is not handed over until this browser has seen
it, which a `buy` or opening Purchases does.

## PY7. What signs, and where

- **Kind 27235** (the buyer's permission note, NIP-98) stays on the never
  list for every site and application. One worker action signs it:
  `unlockAuth`, for one address, method and body, with a fresh nonce, and
  only for a service on BitLogin's list.
- `unlockAuth`, the receipts, a listing lookup and a tip's profile lookup
  are refused unless the page is at one of BitLogin's own sign-in
  addresses. A copy of the widget hosted by an application can't use them.
- None is on the list a handed-over session may ask, so no embedded
  signer can.
- The worker reaches only relays. The page makes every call to the selling
  service and to a lightning address. Only `/connect/` and
  `/connect/panel/` may reach an `https:` address.

## PY8. In the panel

- `mode: "library"` opens Purchases: what was bought, where, until when,
  and whether the service says it was taken back.
- The account page has a "Purchases" door beside Files and the wallet.
- The wallet has the limit.

## PY9. Not built, and not tried

- **Not tried against BitUnlock.** Its sandbox pays with a control call
  and not with Lightning, so a wallet can't pay it. See PY10.
- **No real money**, and no real lightning address.
- **Shares** between several parties, and the client's share: they wait on
  the owner's lawyer. A plan part that is neither the seller's nor the
  service's is shown as "To another party".
- **A token locked to a recipient's key**, paying from a wallet
  connection, a visitor's own issuers, refunds in the interface, a note to
  the person tipped.
- **Buying with no ecash wallet** stops with "Open my wallet". The
  purchase is asked for again from the site afterwards.
- **LUD-06's check of the invoice's description** against the address's
  metadata is not made. The amount is checked, which is what stops an
  overcharge.

## PY10. Trying it

- `packages/widget/src/pay/mockUnlock.ts` is a selling service for tests:
  BitUnlock's buyer-side API with real signatures, its permission notes
  checked as the real service checks them, and a lightning address. Tests
  only.
- A local copy of BitLogin is told of a local service on its own pages:
  `<html data-unlock-service="http://127.0.0.1:<port>|<its key>">` on
  `/connect/`, `/connect/panel/` and `/signer/`. The real address ignores
  it. The application client takes the same as `localUnlockService`.
