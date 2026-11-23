# Why BitLogin's Panels Are Slow: Measured (2026-11-23)

Asked by the owner: "using anything in the bitlogin panels was really slow
… Loading in wallet and files etc. Can we speed that up somehow? It needs
to feel native." (NSWP `docs/backlog/bitlogin-panels-feel-native.md`.)

**Measured only. Nothing is changed by this.**

## How it was measured

- `packages/widget/src/e2e/speed.e2e.test.ts` (opt-in:
  `BITLOGIN_SPEED_OUT=<file> npx vitest run packages/widget/src/e2e/speed.e2e.test.ts`).
  BitLogin's built pages (beta), served the way bitlogin.network serves
  them: revalidated each time, with an ETag. A client page frames the panel
  at a real mouse press, as BitPortal's shell does. Chromium, on the owner's
  machine, while it was busy (load average about 24).
- **Relays slowed to the real ones.** I timed each built-in relay from this
  machine first: one read-only question, no event sent. The test's relays
  then answer the same way:
  - 11 connect in 0.37 to 1.2 s (real: 0.37 to 2.7 s) and answer about 0.1 s
    later;
  - 3 refuse at once (real: relay.damus.io and nostr-pub.wellorder.net
    answered 503, relay.mostr.pub 301);
  - **1 accepts the connection and never answers** (real:
    relay.nostr.band, 10 s with no handshake, on both tries).
- A pretend mint and a pretend file host, each 0.25 s slower than local.
- One throwaway password account, made on localhost. Pretend sats only.
- **Why not live:** I don't type credentials into bitlogin.network. The
  live measurement would need a signed-in account there, so it was made
  locally with the network slowed to match, as the brief allowed.
- **Not measured:** the `ask` mode and the window (only `account`,
  `wallet`, `files` and `library`, in the panel), and Brave or Safari.

## The numbers

Seconds from the press. "Ready" is when the panel says so. "Shown" is when
the panel's own screen for that mode appears ("Opening your wallet"),
not its content. "Usable" is when the content is there: the account, the
balance, the folder, the list.

| Panel | Opening | First paint | Ready | Shown | **Usable** | Files fetched (re-validated) | Relay questions |
|---|---|---|---|---|---|---|---|
| account | cold | 0.39 | 0.79 | 0.85 | **1.4** | 27 (0) | 0 |
| account | again | 0.23 | 0.42 | 0.48 | **0.85** | 27 (20) | 0 |
| wallet | cold | 0.25 | 0.56 | 1.33 | **13.6** | 30 (0) | 59 |
| wallet | again | 0.23 | 0.46 | 1.18 | **12.9** | 30 (23) | 59 |
| files | cold | 0.36 | 0.74 | 1.41 | **19.6** | 29 (0) | 60 |
| files | again | 0.14 | 0.31 | 0.61 | **18.9** | 29 (22) | 60 |
| library | cold | 0.35 | 0.54 | 1.24 | **6.3** | 29 (0) | 37 |
| library | again | 0.15 | 0.30 | 1.11 | **5.6** | 29 (22) | 36 |

Each panel was opened again twice; the two agree to within 0.4 s, and the
table gives the second.

**What the panel's worker was doing**, warm, in order (start, how long):

- **account:** start the worker 0.2 s, take up the session 0.1 s, the
  accounts kept here under 0.1 s. Usable at 0.85 s.
- **wallet:** start 0.2 s, session 0.1 s, **the wallet from relays 9.1 s**,
  then the payment limit 2.1 s, then the mints people recommend.
- **files:** start 0.1 s, session 0.05 s, **the folders from relays 8.9 s**,
  then **the servers people use 8.9 s**.
- **library:** start 0.2 s, session 0.1 s, the receipts 2.2 s, the selling
  service's own record, then the payment limit 2.2 s.

