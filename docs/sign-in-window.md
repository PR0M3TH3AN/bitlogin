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
adding a
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
| Careful | A profile (0), a follow list (3), a deletion (5), a relay list (10002), and anything not named | Only with their say each time, on a page of the sign-in address. A profile, a deletion and a relay list can be put to them: §SW20. The rest is refused. A follow list is changed another way, for a site the user let (§SW16b); a save (37304) is written only by the signer (§SW16a) |
| Never | Private messages and their wrappings (4, 13, 14, 15, 1059, 1060); passes and room signals (27300, 27301); proofs of identity (22242, 27235); wallet and remote-signer traffic (13194, 23194, 23195, 24133); application data (30078), which is where an account's capsules live | Refused, whatever anyone says |

- **The signer finishes the event.** It sets `created_at` itself and adds
  `["nswp:world", "<the site's origin>"]`, dropping any such tag the site
  wrote. What is signed for a site says which site asked.
- **Limits:** 8,000 characters, 60 tags; three signatures a minute and twenty
  an hour for one site.
- **A refusal never says why.** Locked, over the limit, the wrong kind and
  a malformed request all answer `refused`, with the request's id and
  nothing else.
- **It lasts** until the site is told to lock (the user's own doing, from
  the site: signing out of it), or thirty days from Allow. Loading the
  site's page again does not end it: §SW11.
- **It loads itself again, once, if one of its files fails to arrive.** A
  deploy replaces the signer's files together, and a page caught between
  the old and the new would otherwise sit silent in a site that is waiting
  for it. The mark that it has done so is in its own address (`?again=1`);
  a second failure is left as it is.
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
- **The embedded signer's page may contact relays, over TLS, and nothing
  else but its own address** (`connect-src 'self' wss:`). Until 2026-11-19
  it could contact only its own address. The owner opened it so that a
  signer can find out whether its site was taken back
  (`docs/take-back.md`, which says what that costs). It is the worker that
  connects, to ask two questions about the user's own key; nothing is
  published from this page.
- The window's page must keep its link to the page that opened it (no
  `Cross-Origin-Opener-Policy: same-origin` on that one page).
- The sign-in panel's page (§SW19) may be framed by the clients BitLogin
  lists, by exact origin, and by nothing else; it may use passkeys.
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

**An application** (§SW9) uses BitLogin's own client, which does the frame,
the window and the checking:

```js
import { createBitLoginClient } from "./vendor/bitlogin/bitlogin-client.js";

const bitlogin = createBitLoginClient({
  at: "https://bitlogin.network",
  permissions: { name: "My app", sign: [1, 7, 27235] }
});
await bitlogin.ready();                        // already allowed? then signedIn is true
button.onclick = () => bitlogin.signIn();      // from a press: it opens the window
const signed = await bitlogin.signEvent({ kind: 1, content: "hello", tags: [] });
```

It also has `nip44` and `nip04` (`encrypt`, `decrypt`), `decryptEvent`,
`signOut`, `state` and `onChange`. The client file imports two shared
chunks, so an application vendors BitLogin's whole build folder, as it does
today. If an application later wants more than the user approved, `state()`
says `needsMore` and it is not signed in until they are asked again.

# SW9. Applications (built on `beta`; not on `main`)

A note and a reaction are enough for a visitor to a world. They are not
enough for an application. This section is what an application may ask for,
how the user sees it, and how the signer holds the application to it.

**What is built** (2026-11-19, on `beta`): the permission set and its rules
(`embedded/permissions.ts`); the set carried inside the sealed hand-off and
kept with the grant (`worker/handoff.ts`, `worker/signerGrant.ts`); the
worker holding a handed-over session to it, with encrypting and reading
(`worker/cryptoWorker.ts`); the signer and the window (`embedded/signer.ts`,
`embedded/window.ts`, `/connect/`); and a client for an application to use
(`embedded/client.ts`, built as `bitlogin-client.js`). A browser test runs
the whole of it from an application on another origin. **Not built:** a
wallet connection (§SW9.9), and no application has been moved onto it.

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
- `proofs`: the other origins it may prove the user's identity to with a
  web-request proof (kind 27235). Its own origin is always allowed and need
  not be named.
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

## SW9.3 Four tiers of kind

| Tier | Kinds | An application |
|---|---|---|
| Never | Remote-signer and wallet traffic (24133, 13194, 23194, 23195); room signals (27301); kind 30078 under `bitlogin:` | Cannot ask. A set naming one is refused whole |
| Reserved | Passes and grants (27300, 27302, 27303) | Only the address they are reserved to may ask (§SW9.10). For any other site the set is no request at all |
| Sensitive | Profile (0), follows (3), deletion (5), mute and relay lists (10000, 10002, 10050), relay sign-in (22242), kind 30078 under `"*"`, and reading messages (§SW9.5) | May ask. The window lists these apart, under a plain warning |
| Ordinary | Everything else | May ask |

- **Never and Reserved are floors under the user.** No press makes these
  signable from a site they are not for. Kinds 27302 and 27303 give a world
  a terminal on the user's own computer; one careless Allow must not be able
  to give that away.
- **Reserved is what lets BitPortal's own sign-in move to the window.** It
  signs passes and grants, and its address is the one they are reserved to.
