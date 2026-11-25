# One Allow for a Family of Sites

**Document version:** 0.1
**Date:** 2026-11-19
**Status:** Built on `beta` (2026-11-19), with the owner's answers in SF9.
Not on `main`. What is built and where it stops short: SF10.
**Depends on:** `docs/sign-in-window.md` §SW5, §SW6, §SW9, §SW11, §SW16,
§SW18; `docs/take-back.md`; `docs/spec.md` §21.6.

Asked for by the owner through the BitPortal session on 2026-11-19, in
their words: "remember which account I signed in with, for every world".
The owner said "Yes, design it" the same day.

---

# SF1. The problem

- **Each world is a site of its own.** BitPortal's worlds live at their
  own addresses under `bitblocks.network` (`portal.`, `tessera.`, and one
  per reference world). A grant is kept for exactly one origin (§SW11), so
  someone signed in at BitLogin presses Allow once per world, and again
  whenever a grant runs out.
- **Pressing Allow costs nothing in safety at the tenth world.** The worlds
  are run by the same person, and, as SF2 explains, a browser already keeps
  them together. Asking ten times teaches people to press Allow without
  reading it, and that habit is the real risk.

# SF2. What the browser already does

The embedded signer is a frame on someone else's page. Chrome, Firefox and
Safari keep a frame's storage apart by the **top-level site**: the scheme
and the registrable domain of the page it is on (for example
`https://bitblocks.network`), worked out from the browser's own copy of
the Public Suffix List.

So every grant the signer keeps while it is on `portal.bitblocks.network`
sits in the same store as the grants it keeps on
`tessera.bitblocks.network`, and in a different store from the one on
`bitvid.network`. A family grant is not a key that travels between sites.
It is one record that the signer, inside one browser store, agrees to read
for more than one origin.

Two consequences:

- **The browser is a backstop.** If BitLogin worked out a family wrongly,
  a partitioning browser would still never show the record to a page of
  another site. The record would just not be found. That fails closed.
- **It is only a backstop.** Partitioning can be switched off, is missing
  in older browsers, and differs a little between them. The rule in SF3
  has to be right without it.

# SF3. The rule

A **family grant** is a grant for one registrable domain over `https`. It
is written `https://*.bitblocks.network` and covers that domain and every
name under it, at any depth.

- **The family comes from the asking site's address**, as the browser
  reported it (§SW6), never from anything a site says.
- **The registrable domain is computed with the Public Suffix List**,
  shipped inside BitLogin and changed only by a reviewed release
  (`scripts/update-public-suffix.mjs`). As built: 10,467 rules, 45 KB
  compressed, in a file of its own that only the sign-in window and the
  embedded signer load.
- **No family is offered where it would be unsafe or meaningless.** That
  means:
  - an address that is not `https`;
  - an IP address, `localhost`, or a private name (the same test as
    `isPublicRelayHost`);
  - an address that is itself a registrable domain directly under a public
    suffix of the list's private section. `alice.github.io`,
    `x.vercel.app` and `y.pages.dev` are each their own family of one, so
    the offer is not shown.
- **One family per grant.** No wildcards inside a name, no lists of
  domains, no "related sites" claimed by a site.

# SF4. How it is offered

**At the first site of a family,** the Allow screen is as it is today
(§SW11). Nothing is said about a family, because nothing yet tells the
person there is one.

**At the second,** where the sites list (§SW18) shows another site of the
same family already allowed, the Allow screen asks once, with two buttons
in place of Allow:

> You allowed **portal.bitblocks.network** on 18 November.
> Every site whose address ends in bitblocks.network can know who you are
> and ask you to sign notes, without asking you first. Choose this only if
> one person or team runs all of them.
>
> **[ Allow every bitblocks.network site ]**   **[ Just this one ]**

(The domain and site shown are the person's own.)

- **Neither button is the default.** Each is one press, and both are
  equally easy to reach. Remembering is ticked by default because it
  covers only the site in front of the person. This covers sites they have
  not seen yet, so it is a choice they make, not one made for them.
- **It is offered only with "Remember" ticked**, and never while the lock
  is on (§SW12). The lock already keeps nothing but one visit.
- **After "Allow every…" there are no more presses** for that family until
  the grant runs out or is taken back, at sites that exist now and at
  sites made later.
- **After "Just this one"** the question is not asked again for that
  family for thirty days. Asked at every new world, it would be the
  prompt this design is meant to remove.

# SF4a. Offered at the first sign-in, where the world asks for it

Added 2026-11-25 at the owner's word, through the BitPortal session: "These
logins should carry. especialy when on the same domain." It changes SF4's
"at the first site, nothing is said about a family" for a world that asks.

- **The world asks, before its first sign-in.** It sends its embedded
  signer `{ t: "want", family: "https://*.bitblocks.network" }`, written
  exactly as BitLogin writes a family. The signer takes it only where that
  is its own family, worked out from the browser's address for it by the
  Public Suffix List, and BitLogin knows the family (`KNOWN_FAMILIES`). It
  answers `familyTaken: true` or `false`, and approves nothing.
- **The window works it out again** (its own family, known, nothing beyond a
  note and a reaction asked) and, at the first sign-in, puts the family in
  place of Allow, as SF4 does at the second, without naming an earlier site:

  > Every site whose address ends in bitblocks.network can know who you are
  > and ask you to sign notes, without asking you first. Choose this only if
  > one person or team runs all of them.
  >
  > **[ Stay signed in at every bitblocks.network site ]**   **[ Just this one ]**

- **Choosing the family is itself the remembering**: it is offered whether
  or not "Remember" is ticked, and granted as SF4's family grant is (thirty
  days for a known family, signed out of everywhere by a sign-out at any of
  them). "Just this one" is the plain Allow, with the box as the person left
  it, and turns the family down for thirty days, as in SF4.
