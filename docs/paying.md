# Paying for Things: Tips, Purchases and Receipts

**Date:** 2026-11-21
**Status:** On `main` and bitlogin.network since 2026-11-21, with buying
closed there (PY11). Tried against a
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

**The person tipped is told, privately** (owner, 2026-11-21): a note goes
with the payment where their lightning address says it takes one (LUD-12,
`commentAllowed`), cut to the length it takes: "A tip from <name>, in
<the world's host>". The name is the one in the tipper's own public
profile, never the name they sign in by. The page shows the note before the
press, with a tick, "Say it is from me", that takes the name off. An
address that takes no note gets none, and the tip still goes. No Nostr
message is sent.

## PY4. A purchase

All of it runs on BitLogin's page, as the buyer:

1. **Already held?** The account's receipts are read first. A good receipt
   for this listing is handed back and nothing is charged. If the listing
   is the site's own (PY6) that needs no press: the page says "You already
   have this" for a moment. Otherwise the person is asked "Show this site
   your receipt for it?". Several receipts for one timed listing may be
   held, one for each purchase: any that has not run out will do.
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
   A listing for something in a world (one carrying a tag that begins
   `nswp:`) priced **under 500 sats is not shown for sale** (owner,
   2026-11-21). BitUnlock holds the same floor at registration.
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
- Changed in the wallet, under "Payments that leave no receipt", in steps
  and not to any number: 1,000, 10,000, 100,000, or no limit. Not on the
  screen where a site is asking: a site can't walk someone through raising
  it.
- **Kept with the account:** in the browser first, then one sealed record
  on its relays (kind 30078, `d` = `bitlogin-pay-settings`), so it follows
  them to another device. The newer wins. Where it can't be read, 1,000
  stands: never "no limit" by accident.
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

- at sign-in, once the person presses Allow; after each purchase; and
  whenever BitLogin's page is shown for a site that is signed in already
  (it put a question), so something bought on another device reaches it;
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
  connection, a visitor's own issuers, refunds in the interface.
- **The floor's screen** is not in a browser test: the rule is tested, the
  words that say it are not.
- **Buying with no ecash wallet** stops with "Open my wallet". The
  purchase is asked for again from the site afterwards.
- **LUD-06's check of the invoice's description** against the address's
  metadata is not made. The amount is checked, which is what stops an
  overcharge.

## PY10. Trying it

- `packages/widget/src/pay/vectors/` holds BitUnlock's published test
  vectors for a product listing and a receipt's words, fetched unchanged
  from `https://api.bitunlock.network/test-vectors/` on 2026-11-21, and
  `vectors.test.ts` reads both with the code that ships. Its payment-plan
  and delivery vectors were not served there that day, so they are not
  tested against.
- `packages/widget/src/pay/mockUnlock.ts` is a selling service for tests:
  BitUnlock's buyer-side API with real signatures, its permission notes
  checked as the real service checks them, and a lightning address. Tests
  only.
- A local copy of BitLogin is told of a local service on its own pages:
  `<html data-unlock-service="http://127.0.0.1:<port>|<its key>">` on
  `/connect/`, `/connect/panel/` and `/signer/`. The real address ignores
  it. The application client takes the same as `localUnlockService`.

## PY11. Where buying is open, and a purchase that stops half way

**`buy` is open at the test address and on a local copy only**
(`BUYING_OPEN_AT` in `embedded/permissions.ts`), by the coordinator's
answer for the owner on 2026-11-21. At `https://bitlogin.network` a site
that sends `buy` gets no answer, as for a request the signer doesn't know,
and `client.buy` returns null. Tips, the limit, `have` and Purchases are
not held back. It opens there when a purchase has been tried end to end
against BitUnlock's sandbox and the owner says so.

**Two invoices, and the second fails.** BitUnlock's fee comes out of the
price as a second invoice (490 and 10 at 500 sats). The person is shown
one total and presses once. The parts are paid one after the other, and
the service is asked after each before the next. If a part is paid and a
later one is not:

- the page says how much went, that the rest didn't, that there is no
  receipt yet, and that what was paid can't be taken back from here;
