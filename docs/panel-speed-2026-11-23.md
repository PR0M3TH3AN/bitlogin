# Why BitLogin's Panels Are Slow: Measured (2026-11-23)

Asked by the owner: "using anything in the bitlogin panels was really slow
… Loading in wallet and files etc. Can we speed that up somehow? It needs
to feel native." (NSWP `docs/backlog/bitlogin-panels-feel-native.md`.)

**First measured only; then fixes 1, 2 and 3 and the `show` message were
built on beta and measured again with the same test: see "After the
fixes", below.**

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

## After the fixes (beta, measured 2026-11-23)

The same test, the same slowed relays, mint and file host, on the same
machine (load average 14 to 18). "Before" is main as released (6bb9673);
"after" is beta with fixes 1, 2 and 3 and the `show` message. Seconds from
the press; each a range over the openings measured. **Usable** is as
before: the content on screen. For the wallet and the library that may be
the browser's copy, marked "Checking with your relays", with nothing that
spends or changes offered yet. **Changing** is when it is: the wallet's
buttons enabled, the folders' tools no longer held.

| Panel | Before: usable | After: usable | After: changing | Kept, shown again (§SW19.8) |
|---|---|---|---|---|
| account | 0.44 to 1.2 | 0.54 to 1.0 | the same | 0.03 to 0.5 |
| wallet | 12.4 to 15.1 | **0.24 to 1.24** | 5.5 | 0.04 to 0.19 |
| files (no folders yet) | 20.8 to 22.0 | **4.9 to 6.6** | 10.1 | 9.0 to 12.2 (see below) |
| library | 4.7 to 7.0 | **2.9 to 3.8** | the same | 9.6 to 12.9 (see below) |

Files with no folders yet has no copy in the browser to show, so it shows
once the folders are read. With folders kept, they are shown at once, as
the wallet is. The library's list comes from relays read quickly
(receipts are never changed once written, below), about 2.2 s.

### The relay that connects and then never answers

Asked for by the owner: "Make sure a relay that connects and then never
answers is cut off by a limit of its own." The test now has one such
relay beside the one that never finishes its handshake (both are what
relay.nostr.band did, at different times). Each read now has two limits of
its own: a relay gets **3 s to accept the connection** and then **2.5 s to
answer** a question, whatever longer timer the question had. Measured with
it and without it (the handshake-silent relay is in both):

| Panel | Before, without it | Before, with it | After, without it | After, with it |
|---|---|---|---|---|
| wallet | 12.1 to 13.8 | 12.4 to 15.1 | 0.29 to 0.63 | 0.24 to 1.24 |
| files | 18.3 to 19.7 | 20.8 to 22.0 | 4.3 to 4.9 | 4.9 to 6.6 |
| library | 4.6 to 6.4 | 4.7 to 7.0 | 2.6 to 3.0 | 2.9 to 3.8 |

Before, it cost each question its whole timer (up to 6 s) and the panels 1
to 2.5 s more; after, it costs at most the 2.5 s answer limit, and only
where a read waits for every relay. relay.nostr.band stays in the built-in
list, as the owner asked, and can't hold a panel up for longer than that.

### Which writes this touches, and how each is protected

Asked for by the orchestrator: "Quick reads are for showing, never for a
write that replaces … Say in the report which writes this touches and how
each is protected."

- **Careful reads** (every relay that connects within 3 s is waited for,
  each up to 2.5 s to answer; fewer answers never count as "none"): the
  wallet, the folders, the account's own file-server list, the payment
  settings (limit and open orders), the guest lists, and following a
  world. Everything written after these is built on what they read.
  - The **guest lists** were read quickly before; they are now careful, as
    a new list is written on the one found.
  - The **payment settings** were read quickly before; now careful, as they
    are written whole.
  - The **file-server list**: silence used to be read as "no servers", and
    adding one would then have replaced the real list with just the new
    one. Now, until a relay has answered with it, it can't be changed: the
    folders stay on screen, read-only, and the panel says why
    (`docs/files.md`, tested).
  - The wallet's **limit form** waits for the limit to be read, and stays
    held if that read fails.
- **Quick reads** (finished when every relay has answered, or 0.7 s after
  two have), for showing only: the servers people use, the mints people
  recommend. Nothing is written from either.
- **Receipts** are read quickly. What follows from that read is sending
  again a receipt no relay answered with. A receipt record is never
  changed once written (one record a receipt, the same words each time),
  so sending it again can't overwrite anything newer.
- **The browser's copy** (fix 3) is the sealed copy already kept, opened in
  the worker as before. Showing it writes nothing, and while it is on
  screen nothing that spends, receives or changes is offered: Pay, Send,
  Receive, Add sats, a new mint and the limit wait for the fresh read;
  rows and tools in Files are held. Nothing new is kept in the clear, and
  nothing is kept unlocked longer: a hidden panel lets its worker go after
  5 minutes, and at sign-out.
- **Loads asked twice** while the first is still on its way share one
  answer; a load asked after any change is asked anew (tested).

### `show` and `hide`

The panel takes `{ t: "show", mode }` and `{ t: "hide" }` from the
client that framed it, checked against that client's exact origin. The
rules a hidden panel keeps are its contract, in `docs/sign-in-window.md`
§SW19.8: it answers nothing while hidden (a question already asked gets
"no"), checks nothing, ignores a press for 0.9 s each time it is shown, and
lets its worker go after 5 minutes hidden or at sign-out. Kept and shown
again, the account and the wallet are on screen in 0.01 to 0.5 s.

