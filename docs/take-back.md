# Taking a Site Back

**Document version:** 0.1
**Date:** 2026-11-19
**Status:** Design only. Nothing here is built. Written on `beta`.
**Depends on:** `docs/sign-in-window.md` §SW5, §SW6, §SW11, §SW12, §SW18;
`docs/spec.md` §16.2, §19, §22.

Asked for by the owner on 2026-11-19: "remove" on the list of allowed sites
should really stop the site. Today it cannot (§SW18).

---

# TB1. The problem

- What lets a site sign is a **grant**: the everyday key, kept by the
  embedded signer in storage a browser walls off by the site it is embedded
  in (§SW11).
- No page of the sign-in address can read or remove that storage. So the
  list at `/sites/` can show what was allowed and cannot take any of it
  back.
- A grant ends only when the user signs out at that site, when it reaches
  its date (thirty days, or seven for a site BitLogin does not know), or
  when the browser's data is cleared.
- Nothing local crosses that wall. Shared storage, workers, the cache and
  cookies are all kept apart the same way. The only place both sides can
  reach is outside the browser.

# TB2. The idea

The user publishes a small signed record, on their own account's relays,
that says which sites are taken back and when. Every embedded signer reads
it now and then, and forgets its site if the record says so.

A relay is untrusted transport here, as everywhere in BitLogin. It can
withhold the record. It cannot make one up, and it cannot read it.

# TB3. The record

One replaceable event, signed by the user's everyday key:

- **Kind 30078** (application data), `d` tag `bitlogin:taken-back:v1`. The
  same kind as the account's own capsules, with a name of its own. It is on
  the never-sign list for sites (§SW5), so no site can have one signed.
- **Content:** encrypted to the user's own key (NIP-44). A relay sees that
  the record exists and when it changed, and nothing of what it says.
- **Inside:**

  ```json
  {
    "v": 1,
    "all_before": 1795100000,
    "sites": [{ "site": "https://world.example", "before": 1795113000 }]
  }
  ```

  - `sites`: each site taken back, and the moment it was. At most 200; the
    oldest go first, and only once they are older than the longest a grant
    can live (thirty days), since by then no grant they could end is left.
  - `all_before`: "sign out of every site". Every grant made before this
    moment is ended, on every device, including ones no list knows about.

**The rule.** A grant made at time *t* for site *s* is ended if
`all_before ≥ t`, or if `sites` has *s* with `before ≥ t`.

- Allowing the site again makes a grant with a later time, which the old
  entry does not touch. Nothing has to be removed from the record to allow
  a site again.
- So a grant has to know when it was made. It does not today: `at` is added
  to what is sealed into the hand-off and kept with the grant. A grant with
  no `at` (made before this was built) is treated as made at the start of
  its life: `until` minus its length.

# TB4. Who writes it

The sign-in address, with a full session.

- **"Remove" at `/sites/`** adds the site with `before` = now, and
  publishes. The page then says what is true: the site stops the next time
  its signer checks (TB5), and at once if the user also signs out there.
- **"Sign out of every site"**, one button on the same page, sets
  `all_before` = now. It is the answer for a lost or shared device, and for
  sites allowed from a browser whose list the user cannot see.
- It is published to the account's vault relays (`spec.md` §19): the
  relays every BitLogin worker already knows without being told, which is
  what lets a signer inside a site find it.
- **And to the user's own write relays** (NIP-65, kind 10002), where they
  differ: asked for by the owner on 2026-11-19, through the NSWP session.
  That is where the user's other clients would look for anything of
  theirs. See TB9, question 6, for why the signer still reads from the
  vault relays alone.
- Publishing needs two relays to accept it, as a capsule does. If fewer do,
  the page says the site was **not** taken back.
- A new record carries everything the old one did. The page reads the
  newest record it can find before writing, and never publishes one whose
  `all_before` is lower or whose entry for a site is earlier.

# TB5. Who reads it

The embedded signer's worker. Not its page, and never the site.

- **When:** as it takes up a kept grant for the site, if the last check
  that succeeded is more than a day old; and once a day while a page stays
  open.
- **How:** one question to the vault relays, for that one record by that
  one author. It keeps the newest validly signed one, decrypts it with the
  key it already holds, and applies the rule in TB3.
- **If the record ends the grant:** the grant is removed and the signer
  locks, exactly as if the user had signed out at the site. The site is
  told `unlocked: false` and nothing else.
- **It remembers the newest record it has seen** (its time, kept with the
  grant). A relay that later serves an older one is not believed: the same
  idea as the account's generation high-water mark (§16.2).

**When the relays cannot be reached.** This is the choice that matters
most, and it is the owner's (TB9, question 2):

- The proposal: a grant that has been checked in the last **three days**
  keeps working. One that has not is locked until a check succeeds; the
  user can always get a fresh grant from the window.
- Stricter (lock at once when a check fails) would stop every world each
  time the relays have a bad hour, and on 2026-11-18 about four of thirteen
  were dependable.
- Looser (keep signing however long relays are unreachable) would let
  anyone who can block the user's network keep a taken-back site alive.

