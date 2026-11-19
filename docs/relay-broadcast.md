# BitLogin as the Relay Broadcaster

**Document version:** 0.1
**Date:** 2026-11-19
**Status:** Design only. Nothing here is built. Written on `beta`.
**Depends on:** `docs/spec.md` §15.8, §19; `docs/sign-in-window.md` §SW5,
§SW6, §SW9; `docs/relay-and-messaging-portability.md` §3, §4, §6.

Asked for by the owner on 2026-11-19: BitLogin should be the component
that finds the best relays and sends notes to them, for every application
that uses it, so that no application has to.

---

# RB1. The problem

- **Applications each run their own relay list.** An application that
  publishes carries a list of its own and its own code for publishing,
  retrying and giving up (Tessera's is `js/relays.js`; the others were not
  read for this). A relay that dies has to be noticed once per application.
- **BitLogin publishes a poor relay list for every user it creates.** At
  sign-up it writes the user's public relay list (kind 10002) as "read and
  write on every vault relay": thirteen relays today. NIP-65 says two to
  four of each. Measured on 2026-11-18, two of the thirteen never connect,
  one connects about one time in eight, and two refuse or drop events from
  keys they do not know. Other clients are told to look for this user's
  notes there.
- **Nothing measures.** The relays a user is told to rely on were chosen by
  reputation. The 2026-11-18 probe found reputation to be a poor guide: of
  70 relays that relay monitors listed as open, 22 stored a test event.

# RB2. Two questions, and the standard for each

"Send a note to the best relays" is two questions.

**Where does this note belong?** NIP-65 answers it. Each user publishes a
signed relay list (kind 10002) of `r` tags, each marked `read`, `write`, or
both when unmarked. Then:

- an event is sent to its **author's write relays**;
- and to the **read relays of every user it tags**, so they see it;
- someone looking for a user's notes looks on that user's write relays.

NIP-65 also says to keep a list small, "2-4 relays of each category", to
send the author's kind-10002 event along to the relays an event was sent
to, and to spread the list itself widely, to well-known indexers first.

**Which relays work?** NIP-66 offers evidence. Monitors publish an event per
relay they have tested (kind 30166, the relay's address in the `d` tag):
whether it answers, how fast (`rtt-open`, `rtt-read`, `rtt-write`), what it
requires (`R`: `auth`, `payment`, `writes`, each negated with `!`), which
kinds it takes (`k`). A monitor may announce itself (kind 10166).

BitLogin uses the first as the rule and the second only as a hint: RB4.

# RB3. What gets built

A small library that an application loads beside BitLogin's client
(`docs/sign-in-window.md` §SW8). Working name `bitlogin-relays.js`.

```js
import { createBitLoginRelays } from "./vendor/bitlogin/bitlogin-relays.js";

const relays = createBitLoginRelays();

const signed = await bitlogin.signEvent({ kind: 1, content: "hello", tags: [] });
const result = await relays.publish(signed);
// { accepted: 4, of: 5, relays: [{ url, ok, said }], enough: true }

await relays.listFor(pubkey);     // that user's read and write relays, checked and cached
await relays.health();            // what this device has seen of each relay
```

- **It holds no key and signs nothing.** It takes an event that is already
  signed, by BitLogin's signer or any other, and verifies the signature
  before sending it anywhere.
- **It runs in the application's page,** not in the embedded signer. See RB6.
- **It replaces an application's own relay code,** if the application wants
  it to. It is optional: an application may sign with BitLogin and publish
  however it likes.

# RB4. Choosing relays: tested, not trusted

**Candidates** come from three places: a short list shipped with BitLogin
and changed only by a reviewed release; the user's existing relay list;
and NIP-66 monitor events.

**A candidate is only a candidate.** Anyone can publish a NIP-66 event, and
a monitor that lies costs nothing to run. What a monitor says decides only
which relays are worth testing. No relay is used, and none enters a user's
relay list, because a monitor vouched for it.

**The test is the user's own events.** Every publish already tells BitLogin
what it needs to know: did the relay connect, did it accept the event, what
did it say if it refused, and (asked once, a little later) does it still
return the event. So the library keeps a record on the device, per relay:

| What | From |
|---|---|
| Connected, and how fast | Every connection |
| Accepted, or refused and the reason | Every publish |
| Still returns what it accepted | A read-back of a real event, minutes later |
| Requirements and limits | The relay's own information document (NIP-11) |

- **No test events.** `relay-and-messaging-portability.md` §6 forbids
  publishing test events to public relays without the user's consent. None
  are needed: the user's real notes are the test. (The maintainer's
  `scripts/relay-probe.mjs` does publish test events. It is run by hand, by
  the maintainer, to choose the shipped list.)
- **The read-back matters most.** On 2026-11-18 one relay accepted and
  returned every test event, and held half of them a few minutes later.
  "Accepted" is not "kept".
- **The record ages.** A relay that was good last month is not known to be
  good now. Old results count for less, and a relay with no recent result
  is a candidate again.
