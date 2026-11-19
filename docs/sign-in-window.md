# The Sign-In Window and the Signer Hand-Off

**Document version:** 0.4
**Date:** 2026-11-19
**Status:** Implemented, and live at `https://bitlogin.network` since
2026-11-19 (pull requests #31 and #33): the **signer hand-off** (§SW4:
`worker/handoff.ts`, three worker actions, four methods on the headless
signer); the **embedded signer** and its rules (§SW5: `embedded/signer.ts`,
`embedded/policy.ts`, built as `bitlogin-signer.js`); the **window's
finding and handing over** (§SW3: `embedded/window.ts`, built as
`bitlogin-window.js`); and both pages on BitLogin's own site
(`/signer/`, `/connect/`), with the headers of §SW6; and the signer
**remembering a site** (§SW11: `worker/signerGrant.ts`). NOT implemented, design only:
what an application needs beyond a note and a reaction (§SW9, designed and
being built on `beta`), adding a
passkey to an existing account (§SW7), the optional lock (§SW12, §SW13),
profiles in the window (§SW14), and fewer presses for a new site (§SW15).
The order of work is in `docs/TODO.md`.
**Depends on:** `docs/spec.md` §22.1, §22.4, §26.3; `docs/passkey-login.md`.

---

# SW1. The problem

`<bitlogin-auth>` runs as part of the page that embeds it. That page can
read the password as it is typed (§22.1), and the spec says so: the host
page is inside the trust boundary.

That is acceptable for one site trusted with one account. It gets worse
with every site added, because one BitLogin account is one identity
everywhere: the least careful site decides how safe the whole identity is,
and a Nostr key cannot be changed once it is taken. Nobody has to be
hostile. One injected script on one embedding site is enough.

Passkeys have the mirror-image problem: a passkey belongs to the site it
was made on, so the same person gets a different account on every site
(`passkey-login.md`, "Per-site scoping").

# SW2. The answer

§26.3 already points at it. **The password is typed, and the passkey lives,
at one address the user trusts: their sign-in address. Every other site
asks that address, and gets back a signer it can ask, never a secret.**

Two parts, both served by the sign-in address:

- **The sign-in window**: a real, top-level window with its own address
  bar. If the user isn't signed in there, they sign in there, with the
  ordinary widget. It shows which site is asking and for what.
- **The embedded signer**: a hidden frame of the sign-in address inside the
  asking site. It has no interface. The asking site cannot read it or
  script it. It answers requests to sign.

A browser walls off a site's storage when that site is embedded in another.
So the embedded signer starts with nothing, however signed in the user is
at the sign-in address. The window gives it what it needs: §SW4.

What the embedded widget is still for: the sign-in address itself, and a
site that is its own user's home.

# SW3. The window

1. The asking site opens the window at the sign-in address.
2. The window finds the sign-in address's own frame inside the page that
   opened it. A message addressed to the sign-in address's origin is
   delivered to nothing else, so a page posing as the signer hears nothing.
3. The frame tells the window which site embeds it, as the browser reported
   it. Never as the site says.
4. The window shows that address and what is asked, and waits for Allow.
5. On Allow, the hand-off (§SW4), and the window closes.

A window that finds no frame of its own origin offers no Allow.

**What this does not do** is make a fake impossible. A hostile site can
open a look-alike on an address of its own. The address bar tells them
apart, and so does a password manager, which fills a password in only at
the address it was saved for. BitLogin's passwords are generated (§9.2), so
they live in a password manager. A passkey cannot be phished at all.

# SW4. The signer hand-off (implemented)

The everyday key moves from the window's crypto worker to the frame's,
sealed between two throwaway keys, one made in each worker. The pages in
between carry a public key one way and ciphertext the other. The key is
never in a page's own memory (§22.4).

```text
frame worker    handoffBegin   -> recipientPublicKey            (throwaway)
window worker   handoffExport(recipientPublicKey)
                               -> { senderPublicKey, payload }   (NIP-44)
frame worker    handoffAccept({ senderPublicKey, payload })
                               -> { everydayPublicKey }
```

- **What moves:** the everyday private key, and a fixed purpose string
  (`bitlogin:signer-handoff:v1`). No vault root, no capsule events, no
  recovery material, no account id.
- **What results:** a **signer-only session**. It can `getPublicKey` and
  `signEvent`. Every other action is refused before it runs: decrypting,
  encrypting, exporting the key, the vault, changing the account, handing
  the key on again. The list is `SIGNER_ONLY_ACTIONS`.