- **A world is unchanged.** A site that declares nothing gets what §SW5
  gives: a note and a reaction, under the old limits.

## SW9.3a When a site asks for more than it may have

A set a site may not hold at its address (it names a kind reserved to
another address) is never shown: the window asks the plain question, for a
note and a reaction. Two things say so (owner, 2026-11-20: "prioritize the
user experience"):

- **The window says it to the user.** "This site asked for more than it
  may have at this address. If you allow it, it can only do what is listed
  below." Without that line the user was shown a smaller question than the
  one the site asked, with no word of it, and then found things missing.
- **The answer to `want` says it to the site:** `taken: true` or `false`.
  It approves nothing either way. It lets an application fall back, or say
  so, before it opens the window. `createBitLoginClient` gives it as
  `state().canAsk`. A plain `state` answer never carries it.

**A local copy of BitLogin.** Where BitLogin itself is running at a local
address (localhost, a loopback address, or a private range) a site that is
also at a local address may hold the reserved kinds. Otherwise an
application that uses them could not be tried before it is live. The
window says so, and says to use a test account. At BitLogin's real address
nothing changes: the kinds are the named site's and nobody else's, local
or not. A named site is given exactly what it is named for, wherever
BitLogin runs.

## SW9.4 What the signer does to an event

- **Kind** must be in the approved set, and not Never.
- **Kind 30078:** its `d` tag must begin with an approved prefix, and never
  with `bitlogin:`.
- **Kind 27235:** every address the event names (`u`) must be of the asking
  site's own origin or an approved one. A proof with no address is refused.
  This is what stops a site from collecting a proof that works at someone
  else's server.
- **Kind 24242 is not bound to an address.** File hosts are the user's own
  choice, often several, and the proof commonly names none. It is approved
  as what it is, and the window lists it with the Sensitive ones: it can
  upload and delete the user's files wherever they are.
- **The time** is the site's if it is within ten minutes of the signer's
  clock, and the signer's own otherwise. Applications replace their own
  events and need the later one to win. An application that sent a time
  further off than that gets back an event with another: **read
  `created_at` from the event that comes back, never from the one that
  was sent.** This stops an application dating a note in the past or the
  future as the user.
- **The mark.** Every event is tagged with the site that asked,
  `["bitlogin:site", "<origin>"]`, except a seal (kind 13), which must have
  no tags. A world's notes keep the tag NSWP gave them.
- **The mark is the signer's to write.** Any tag named `bitlogin:site` or
  `nswp:world` on what an application sends is taken off before the
  signer's own is put on, so what comes back has exactly one. A site that
  could write the mark could say it was another site. An application that
  wants to name a world in an event uses a tag of another name.
- **One exception: a world grant (kind 27303) keeps its `nswp:world`.**
  There the tag is the grant's subject, the one world a terminal may be
  brought to, and NSWP's Bridge requires exactly one. It is kept only in
  that kind, which is signed only for the address it is reserved to; it
  must be exactly one tag naming an origin, or the grant is not signed;
  and the event still carries the signer's own `bitlogin:site`.
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
- **The user's own event that names somebody** (a `p` tag) is tried
  against that key and then against the user's own. A note an application
  saved for the user alone is sealed to their own key whatever tags it
  carries; a `p` tag on one used to make it unreadable (found by the
  BitPortal session, 2026-11-19). Nothing more can be read this way: it is
  still one event, of a kind and a prefix the set may read.
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
| Sensitive, and the reserved kinds (27300, 27302, 27303) | 30 | 300 |
| Reading | 600 | 12,000 |

The reserved kinds were counted as public until 2026-11-19. They are a
pass that says who the user is, a terminal on a computer of theirs, and
access granted to a world: the window lists them as deserving a second
look, and they are now counted that way.

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

## SW9.10 Decided by the owner (2026-11-19)

1. **Kinds reserved to named addresses: yes.** NSWP's passes and grants
   (27300, 27302, 27303) may be asked for only by BitPortal's address. Any
   other site that names one is given nothing, and the window shows it no
   question. Room signals (27301) stay Never for everyone.
2. **Sensitive kinds are approved once,** like the rest, under the window's
   warning, until the lock's panel (§SW12) gives somewhere to ask each time.
3. **The names stand:** the mark is `bitlogin:site`. The messages keep
   NSWP's envelope for now, with the new requests added to it.
4. **The limits in §SW9.6 stand.**
5. **Known applications: yes, as display only.** The window says "BitLogin
   knows this address" for a list shipped with the sign-in address
   (`KNOWN_APPS` in `embedded/permissions.ts`), and that it does not for any
   other. Being on the list changes nothing a site may do, except item 1.
   The list is changed only by a reviewed release.

# SW10. (Not used)

The number belonged to a section that moved. It is kept empty so that
references to §SW11 and later, in the code and elsewhere, stay right.

# SW11. Remembering a site (implemented)

The first version held the handed-over key in memory, so every load of the
asking site's page began locked, and the window had to be opened again. The
owner asked for that to stop (2026-11-19): being asked once for a site is
the point, and a window on every page load is not that.

A grant is for one site. Where the user chose "Allow every … site" in the
window, it is for a **family**: every site under one registrable domain,
with less allowed than a site's own grant. That is `docs/site-family.md`;
the rest of this section is true of both.

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
- **Unless the user unticks "remember"** (owner, 2026-11-19; the first
  rule that day was "only a known site, or one ticked", and was withdrawn
  the same day: every world is an unknown address, a headset cannot open
  the window, and the aim is one yes for a world and then no
  interruptions). The window shows the box ticked, for every site. Left
  ticked, the site is kept. Unticked, it is allowed for the visit: the key
  is held in memory, nothing is written down, and it ends when the site's
  page is closed or loaded again, and after twelve hours at the latest. The
  tick travels inside the sealed hand-off; the worker that opens it keeps
  nothing unless the seal says so. The signer's `state` reply says
  `remembered: true` or `false`.
- **Thirty days for a site BitLogin knows, seven for any other,** from
  Allow. Decided where the grant is kept, from the site's address, and
  never longer whatever is asked. Removed when it is past its date.
- **Never while the lock is on** (§SW12): then every site is for one visit.
- **The count goes with it.** Three signatures a minute and twenty an hour
  (NSWP's own numbers, from its kit 0.28.0; they were six and sixty) are
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

# SW12. An optional lock: a PIN, or the device's own unlock (partly built on `beta`)

**What is built** (2026-11-19, `spec.md` §21.5), at the sign-in address
and in the widget wherever it runs:

- Off by default. Turned on from the account screen with a PIN; the
  device's own unlock can be added, and is then offered first, with the PIN
  as the other way in.
- "Lock now". It also locks on every page load, and after fifteen minutes
  unused.
- Five wrong tries remove the lock and what this browser kept.
- The sign-in window asks for it before Allow.
- **While it is on, no site is remembered:** every site is allowed for one
  visit, whether BitLogin knows it or not, and the window shows no box to
  tick. So no key is at rest outside the lock.

**What is not built, and differs from the design below:**

- **The panel inside a site.** The design opens the lock in a panel the
  embedded signer draws. That needs the signer's page to have an interface,
  and every asking site to show its frame and allow it the passkey prompt.
  Not built. What stands in for it is the rule above: with the lock on,
  nothing is kept for sites, so there is nothing in a site to open. The
  cost is a visit to the window for each site each time, and nothing at all
  in a headset.
- **Sites remembered before the lock was turned on stay remembered** until
  their date or until signed out there. The sign-in address cannot reach
  them (§SW18).
- **It locks on every page load,** not only when the browser is started
  again: the key that opens it lives in the page's worker and goes with it.
  At the sign-in address that is a visit now and then. In an application
  that embeds the widget and loads many pages it is an unlock per page.
- Not tried: a real fingerprint or face reader, Safari, a phone. The
  device's unlock was tested with a simulated authenticator in Chromium.

The design, as first written:

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

# SW16. Who someone is, in a world (built on `beta`)

Asked for by the NSWP session on 2026-11-19 and agreed by the owner the same
day. A visitor who signed in at a world could post, but was a guest in the
room and was shown as a key: the world had no name for them, and no pass.

**The profile.** A name, a picture and a line about them come from one
place: their own signed profile (kind 0).

- BitLogin's worker fetches it at the sign-in address, while the question
  is being read, and believes it only as far as its signature goes. The
  newest one their key signed is used, even if it says nothing.
- The name is the one they show: `display_name`, then the older
  `displayName`, then the short `name`, the order BitPortal and other
  Nostr clients use (owner's decision, 2026-11-19).
- It is cleaned as NSWP cleans it: a name of one line and 48 characters; a
  picture only at an `https` address with no credentials, at most 300
  characters; a line about them of at most 280.
- It is sealed into the hand-off with the key, and kept with the site's
  grant. The embedded signer does not fetch it, then or later. (What it
  does ask relays, since `docs/take-back.md`: whether its site was taken
  back, and where the user writes.)
- The world never supplies it and never fetches it. A world still asks no
  relay about its visitors.
- If no relay answers within a few seconds, the site is handed the key
  alone and told the name the sign-in address knew, as before.
- Only a site that declared no permissions is told. An application is held
  to the set the user read (§SW9).

The signer's `state` reply now carries `name`, `picture` and `about` where
there are any.

**The pass.** A new request, apart from `sign`:

```
site   → signer   { nswp: "nswp-signer", v: 1, id, t: "pass", session: <64 hex> }
signer → site     { nswp: "nswp-signer", v: 1, id, t: "signed", event }   or   { ..., t: "refused", id }
```

The event is NSWP's room pass (kind 27300, `protocol/10-identity.md`):
`["nswp:session", session]`, `["nswp:origin", site]`, `["expiration", …]`,
then `name`, `picture`, `about` where the profile has them. Content empty.

- **The site supplies the session key and nothing else.** Anything more it
  sends with the request is not read.
- **The origin is the one the hand-off was sealed for.** The site's address
  now travels inside the seal for every hand-off, so the worker that signs
  knows which site it serves without being told by a page.
- **Four hours,** from the signer's own clock.
- **Built and signed in the worker,** by an action that takes a session key
  and has no other input.
- **Refused** when the signer is locked, for an application, for a session
  key that is the identity key, for a hand-off that named no site (one made
  before this was built), and over the limit. A refusal says nothing.
- **Counted apart from notes** (owner, 2026-11-19, with NSWP's numbers):
  two a minute and ten an hour, across page loads, so that signing in does
  not use up a post.
- **`sign` still refuses kind 27300.** The never-sign list is as it was.
  A pass for some other site is still BitPortal's alone to make (§SW9.4).
- **The window says so** before Allow: the site can tell the other people
  there who you are, at that site only, four hours at a time.

What a pass lets a world do that it could not before: show the others in a
room this person's name and picture, with proof. What it does not: it is
good at no other site, the session key signs nothing on Nostr, and it ends
in four hours whether or not the site is still allowed.

Checked against NSWP's own `verifyRoomPass` at its `main` of 2026-11-19
(`99f51a4`): a pass built here is accepted for its site and refused for
another.

# SW16a. What a world keeps for its visitor: saves (built on `beta`)

Asked for by the NSWP session on 2026-11-20 (NSWP-12, kit 0.36.0) and agreed
by the owner the same day. A world can keep something with its visitor's
own account, so it is there on their next device.

Three more requests, for a site that declared nothing. All need the signer
unlocked for that site. Anything else is `refused`, with no reason.

```
site → signer   { ..., t: "save", slot, data }     signer → site   { ..., t: "signed", event }
site → signer   { ..., t: "find", slot }           signer → site   { ..., t: "found", d }
site → signer   { ..., t: "open", event }          signer → site   { ..., t: "opened", slot, data, at }
```

- **A save is a note of kind 37304,** signed by the visitor's key, with the
  content encrypted to that same key (NIP-44). Its tags are `d` and `alt`,
  and nothing else: no `nswp:world`, no `bitlogin:site`. Nothing on a relay
  names the world.
- **Where it is kept is the signer's to say.** `d` is
  `HMAC-SHA256(K, "nswp-save\n" + origin + "\n" + slot)`, in hex, where `K`
  is the NIP-44 conversation key of the visitor's key with itself. The
  origin is the site the hand-off was sealed for, never anything in the
  request.
- **A save is opened only for the world it is from.** The signature must be
  good and the visitor's own; the kind 37304; what is inside must name the
  asking origin; and `d` must be the address the signer works out for that
  origin and slot.
- **Limits:** 32,768 bytes of UTF-8; a slot of lower-case letters, digits
  and hyphens, 32 at most; six saves a minute and sixty an hour.
- **The count is the world's own,** by its exact address, whether it was
  allowed by itself or as one of a family (`site-family.md`). It is kept
  across page loads, and apart from notes and passes. Finding and opening
  are not counted.
- **No other way in.** `sign` refuses kind 37304 for a world. An application
  may not have it in a permission set, to sign or to read. Kind 30078 stays
  refused for a world.
- **Not for an application,** which keeps its own data under kind 30078.
- **The window says so** before Allow: the site can keep its own saves with
  your account; only you can read them.

All of it is done in BitLogin's worker (`worldSave`, `worldFind`,
`worldOpen`), from `embedded/saves.ts`. Checked against NSWP's vectors
(`vectors/saves.json` at `8400ac7`): every address, the sealed save, and all
seven opening cases.

What it costs: a world the user allowed can put up to about 2 MB an hour of
encrypted notes on their relays, under their key. A relay sees that this key
saved something, how big, and when.

# SW16b. Following from inside a world (built on `beta`)

Asked for by the BitPortal session on 2026-11-20 (NSWP-10 "Asking for
more", NSWP-14, kit 0.40.0), on the owner's decision of the same day:
"worlds no differently than a Nostr client. Some trust is required."

**What can be asked.** Every `state` the signer sends a world, locked or
unlocked, carries `offers`: the names it can be asked for (today
`["follows", "messages"]`). A world asks for nothing that is not there
(asked for by the BitPortal session, 2026-11-20).

**Asking.** A world sends `{ t: "want", more: ["follows"] }`. It approves
nothing. The signer remembers it and the window shows it, in BitLogin's own
words, with two buttons: **Allow, and let it change who I follow** and
**Allow without that**. Neither is the default. What was allowed comes back
in `state` as `more: ["follows"]`.

- **A short closed list of names** (`WORLD_MORE`), today one. A name not on
  it is dropped.
- **For one site, by its own address.** Never with a family: no family is
  offered beside it, and a family's grant never carries it. Never for an
  application, which is held to its permission set. A hand-off that mixes
  them is refused whole.
- **It lasts as long as the grant,** is kept with it, and ends with `lock`.

**Following.** The world then sends
`{ t: "follow", list, add | remove }`, where `list` is the visitor's newest
kind 3 event as the world found it, or null. The answer is `signed`, with
the new list, or `refused`.

A follow list replaces the last one, so a wrong one loses everyone its owner
follows. Before anything is signed:

1. **The list is theirs.** A real signature, by the visitor's own key, kind
   3, at most 20,000 tags.
2. **BitLogin looks for itself.** Its worker asks the user's own write
   relays and the usual ones for their newest follow list. A world's own
   choice of relays is not asked.
3. **A world that is behind is refused:** a list older than one a relay
   has, or older than the newest this signer has signed, been handed or
   found (kept by public key).
4. **"They have none" is believed once,** and only where a relay answered
   and had none. With no relay answering it is refused. NSWP lets a signer
   take a world's word here; BitLogin does not.
5. **One change:** one person added or taken out. Everything else is kept
   as it was and in its order. Following oneself, someone already followed,
   or unfollowing someone not followed is refused.
6. **No mark of the site** is put on it, and any on the old list is
   dropped: a follow list that named a world would say where its owner had
   been.

- **Limits:** six a minute and sixty an hour for one world, kept across
  page loads.
- **`sign` still refuses kind 3** for a world.

Checked against NSWP's vectors (`vectors/people.json`, `fromAWorld`, at
`13d5feb`).

Where it stops short:

- **A list handed over stands where no relay answers.** It is theirs,
  signed, and not older than any this signer has seen. In a browser that
  has seen none, with every relay down, an old list of theirs would be
  taken as the newest.
- **A first follow is refused while relays are down.** The world says so,
  and the person tries again.
- **The list of sites allowed** (§SW18) does not yet say which sites may
  change who the person follows.
- **Tried in Chromium only,** with made-up addresses and mock relays.

# SW16c. Private messages from inside a world (built on `beta`)

Asked for by the BitPortal session on 2026-11-20 (NSWP-10 "Asking for
more", NSWP-14 "Messages from inside a world", kit 0.42.1), on the owner's
words that day: "Yes more like a nostr client." The owner said "Yes, build
it" to this design the same day.

**This is the most a world can be let do.** A world let do this can read
every private message sent to the person that it can find, and write as
them to anyone. It shows the messages on their screen, and nothing here can
stop a world that means to send what it read somewhere else. A message that
was read can't be unread.

**Asking.** A world sends `want` with `more` naming `messages` (with
`follows` too, where it has that already: NSWP's kit sends everything it
holds plus the new one). The window asks about what is new, in BitLogin's
words, with the two buttons of §SW16b: **Allow, and let it send and read my
private messages**, and **Allow without that**. What the site already had
is said on the page and kept either way.

- **For one site, by its own address.** Never with a family, never for an
  application: the same rules as `follows`, and the same refusal whole.
- **Asked again after seven days,** however well BitLogin knows the site: a
  grant that carries `messages` is kept seven days, not thirty (owner,
  2026-11-20).
- **Ended by `lock`,** with everything else.

**Three requests,** each refused unless `more` has `messages`:

```
site → signer   { ..., t: "seal", to, text }       signer → site   { ..., t: "sealed", message, seals }
site → signer   { ..., t: "unwrap", event }        signer → site   { ..., t: "message", message }
site → signer   { ..., t: "reach", relays }        signer → site   { ..., t: "signed", event }
```

- **`seal`.** The signer writes the message itself (kind 14, never signed):
  from the visitor, one `p` tag naming `to`, the words cleaned, the time
  now. It seals it (kind 13, no tags, NIP-44) to the reader and again to
  the visitor, signs both, and hands back the message and
  `seals: [forReader, forWriter]`. The world wraps each with a key of its
  own, used once, and sends them. Nothing else a world sends with the
  request is read. Writing to oneself is refused.
- **`unwrap`.** A kind 1059 wrap, for the visitor, with a real signature.
  The signer opens both layers and answers `{ id, from, to, text, at }`.
  `from` is the key that signed the seal: a message that says it is from
  anyone else is dropped. So is a seal with tags, anything that is not a
  message, and a message the visitor neither wrote nor is a reader of.
- **`reach`.** A kind 10050 list of where the visitor's messages reach
  them: up to four `wss` relays at public names, each once. No mark of the
  site is put on it.
- **A world is never given a key,** and can't have anything else encrypted
  or decrypted. `sign` still refuses kinds 13, 14, 1059 and 10050.
- **Limits, for one world:** ten sealed a minute and two hundred an hour,
  kept across page loads; six hundred opened a minute and twelve thousand
  an hour (a first look opens some hundreds in a row; this count starts
  again with the page); three `reach` a minute and twelve an hour.

Checked against NSWP's vectors (`vectors/people.json` at `4cde6bf`): all
seven `messages` cases, and the message and seals of `sealedForAWorld`.

Where it stops short:

- **The count on opening is not a wall.** A world let read messages can
  read them: the count bounds a runaway script, not a world that means to.
- **Taking it back** is taking the site back (§SW18): the list of sites
  allowed does not yet show or end `messages` by itself.
- **Tried in Chromium only,** with made-up addresses.

# SW16d. A score on a world's board (built on `beta`)

Asked for by the BitPortal session on 2026-11-20 (NSWP-15, kit 0.44.0), on
the owner's words that day: "Yes, scores first".

```
site → signer   { ..., t: "score", world, board, score, title?, format? }     signer → site   { ..., t: "signed", event }
```

- **A score is a note of kind 37306** with no words: `d` is
  `<world coordinate>/<board>`, `a` the world's coordinate
  (`37300:<publisher>:<d>`), then `board`, `score` (a whole number, zero or
  more, as text), `alt`, and `["nswp:world", <origin>]`. One for each
  person on each board; a newer one replaces it.
- **The signer builds all of it.** The world names its coordinate, a board
  and a number. Nothing else it sends is read. The mark is the site the
  hand-off was sealed for, as for a note: a board counts a score only where
  the mark is the world's own address, so another site can't post to it.
- **For any site the user allowed** that declared nothing. It is not asked
  for by name (§SW16b): a score is less than a note, which such a site may
  already have signed. `offers` and `more` are unchanged.
- **Six a minute and sixty an hour** for one world, by its exact address,
  kept across page loads, apart from notes.
- **`sign` still refuses kind 37306** for a world. An application that
  declares the kind has it marked `bitlogin:site`, as everything it signs.
- **The window says so** before Allow.

- **`title` and `format` are optional** (NSWP kit 0.46.0). `title` is what
  the board is called, one plain line of 60 characters at most; `format`
  is `"time"` where the score counts thousandths of a second, and anything
  else is a plain number. Given, they are written as
  `["board", id, title]` and `["score", n, "time"]`, and into `alt`
  ("Lantern Run: 42.5 s"), so the score can be shown where the world
  isn't. NSWP's kit checks that what comes back carries what it asked.

A score is a claim: nothing checks that it was earned. Checked against
NSWP's vectors (`vectors/scores.json`, `signed` and `signedPlain`), as they
stood on its `on-cards` branch on 2026-11-20, before that was merged.

# SW16e. An achievement held in a world (built on `beta`)

Asked for by the BitPortal session on 2026-11-20 (NSWP-16, kit 0.45.0); the
owner said "Yes, build it" the same day. Built as a score is.

```
site → signer   { ..., t: "achieve", world, achievement, title }     signer → site   { ..., t: "signed", event }
```

- **A note of kind 37307** with no words: `d` is
  `<world coordinate>/<achievement>`, `a` the world's coordinate, then
  `achievement`, `title`, `alt`, and `["nswp:world", <origin>]`.
- **The signer builds all of it** and writes the mark itself. `title` is
  made one plain line of at most 60 characters; with none left, nothing is
  signed.
- **For any site the user allowed** that declared nothing, six a minute and
  sixty an hour, counted apart from scores and notes. A world that shows
  more than six at once has the rest refused, and asks again.
- **`sign` still refuses kind 37307** for a world.

It is a claim: nothing checks that it was earned. Checked against NSWP's
vector (`vectors/achievements.json`, `signed`, at `cdb91a4`).

# SW17. Not covered

- Safari, and phones, where a window is a tab: not tried.
- An asking site that cuts its link to windows it opens: the window finds
  no frame, and offers no Allow.
- Spending. The wallet mode in which BitLogin pays and the site never sees
  the connection is `nwc-connections.md`'s broker mode, and is not built.

# SW18. The list of sites allowed (built on `beta`)

Asked for by the owner on 2026-11-19: one page showing every site that can
sign as them, when it last did and how many times, with a remove button.
Part of that can be built, and part cannot without a decision.

**Built:** a page at the sign-in address, `/sites/`. It lists every site
Allow was pressed for from this browser: the address, the name BitLogin
knows it by if any, which account, what it may do, when it was allowed,
when it ends, and whether it is remembered or was for one visit. The record
is written by the window at Allow, in the sign-in address's own storage. It
holds no key and lets nothing sign.

**Not possible from that page by itself** (see the end of this section
for what was built to get round the first):

- **Switching a site off at once.** What lets a site sign is the grant the embedded
  signer keeps (§SW11), in storage a browser walls off by the site the
  signer is embedded in. No page of the sign-in address can read or remove
  it. A site is stopped by signing out at that site, by its date, or by
  clearing the browser's data. The page links to the site for the first.
- **When a site last signed, and how often.** That count is in the same
  walled-off storage.

"Remove from this list" takes a line off the page and stops nothing.

**A real "remove" is built on `beta`** (2026-11-19): `docs/take-back.md`.
"Take it back" and "Sign out of every site" on this page publish a record
that every embedded signer reads and obeys. It is not instant, and the page
says so. What follows is how the choice was put:

1. **A record on relays that every signer checks.** The sign-in address
   publishes "this site is taken back"; the embedded signer reads it when
   it loads and forgets the site. It works everywhere and on every device.
   Its cost is the one §SW6 was written to refuse: the page that holds the
   key would have to be allowed to contact relays (`connect-src`), where
   today it can contact nothing but its own address.
2. **Shorter memory.** Thirty days becomes a few; a site that is used keeps
   being asked for now and then, and one that is not falls away soon. It
   takes nothing back at once, and costs presses.

Opening the site from the list and telling its signer to forget was looked
at and left out: the opened site would hold a link back to a page of the
sign-in address, and could send that page somewhere else.


# SW19. The sign-in panel: BitLogin inside a client that keeps the screen (built on `beta`)

Asked for by the owner on 2026-11-21, after trying BitPortal's shell (one
top-level page that shows the room, the Airlock and each world in a frame,
so the screen stays filled from world to world): "Make them a part of our
menu rather than an escape and click situation", and then: "Keep all of it
in app and not in a separate window. I want all of bitportal to feel like
one cohesive experience." The owner confirmed in this repository's session
that day: "Yes that's what I want. In world as seamless as possible."

Opening a window gives up a filled screen, so every new world used to cost
the visitor the screen, a second window and the screen again. The panel is
the window's own page, drawn by the client where the world's menu is.

## SW19.1 What it is

- **The same page.** `/connect/panel/` is made from `/connect/index.html`
  at build time (`packages/demo/build.mjs`), so the panel and the window can
  never say different things. Only the paths and the headers differ. The
  page knows which it is by its own address.
- **Shown by a listed client, never by a world.** `PANEL_CLIENTS` in
  `embedded/panel.ts` is the list, by exact origin: today
  `https://portal.bitblocks.network`. The panel's `frame-ancestors` is that
  list and nothing else, and a test pins the two together. `/connect/`
  itself stays `frame-ancestors 'none'`.
- **It finds the world's signer the way the window does** (§SW3), in the
  client's frames and in theirs, two levels deep, never deeper. The signer
  reports which site embeds it, as the browser told it. The client says
  which world the panel is for, and the panel takes only a signer that
  reports that world. With none, it offers no Allow.
- **The embedded signer is unchanged.** The panel is a page of BitLogin's
  own origin, as the window is, and everything after "found" is the
  window's: the question, the account chooser, the lock, the hand-off
  (§SW4), the remembered grant (§SW11), more permissions (§SW9.3a).

## SW19.2 What the panel and its client say

Messages are `{ bitlogin: "bitlogin-panel", v: 1, t, ... }`. They carry
nothing about the visitor: no key, no name, no account, no public key.

| From | `t` | Fields | Meaning |
|---|---|---|---|
| client | `hello` | `world?`, `mode?` | Which world asked, and what for: `"ask"` (the default when `world` is given), `"switch"` (the account chooser), `"account"` (the account pages; the default without `world`). Sent again every few hundred milliseconds until `ready`. |
| panel | `ready` | | It heard a listed client. Nothing is said to any page before this. |
| panel | `size` | `size: "menu" \| "tall"`, `height?` | The size it would like: the menu's, or taller for sign-in and the account pages; and how tall its content is, in CSS pixels. Sent again when that changes. The client decides, and clamps both. |
| panel | `close` | `allowed: boolean` | Done; the client removes the frame. Whether the world was allowed. The world learns the rest from its own signer. |

- The panel listens only to `window.parent`, and only where the browser
  says the message came from a listed client (`panelClientAllowed`). A
  local copy of BitLogin answers only a local client, and the real address
  never answers a local page.
- The client frames `https://bitlogin.network/connect/panel/` (with the
  trailing slash: without it the window's headers apply, and framing is
  refused), with `allow="publickey-credentials-get https://bitlogin.network;
  publickey-credentials-create https://bitlogin.network"`. One panel load
  per question: for the next, the client loads it again.

## SW19.3 Signing in, in the panel

Everything is in the panel, by the owner's choice, including a typed
password. The panel's own headers allow passkeys
(`publickey-credentials-get=(self), publickey-credentials-create=(self)`).

- **Storage.** The panel is a frame of BitLogin's origin under the client's
  site, so a browser gives it storage of its own, apart from what
  bitlogin.network keeps when visited directly. Someone signed in at
  bitlogin.network is not signed in in the panel: they sign in once there,
  and the panel remembers them for that client, as the sign-in address
  does. The signer frames inside the client's worlds are under the same
  site, as before.
- **A passkey works in the frame** where the browser allows it and the
  client delegates it: tested in Chromium with a virtual authenticator
  (creating a passkey account in the panel's frame; signing in again with it there is not yet tested). Not yet tried: Brave, Firefox,
  Safari, and real platform passkeys.
- **A browser that clears a framed page's storage when the client's last
  tab closes** (Brave does this for third-party storage) signs the visitor
  out of the panel each time. With a passkey that is one press. Not yet
  measured.

## SW19.4 Everything else, in the panel

"Account and more" opens the whole widget, as the account page has it:
switching and adding accounts, the lock, changing the password, the
recovery phrase, the key, the recovery file, the relays' health, and the
vault of connections. A client may open the panel for this alone
(`mode: "account"`). Everyday steps are up front; this is behind the one
button.

## SW19.5 What it costs: the threat model

- **There is no address bar.** The window's defence against a look-alike
  is the address bar (§SW3). A panel has none, and a filled screen shows
  none anyway. A hostile world can draw a copy of the panel inside its own
  frame, whatever BitLogin does, and ask for a password or a recovery
  phrase. What still tells them apart: a passkey, which can't be phished; a
  password manager, which fills only at BitLogin's own origin; and
  BitLogin's passwords being generated (§9.2), so they live in a manager.
  The panel says this where a password is typed ("A world can draw a copy
  of this panel… if your password manager offers nothing, stop"), and
  where the recovery phrase and key are shown. A recovery phrase typed into
  a copy has no such protection. That is the risk the owner accepted.
- **The client is trusted with the panel.** A page that frames the panel
  can cover it, shrink it or slide it under a press. That is why only a
  listed client may frame it, and never a world: the client is a top-level
  page the world inside it can't script. A client that is compromised could
  do to the panel what a hostile site could do to any framed page. It still
  can't read the panel, the key or the session: those are BitLogin's
  origin's, and the browser keeps them apart.
- **A press too soon is ignored,** as in the window: Allow does nothing for
  900 ms after the question appears.
- **The client learns only that the panel closed, and whether the world was
  allowed.** It hears nothing a world couldn't learn from its own signer.

## SW19.6 Not built yet, and not yet tried

- **Tried:** Chromium, Firefox and WebKit as Playwright ships them, with a
  password account made in the panel (sign-up, Allow, the world signs, and
  the panel still knows them after the client's page is loaded again); and
  Chromium with a virtual passkey. **Not tried:** Brave, Safari on a real
  device, a real platform passkey or password manager in the frame, and
  signing in again with an existing passkey in the frame.
- **Phones and headsets,** where BitPortal does not yet use the shell: the
  world opens the window as before. A world framing the panel itself would
  mean listing world origins, and the clickjacking question again: a
  separate decision.
- **Ecash (NIP-60)** is `docs/ecash.md`.

## SW19.7 The private key, in the panel

In the panel's account pages the widget is given `fresh-secrets`: "Reveal
private key" works only within five minutes of a proof of who is there (a
sign-in, or the lock opened with its PIN or the device). A session taken up
from what the browser kept, or a switch between kept accounts, is not
proof. Otherwise the widget says so and offers to sign out, so someone who
finds the panel open cannot read the key off it. The account page at the
sign-in address is unchanged. The recovery phrase is shown only while an
account is being made, as everywhere.

# SW20. Asking the person: careful kinds, and a wallet (built on `beta`)

A site the user allowed can have a note and a reaction signed without
asking (§SW5). Two more things can now be **put to the person, each time,
on a page of BitLogin's own**: the panel where a client shows it, the
window otherwise. Nothing here is ever done without a press on that page.

| The site sends its signer | The signer answers at once | And later, under the same `id` |
|---|---|---|
| `{ t: "propose", id, event }`: a profile (kind 0), a deletion (5) or a relay list (10002) | `{ t: "asking", id }` | `{ t: "signed", id, event }`, or `refused` |
| `{ t: "wallet", id }` | `{ t: "asking", id }` | `{ t: "wallet", id, uri }`, or `refused` |
| `{ t: "pay", id, invoice }`: a Lightning invoice, paid from the person's own ecash wallet (`docs/ecash.md`) | `{ t: "asking", id }` | `{ t: "paid", id, preimage? }`, or `refused` |

On `asking`, the site has BitLogin's page shown: it asks its client for the
panel (`hello` with its `world`, §SW19.2), or opens `/connect/`. The page
finds the signer as always, is told what is waiting and which account the
site is signed in as, shows it, and brings back the answer.

- **Only for a site already allowed.** An application the user approved
  may ask too (BitPortal's own room is one): asking widens nothing it may
  do on its own say, because every answer is a press on BitLogin's page.
  Not a wallet: an application asks for one through the widget, at its own
  address. Anything else answers `refused`.
- **One question at a time,** dropped after five minutes; a new one ends
  the one before. Two a minute and ten an hour for each kind of question.
- **The embedded signer signs none of it.** Its session still signs a note
  and a reaction and nothing else: the worker's floor (§SW4) is unchanged.
  A careful kind is signed by the session of BitLogin's own page, after the
  press, and passed back through the signer, which hands it to the site
  only if it is exactly what was put to the person: signed by the account
  the site is signed in as, the same kind, words and tags, and timed now.
- **Marked with the site,** like everything signed for one
  (`["nswp:world", origin]`).
- **Not a follow list** (kind 3): a whole list signed for a site could
  unfollow everyone; following is one person at a time (§SW16b). Not a
  never-kind. Not anything unnamed.
- **From an application, through the client** (`bitlogin-client.js`):
  `client.propose(event, { show? })` and `client.pay(invoice, { show? })`.
  The client sends the request and, on `asking`, has BitLogin's page shown:
  `show()` is called once, and returns true where the host showed it itself
  (its shell's panel); otherwise the client opens the window. It resolves
  with the signed event, checked to be what was asked, or the proof of
  payment; or null.
- **A profile is shown as what would change,** against the newest profile
  relays hold: each field changed, added or removed, with what it was, and
  how many stay as they are. Where the current one can't be read in five
  seconds, the whole new profile is shown, and a line says so.
- **Said in words** (`embedded/careful.ts`): a profile field by field, with
  "this replaces your whole profile" and a word about the lightning
  address; a deletion's notes, and that it can't be undone and reaches
  beyond this world; a relay list's relays, and what a wrong one costs.
- **The same account.** If the page is signed in as another account than
  the site, nothing is shown and the site hears `refused`.

**A wallet** is the widget's own wallet step (`nwc-connections.md`,
`vault-ux.md`), in reveal mode, said plainly: the site receives the
connection and can spend within the budget the wallet enforces.

- **Bitcoin Connect first, a pasted NWC connection second,** as the widget
  has always offered. A connection already made for this site is offered
  with one press.
- **Bound to the site's address,** the one shown on the page. The worker
  takes a named site (`site` on `vaultSaveNwc`, `vaultFindForOrigin`,
  `vaultRevealNwc`) only where it runs at one of BitLogin's own sign-in
  addresses (`SIGN_IN_ADDRESSES`, or a local copy). In a vendored copy at
  an application's address a named site is refused, as before: a host can
  never be handed a wallet the user connected to another site.
- **Bitcoin Connect may open a wallet's own page** to approve the
  connection. That is the wallet's doing and leaves a filled screen;
  pasting a connection does not.
- **The site's kit has to use what it is given.** That, and the name of
  these two requests in NSWP-10, are the NSWP session's.