- **"Best" for a user** is the relays that have kept this user's own events,
  recently, weighed by how fast they answer.

# RB5. Publishing a note

For one signed event, the library sends it to:

1. **The author's write relays,** from their newest valid kind-10002 event.
2. **The read relays of the users it tags,** so they see it. At most two
   relays per tagged user and at most ten tagged users: a tagged user's
   list is input from a stranger.
3. **Extras, when the author's own list is thin.** If fewer than two of the
   author's write relays are known to work, the event also goes to the best
   relays on this device's record, up to four. This is the part that makes
   "it just works" true for an account whose relay list is poor.

Then it reports, per relay, what happened. A publish is **enough** when at
least two relays accepted it; the application decides what to do when it is
not. Refusals that look temporary are tried again a few times, with a pause
that grows.

What it will not carry:

- **A private message's wrapping** (kind 1059) goes to the recipient's
  message relays (kind 10050), as NIP-17 says, and not to their general
  relays. The library does that when it is handed one.
- **BitLogin's own account capsules.** They are published by the account
  flows, to the vault relays, and nothing here touches them: RB8.

# RB6. Where it runs

In the application's page, as a library. **Not in the embedded signer.**

The embedded signer's page is allowed to contact nothing but its own
origin (`connect-src 'self'`, `sign-in-window.md` §SW6). That is deliberate:
a page that holds the user's key and can also open connections to anywhere
is a page that could send the key anywhere. Publishing from the signer
would mean lifting that, for a convenience. So signing and sending stay
apart: the signer signs and cannot reach the network; the library reaches
the network and holds nothing worth taking.

The cost is that an application's own page policy has to allow relay
connections (`connect-src wss:`), as the three checked so far do (AdZap,
BitUnlock, Tessera), and that the library's record of relay health is kept per
application, in that application's storage, and not shared between them.

# RB7. What can go wrong, and what bounds it

- **A lying monitor.** It can waste a test, and nothing more (RB4).
- **A stranger's relay list.** A tagged user can list five hundred relays,
  or addresses on the reader's own network. Bounded by: two relays per
  tagged user; `wss://` only, never a loopback or private address; a short
  time limit per connection; a limit on connections open at once.
- **More relays see more.** Each relay an event is sent to learns the
  sender's address. Sending to tagged users' relays means connecting to
  relays the user never chose. This is what NIP-65 asks of every client;
  it should be said in the documentation and be possible to turn off.
- **A relay that accepts and discards.** Caught by the read-back, after the
  fact. A note is "enough" on two acceptances, so one such relay does not
  lose it.
- **A full queue.** The library keeps nothing on disk in its first version.
  A note that could not be sent is the application's to send again.

# RB8. What changes in BitLogin itself

1. **New accounts get a short relay list.** Three or four write relays and
   three or four read relays, from the shipped list, in place of all
   thirteen vault relays. Starts in `spec.md` §15.8.
2. **`getRelays()` tells the truth.** Today it returns the widget's
   configured relays. It should return the user's own list.
3. **Existing accounts are offered a repair.** Their public list names
   relays that do not work. Changing a user's relay list is a Sensitive
   kind (`sign-in-window.md` §SW9.3): it is offered at the sign-in address,
   as one press, showing the old list and the new, and never done silently.
4. **The vault relays are a separate matter and do not change.** Where an
   account's capsules live has to be fixed and known, or a new device
   cannot find the account (`spec.md` §19). That list is changed only by a
   reviewed release or the signed relay list (§19.1). Nothing in this
   document chooses vault relays.

# RB9. Order of work

1. **A relay directory and a publisher, in `@bitlogin/core`.** Fetch, check
   and cache a user's kind-10002 list; choose targets by RB5; publish and
   report per relay. Tested against the mock relays, including a hostile
   list.
2. **The library,** built as `bitlogin-relays.js`, and a browser test from
   an application on another origin.
3. **The health record:** what is kept, how it ages, the read-back.
4. **A short relay list for new accounts,** and the repair for existing
   ones at the sign-in address.
5. **NIP-66 as a source of candidates.**
6. **Move one application onto it.** Tessera again: its relay code is one
   small file.

# RB10. Decisions that are the owner's

1. **May BitLogin change a user's relay list without asking?** Proposed:
   no. Sending a note to extra relays is automatic (RB5.3); rewriting the
   list other clients read is one press at the sign-in address (RB8.3).
2. **How short is the list?** Proposed: four write, four read, where NIP-65
   says two to four.
3. **Send to tagged users' relays?** Proposed: yes, within the bounds in
   RB7, with a switch to turn it off.
4. **Which monitors?** Proposed: any, since a monitor only nominates. A
   short pinned list of monitors can come later if the open set proves
   noisy.
5. **One record of relay health per application, or one shared?** Proposed:
   per application for now (RB6). A shared one would have to live at the
   sign-in address and be asked for across sites, which is more surface on
   the page that holds the key.