- **Accepting writes nothing.** A hand-off writes nothing to the session
  cache or the public record. Whether it outlasts the page is a separate
  step, for the embedded signer alone: §SW11.
- **One at a time, used once.** The receiving worker's throwaway key is
  wiped when the hand-off is opened, or replaced if another is begun.
- **The sealing is not what protects against the asking site.** The browser
  does that, by delivering the message only to a frame of the sign-in
  address's origin. The sealing keeps the key out of the DOM thread on both
  sides. A caller that posts the result with a wildcard target has undone
  the design; `exportHandoff`'s contract says so.

A session that did not come from a password or passkey sign-in (an
extension, a bunker) has no key to hand over, and `handoffExport` refuses.

# SW5. What the embedded signer signs for a site (implemented)

Unlocking is not agreeing to everything. `embedded/policy.ts` is the list.

| | Kinds | When |
|---|---|---|
| Ordinary | A note (1), a reaction (7) | Once the user has allowed that site, in the window |
| Careful | A profile (0), a follow list (3), a deletion (5), a relay list (10002), and anything not named | Only with their say each time, on a page of the sign-in address. **Not built: refused** |
| Never | Private messages and their wrappings (4, 13, 14, 15, 1059, 1060); passes and room signals (27300, 27301); proofs of identity (22242, 27235); wallet and remote-signer traffic (13194, 23194, 23195, 24133); application data (30078), which is where an account's capsules live | Refused, whatever anyone says |

- **The signer finishes the event.** It sets `created_at` itself and adds
  `["nswp:world", "<the site's origin>"]`, dropping any such tag the site
  wrote. What is signed for a site says which site asked.
- **Limits:** 8,000 characters, 60 tags; six signatures a minute and sixty
  an hour for one site.
- **A refusal never says why.** Locked, over the limit, the wrong kind and
  a malformed request all answer `refused`, with the request's id and
  nothing else.
- **It lasts** until the site is told to lock (the user's own doing, from
  the site: signing out of it), or thirty days from Allow. Loading the
  site's page again does not end it: §SW11.
- **Nothing is addressed to "any origin".** Every message the signer sends
  goes to the site's address as the browser gave it, or to this origin. A
  site learns the signer is there by asking `state` once the frame has
  loaded.
- **The asking site's address is the browser's word:** `ancestorOrigins`
  where there is one, and otherwise the origin of the first message from
  the embedding page. Never anything a message says.
- **It never restores this origin's own session.** What it takes up on a
  page load is only what it kept for the site it is in (§SW11). A site that
  shares a registrable domain with the sign-in address is treated like any
  other. A test reads the source for this.

Under the list is a floor BitLogin's worker keeps whatever a page does: a
handed-over session can sign and nothing else (§SW4).

The messages between a site and the signer, and between the window and
the signer, are those of NSWP-10 ("Signing from a world"), version 1, kept
exactly so that a site built against that works unchanged. The tag's name
comes from there too. Both are candidates for names of BitLogin's own in
the version an application's permissions will need (§SW9).

# SW6. What a deployment must set

- The embedded signer's page, and only that page, may be framed by other
  sites. It must have no interface.
- The window's page must keep its link to the page that opened it (no
  `Cross-Origin-Opener-Policy: same-origin` on that one page).
- Every other page keeps `frame-ancestors 'none'` and the rest of the
  pinned headers. BitLogin's own demo is unchanged: it serves neither page.

# SW7. A passkey for an existing account (design only)

Today a passkey derives an account of its own (`passkey-login.md`). To let
someone who signed in with a password add a passkey, the passkey's secret
would wrap the existing account's credentials in a record of its own,
found by a locator derived from the same secret. That is a new capsule
profile, so it starts in `spec.md` and goes through the same review as the
vault. Until it exists, the window's "add a passkey" message can only
point at passkey sign-in as it is.

# SW8. Using it from a site

```html
<iframe src="https://<sign-in address>/signer/" hidden></iframe>
<button>Sign in with BitLogin</button>
```

The button opens `https://<sign-in address>/connect/` with `window.open`,
from a press, without `noopener`. The site then posts requests to the frame
and listens for its answers, checking that each came from that frame and
that origin, and verifying every signature it is handed. The NSWP kit's
`createWorldSigner({ at: { signer, window } })` does all of that, and its
flat demo (`docs/plans/signin-demo` in that repository) is a small site
that uses it.

