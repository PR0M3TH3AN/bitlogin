# The First Real Tip, and the First Real Purchase: What to Watch

**Date:** 2026-11-21
**For:** the owner, before sending real sats through BitLogin for the
first time. Everything below has only ever run with pretend sats, a mock
mint, or a throwaway account. It works in tests. None of it has met real
money.

Keep the first try small: a 21-sat tip, from a wallet holding a few
hundred sats.

## Before you start

- **Use a mint you would trust with the amount.** The wallet has only been
  tried against a mock mint and a public test mint that issues pretend
  sats. A real mint's fees, limits and errors are untested.
- **Fund the wallet with a small Lightning payment first** ("Add sats").
  Watch that the balance appears after the invoice is paid. If it doesn't
  within a minute, don't pay again: reopen the wallet, which checks again.

## A tip: what should happen

1. In a world, press the tip button on someone's card. BitLogin's panel
   opens.
2. The panel says **"Send this tip?"**, the person's name, and their
   **lightning address beside it**. Check the address is theirs.
3. It shows the amount, a routing fee "at most", and **"No receipt:
   nothing will be recorded as yours."**
4. If their address takes a note, it shows the note that will go with it,
   and a tick, "Say it is from me".
5. Press Send. It says how much was paid and what is left.

**Watch for:**

- **A long wait before the screen appears.** A fix for this shipped today
  and was measured only against a stand-in relay. Tell me how many seconds
  it takes on real relays.
- **"That lightning address didn't answer"** or **"answered with an
  invoice for a different amount"**. No real lightning address has been
  asked yet. Some providers round amounts or refuse small ones.
- **The note.** Which providers show it to the person tipped is unknown.
  Ask them whether they saw it, and what it said.
- **The fee.** The mint holds back a reserve and returns what it doesn't
  use. Check the balance afterwards went down by the tip plus a sat or
  two, not by the whole reserve.
- **A tip over 1,000 sats** should be refused with a message naming your
  limit. The limit is changed in the wallet, under "Payments that leave no
  receipt".

## If something goes wrong mid-payment

- **The screen says it failed but the balance went down:** reopen the
  wallet. It asks the mint which tokens were really spent and corrects
  itself. This recovery has only been tried against a mock mint.
- **The world says the tip "didn't go" but BitLogin said "Paid":** believe
  BitLogin's balance, and tell me. That would be the answer not reaching
  the world, not money lost.
- **Don't press Send twice** for the same tip while one is in flight.

## A purchase: not yet possible on bitlogin.network

Buying is switched off there. When it is opened, the same cautions apply,
plus these, none of which has run with real money:

- **Two payments, one press.** The service's fee is paid first and the
  seller last. If it stops between them, the page says how much went and
  the purchase appears under Purchases as "Not finished", with a Finish
  button. Use that; never start again from the world.
- **"Paid in full … hasn't given your receipt yet"** means nothing more is
  owed. Finish it later from Purchases.
- **A refund is the seller's to give.** BitLogin can't take a payment
  back.

## Also never tried for real

- A passkey or a password manager used inside the panel by a real person.
- Brave and Safari.
- The file browser against a real Blossom server, and paying a server
  that charges.
- Two devices signed in to the same account with one wallet: the second
  device should see the same balance, and spending on one should show on
  the other after it is reopened.