- **Unchanged:** never with the lock on; not where "Just this one" was
  pressed for the family in the last thirty days; never for a family
  BitLogin doesn't know, or one that isn't the asking site's own; never with
  more than a note and a reaction. A world that doesn't ask sees SF4 as
  before.

# SF5. What a family grant allows

Less than a site's own grant, where the two differ:

| | Site's own grant | Family grant |
|---|---|---|
| Who the person is (`state`, §SW16) | Yes | Yes |
| A room pass (§SW16) | Yes, for this origin | Yes, `nswp:origin` is always the exact origin that asked |
| A note and a reaction | Yes | Yes |
| An application's declared kinds (§SW9) | As approved | **No.** An application that declares kinds still gets its own Allow, at its own origin, with its own list. An application may ask for its family as well; the family still gets only SF5's (SF5a) |
| Reserved kinds (§SW9) | Only at the named address | Only at the named address, through that address's own grant |
| How long | 30 days known, 7 unknown | 30 days for a known family (`bitblocks.network`, SF9.3), otherwise 7 |

- **The counts are the family's,** not each site's. Two passes a minute
  and ten an hour (§SW16), three notes a burst and twenty an hour, shared
  by every site in the family. Otherwise a family of fifty sites would
  have fifty times the limit.
- **A site's own grant wins.** Where an origin has its own grant, that is
  the one used, with its own permissions; the family grant is read only
  where there is none.
- **The session key is the family's.** One key handed over at Allow, kept
  sealed in the one store (SF2). It signs nothing a site's own grant could
  not.


# SF5a. An application that asks for its family as well

Added 2026-11-25, at the owner's word through the BitPortal session: the
portal is an application (it declares kinds), and "these logins should
carry".

- **The ask.** An application's client (`createBitLoginClient`) may pass
  `family: "https://*.bitblocks.network"`. It is sent to the embedded signer
  as its own `want`, before the application's set, and taken only as SF4a
  takes a world's: its own family, by the browser's address, and one
  BitLogin knows. The client's state says `familyTaken`; a signer too old
  to answer counts as "not offered".
- **The screen.** The application's own Allow screen, as today, with the
  family line beside it, and two presses, neither the default:
  **[ Stay signed in at every bitblocks.network site ]**
  **[ Just this one ]** (the application's plain Allow).
- **One press, two grants.** "Stay signed in…" hands over one sealed
  hand-off carrying the application's set and the family. The signer keeps
  two records: the application's own (its kinds, its address only, as long
  as its own grant is kept, and the family it was allowed with), and the
  family's, with no set at all: a note, a reaction and a pass, as above. A
  family's record can never hold a set (`saveSignerGrant` refuses one).
- **A sign-out at the application ends the family too,** as a sign-out at
  any site of it does.
- **Unchanged:** never with the lock on; not within thirty days of
  "Just this one" for that family; never for a family BitLogin doesn't
  know.
# SF6. Seeing it, and taking it back

- **The sites list (§SW18)** shows the family as one row, "Every site at
  bitblocks.network", with the sites it was allowed from. It cannot list
  the sites the family later signed in: the signer that does that sits in
  storage no page of the sign-in address can read (SF10).
- **Signing out at any site the family signed in** signs out of the
  family. Otherwise that site's next page load would take the family's
  grant up again, and the sign-out would not have happened.
- **Take it back** works on the family as on a site (`take-back.md`). The
  record gains entries of the form `{site: "https://*.bitblocks.network",
  before}`. A grant is ended if its own site, **or its family**, has a
  `before` at or after the time it was made. Taking back one member of a
  family ends that member's own grant, and the family grant too: a person
  who says "not this one" should not still be signed in there by way of
  its family. They can allow the others again.
- **Older signers** read a family entry as a site they never kept, and
  ignore it. They hold no family grants, so nothing is missed.
- **Sign out of every site** already covers families (`all_before`).

# SF7. What can go wrong, and what bounds it

- **A subdomain someone else controls.** A family covers every name under
  the domain, including ones the owner forgot (a dangling DNS record taken
  over by a stranger) or gives away (a service that hosts customers at
  `name.example.com` without being on the Public Suffix List). That
  stranger's page learns who the person is and can sign notes and room
  passes for itself. Bounded by: the wording at Allow; seven days unless
  the family is known; no application kinds and no reserved kinds; the
  family's shared counts; take-back. A known family (SF9.3) is kept thirty
  days, so its entry is sound only while every name under it is run by
  the same owner.