On the window's page, a press on Allow in the first second is ignored: a
key meant for the site, pressed as the window came up, must not land on it.

# SW9. Applications (design; being built on `beta`)

A note and a reaction are enough for a visitor to a world. They are not
enough for an application. This section is what an application may ask for,
how the user sees it, and how the signer holds the application to it.

**The requirement (owner, 2026-11-19).** Once a user has approved an
application, it signs and sends in the background, with no further prompt,
as applications do with the embedded widget today.

## SW9.1 What the applications ask for

Read from their code on 2026-11-19 (`bitvid`, `bitunlock`, `bitportal`,
`satisfied`, `AdZap`, `tessera`, `bitroad`). What the design has to carry:

- **A proof for a web request** (kind 27235): six of the seven, to their own
  origin or to `api.bitunlock.network`. Signed on timers, with nobody
  pressing anything: every one to four seconds while an order or a deposit
  is watched.
- **A proof for a file host** (kind 24242): four of them.
- **Their own data** in addressable events: kind 30078 under a prefix of
  their own (`adzap:`, `bitroad:`, `bitportal/`), or kinds of their own
  (30310 to 30316, 33600 to 33604). bitvid's video posts are kind 30078
  with no prefix at all.
- **Encrypting to the user's own key**, and reading it back: nearly all.
  AdZap reads the user's Cashu tokens this way.
- **Encrypting to one fixed service key** and reading its answers: the
  BitUnlock service, from three of them.
- **Messages with anyone:** bitvid's direct messages; bitroad's orders,
  which a seller reads from buyers they have never seen.
- **Kinds §SW5 calls careful:** profile (0), deletion (5), relay lists
  (10002, 10050), a mute list (10000). Nearly all of it from a press.
- **Bursts.** Satisfied signs every entry again at sign-in, a hundred or
  more in seconds, and eighty proofs a minute while an order runs. bitvid
  signs about twenty a minute in ordinary use.
- **A wallet connection** (bitunlock, Satisfied): asked of the widget
  today. Not in this section: §SW9.9.

## SW9.2 A declared permission set

An application says what it wants. The user sees it once, in the window.
The signer signs that and nothing else, for as long as the site is
remembered (§SW11).

```json
{
  "name": "Satisfied",
  "sign": [0, 5, 7, 24242, 30310, 30311],
  "appData": ["satisfied:"],
  "proofs": ["https://api.bitunlock.network"],
  "read": [30310, 30314],
  "peers": ["66be61cf…787d"]
}
```

- `name`: what the application calls itself. Shown second, after the
  address, and never instead of it.
- `sign`: the kinds it may have signed.
- `appData`: prefixes of the `d` tag it may write kind 30078 under. `"*"`
  is any prefix, for an application whose kind-30078 events have none.
- `proofs`: the other origins it may prove the user's identity to (kinds
  27235 and 24242). Its own origin is always allowed and need not be named.
- `read`: the kinds whose content it may have decrypted (§SW9.5).
- `peers`: fixed public keys it may encrypt to and decrypt from, outside
  any event (§SW9.5).

A set is at most 64 kinds, 8 prefixes, 8 origins and 8 keys. A set that is
malformed in any part is refused whole: there is no partial approval of
something the user was not shown.

**How it reaches the window.** The site tells the embedded signer what it
wants. The signer passes that to the window with the site's address, which
is still the browser's word and never the site's. The window shows both.
On Allow, the approved set travels inside the sealed hand-off (§SW4), from
one of BitLogin's workers to the other, and is kept with the grant
(§SW11). Nothing between the two workers can widen it.

**All or nothing, for now.** The window offers Allow and Don't allow. Ticking
some permissions and not others is not offered: an application that got
half of what it asked for fails in ways its user cannot see.

## SW9.3 Three tiers of kind

| Tier | Kinds | An application |
|---|---|---|
| Never | Remote-signer and wallet traffic (24133, 13194, 23194, 23195); passes, grants and room signals (27300 to 27303); kind 30078 under `bitlogin:` | Cannot ask. A set naming one is refused whole |
| Sensitive | Profile (0), follows (3), deletion (5), mute and relay lists (10000, 10002, 10050), relay sign-in (22242), kind 30078 under `"*"`, and reading messages (§SW9.5) | May ask. The window lists these apart, under a plain warning |
| Ordinary | Everything else | May ask |