### Still slow

- **Changing modes in a kept panel.** Shown as files or library right after
  the wallet, it waits 9 to 13 s, because the worker answers one thing at a
  time and the wallet's careful read and mint check are still in line. The
  cure I propose: one line per store (wallet, files, receipts, settings),
  so a read of one doesn't wait on another's. Changes stay in order within
  each. Not built.
- **The wallet's buttons at about 5.5 s**, and **files changing at about 10
  s**: a careful read, then the server list behind the folders. Both wait
  for the 2.5 s answer limit set by the silent relay.
- **Sats arriving after an invoice is paid:** still about 18 s (checked
  every 2.5 s, then written to relays). Not looked at yet.

## Round two (beta, measured 2026-11-23)

Asked by the orchestrator: one queue per store; where the time goes when
sats arrive; and what the floor is for a careful read. The same test, which
now also records what a kept panel was still doing at each press, and when
each kind of question was asked. (Tried and taken out again: each test
relay at an address of its own, as real ones are. It changed little.)

### One line per store

The worker answered one thing at a time. Now each store has a line of its
own: the wallet, the files, the receipts, the payment settings, the mints
people recommend, and the profile. Work in a line runs in order, as before.
Lines run side by side. Everything else runs alone: signing in and out, the
lock, switching accounts, and every other action. It waits for every line
to finish what it was given, and holds every line until it's done (tested:
`serialQueue.test.ts`).

Kept and shown again, right after the wallet (seconds from the press):

| Panel | Before | After |
|---|---|---|
| library | 9.6 to 12.9 | 3.0 to 6.3 |
| files | 9.0 to 12.2 | 0.3 to 9.5 |

Files is still slow here. Two causes, both measured:

- **In this test, every action looks up the account's relay list again.**
  The test's relays are local `ws://` addresses, which BitLogin rightly
  never keeps as an account's relays, so the list is never found. A real
  account keeps it for the session after the first look. Here each careful
  read pays an extra round, 1 to 3 s. The before and after numbers both
  carry it.
- **Each action opens new connections to every relay.** Beside the wallet's
  read, the folders' first round took 3.3 s instead of 0.9 s. My reading,
  not yet proven: Chromium throttles new WebSocket connections from a page
  that has some pending, or has had some fail recently (the refusing and
  silent relays). The fix I propose: the worker keeps its connections open
  between actions, and remembers for a few minutes a relay that refused or
  never answered. Not built.

### Sats arriving after an invoice is paid: 17.5 s, now 7.4 to 7.8 s

Where the 17.5 s went, from the moment the invoice was paid:

- up to 2.5 s until the panel next asks the mint whether it's paid;
- 0.3 s for the mint to issue the ecash;
- **14 s writing it to relays.** The ecash is first written in this browser,
  sealed, and from then on is never lost. Then two records are sent, one
  after the other, and each waited for **every** relay to take it or for
  six seconds, so a relay that connects and never answers cost 6 s each.

**Changed:** the stores' records are sent until two relays have taken
them, then the rest get 1.5 s more (`RelayPool.publishEnough`, tested). A
record still counts as kept only once two relays have it, as before.
Fewer than two, and the whole time is waited. Every relay that's answering
takes it within the 1.5 s. Only the silent one is cut short. This applies to
the wallet, the files, the server list and the payment settings. The
take-back record is still sent to every relay and waited for in full. The
write now takes 3.9 to 4.5 s.

**Safe to shorten further, not changed:**

- Ask the mint every 1 s instead of 2.5 s: about 1 s saved on average.
- Send the history record beside the ecash record, not after it: about 2 s.
- Say "Added" once the mint has issued the ecash and it's sealed in this
  browser, with "Sending to your relays" until two have it. That's about
  3 s in all. It never shows sats before the mint has issued them, and the
  sealed copy is what's kept first now anyway.

### The careful read's floor

Measured, a careful read is: connect (the slowest answering relay, 1.2 s
here), then the answer, then **the 2.5 s answer limit if a relay connects
and never answers**. About 3.9 s with the connected-silent relay, 1.3 to
1.5 s without it. Plus, in this test only, the relay-list round above.

Can it finish on the relays that answered while the slow ones are still
within their limits? Not safely. Everything a wallet or a folder writes is
built on the copy this read brings up to date: the mint list, a folder and
the settings are each written whole. A slow relay may hold the newer one.
What can safely be shorter:

- **The answer limit.** Relays that answer did so within 0.35 s of
  connecting. 1.5 s instead of 2.5 s still gives them four times that, and
  saves 1 s whenever one relay is silent. It's the owner's call how much
  margin a slow but honest relay gets.
- **Connections kept open, and dead relays remembered** (above). The connect
  step goes after the first read, and a relay that refused isn't asked
  again for a while.

## Who does what

- **BitLogin:** fixes 1, 2 and 3, the `show` message, and trying the
  service worker in the panel. Each is measured again with this test,
  before and after.
- **BitPortal (the shell):** fix 4: keep the frame alive, hidden, and send
  `show`. Close it on sign-out and after a while hidden.
- **The owner:** kept relay.nostr.band in the built-in list (2026-11-23),
  "but not let it hold us up": the read limits above.