- **A wrong Public Suffix List.** An old list may miss a new hosting
  suffix, which would offer a family across strangers' sites. Bounded by:
  partitioning (SF2) in every current browser; reviewed list updates; the
  "never ticked by default" rule.
- **Linking across a family.** Every site in it learns the same public key
  without the person seeing a prompt. That is what was asked for. It is
  said at Allow, and the sites list shows who has used it.
- **A room pass replayed between worlds.** Not possible: the pass names
  the exact origin that asked (`nswp:origin`), and a world's kit checks it.

# SF8. Order of work

1. **The registrable-domain function,** with the Public Suffix List,
   tested against the list's own test file, plus the refusals in SF3.
2. **Family grants in `signerGrant.ts`:** a record kept under the family's
   key, read after the origin's own; shared counts; no app permissions.
3. **The hand-off** carries `family: true` (`handoff.ts`), and the window
   shows the tick (SF4).
4. **Take-back** matches family entries (`takeBack.ts`, `spec.md` §21.6).
5. **The sites list** shows the family row and its members.
6. **Browser tests** on two origins under one test domain, in the three
   engines, including a member taken back and an origin with its own grant.

# SF9. Decisions that are the owner's

1. **Any domain, or only families BitLogin lists?** **Decided by the owner
   on 2026-11-19: any domain,** with the bounds in SF3 and SF7. No list of
   families has to be kept up to date. (The narrower choice was a shipped
   list of families, changed only by a release.)
2. **Offer it at the first site of a family, or only from the second?**
   **Decided 2026-11-19: from the second, as two buttons** (SF4).
   **Reversed 2026-11-25, for a world that asks,** by the owner's words
   through the BitPortal session: "These logins should carry. especialy
   when on the same domain." A world of a known family may ask for it at
   its first sign-in, and is offered it there (SF4a). A world that doesn't
   ask is still offered it from the second.
3. **Is `bitblocks.network` a known family,** remembered thirty days
   instead of seven? **Decided 2026-11-19: yes.** BitLogin keeps a short
   list of known families beside `KNOWN_APPS`, starting with
   `bitblocks.network`, changed only by a release. It decides how long a
   family is kept and nothing else: any domain may still be a family
   (SF9.1). This answers the BitPortal session's ask to add the reference
   worlds to `KNOWN_APPS`, and covers worlds not yet made. **The entry
   assumes every name under `bitblocks.network` is the owner's.** If a
   world run by someone else is ever hosted there, the entry is reviewed,
   and removed or narrowed, in the same release. Otherwise that world would
   get `state`, passes and notes for thirty days without a prompt.
   (Caution from the BitPortal session, 2026-11-19.)
4. **Does taking back one member end the whole family grant?**
   **Decided 2026-11-19: yes** (SF6).

The owner chose these as "the best user experience", on the reasons given
in SF4 and SF6: one clear question asked once, a family that is not asked
again every week, and a site taken back that is really gone.

# SF10. What is built, and where it stops short

Built on `beta`, 2026-11-19:

- **The rule** (`embedded/publicSuffix.ts`, `embedded/family.ts`): the
  Public Suffix List of 2026-11-19, compiled by
  `scripts/update-public-suffix.mjs`, and `familyOf(site)`. Checked against
  the list's own test cases.
- **The grant** (`worker/signerGrant.ts`, `worker/cryptoWorker.ts`): kept
  under the family's name; taken up only where a site has no grant of its
  own; one count of notes and one of passes for the whole family; never
  with an application's permissions.
- **The hand-off** (`worker/handoff.ts`) carries the family, and is refused
  whole where the family is not the site's, is not remembered, or is for
  an application. The embedded signer works the family out again from the
  address the browser gave it, and refuses a hand-off for any other.
- **The window** (`/connect/`): the question and its two buttons at the
  second site of a family; "Just this one" is remembered for thirty days.
- **Take-back** (`embedded/takeBack.ts`, `spec.md` §21.6) and the sites
  list (`/sites/`), as in SF6.
- **A browser test** with three sites of one domain and one of another:
  the third is signed in with nothing pressed, signs as its own address,
  shares the family's counts, and is signed out with the rest.

Where it stops short:

- **A site allowed by itself keeps its own grant.** The first site of a
  family was allowed before there was a family. Signing out at another
  site ends the family's grant and leaves that one. Taking the family
  back from `/sites/` ends both.
- **The sites list does not show who used a family** (SF6).
- **Tried in Chromium only.** The other tests of the sign-in window run in
  three engines; this one runs in one. Firefox and Safari keep an embedded
  page's storage apart by site as Chromium does, and that is not yet
  tested here.
- **Not tried at the real addresses.** The test's sites are made-up names
  answered by the test. Nothing has been tried at `bitblocks.network`.
- **"Just this one" is remembered in this browser only,** at the sign-in
  address. Another browser asks once of its own.
- **The list goes stale.** Nothing reminds anyone to update it. An old list
  can miss a new hosting suffix (SF7). Wanted: a check in the release steps.