- **Never is a floor under the user.** No press makes these signable from a
  site. Kinds 27302 and 27303 give a world a terminal on the user's own
  computer; one careless Allow must not be able to give that away.
- **This keeps BitPortal's own sign-in on the embedded widget.** It signs
  passes and grants. Moving it needs kinds reserved to named origins, which
  is an open decision (§SW9.10).
- **A world is unchanged.** A site that declares nothing gets what §SW5
  gives: a note and a reaction, under the old limits.

## SW9.4 What the signer does to an event

- **Kind** must be in the approved set, and not Never.
- **Kind 30078:** its `d` tag must begin with an approved prefix, and never
  with `bitlogin:`.
- **Kinds 27235 and 24242:** every address the event names (`u`, and
  `server` where there is one) must be of the asking site's own origin or
  an approved one. A proof with no address is refused. This is what stops
  a site from collecting a proof that works at someone else's server.
- **The time** is the site's if it is within ten minutes of the signer's
  clock, and the signer's own otherwise. Applications replace their own
  events and need the later one to win.
- **The mark.** Every event is tagged with the site that asked,
  `["bitlogin:site", "<origin>"]`, except a seal (kind 13), which must have
  no tags. A world's notes keep the tag NSWP gave them.
- **Size:** 100,000 characters of content, 2,500 tags.

## SW9.5 Encrypting and reading

A handed-over session refuses both today. For an approved application:

- **Encrypting** to the user's own key is always allowed: it gives nothing
  away. To another key it is allowed for a key in `peers`, and for the
  recipient named in an event the application may sign.
- **Reading is tied to an event.** The application hands the signer a whole
  signed event. The signer checks the signature, that the kind is in
  `read`, and for kind 30078 the prefix; then decrypts the content against
  the right key (the author's, or for the user's own event the key it was
  addressed to). An application approved to read its own drafts cannot read
  the user's Cashu tokens, because those are another kind.
- **`peers`** covers what is not in an event: an answer from the BitUnlock
  service arrives as a sealed envelope, not a Nostr event. Raw decrypting is
  allowed only against a key the user was shown.
- **Messages.** Reading kinds 4, 13 or 1059 is reading the user's private
  messages, and is Sensitive. The window says so in those words.
- **Raw decrypting against any key is not offered,** to anyone. It is
  indistinguishable from reading everything.

This changes what an application calls: `decryptEvent(event)` where it
called `nip44.decrypt(pubkey, ciphertext)`. Each of the owner's applications
has the event in hand where it decrypts.

## SW9.6 Limits

Counted across page loads (§SW11), per site, by what is being signed:

| | A minute | An hour |
|---|---|---|
| Proofs (27235, 24242, 22242) and the application's own data | 300 | 6,000 |
| Anything public and Ordinary | 60 | 1,200 |
| Sensitive | 30 | 300 |
| Reading | 600 | 12,000 |

An application cannot raise them. They are sized to the bursts in §SW9.1,
with room, and are the owner's to tune.

## SW9.7 What the window shows

The address first, exactly as the browser gave it. Then the name the
application calls itself. Then, in plain words, what it asked for, with the
Sensitive ones apart:

> **satisfied.example** calls itself "Satisfied" and asks to, without asking
> again:
> - prove who you are to satisfied.example and api.bitunlock.network
> - save and read its own data
> - post reactions
>
> **And these, which can change how others see you:**
> - change your profile
> - delete your posts

A kind BitLogin has no words for is shown as its number, and says that
BitLogin does not know what it is.

## SW9.8 A session between "can only sign" and "everything"

The hand-off (§SW4) now carries the approved set, sealed with the key. The
receiving worker holds it, and refuses in the worker, whatever the signer's
page asks, anything outside it. A session without a set is what it was: it
can sign a note and a reaction and nothing else.

## SW9.9 Not here