- the site hears `refused`;
- the order stays with BitUnlock as part paid. The next `buy` for the same
  listing takes that order up again, after asking the service to look
  again (a part whose invoice ran out unpaid is given a new one), and pays
  only what is left. Nothing is charged twice.

**Paid in full, and no receipt.** If every part is settled and the service
doesn't unlock (a 503, say), the page says it is paid, that nothing more
is owed, and to try again later. The order is kept and shown as not
finished. It is never forgotten, and never paid for again.

**Before `buy` opens at bitlogin.network** (the coordinator, 2026-11-21):
a purchase tried end to end on the buy screen against BitUnlock's sandbox;
BitUnlock's fix for listings with a space in their name deployed live
(until then such a listing can be paid for there and never unlocked); and
the owner's word.

What BitLogin can't do: get back what went to the seller if the purchase
is never finished. That is the seller's to refund, or BitUnlock's to
settle.

**Kept before paying, and paid in an order that strands the least** (the
coordinator's answer for the owner, 2026-11-21, from how BitUnlock treats
a half-paid order):

- The order's id and the key its quote was asked with are kept with the
  account before the first payment: in the browser first, then in the
  sealed settings record (PY5). If that can't be written, nothing is paid.
- The smallest part is paid first and the seller's last, so a payment
  that stops half way strands the fee and not the price.
- An order is found again by the id that was kept, in whatever state short
  of finished, and asked about again: what was paid is counted, and a part
  whose invoice ran out unpaid is given a new one. Never a second order
  for a listing that has one open.
- Purchases shows it under "Not finished", with one press to finish it.
  Nothing is shown as bought until every part is settled, the order is
  unlocked, and the receipt passes its check.
- If the seller withdrew the listing meanwhile, the page says it can't be
  finished and that what was paid went to the seller or the service.

## PY12. A test service with pretend sats

BitUnlock's sandbox signs real receipts over pretend money. It is tried
**only on a local copy of BitLogin** (owner's decision 30 allows beta too,
once the sandbox has an address; it is not built for beta yet):

- It is named on the local copy's own pages, as in PY10, and may be an
  `https:` address on this machine or a private network. Its key is
  believed there and nowhere else.
- Its signed policy says `paymentAdapters: ["mock"]`. Then the page opens
  a session of its own (`POST /sandbox/v1/sessions`), sends
  `X-BitUnlock-Sandbox-Session` with every buyer call, shows "pretend
  sats: a test service", and settles each part with
  `POST /sandbox/v1/payments/<hash>/settle` in place of a wallet.
- A local copy is one served from this machine or a private network
  address, over http or https. Its pages may also name a test relay where
  test listings are kept, `<html data-listing-relays="wss://…">` on
  `/connect/` and `/connect/panel/`, so that none is put on a public relay.
  The real address reads neither attribute.
- Anywhere a test service is not being tried, a `bitunlock-mock:` request
  fails the plan check and never reaches a wallet. A test service's plan
  with a Lightning part in it is refused too.
- **Tried against BitUnlock's own sandbox on 2026-11-21**, on the owner's
  machine, with the code that ships and a throwaway key: the signed
  policy, a listing with a space in its name read from a test relay, a
  quote, the same order for the same key, the fee part settled and the
  order taken up again by its id, the seller's part alone then paid, the
  unlock, a receipt that passes with the sandbox's key and is refused
  without it, a renewal that runs on, and the service's list of both
  receipts. All passed. **The buy screen was then tried against it too**, in a
  real browser, in BitLogin's own test with a throwaway passkey account
  and mock relays: a world asked `buy`, the panel showed 500 sats as 490
  to the seller and 10 to the service, "pretend sats: a test service", a
  press settled both, and the world was handed `bought` with the sandbox's
  receipt, then `have`. That run is opt-in (`BITLOGIN_SANDBOX`,
  `BITLOGIN_SANDBOX_RELAY`, `BITLOGIN_SANDBOX_LISTING` in the panel test),
  since it needs the sandbox running. Not tried: a world built on the
  NSWP kit doing the asking.
