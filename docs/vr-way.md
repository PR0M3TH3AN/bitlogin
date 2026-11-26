# VR way: BitLogin inside VR

**Date:** 2026-11-25. **Status:** first part built, behind `VR_WAY`, which is off. Designed with the orchestrator, from
the owner's words: "the only thing that should force us out of VR is the initial phone pairing and the browsers
immersive VR site to site limitation". Names given by the orchestrator. NSWP `docs/backlog/everything-in-vr.md`.

## What the person chooses

At the pairing, which is the one moment they are out of VR anyway, the phone asks, for the world's family, with two
presses of equal weight and no default:

- **Use BitLogin inside VR.** Convenient. A world you're in could show you anything and act on your wallet and files,
  within your limits.
- **Step out to BitLogin each time.** Safer. Your wallet and files open on BitLogin's own page.

`/headset/` shows the same two lines while its code is up. The choice is sealed in the hand-off (`vr: true`) and kept
in the grant.

- **Inside VR means the account's own key in that world's signer frame**, as an Allow gives it. A device key (Way 2)
  can't open the wallet or the files, so the two never go together. "Step out" gets the device key, once
  `DEVICE_KEYS` is on.
- It is offered for a family, or a site BitLogin knows: one storage partition, one wallet copy, one seed lane.
- The first sign-in is always that pairing.

## What the frame answers, where it was chosen

The world's kit draws the screens to match BitLogin's flat ones, from these answers:

| Ask | Answer |
| --- | --- |
| `walletState` | `wallet-state` {balance, mints:[{mint, sats}]} |
| `walletReceive` {sats, mint?} | `invoice` {invoice, quote, sats}, for one of the person's own mints |
| `walletClaim` {quote} | `wallet-state`, with `claimed` |
| `walletSend` {invoice} | `confirm` {what:"pay", sats, fee} → `confirmed` → `paid` |
| `walletTake` {token} | `confirm` {what:"take", sats, mint}, for a mint already added → `confirmed` → `wallet-state` |
| `filesList` | `files` [{id, name, size, type, private, folder}] |
| `fileOpen` {file} | `file` {name, type, bytes} |
| `fileSave` {name, type, bytes, private} | `confirm` {what:"save"} → `confirmed` → `file-saved`, into the world's own folder |
| `vrOff` | `state`, without `vr` |

`state` says `vr: ["wallet", "files"]` where VR way is on.

**A `confirm`** carries an id the frame made, and amounts in BitLogin's own reading (the invoice, the token), never
the world's words. It is taken only once, after the 0.9 s press guard, and within a minute. Anything else is "Nothing
was done."

**Refused in words** ("Do this on BitLogin's own page."), or a specific line:

- adding a mint;
- a token from a mint not added;
- paying for storage;
- anything with VR way off, or for an application.

Never, VR way or not:

- the phrase, the password, the Vault's roots and NWC;
- key exports;
- account settings;
- the wallet's and files' own settings;
- sign-outs and take-backs;
- other sites.

The worker opens to the frame only `VR_ACTIONS`: the wallet's and files' own records, and the read of the pay limit.

## What the frame reaches

/signer/'s `connect-src` gains `https:`, on the owner's "Yes, allow it". The frame's `fetch` is wrapped as the signer
starts, VR way or not. It lets through only BitLogin's own address and, in a signed-in session with VR way on, the
person's own mints (from the wallet's record) and file servers (from their server list), by exact https origin.
Everything else is refused before it is asked.

`connect-src` covers more than `fetch` (the orchestrator's review of 63684d9). The frame's own code uses none of the
other ways, so each is refused outright as the signer starts: XMLHttpRequest, EventSource, WebSocket (relays are the
worker's), WebTransport, and `navigator.sendBeacon` (answers false). Each is made read-only, so it can't be set back.

The worker is served from `/vendor/` under the general rule (`connect-src 'self' wss:`), which a dedicated worker
takes from its own script's response, so the widening never reached it. Its own `fetch` is also guarded in its code:
BitLogin's own address, and over https nothing else. Its relays are WebSockets, as they were.

## Turning it off

- **In VR**, `vrOff`: at once, and kept. Off is the safe direction.
- **On "Sites you allowed"** (or from a notice's link), "Turn off BitLogin inside VR": a take-back with `vr: true` for the site or family. The
  headset's daily check drops VR way and stays signed in.
- **On again** only at a pairing. Never from a world.

## The notice on the phone, and "Payments made in VR"

The owner: "yes notification on phone is good". It is no limit and blocks nothing.

- **The notice.** For every payment made in VR, the world's frame has the account tell itself, as NIP-17: a kind 14
  rumor, sealed (13), wrapped (1059) by a key made for that wrap, sent to the person's own DM relays (their 10050).
  Any Nostr app on the phone that notifies for messages shows it. The words are "You paid {sats} sats in {site}." and
  then "To turn off BitLogin inside VR: https://bitlogin.network/sites/#vr-off". The amount is what left the wallet,
  fee and all; the site is the session's own. Nothing of the mint, the invoice or a token goes in it. With no DM
  relays named, nothing is sent. It is sent after the answer to the world.
- **The history's mark.** A payment's history line, NIP-60 kind 7376, encrypted to the account, carries
  `["nswp:vr", "<site>"]`. The worker writes it only in a session with VR way on, from the session's own site, never
  from what a page passed.
- **The list.** "Payments made in VR", on Sites you allowed, is read from that history (`vrPayments`), not from the
  notice.
- **The link.** /sites/#vr-off brings the page to its "Turn off BitLogin inside VR" presses and focuses one. It
  presses nothing.

## Not built yet

- Purchases (`buy`) and the careful asks drawn in VR.
- `walletToken`: this wallet has no "send as a token" yet, so it is refused.
- Securing a guest in VR, as "Create an account using Phone".
- The daily VR-way cap stays out until the owner says.

## Tests

Stand-in relays only:

- The switch, the words, and who it's offered for.
- The fetch guard: other hosts, look-alikes, ports, `vr` off, no session, its own address.
- The confirm gate: too soon, late, another id, once, and a no.
- The take-back's `vr` scope.
- The hand-off's `vr`: refused for an unknown site or a wrong value.
- `VR_ACTIONS`, the switch local-only, and no device key with VR way.
- The security header test, with the guard installed.
- In Chromium:
  - the phone's choice, with no default, then the family's grant;
  - `state.vr`;
  - `walletState`, `walletReceive` refused for no mint, `filesList`;
  - a confirm the frame never made, refused;
  - the frame's fetch to another https host refused;
  - "Turn off BitLogin inside VR" listed;
  - `vrOff`, then `walletState` refused, and still off after a reload.