- **A wallet connection.** Two applications ask the widget for one today.
  Through the window it is a question of its own ("let this site spend from
  this wallet"), and is not designed.
- **Asking each time.** §SW5 wanted Sensitive kinds asked for every time.
  That needs a surface inside the site, which is the lock's panel (§SW12).
  Until it exists, Sensitive kinds are approved once like the rest, and the
  warning in the window is what stands in for it.

## SW9.10 Decisions that are the owner's

1. **Kinds reserved to named sites.** Should BitLogin ship a short list of
   origins that may ask for passes and grants (BitPortal's)? Without it
   BitPortal's own sign-in cannot move to the window.
2. **Approving Sensitive kinds once.** Accept it until the panel exists, or
   refuse those kinds until then? Refusing keeps bitvid, Satisfied and
   AdZap on the embedded widget.
3. **The mark's name**, `bitlogin:site`, and the protocol's
   (`bitlogin-signer`, version 2).
4. **The limits** in §SW9.6.
5. **Known applications.** Should the window say "BitLogin knows this
   application" for a list shipped with the sign-in address? It would make
   a look-alike of bitvid easier to spot, and makes BitLogin a gatekeeper of
   who looks trustworthy.

# SW10. (Not used)

The number belonged to a section that moved. It is kept empty so that
references to §SW11 and later, in the code and elsewhere, stay right.

# SW11. Remembering a site (implemented)

The first version held the handed-over key in memory, so every load of the
asking site's page began locked, and the window had to be opened again. The
owner asked for that to stop (2026-11-19): being asked once for a site is
the point, and a window on every page load is not that.

So the signer remembers. When a hand-off is accepted, the worker keeps a
**grant** for the asking site (`worker/signerGrant.ts`):

- **What is kept:** the everyday key, the site's origin, the date it stops,
  the name shown, and when the last signatures were made. AES-GCM, under a
  non-extractable key held by IndexedDB: the same protection at rest as the
  session cache (§21), and the same limits to it.
- **Under names of its own.** A grant is never read as a full session, and
  a full session is never written as a grant: only a session that arrived
  by a hand-off can be kept, and what is taken up from a grant can only
  sign (§SW4).
- **For one site.** The record is filed under the site's origin and names
  it inside; one moved under another site's name opens nothing. Another
  address of the same site finds nothing.
- **Thirty days from Allow,** never longer whatever is asked, and removed
  when it is past its date.
- **The count goes with it.** Six signatures a minute and sixty an hour are
  counted across page loads, so loading the page again is not a way round
  them.
- **Signing out of the site forgets it.** `lock` deletes the grant.

**Where it lives** is the embedded signer's own storage. A browser keeps
that apart for each site the signer is embedded in, so the asking site
cannot read it, and what is kept for one site is not there for another.

**What it costs,** plainly:

- The key is at rest in the browser for each site the user allowed, where
  before it was only in the sign-in address's own storage.
- A site the user allowed can have notes and reactions signed whenever they
  have that site open, for thirty days, within the count. It cannot use the
  signer when they are not there: the key is in their browser, never with
  the site.
- **The sign-in address cannot list or take back these grants.** A browser
  does not let a page see what was stored for it inside other sites. They
  end by signing out at the site, by their date, or by clearing the
  browser's data. A list of allowed sites that can be taken back from one
  place needs a different design (a record on relays that every signer
  checks), and is not built.
- Where a browser gives an embedded page no lasting storage (some do, or
  clear it when the last tab of the site closes), nothing is kept, and the
  user is asked again, as before.

# SW12. An optional lock: a PIN, or the device's own unlock (design only)

Decided by the owner on 2026-11-19: there should be a lock a user can turn
on, and a PIN should be one of the ways to open it. Some people want a PIN
for privacy at home, on a computer others can reach, and that is worth
having even though a PIN is not a strong gate.

**What it is.** Off by default: nothing gets slower for anyone who doesn't
ask. Turned on, what this browser keeps is locked until the user opens it:

- what the embedded signer remembers for each site (§SW11), and
- the sign-in address's own cached session (§21).

It locks when the browser is started again, and after a time unused. How
long is an open decision (spec §34, question 5, asks the same of an
unlocked identity); fifteen minutes is the suggestion to start from.

**Two ways to open it,** the user's choice when they turn it on:

1. **A BitLogin PIN.** The same on every device and browser, and nothing
   to set up beyond choosing it. At least six digits; longer, or letters,
   allowed.
2. **The device's own unlock:** a fingerprint, a face, or the device's PIN,
   through a passkey prompt the browser draws. Stronger, and it cannot be
   imitated by a site. It needs a device and browser that can do it.

**Where it is opened.** At the sign-in address, on its own pages. Inside a
site, in a small panel the embedded signer's frame draws: no window, and no
trip to the sign-in address. The site cannot read the panel.

**How a PIN wraps what is kept.** Two layers, both needed:

- the non-extractable device key (§21.2), as now, so a record is useless
  off this browser profile; and
- a key stretched from the PIN with Argon2id, the KDF already in use, with
  a salt of the record's own.

A count of wrong tries is kept beside the record. Past a small number
(eight is the suggestion) the record is removed, and the user signs in
again the ordinary way. Nothing is lost by that: the PIN is never a way
into the account.

**What a PIN does and does not do,** to be said in the interface where it
is turned on, and not only here:

- It stops someone who sits down at an unlocked browser.
- It does not stop malware on the device, or someone who copies the browser
  profile: six digits are quickly guessed, and a count kept in software can
  be put back. `second-factor.md` §SF11 says the same of software-only PIN
  wrapping.
- It is not a credential. It replaces neither the password nor the recovery
  phrase, opens nothing on any other device, and is never sent anywhere.
  Forgetting it costs one ordinary sign-in.
- A site can draw a look-alike panel and learn a PIN. What it learns opens
  nothing: the record it would open is in storage only this origin can
  reach.

**How the device's unlock wraps it.** A passkey made at the sign-in
address, used only as a wrapping key: the WebAuthn PRF output takes the
place of the PIN-stretched key above. It is **not** a passkey account
(`passkey-login.md`): nothing is derived from it but the wrapping key, no
capsule is made, nothing goes to a relay, and the derivation chain is
untouched. Losing it costs one ordinary sign-in. This is also the answer,
for one device, to "a passkey for an account that already exists" (§SW7),
with none of that section's new capsule.

Tried, with simulated authenticators, in the NSWP repository's
`docs/plans/in-game-identity.md` (Part 1): a frame of one site embedded in
another gets the same PRF secret as on its own page, in Chrome 157 and
Firefox 160, when the embedding page allows it
(`allow="publickey-credentials-get"`). Not tried: Safari, real devices, a
headset.

**What it changes elsewhere.**

- The embedded signer's page gains an interface, for this one thing. §SW6
  says it has none, and its policy allows no styles: both change, and the
  policy tests with them. The panel must be drawn only when the user's own
  press asked for something that needs it, never unasked.
- The embedding site must show the frame and allow it the passkey prompt.
  The site-to-signer messages gain a way for the signer to say "show me"
  and "I am done".
- Inside a headset session nothing but the world can draw, so no panel can
  appear there. The device's unlock, if its prompt can appear in a headset,
  is the only one of the two that could work there, and that is untested.
- This is key handling at rest: it starts in `spec.md` §21, and the pull
  request says why as well as what (`CONTRIBUTING.md`).

# SW13. The sign-in address remembers you (mostly exists)

It already does: a session is cached (§21), so for someone signed in there
a new site's window goes straight to the question, with no password. What
is new is only that the lock (§SW12), when it is on, covers this session
too. Then a new site is: the window, unlock, Allow. The password is typed
once for a device, and after that only if the lock's record was removed.

# SW14. Profiles in the window (design only)

Wanted by the owner (2026-11-19): several profiles on a device, natively.
It rests on `account-switching.md`, which is a design and not built: each
profile is a whole account of its own, with its own password, phrase and
identity, and the device keeps more than one signed in.

With that in place:

- The window says which profile it would allow a site as, and offers the
  others: "Allow as: Personal / Work".
- What the signer remembers for a site (§SW11) is for one profile. Allowing
  the same site as another profile replaces it.
- A site learns the public key of the profile it was allowed as, and
  nothing of any other: not that they exist, and not how many.
- With the lock on, one unlock opens the device's profiles, not one each.
  Whether a profile may have a lock of its own is an open question.

# SW15. Fewer presses for a new site (to explore)

Decided by the owner (2026-11-19): one press for a new site stays, for now;
ways to make it lighter are to be explored here.

What must stay: a site that has never been allowed is not connected
without the user doing something deliberate. A site connected silently
learns who its visitor is, and could sign as them, by their merely arriving.

What might go: the window. Two things to try, neither tried yet, and both
different from browser to browser:

- **The browser's storage-access permission.** A button the signer's frame
  draws ("Continue as Alice"), a press on it, and the browser's own
  question. If granted, the frame can reach what the sign-in address keeps,
  and no window opens.
- **The browser's federated sign-in.** The browser draws the choice of
  account itself.

Not to be built: a list of sites that are connected without asking. That is
the silent connection above, by another name.

# SW16. Not covered

- Safari, and phones, where a window is a tab: not tried.
- An asking site that cuts its link to windows it opens: the window finds
  no frame, and offers no Allow.
- Spending. The wallet mode in which BitLogin pays and the site never sees
  the connection is `nwc-connections.md`'s broker mode, and is not built.
