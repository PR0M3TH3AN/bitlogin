# Signing in a headset from your phone

**Date:** 2026-11-25. **Status:** built, released in feef753, then **paused** the same day (the owner's "Yes, pause
it now"). A world draws everything a headset shows, the code and the number too, so a hostile world could show the code
of a pairing started on its own headset, draw that headset's number as well, and be handed the key. The phone's
`/pair/` and the worker's `pairAnswer` refuse ("Signing in a headset from your phone is paused while we make it safe.
Sign in on the headset with the sign-in window instead."), and a headset's `pair` is answered `pairing-expired` with
`why: "paused"` at once. The code stays (`PAIRING_PAUSED` in `embedded/pair.ts`) until it is made safe.

**Way 1 (the owner's "Can we do Way 1 for now and explore Way 2 as a possibility?"):** the code, its QR and the number
are shown only on BitLogin's own top-level page, `/headset/`, in the headset's 2D browser, whose address bar a world
can't draw over. Its first line: "Check that the address bar says bitlogin.network." A world opens it from a press,
as a window with its link back (`window.open("<signIn>/headset/", "bitlogin-headset", "popup")`, or
`client.signInFromPhone()`); the page finds the world's signer through its opener, as the sign-in window does, so the
site is the browser's word and the phone seals the hand-off to that signer's one-time key (the offer's `to`). The page
passes it on sealed (`grant`), says "Signed in. Go back to the world." and closes; the world hears `state`. The phone
asks of every code, typed or scanned: "Is the code on a page whose address bar says bitlogin.network, on a headset
you are holding?", and answers only an offer that names `to`. In-world `pair` stays paused. A hostile world gets what
its own Allow would, for its own origin, in that browser; it can move the window it opened to a look-alike page,
which only the address bar shows, so the words say to check it.

Built Names given by the orchestrator (kind 27304, tag `nswp:pair`, messages
`pair`, `pairing`, `paired`, `pairCancel`, `pairing-expired`, the hand-off's `device`, take-back's `{ device, before }`,
page `/pair`), with number matching, the warning on a code from a link, and what a lost device needs (P4a, P4b, P5a).

For NSWP `docs/backlog/sign-in-inside-a-headset.md`, way 2 (the owner's "yeah lets build that").

Where it is: `embedded/pair.ts` (the code, the offer, the label, the numbers), `worker/pairing.ts` (both sides over
relays), the worker's `pairBegin`, `pairPoll`, `pairCancel` (a headset's signer) and `pairFind`, `pairFound`, `pairEnd`,
`pairAnswer` (BitLogin's own `/pair/`, never a signer), the signer page's `pair` and `pairCancel`, `client.pair()`, and
the phone's page, `/pair/`. Tests: `pair.test.ts`, `e2e/pairing.e2e.test.ts` (both sides over relays that keep no
ephemeral note, as real ones), and in Chromium, `e2e/passkey.e2e.test.ts` ("a headset is signed in from a phone").

## P1. What the phone sends: the same hand-off an Allow sends

- **Exactly what pressing Allow in BitLogin's window gives a site today**: a sealed hand-off (`sealHandoff`), carrying
  the everyday key, the site, and the family where one is chosen, sealed to the headset signer's one-time key. The
  headset's signer opens it, keeps it as any grant (sealed under its non-extractable device key, filed under the
  site or family), and drops the one-time key.
- **Why not something narrower:** BitLogin has no narrower key to give. Every site's signer already holds the
  everyday key, sealed in that site's own storage, and is held to a note, a reaction and a pass (or an application's
  approved set) by the signer page and again by the worker. A delegated or derived key would sign as someone else, and
  worlds would not know it was them. What keeps the headset narrow is the same as any site: the grant's rules, its
  expiry, and taking it back. Nothing here is wider than an Allow.
- **An application's set** is not given by pairing: a headset signs in as a world (or its family), and an
  application asks for its set in its own Allow later, on a screen. (Pairing has no screen on the headset to read a
  set on.)

## P2. The two notes, over relays

Both ephemeral (relays forward, don't keep): **kind 27304**, the next in NSWP's 273xx, beside the room
pass (27300). Sent to BitLogin's own vault relays (the built-in list both ends already use).

- **The offer**, published by the headset's signer, signed by its one-time key:
  - tags: `["nswp:pair", "<code hash>"]`, `["nswp:origin", "<site, as the browser gave it>"]`,
    `["expiration", "<now + 300>"]`;
  - content: `{ "device": "<a label from the browser, e.g. Meta Quest Browser>" }`.
  - The code hash is SHA-256 of the code: a relay sees no code, and the phone finds the offer by it. Nothing in the
    offer is secret, by design: a one-time public key, a site, a device label.
- **The answer**, published by the phone, signed by a throwaway key (so relays never link the person's key to the
  headset):
  - tags: `["p", "<the offer's one-time key>"]`, `["e", "<the offer's id>"]`, `["expiration", "<now + 120>"]`;
  - content: the sealed hand-off, openable only by the one-time key.

## P3. The code

- **8 characters**, Crockford base32 without I, L, O, U (no 0/O or 1/I confusions), shown as two groups of four:
  `K7QF-3MPX`. About 2^40: guessing one in five minutes is not a real attack, and it is only a pointer anyway.
- **Expires after 5 minutes**; the headset offers a new one after that.
- **Used once:** the headset takes the first answer that opens with its one-time key, then forgets the key, so a
  second answer opens nothing. The phone remembers offers it answered and won't answer one twice.
- **Shown on both screens**, with the site and the device, so a person sees they match before the yes.
- The QR code is `https://bitlogin.network/pair/#K7QF-3MPX`: the code in the fragment, so it reaches no server log.
  (`/pair/`, with the slash: the page is a folder's index, which every static host serves at that address.) The page
  takes the code out of its address at once, so it is not left in the history.

## P4. On the phone

- `bitlogin.network/pair` (first-party, where they are signed in): the code typed or arriving from the scan. It asks
  the relays for an offer with that code's hash, at most 5 minutes old, not expired.
- **"Sign in this headset?"**, then `<device>`, `at <site>`, `Code K7QF-3MPX`, and the presses:
  - for a site of a family BitLogin knows: **[ Stay signed in at every bitblocks.network site ]** **[ Just this site ]**
    (as SF4a), or for any other site: **[ Sign in ]**;
  - and **[ Not this one ]**.
- **Refused, said plainly:** no offer for that code ("No headset is showing that code. Check it, or ask for a new
  one."); more than one offer for the same code ("Two devices are showing that code. Start again on the headset.");
  an expired one.
- **With the lock on**, the headset is signed in for its visit only, as any site. In this first version the page does
  not unlock: where BitLogin is locked on the phone it says so, and asks to unlock it on the account page and come back.
- The press guard (0.9 s) as on Allow.

## P4a. Number matching (against the device-flow phish)

The threat P7's words alone don't stop: someone starts a pairing on their own headset, then sends the owner the link
`bitlogin.network/pair/#CODE` ("verify your account"). A yes would hand the everyday key to a device they control.

- Once the phone finds the offer, it sends the headset's one-time key a **`found`** note (27304), sealed (NIP-44)
  from the phone's throwaway key: a random number from 10 to 99.
- The headset shows **"Your phone asks: 47"** beside the code (the signer tells the kit in `pairing`, with `number`).
- The phone shows three numbers, the right one among them, and the person taps the one in front of them. Only then
  is "Sign in this headset?" shown. A wrong tap ends the pairing on both sides: the phone sends an **end** note, the
  headset drops its one-time key and says `pairing-expired` (`why: "refused"`), and nothing is signed in.
- The headset takes notes only from the throwaway key that sent `found` first.
- The phone's worker holds to it too: it sends one number to an offer, and seals the answer only when the page hands
  back that same number. Any other ends the pairing, as a wrong tap does.
- A link alone then gets nowhere: the attacker would have to relay the number from their headset to the owner, live.

## P4b. A code that came in a link

`/pair` opened with a code in its fragment (the QR's address, or a link someone sent) says first, before any search:
**"Did you just press Sign in on a headset you are holding?"** **[ Yes, I'm holding it ]** **[ No ]**. "No" ends it
with "Then don't sign it in. Someone may be trying to get into your account." A code typed in by hand asks nothing
more: typing it is the check.

## P5. How long, and signing it out

- **As any grant:** 30 days for a site or family BitLogin knows, 7 for others, one visit with the lock on.
- **Listed on the phone** in the sites list as that site (or family) with "a headset (Meta Quest Browser), signed in
  from this phone on 25 November".
- **Signed out from the phone:** today a take-back is per site (or family), for every device of it. Proposed: the
  hand-off carries a random **device id (`device`)**, kept in the headset's grant, and a take-back record
  may name one (`{ device, before }`), so "Sign out this headset" ends that headset alone. The headset's signer
  checks take-backs as signers do now (daily, and before answering when overdue): it ends within a day at most, at
  once on its next page load past a check. Signing out in the headset itself (the world's Sign out) works at once,
  as now.

## P5a. A paired device that is lost or stolen

- **Sign out this headset** (by `device`) ends its grant: its signer stops within a day at most, at once on its next
  load past a check, and in the world itself at once.
- **What that can't undo:** a headset's browser holds the everyday key, sealed in that site's storage, as any site's
  signer does. Someone who has the device and can read its browser's storage, or who paired a device they control,
  keeps the key whatever is signed out. That is so for every Allow today, not only for pairing.
- **What BitLogin offers then: not yet a new key.** It can't rotate an account's everyday key today
  (`docs/ecash-seed-counter.md` rule 7 says the same). The only full remedy is a new account. Said plainly on the
  phone's "Sign out this headset": "If you think someone has read this headset's storage, sign it out, then make a new
  account: BitLogin can't change an account's key yet."
- **With the lock on**, a pairing is for the visit only: nothing is kept on the headset at rest.

## P6. What the kit asks the headset's signer frame

- `{ t: "pair", id }` → `{ t: "pairing", id, code: "K7QF-3MPX", url: "https://bitlogin.network/pair/#K7QF-3MPX", expires }`,
  and again with `number` once the phone found it.
  The signer makes the one-time key, publishes the offer, and listens for the answer. The kit draws the code and a QR
  of `url`; it never sees a key.
- When the answer arrives and opens: the signer is unlocked and says `{ t: "state", unlocked: true, ... }` as after
  an Allow, plus `{ t: "paired", id }` so the kit can close its screen.
- `{ t: "pairCancel", id }`: the one-time key is dropped and the offer is let expire.
- On expiry: `{ t: "pairing-expired", id }`, and with `why: "refused"` where the phone said no; the kit offers "Show
  a new code".
- An application asks through the client: `client.pair(onCode)` gives `{ done, cancel }`; `onCode` is told the code,
  the address and, later, the number.
- Only where nobody is signed in on the headset, or it is a guest (an account then wins over the guest, as G7a).

## P7. Threats

- **Someone else's code:** an attacker shows the person a code of the attacker's headset ("enter this to get a
  prize"). The phone says which device and which site, from the offer; the person says yes only to a headset in
  front of them. That's the whole defence, as for TV sign-in: the words say it ("Only sign in a headset you are
  holding.").
- **A shoulder-surfed or photographed QR:** the attacker publishes a second offer with the same code. The phone sees
  two offers for one code and refuses both, said plainly. The headset publishes its offer before it shows the code,
  so the real offer always exists before anyone can copy the code; the phone also waits 2 seconds after the first
  find for any second before showing anything.
- **A relay replaying:** both notes are ephemeral and carry `expiration`; the phone ignores offers older than 5
  minutes; an answer opens only with its offer's one-time key, which the headset drops after the first, so a replay
  to the same headset opens nothing, and to any other headset can't open at all.
- **A relay or world reading:** the offer holds nothing secret; the answer is sealed to the one-time key; the world
  sees a code and a URL and never a key. Nothing is typed in the headset; no password or phrase passes through a
  world's page.
- **The headset's world itself** (a hostile world asking for a pairing): it gets what any site's Allow gives that
  site, for its own origin, which the phone names before the yes.

## P8. Tests

Stand-in relays only: the offer and answer through mock relays; one-time key dropped after one answer; a second
answer opens nothing; two offers with one code refused; an expired offer refused; the lock on makes it one visit;
a device take-back ends that headset alone; in Chromium, a routed world page as the "headset" and a second context as
the phone.