So a removal takes effect within a day where relays answer, and within
three days at worst. Signing out at the site is still the only thing that
is immediate. The interface has to say that, and not "removed".

# TB6. What it costs

**The signer's page may contact relays.** Today its policy is
`connect-src 'self'`: it can contact nothing but the sign-in address
(§SW6). That would become a fixed list: the sign-in address and the vault
relays, each written out in the header.

- **Not `wss:`.** A list of named relays, so the page that holds a key can
  reach thirteen known hosts and no others.
- **The list lives in the deployment's headers,** so a relay added by the
  signed maintainer list (§19.1) cannot be reached by the signer until a
  release adds it to the header too. That is a cost, and the right way
  round: this list should change only by a reviewed release.
- **What the rule was protecting, plainly.** It is a second line, not the
  first. A signer page that had been tampered with could already hand a
  key to the site it is embedded in, with a message. `connect-src 'self'`
  stops it reaching anyone else. With this change it could also reach
  those relays, and anything sent to a public relay can be read by anyone.
  The first line is unchanged: the signer's code is BitLogin's own, served
  under a policy that runs nothing else, and TODO item 9 (a check that the
  live build is a reviewed one) matters more once this is built.
- Only the worker opens the connections, and only to ask. The browser
  cannot be told "read only": the policy allows a connection or does not.

**Relays learn a little more.** A vault relay already sees the account's
public key when a capsule is read. With this it also sees that key asked
about roughly once a day from each browser where a site is remembered, and
from which network address.

- It does not learn which site: the connection comes from the sign-in
  address's frame, not from the site.
- It does learn that the person is online then. Checking once a day, and
  not on every page load, is what keeps that small.

**One more thing at rest:** when a grant was made, and the time of the
newest record seen. Neither is secret.

# TB7. What it does not do

- **It is not immediate.** See TB5.
- **Blocking the relays only delays it.** A check that does not succeed
  does not count, so someone who can block the user's network holds a
  taken-back site open for three days at most. A browser that never comes
  online again is never told, and signs nothing that reaches anyone.
- **It does not undo what was signed.** Notes a site had signed before it
  was taken back are signed.
- **It does not cover a visit.** A site allowed for one visit is held in
  memory and ends with its page; it is not checked.
- **It does not cover an application that embeds the widget itself**
  (every application before the sign-in window). Those hold a full session
  in their own storage. Whether "sign out of every site" should reach them
  is TB9, question 4.
- **It does not make the list complete.** `/sites/` still shows only what
  this browser allowed. `all_before` is how a user ends what they cannot
  see.
- **All relays withholding the record defeats it** until the three-day
  limit. Asking several and keeping the newest is the defence, and it is
  the same one the account itself rests on.

# TB8. Order of work

1. **The record, in `@bitlogin/core`:** build, encrypt, read, merge, and
   the rule in TB3. Tested with a hostile relay: an old record, a forged
   one, one that will not decrypt, none at all.
2. **`at` in the hand-off and the grant.**
3. **The check, in the signer's worker,** with the day and three-day
   clocks, and the newest-seen mark. Browser test: allow, take back at the
   sign-in address, load the site's page, find it locked.
4. **The signer page's policy:** the named relays in `vercel.json`, and
   the policy tests with them. This is the step that changes §SW6, and the
   pull request says why as well as what (`CONTRIBUTING.md`).
5. **`/sites/`:** "Remove" that publishes, "Sign out of every site", and
   words that say when each takes effect.
6. **`spec.md`:** the record beside the capsules (§12), and §22 for the
   policy.

# TB9. Decisions that are the owner's

1. **May the signer's page contact the vault relays?** Proposed: yes, as a
   written-out list, never `wss:`. Without this there is no design.
2. **How long may a grant go unchecked?** Proposed: checked once a day;
   locked after three days without a check that succeeded.
3. **"Sign out of every site"?** Proposed: yes. It costs nothing more to
   build and is the only thing that reaches a device the user no longer
   has.
4. **Should the widget inside an application honour it too?** Proposed:
   later, and only `all_before`. It would mean every application's page
   asking relays once a day, which they already may.
5. **With this built, should memory get longer again?** Proposed: no.
   Seven days for a site BitLogin does not know is cheap, and it is the
   backstop when the record cannot be read.
6. **Which relays does the signer read from?** The owner asked that relay
   choice follow the user's own relay list (NIP-65). For writing, yes
   (TB4). For the signer's reading, proposed: the vault relays only. A
   user's relay list can name any relay at all, so reading from it would
   mean letting the page that holds the key connect to any address
   (`connect-src wss:`), which question 1 was written to avoid; and a
   record that is on the vault relays is one every signer can find without
   being told where to look. A BitLogin account's own relay list is the
   vault relays today, so for most accounts the two are the same relays.
   The other way round (carry the user's cleaned write relays inside the
   hand-off, and open the policy to any relay) is possible, and is the
   looser choice.

Reported by the NSWP session on 2026-11-19: the owner answered question 1
there, "yes use relays". The rest are open, and question 1 is still to be
confirmed in BitLogin's own session before anything is built.
