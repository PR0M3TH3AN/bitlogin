# An Ecash Wallet Kept With the Account (NIP-60)

**Date:** 2026-11-21
**Status:** Built on `beta`. Not on `main`. Tried against a mock mint, and
against a public test mint that issues pretend sats. **Not tried with real
money.** Treat it as experimental and keep small amounts in it.

Asked for by the owner on 2026-11-21: support NIP-60 ecash, with BitLogin
holding the wallet and paying a world one payment at a time, on the
person's press, so that no world ever reads a token. Later the same day:
keep a copy in the browser in case relays are down; a list of the mints
people recommend; and a wallet that is pleasant to use.

**Flagged experimental in the interface** (owner, 2026-11-21): the way in
and the screen itself carry an "Experimental" mark and a line saying what
that means for the person.

## EC1. What it is

- **Ecash** is bitcoin held as tokens a **mint** signed (Cashu). Whoever
  holds a token can spend it. The mint holds the bitcoin behind it: a mint
  that disappears takes the sats kept at it. The wallet says so where a
  mint is chosen.
- **The wallet is the account's**, kept as NIP-60 says: a wallet record
  (kind 17375) naming its mints, token records (7375) holding the proofs,
  and a line of history (7376) when the balance changes. Every record is
  sealed to the account's own key (NIP-44) before it leaves the worker. A
  relay holds nothing it can read. Another NIP-60 wallet, signed in as the
  same account, sees the same sats.
- **Sats only.** A token in another unit is left where it is, unread.
- **It lives on BitLogin's own sign-in page and panel**, and nowhere else:
  under "Account and more", and when a site asks to be paid. No
  application's vendored copy carries it.

## EC2. Where it is kept: this browser first, then relays

`worker/ecashStore.ts`. The rule that keeps money safe:

- **The browser's copy is written first.** New proofs are in the browser's
  storage, sealed the same way, before anything is sent to a relay.
- **A record no relay takes stays in the browser,** marked unsaved, and is
  sent again the next time the wallet is opened.
- **With no relay answering, the wallet opens from the browser's copy,**
  and says so. It is never shown as empty because relays were silent.
- **An old record is deleted only once what replaces it is on a relay.**
  The new record names the ones it replaced (`del`), so a relay that never
  honours a deletion can't bring spent ecash back, and no proof is counted
  twice.
- **Their own write relays (NIP-65) and BitLogin's list,** the same place a
  take-back is kept. The list is read again at every opening (2026-11-24),
  so a list changed in another app is used at the next one, with no
  sign-out. Where the session already has a list, that read is waited for
  for 1.5 s at most, and otherwise finishes behind, for the next opening.
- **What waits in this browser is sent again in one go** (2026-11-24): by
  mint, in as few records as hold it, all at once. It used to go one
  record at a time, each waited for. Ten changes that relays never
  confirmed then took the opening past the panel's minute, and the wallet
  said it couldn't be opened. The owner's own wallet showed that screen.
- **A saved record the answering relays didn't return is kept**
  (2026-11-24), unless they deleted or replaced it. The relays holding it
  may only have been slow, or gone, and the browser's copy used to forget
  it. Only a mint saying its sats are spent drops it, through the check
  that follows every opening.
- **Sats no relay has confirmed are counted and said plainly**
  (2026-11-24): "N sats are kept only in this browser so far…", with
  "don't clear this site's data in this browser" until relays have them.
- **Where opening fails, the screen says why and offers "Try again".** The
  reasons it can name: relays took too long; BitLogin is locked or signed
  out on that page; part of the page couldn't be loaded; the browser
  wouldn't let the wallet's copy be read or kept; or the error's own
  words. The whole reason goes to the console. A balance already on
  screen from this browser's copy stays there, marked, with nothing that
  spends offered until the wallet opens.

## EC3. Dealing with a mint

`ecash/wallet.ts`, on the Cashu protocol as `@cashu/cashu-ts` implements
it (pinned to an exact version; loaded only when a wallet is opened).

- **Add sats:** the mint gives a Lightning invoice; paid from any wallet,
  the sats arrive as ecash.
- **Receive a token:** a pasted Cashu token is exchanged at its mint for
  proofs only this wallet knows, so its sender can't take it back. Only
  from a mint already in the wallet: a token from an unknown mint is a
  promise from a stranger.
- **Pay an invoice:** the mint says what it costs and the most it may keep
  for routing; nothing is spent until the press. What routing doesn't use
  comes back as change.
- **Every step that makes new proofs is followed at once by a save.**
- **When a mint takes the ecash and its answer never comes,** nothing is
  thrown away on a guess: the mint is asked which proofs are spent, then
  and each time the wallet is opened, and only those are dropped. That
  also puts right ecash spent from another device.

## EC4. Paying a world

A site the user allowed sends its signer `{ t: "pay", id, invoice }` (a
bolt11 invoice). It is one of the things put to the person
(`sign-in-window.md` §SW20): answered `asking` at once; the site has
BitLogin's panel or window shown; the page says which site asks, how many
sats, the most routing may cost, from which mint and what is held there;
and on **Pay** the mint pays the invoice. The site then hears
`{ t: "paid", id, preimage? }`, or `refused`.

- **The site learns that it was paid, and nothing of the wallet:** not
  what it holds, not which mint, never a token.
- **Each payment is a press.** No allowance, no limit a site spends under:
  not built, and not to be built without the owner's word.
- **A press too soon is ignored,** as Allow is. Two questions a minute and
  ten an hour.
- **The amount is the mint's reading of the invoice,** and the Cashu
  library checks the invoice's own amount against it.
- With no wallet yet, the panel offers to start one, and to add sats, and
  then returns to the question.

## EC5. Choosing a mint

The wallet lists **mints people recommend** (NIP-87, kind 38000 notes for
kind 38172), read from relays by the worker. One voice per account;
people the user follows first; one stranger's word alone is not shown;
known test mints are left out. It is a count, not a guarantee, and the
screen says so: anyone can publish a recommendation. A mint is added only
once it has answered as one. Any other https address can be entered.

## EC6. What changed in the deployment

- `/connect/` and `/connect/panel/` may reach **any https address**
  (`connect-src 'self' wss: https:`): a mint is an https address the
  person chooses. This is a real loosening of those two pages, which hold
  a signed-in session: a script that got onto them could now send what it
  read anywhere. Every other page, the embedded signer and every worker
  keep `connect-src 'self' wss:`. The mint traffic is therefore made by
  the page, and the keys stay in the worker.
- A new dependency, `@cashu/cashu-ts` 4.13.1, with its own copies of the
  noble libraries.

## EC7. Known limits

- **A crash at the wrong instant can lose a little.** If the page dies
  between a mint issuing proofs and the save that follows (milliseconds),
  those proofs are gone: this wallet does not yet derive its secrets from
  a seed, which is what would let them be recovered. The change from one
  payment is the usual amount at risk.
- **Not built:** sending a token to someone; nutzaps (NIP-61), though the
  wallet record carries the key they need; more than one unit; a spending
  allowance for a site; a wallet page outside the panel and window.
- **Not tried:** real sats; Brave and Safari; a mint that is slow to pay
  (the wallet reports "not paid yet" and reconciles later).