**What was downloaded:** cold, 1.2 to 1.65 MB, sent uncompressed here
(bitlogin.network compresses, to roughly a third of that). Opening again,
20 to 23 files are each re-validated (one round trip apiece, answered "not
modified"). Even so, about 0.4 MB is fetched again on every opening; I
haven't yet broken down which files that is.

**Actions inside a panel:**

| Action | Seconds |
|---|---|
| Ask the mint for an invoice to add sats | 0.7 |
| Sats appear once that invoice is paid (checked every 2.5 s, then written to relays) | 12.6 |
| Add a file server and check it | 10.9 |

**Unlocking:** taking up the session already signed in costs 0.05 to 0.16 s
each opening. That is not the problem. Making the account (the key and the
recovery phrase) took 27 s on this loaded machine. Signing in on a new
device costs about the same, but that's sign-in, not the panels.

## What costs the most

### 1. Every relay question waits for the slowest relay, and a silent one costs 8 s or more

The wallet, the folders, the server list, the mints people recommend and
the take-back check ask the whole relay pool with `queryQuorum`. That waits
until every relay has answered or timed out. A relay that accepts a
connection and never answers (relay.nostr.band, today) is waited for until
the connection gives up at 8 s, and only then does that question's own
timer start. So each such question takes about 9 s, whatever the other
eleven did in under 1.2 s. This is the same fault fixed for buying on
2026-11-21.

- **Fix (BitLogin's):** ask these the way the paying screens already do
  (`worker/quickRelays.ts`): a question is finished when every relay has
  answered, or 0.7 s after two have. Give a read a short connect timeout
  (2 s) so a silent relay can't hold it.
- **Saves:** about 8 s on each of the wallet, the folders and the server
  list; the wallet to about 4 s, files to about 3 s, before fix 3.
- **Risks:** a slow relay holding a newer record is missed that time. The
  stores already keep a browser copy, take the newest of what answers, and
  send it again later. Fewer than two answering still waits the whole
  time, so nothing is ever called empty out of impatience.
- **Also:** relay.nostr.band has failed every probe since 2026-11-18. Taking
  it off the built-in list is the owner's call, and it would only help until
  the next relay goes quiet. Fix 1 is the real cure.

### 2. The worker answers one thing at a time, so slow reads stack

The worker runs one action after another, by design: it orders changes to
the account. So two slow reads cost their sum.

- Files waits for the folders and then for the servers people use: 500
  server lists from every relay, needed only on the screen where a server
  is chosen. 9 s + 9 s.
- The wallet waits for the payment limit after the wallet (2.1 s), and
  before it shows the balance it asks every mint whether each token is
  spent.

**Fix (BitLogin's):** don't ask for what the screen doesn't show.
- Files opens on the folders alone. The servers people use are asked for
  when that screen is opened.
- The wallet shows its balance, then asks the mints and the limit behind
  it.

**Saves:** 9 s on Files, about 2 s on the wallet. **Risks:** none for safety.
The server list and the limit are still read before they are used.

### 3. Nothing is shown until the relays answer, though the browser already holds it

The wallet, the folders, the receipts and the settings are each kept in
the browser first, sealed to the account's own key in IndexedDB, then on
relays. Yet each panel shows "Opening your wallet" until the relays have
been asked.

- **Fix (BitLogin's):** show the browser's copy at once, marked "Checking
  with your relays", then replace it with the fresh answer. The orchestrator
  calls this "what was there last time, marked as being checked".
- **Saves:** usable at about 1 s, opened again, instead of 6 to 19 s. With
  fix 4, about a tenth of a second.
- **Risks:** a balance or a folder seen for a moment as it was. While it is
  being checked, nothing that spends or changes is offered: Pay and Send
  wait. A mint refuses spent tokens anyway, so a stale balance can't spend
  twice. Nothing new is stored in the clear: the copy is the sealed one
  that's already there, opened in the worker as now.

### 4. Every opening loads the panel from nothing

Each opening makes a new frame, so the panel's code is fetched again or
re-validated: 20 to 23 round trips, and about 0.4 MB fetched again even
when cached. A new worker starts (0.1 to 0.4 s) and takes up the session
(0.1 s). Ready comes at 0.3 to 0.8 s, and the screen for the mode at 0.5 to
1.4 s, before any relay is asked.

- **Fix (the shell's, BitPortal):** keep BitLogin's panel frame alive and
  hidden between openings, and tell it which mode to show. Mine with it: a
  new panel message, `{ t: "show", mode }`, to the frame already loaded.
- **Fix (BitLogin's, smaller):** let the panel page use the site's service
  worker, which already precaches every file but is registered only by the
  home page. A third-party frame's service worker is kept apart per site,
  and that may still be allowed; it needs trying.
- **Saves:** about 0.5 to 1.4 s on every opening after the first, and all the
  re-fetching. With fix 3, something useful within about 0.1 s.
- **Risks, and what a kept frame may and may not do while hidden:**
  - The frame holds the visitor's session in its worker, as the open panel
    does now. It must not hold it unlocked any longer than the session itself
    lasts. Signing out or the lock closes it, and a hidden frame lets its
    worker go after a few minutes, to start again at the next opening.
  - While hidden it answers nothing: no question from a world is put or
    answered, no wallet or file action runs, and nothing is signed. It
    listens only for `show`.
  - Each time it is shown, a press is ignored for the first 0.9 s, as now,
    so a press meant for the world can't land on Allow or Pay.
  - The shell can't read it, as now: it is another origin.

**Not a cause:** unlocking the session already signed in (about 0.1 s), and
first paint (0.15 to 0.4 s).

## The proposal for "native", tested

| The orchestrator's proposal | Today | After fixes 1 to 3 | After fixes 1 to 4 |
|---|---|---|---|
| Something useful within about 0.1 s | No: 0.85 s at best (account), 6 to 19 s for content | About 1 s opened again | **Yes, from the second opening:** the last view at once, marked as being checked |
| Never waits on the slowest relay, mint or host for what is on screen | No: 9 s per question | Yes for relays. The mint check moves behind the balance | Yes |
| The first opening after a browser start | 1.4 to 19.6 s | About 1 to 3 s | About 1 s |

## Who does what

- **BitLogin:** fixes 1, 2 and 3, the `show` message, and trying the
  service worker in the panel. Each is measured again with this test,
  before and after.
- **BitPortal (the shell):** fix 4: keep the frame alive, hidden, and send
  `show`. Close it on sign-out and after a while hidden.
- **The owner:** whether to drop relay.nostr.band from the built-in list.
