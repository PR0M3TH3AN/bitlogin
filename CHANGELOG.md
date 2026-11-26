# Changelog

Tracks changes to `@bitlogin/core` and `@bitlogin/widget` that matter to a
site with its own vendored copy (see "Updating your integration" in
`README.md`). Not every commit needs an entry — only ones where a site
sitting on an older vendored copy is missing a fix or behavior change it
would plausibly want. Newest first.

## 2026-11-26

- **`client.signInFromPhone()` returns `{ opened, done }`** in place of a
  promise (the kit's own shape): `opened` is false where the browser
  refused the window, so a site can offer its own press, and `done`
  settles once the window closes, true if signed in. The window is now
  opened in the press itself, before anything is waited on.

## 2026-11-25

- **Signing in a headset from your phone is back, on BitLogin's own page**
  (`docs/pair-a-headset.md`, Way 1): a world opens `<signIn>/headset/` in a
  window from a press (or calls `client.signInFromPhone()`), and the code,
  QR and number appear only there. In-world `pair` stays paused.

- **Signing in a headset from your phone is paused** the same day it was
  released: a world draws the code and the number a headset shows, so a
  hostile one could have them answered for its own headset. A headset's
  `pair` is answered `pairing-expired` with `why: "paused"` at once, and
  `client.pair()` resolves false.

- **A headset is signed in from the person's phone** (`docs/pair-a-headset.md`):
  a world sends `pair` to its signer frame and shows the code and a QR of
  `/pair/#CODE`; the phone, signed in to BitLogin, finds it, has the person
  tap the number the headset shows, and sends what Allow sends. Nothing is
  typed in the headset. An application uses `client.pair(onCode)`. The
  phone's list of sites signs one headset out alone.

## 2026-11-22

- **A world's owner can change its guest list and block list** from inside
  the world (`docs/guest-lists.md`): a world sends `guests` with one
  change; BitLogin asks the owner in words every time, checks they keep the
  world by its own manifest, and builds and signs the new list itself.

## 2026-11-21, later still (released on `main` 2026-11-21)

- The paying screens don't wait on the slowest relay; a listing lasting an
  hour says "an hour".
- **A price shared between several people** (`docs/paying.md` PY14) is
  built and switched off. Until it is switched on, a listing carrying
  `nswp:share` is not shown for sale.

## 2026-11-21, later (on `main`, with buying closed there)

- **Tips, purchases and receipts** (`docs/paying.md`), on BitLogin's own
  sign-in page and panel. A site may ask its signer for `tip` (a person or
  itself, and an amount), `buy` (a BitUnlock listing, by coordinate) and
  `have` (answered with no question, for the site's own listings only).
  BitLogin finds the lightning address, runs the purchase as the buyer,
  keeps the receipt with the account, and hands the site the receipt.
  `client.tip`, `client.buy` and `client.have` do the same for an
  application. Experimental: not tried against BitUnlock or real money.
- **A limit on a payment that leaves no receipt:** `pay` and `tip` are
  refused above 1,000 sats in one payment unless the person raised the
  limit in their wallet. **A site that relied on `pay` for more than
  1,000 sats will now hear `refused`.** The page for `pay` says that
  nothing will be recorded as the person's.
- The panel takes `mode: "library"`: what the person has bought.
- The limit is one of four steps (1,000, 10,000, 100,000, none) and is
  kept with the account. A tip carries a note to the person tipped where
  their lightning address takes one. A listing for something in a world
  priced under 500 sats is not shown for sale.

## 2026-11-21 (on `main`)

- **The sign-in panel** (`docs/sign-in-window.md` §SW19):
  `/connect/panel/`, the sign-in window's own page, shown in a frame by a
  client BitLogin lists (BitPortal's shell) where the world's menu is, so a
  visitor never leaves the world. Sign-in (passkey or password), Allow, the
  account chooser, the lock and every account page are in it. Only
  `https://portal.bitblocks.network` may frame it. Nothing changes for a
  site that opens the window.
- **The ecash wallet and the file browser are marked "Experimental"** in
  the interface, on the way in and on every one of their screens.
- **A person's files, on Blossom servers** (`docs/files.md`), on
  BitLogin's own sign-in page and panel: a file browser with folders,
  move, copy, rename and delete; public files, and private ones sealed
  before upload; servers people use, marked free or paid; a server that
  charges paid from the ecash wallet up to a limit the person sets.
  Experimental: not tried against a real server.
- **A site can offer a file to be saved, or ask for one** (`file-save`,
  `file-pick`): the person's file browser is shown, and the site sees
  nothing of what they keep.
- **An ecash wallet kept with the account** (NIP-60; `docs/ecash.md`), on
  BitLogin's own sign-in page and panel. Add sats by Lightning, receive a
  Cashu token, pay an invoice. Kept in the browser first and then on the
  account's relays, sealed to its key. Mints people recommend (NIP-87) are
  listed to choose from. Experimental: not tried with real money.
- **A site can ask to be paid** (`pay`, with a Lightning invoice): the
  person's own wallet pays it on a press, and the site hears `paid`. It
  never sees a token.
- **`/connect/` pages may reach https addresses** (a mint). No other page.
- **New dependency:** `@cashu/cashu-ts` 4.13.1, in `bitlogin-ecash.js`
  only. A site that vendors the widget does not need that file.
- **`propose` and `pay` on the client** (`bitlogin-client.js`), for an
  application: `client.propose(event, { show? })`,
  `client.pay(invoice, { show? })`. An approved application may ask what a
  world may, except a wallet.
- **A proposed profile is shown as what would change,** against the one
  relays hold now.
- **A site can put a careful kind to the person** (§SW20): `propose`, for
  a profile, a deletion or a relay list. Answered `asking`, shown in words
  on BitLogin's own page (the panel or the window), signed there on a
  press, and handed back as `signed`. The embedded signer's own session
  still signs a note and a reaction only.
- **A site can ask for a wallet** (§SW20): `wallet`. The widget's wallet
  step on BitLogin's own page, Bitcoin Connect first and a pasted NWC
  connection second, bound to the site's address.
  `requestNwcConnection({ forSite })` exists for that page alone: the
  worker refuses a named site anywhere but BitLogin's sign-in addresses.
- **`fresh-secrets` on `<bitlogin-auth>`:** "Reveal private key" then
  works only within five minutes of a sign-in or of the lock being opened.
  BitLogin's panel sets it. Without the attribute nothing changes.
- **A local copy's panel accepts a client on a private network address**
  (10.x, 172.16-31.x, 192.168.x), where it is served from one itself.
- **The window's sign-in widget uses the relays its page names,** where it
  names any. It used BitLogin's built-in list whatever the page said.

## 2026-11-20 (on `beta` only)

- **Words for kind 37308** in the window, a visitor's bag: "change what is
  in your bag: the items you carry between worlds". And for a score
  (37306) and an achievement (37307), should an application ask to sign
  them.
- **A world can have an achievement its visitor holds signed** (NSWP-16;
  `docs/sign-in-window.md` §SW16e): `achieve` with a world's coordinate,
  the achievement's name and its title. Built and marked by the signer, as
  a score is.
- **`score` takes an optional `title` and `format`** (NSWP kit 0.46.0), and
  writes them into the note.
- **A world can have its visitor's score signed** (NSWP-15;
  `docs/sign-in-window.md` §SW16d): `score` with a world's coordinate, a
  board and a number. The signer builds the kind 37306 note and marks it
  with the site that asked. For any site the user allowed; six a minute
  and sixty an hour.
- **`scripts/vendor.mjs`: one way to vendor BitLogin into any site.** It
  builds from a clean checkout, copies the files a site needs (all of them,
  or `--set widget`), removes only BitLogin's own stale files, and writes
  the integrity record the sites already check; `--check` verifies a folder
  without changing it. README, "Updating your integration".
- **The import screen leads with the fresh-account choice.** On a phone,
  "Create a fresh account instead" was five paragraphs down. It now comes
  first, with the full warning right beneath it, unchanged.
- **Importing a key says plainly where the key will be kept** (`docs/spec.md`
  §28.1). The import screen now states that an encrypted copy is published
  to public relays, that anyone can download it, that it can't be taken
  back, and that a Nostr key can't be changed. It recommends a fresh
  account or a signer that never stores the key, and the user must tick
  that they understand before going on. A site that drives the widget's
  import flow in its own tests needs to tick `#import-ack-check`.
- **A world can keep saves with its visitor's account** (NSWP-12;
  `docs/sign-in-window.md` §SW16a). The embedded signer answers `save`,
  `find` and `open` for a site that declared nothing. A save is an
  encrypted note of kind 37304 that names no world, and is opened only for
  the world it is from. Six a minute and sixty an hour for one world. No
  application may sign or read kind 37304.
- **A world can be let follow and unfollow people** (NSWP-14; §SW16b). It
  asks with `want` and `more: ["follows"]`; the window asks the user, with
  two buttons; `state` then carries `more`. `follow` hands over the
  user's newest follow list and one change. BitLogin checks the list is
  theirs and looks at their relays itself before it signs. Never with a
  family grant, never for an application.
- **A world can be let send and read private messages** (NSWP-14; §SW16c):
  `want` with `more` naming `messages`, then `seal`, `unwrap` and `reach`.
  The largest thing a world can be let do, and the window says so. One
  site at a time, never a family or an application, and asked again after
  seven days.
- **`state` carries `offers`** for a world: the names it can ask to be let
  do (`["follows", "messages"]`), said locked or unlocked.
- **`FoundSigner.more` and `.has`, and a fifth argument to `grant`**
  (`withMore`), for a site that draws its own sign-in window. `more` is
  what is newly asked; `has` is what the site already held, kept either
  way.
- **A follow list of more than 2,500 people can be signed** by an
  application that may sign kind 3: up to 20,000 tags for that kind.
- **Words for kind 37305** in the window: "rate worlds, from one to five
  stars".

## 2026-11-19 (later, on `beta` only)

- **A site that asks for more than it may have is told so, and so is the
  user** (`docs/sign-in-window.md` §SW9.3a). The window's plain question
  now carries a line saying more was asked and will not be given. The
  answer to `want` carries `taken`; `createBitLoginClient` gives it as
  `state().canAsk`.
- **At a local copy of BitLogin, a local site may hold the reserved
  kinds** (27300, 27302, 27303), so an application that uses them can be
  tried before it is live. The window says so. BitLogin's real address is
  unchanged.
- **A recovery phrase typed with a capital letter is accepted.** It was
  refused as "not a valid phrase", and a phone capitalises the first word
  of a field. Every word in the list is in small letters, so no account
  was ever made from a capitalised phrase and none changes.
- **"Restore from an export file"** under "More sign-in options": either
  file that Export identity makes is read and taken to the step that uses
  it. The recovery export (`.json`) goes to the recovery phrase with the
  file already loaded; the key file (`.txt`) goes to "Import a Nostr key"
  with the key already checked. Before, the recovery export could only be
  given as an optional extra under "Recover account", and the key file
  could not be loaded at all.
- **Five things for applications that sign through the window**
  (`docs/sign-in-window.md` §SW9.4 to §SW9.6), after the BitPortal session
  moved its sign-in to it:
  - `decryptEvent` on the user's own event that carries a `p` tag now also
    tries the user's own key. A saved note with a `p` tag was unreadable.
  - The reserved kinds (27300, 27302, 27303) are counted at the sensitive
    rate, 30 a minute and 300 an hour, where they were 60 and 1,200.
  - The embedded signer's page loads itself again, once, if one of its
    files fails to arrive (a page caught in the middle of a deploy).
  - A world grant (kind 27303) keeps its one `nswp:world` tag, which names
    the world the grant is for. It was taken off, so the grant could not
    be signed through the window. Every other kind is as before.
  - Written down, not changed: a tag named `nswp:world` or `bitlogin:site`
    is taken off what an application sends; and a `created_at` more than
    ten minutes off is replaced, so read it from the event that comes back.
- **Several accounts can be kept signed in on one device, and switched
  between with one press** (`docs/account-switching.md`, "What is built").
  Signing in as another account no longer signs the first one out. The
  signed-in view has "Switch account"; the welcome screen offers "Continue
  as"; the sign-in window has a chooser, and asks which account when more
  than one is kept and a site asks for the first time.
- **Log out now forgets only the account that is signed in.** Other
  accounts kept on the device stay, and so does the lock they are under.
- **New for a site:** `switchAccount()` on `createBitLoginClient` opens
  the window at its chooser (`/connect/#switch`). The site never sees the
  list of accounts.
- **New on the headless signer:** `accounts()`, `switchAccount(pubkey)`,
  `addAccount()`. New on `<bitlogin-auth>`: `switchAccount(pubkey)`.
- **For a site with its own vendored copy:** new storage keys
  `bitlogin:kept-session:v1:<pubkey>` and `bitlogin:kept-accounts:v1`,
  beside the session the widget already kept. Nothing is migrated: an
  account is kept from its next sign-in or page load.
- **The widget's signed-in view shows who is signed in:** a picture, the
  name from the account's own signed profile, the line about them and the
  whole npub, where it showed the key alone. So does the sites page. For a
  BitLogin account only: an extension or remote-signer session still shows
  the key. **For a site with its own vendored copy:** the worker asks up
  to eight relays for the profile once per sign-in, and the picture is
  fetched from its https address. A page whose policy forbids remote
  images (`img-src`) shows a letter in its place; nothing breaks.
- **The Allow screen shows who you are signing in as, and the buttons
  come first** (asked for by the owner after the window signed them in to
  a world as an account they did not mean). Under the site's address: the
  name and picture from the account's own signed profile, the whole npub,
  the line about them, and "Use a different account". Then Allow and
  Don't allow, on screen without scrolling. What it allows is listed below.
- **"Use a different account"** signs this browser out of BitLogin as the
  account shown (and removes the lock, if one is on) and offers the
  ordinary sign-in. Sites already allowed as the first account stay
  allowed as it.
- **A deployment must change one header:** `img-src` gains `https:` on the
  sign-in address's pages, so a profile picture can be fetched. The
  embedded signer's page is unchanged: it fetches no pictures.
- **An application is never handed the profile.** The window now reads it
  for every site, to show the user; the worker leaves it out of an
  application's hand-off.
- **Words on the Allow screen for two kinds:** 30004 ("change your lists
  of worlds") and 37300 ("announce a world as yours").
- **One Allow can cover every site under one domain
  (`docs/site-family.md`).** At the second site of a family the sign-in
  window offers "Allow every example.com site" beside "Just this one".
  After that, any site under that domain is signed in with nothing
  pressed, for notes, reactions and room passes. An application's own
  permissions still need its own Allow. Never offered on shared hosting
  names (`x.vercel.app`, `alice.github.io`).
- **New files to deploy with the sign-in window and signer:** one more
  `bitlogin-shared-*.js` chunk, holding the Public Suffix List (45 KB
  compressed). A site that vendors only `bitlogin.js` and the worker is
  not affected.
- **New on the headless signer:** `exportHandoff()` takes a family;
  `restoreSignerGrant()` takes the site's family. `FoundSigner` gains
  `family` and `knownFamily`, and `grant()` a fourth argument.
- **The take-back record may list a family** (`https://*.example.com`). An
  older signer ignores such an entry; it holds no family grants.
- **The name a site is told is the one a person shows** (§SW16): their
  profile's `display_name`, then `displayName`, then `name`, the order
  BitPortal and other Nostr clients use. It was `name` first. A room pass
  made from a sign-in after this carries the new name.

## 2026-11-19

**A site can be taken back from one place (`docs/take-back.md`).** For
sites that sign in through the window.

- **"Take it back" and "Sign out of every site" at `/sites/`** publish a
  record, sealed to the user's own key, on their relays. Every embedded
  signer asks for it on its first page load after Allow and then once a
  day, and forgets its site if the record says so. It is not instant.
- **A deployment must change one header:** the embedded signer's page
  needs `connect-src 'self' wss:` where it had `connect-src 'self'`.
  Without it the check cannot run, and a remembered site locks after three
  days.
- **A grant kept more than three days without a check that succeeded is
  locked** until a relay answers.
- **New on the headless signer:** `takeBack()`, `checkTakenBack()`;
  `loadProfile()` takes `{ profile: false }` and also reads the user's
  relay list (kind 10002). `startEmbeddedSigner()` takes relay options.

**An optional lock (`docs/spec.md` §21.5, `docs/sign-in-window.md` §SW12).**
Off unless the user turns it on, from the account screen.

- **A PIN, and optionally the device's own unlock.** With it on, what the
  browser keeps is sealed a second time, and the widget shows an unlock
  screen on each page load and after fifteen minutes unused. Five wrong
  tries sign the browser out.
- **"Lock now"** on the account screen.
- **For a host page:** locking fires `bitlogin-logout` and unlocking fires
  `bitlogin-login`, as signing out and in do. Nothing changes for a user
  who never turns it on.
- **While it is on, no asking site is remembered:** each is allowed for
  one visit.
- **New on the headless signer:** `lockStatus()`, `lockOpen()`. `restore()`
  resolves null while locked.

**A world is held tighter, and an unknown site is remembered for a week
where it was a month (`docs/sign-in-window.md` §SW11, §SW18).** For sites that sign in
through the window.

- **Three signatures a minute and twenty an hour** for a site that
  declared no permissions, where it was six and sixty. NSWP's kit 0.28.0
  uses the same numbers. An application's own limits (§SW9.6) are as they
  were.
- **A site is remembered unless the user unticks it in the window:**
  thirty days for a site BitLogin knows, seven for any other (it was
  thirty for all). Unticked, it is allowed for the visit and asks again
  when its page is next loaded. `state` says `remembered: true` or
  `false`.
- **A room pass is counted apart from notes:** two a minute and ten an
  hour.
- **A page at the sign-in address, `/sites/`,** lists the sites allowed
  from this browser. It cannot switch one off: a browser does not let it.
- **`exportHandoff()` takes a fourth argument,** whether "remember" was
  left ticked; `FoundSigner.grant()` a third, the same; `FoundSigner.known`
  says whether BitLogin knows the address.

**A world can know its visitor by name (`docs/sign-in-window.md` §SW16).**
For a site that signs in through the window and declared no permissions.

- **`state` carries `name`, `picture` and `about`,** from the person's own
  signed profile. BitLogin's worker fetches and checks it at the sign-in
  address and seals it into the hand-off; the site never supplies it.
- **New request `{ t: "pass", id, session }`.** The reply is NSWP's room
  pass (kind 27300) for the asking site, four hours long, naming that
  session key. The site sends a session public key and nothing else.
- **`sign` still refuses kind 27300.**
- **New on the headless signer:** `loadProfile()`, `roomPass()`, and a
  third argument to `exportHandoff()`: the site the hand-off is for.
- **A site allowed before this build** keeps working, with no picture and
  no profile name until the user is next asked there: its kept grant holds
  no profile.

**The browser can save a new password (`docs/TODO.md` item 11).** The
generated password was shown as text only, so a browser or password manager
had nothing to save from at sign-up, after recovery, or after a rotation,
except in Chromium, which was asked outright.

- **Sign-up, recovery and rotation are real forms now:** the login name
  marked `username`, and the generated password in a field of type
  `password` marked `new-password`. Rotation also keeps the old password
  marked `current-password`, the shape a browser reads as a changed
  password.
- **The field cannot differ from the account's password.** It is put back
  if it is typed in or filled by a password manager's own suggestion.
- **Nothing for an integrator to change.** The saved login belongs to the
  address the form is on: the application's, where the widget is embedded;
  BitLogin's, in the sign-in window.
- **Not verified:** the browsers' own prompts. The forms are checked in
  three engines; whether each browser then offers to save and fill has to
  be looked at by a person.

**The embedded signer remembers a site (`docs/sign-in-window.md` §SW11).**
It held the handed-over key in memory, so every load of the asking site's
page began locked and the window had to be opened again.

- **A site the user allowed stays allowed** for thirty days on that device,
  or until they sign out of it there. Loading the page again asks nothing.
- **What is kept** is a grant for that one site: the key, encrypted at rest
  like the session cache, under names of its own. What is taken up from it
  can only sign.
- **The count is kept with it,** so loading the page again is not a way
  round six a minute and sixty an hour.
- **New on the headless signer:** `keepSignerGrant()`,
  `restoreSignerGrant()`, `touchSignerGrant()`, `forgetSignerGrant()`. Only
  the embedded signer's page has a use for them.
- **A limit to know:** the sign-in address cannot list or take back what
  was kept inside other sites. A grant ends at the site, at its date, or
  with the browser's data.

**The sign-in window and the embedded signer, on BitLogin's own site
(`docs/sign-in-window.md`).** A site no longer has to embed the widget, and
so see the password, to have something signed.

- **Two new pages on the site:** `/signer/`, which other sites embed
  unseen, and `/connect/`, the window a site opens. The password is typed
  on BitLogin's own page, in that window. The site is handed a signer it
  can ask, and never a key.
- **Two new files in the widget build:** `bitlogin-signer.js`
  (`startEmbeddedSigner()`, the whole of the signer's page) and
  `bitlogin-window.js` (`findEmbeddedSigner()`, for the window's page).
  A deployment that serves its own sign-in address ships both.
- **What the signer signs for a site:** a note and a reaction, once the
  user has allowed that site. Everything else is refused, without saying
  why. Six a minute, sixty an hour, four hours at most.
- **Headers changed for those two pages only** (`vercel.json`): the signer
  may be framed by an https site, and the window keeps its link to the page
  that opened it (no `Cross-Origin-Opener-Policy`). Every other page is as
  it was, and the policy tests pin all three sets.
- **Nothing changes for a site that embeds the widget today.**
- **Not built:** permissions an application declares (a note and a
  reaction are not enough for an app), and a passkey added to an existing
  account.

**A signer hand-off, for a sign-in window (`docs/sign-in-window.md`).** A
site that embeds the widget can read the password as it is typed. The way
out is for the password to be typed at one address the user trusts, and for
other sites to ask a hidden signer of that address. This is the piece of
that which belongs here.

- **The headless signer can hand its key to another of itself on the same
  origin:** `beginHandoff()` and `acceptHandoff()` on the receiving side,
  `exportHandoff()` on the sending side, `isSignerOnly()`. The everyday key
  moves worker to worker, sealed between two throwaway keys; the pages
  carry a public key and ciphertext.
- **What arrives is a session that can only sign.** `getPublicKey` and
  `signEvent` work. Decrypting, encrypting, exporting the key, the vault and
  every account action are refused, and nothing is cached. `getSessionStatus`
  says `signerOnly`.
- **Nothing existing changes.** No wire format, no stored format, no header.
  A site that never calls these is unaffected.
- **Not here, at first:** the sign-in window page and the per-site
  permission list. They followed the same day: see the entry above.

## 2026-11-19 (on `beta` only; not yet on `main`)

- **An application can sign in through the sign-in window and then act in
  the background.** It declares a permission set; the user sees all of it
  once, in the window; after Allow it signs those kinds with no prompt for
  thirty days or until the user signs out of it. New file to vendor:
  `bitlogin-client.js` (`createBitLoginClient`). See
  `docs/sign-in-window.md` §SW8 and §SW9.
- **What an application may and may not have.** Never: wallet and
  remote-signer traffic, NSWP passes and grants, BitLogin's own data. A
  web-request proof is signed only for the application's own origin or one
  it declared. Reading is tied to a signed event of a kind it declared, so
  approval to read one kind is not approval to read another; raw decrypting
  against the user's own key is not offered.
- **Changed for integrators already on the window (worlds):** nothing. A
  site that declares no permissions gets a note and a reaction, as before.
- **A beta channel.** Work lands on the `beta` branch and
  `https://bitlogin-beta.vercel.app/` before production
  (`CONTRIBUTING.md`, "Release channels").

## 2026-11-18

**Relay list (later the same day).** A probe of the eight built-in storage
relays found only about half dependable: two never connect, one connects
about one time in eight, one refuses capsule keys under a web-of-trust rule,
and one acknowledges capsules and then drops half within minutes.

- **A signed, updatable relay list (spec §19.1) is now wired in, switched
  off.** The widget remembers the last signed list it accepted, applies it at
  start, and looks for a newer one in the background. It stays off until a
  maintainer public key is pinned in `packages/core/src/nostr/bootstrap.ts`;
  until then nothing is fetched. A host page that configures its own relays
  is never extended by it. A signed list can add at most one fewer relay than
  the widget pins, so it can never form a read quorum by itself, and a list
  cannot be rolled back to an older version.
- **Five storage relays added, none removed.** `nostr.mom`,
  `relay.nostr.net`, `nostr-01.yakihonne.com`, `relay.nostr.wirednet.jp` and
  `nostr.sathoarder.com` join the built-in list, and `nos.lol` joins the
  lookup list. A live sign-up now lands on 10 of 13 relays, where it landed
  on 3 to 5 of 8 before. Existing accounts are still looked for on every
  relay they were ever written to. Sign-in opens more connections than it
  did.
- **Capsules store at most four relay hints.** They used to store the whole
  relay list, twice, in a fixed-size payload that had only a few dozen bytes
  to spare. Growing the list to thirteen made registration fail outright;
  this was caught by a live run, not by the test suite, which now registers
  against the largest relay list a client can have. Older widgets read the
  shorter hints without change.
- **`scripts/relay-probe.mjs`** tests relays the way BitLogin uses them
  (capsule-shaped events from throwaway keys, read back now and later) and
  can take candidates from NIP-66 monitors. **`scripts/sign-relay-list.mjs`**
  signs and publishes the list.

Spec v0.7. Prompted by a real loss: every relay dropped one account's
capsules, and neither the password nor the recovery phrase could bring the
identity back.

- **New accounts derive their identity key from the recovery phrase.**
  Previously the key was random and the phrase only located a capsule on a
  relay. Now the phrase alone rebuilds the identity when no relay holds
  anything (spec §11.6). This applies to accounts created from this version
  on; existing accounts keep the key they have, and nothing about how they
  sign in changes. The derivation is a frozen contract, pinned in
  `knownAnswer.test.ts`.
- **Rebuild from phrase.** When "Recover account" finds no account on the
  relays, the widget shows the identity the phrase derives and, once the user
  confirms the npub is theirs, republishes a recovery capsule and continues
  to "set a new login" (spec §17.6). Saved wallet connections are not
  rebuilt. For an imported key or an older account the identity shown is not
  theirs, and the screen says so. In core: `previewPhraseRebuild` and
  `rebuildAccountFromPhrase`.
- **Imported keys are told they are different.** An imported `nsec` is not in
  the phrase. After the phrase quiz, an imported-key sign-up shows the key
  with copy and download buttons and grants the session only once the user
  ticks that it is saved. **Integration-visible:** for imported keys only,
  `bitlogin-login` fires one screen later than before.
- **Capsules record where the key came from.** A new optional
  `protocol.everyday_derivation` field in both capsule payloads (spec §12.1).
  Older vendored widgets ignore it, and can read and write these accounts as
  before; if one rewrites a capsule the hint is dropped, which only changes
  what the newer widget says about backups. `LoginResult`, `RegisterAccountResult`
  and `RecoveredIdentity` gain `everydayKeyDerived`.
- **Backup health check on the dashboard.** "Check account backup health"
  asks each vault relay for the two capsules this session holds, verifies
  what comes back, and reports how many relays hold each one. "Re-send my
  account to every relay" republishes both signed events, which restores an
  account that relays have dropped as long as one signed-in device still has
  it. It runs only when the user asks. In core:
  `checkReplicaHealth({ relayUrls, credentialEvent, recoveryEvent })`; in the
  worker: a `checkReplicaHealth` action beside the existing `repairReplicas`.
- **The health screen says why a relay lacks a copy.** After a re-send, each
  relay that still lacks a capsule shows its own reply (a refusal reason, a
  connection error, or "accepted it but does not return it"). Relay text is
  flattened, capped at 140 characters and escaped. In core,
  `rebroadcastCapsules` returns a per-relay `relays` array alongside the
  counts; the worker's `repairReplicas` result carries the same array.
- **Sign-in repairs relays on its own.** After each password or passkey
  sign-in the worker re-sends both capsules to every vault relay in the
  background, so relays dropping an account one at a time are topped up
  before the last copy goes. It is skipped when the sign-in showed a rollback
  or relay disagreement, and it does not run on a restored session. Expect a
  short burst of extra relay connections after sign-in.
- **Standing notice for accounts the phrase can't rebuild.** Imported keys,
  and every account created before this version, see a dashboard notice that
  their key is not in the recovery phrase, with a link to Export identity.
- **The revealed private key no longer lingers.** The Export identity screen
  kept a revealed `nsec` in the element until logout; it is now dropped on
  leaving the screen. That screen also gains "Copy" and "Download key file".

## 2026-11-17

- **A release artifact set with an integrity manifest.**
  `npm run release:artifacts` builds the widget and assembles
  `release/bitlogin-widget-v<version>/`: every file a site deploys side by
  side, plus `integrity.json` (version, source commit, and a sha256 and SRI
  hash per file) and `SHA256SUMS.txt`. Vendor that folder and keep the
  hashes, so you can tell whether your copy still matches a known build.
  Nothing about the build or the widget changed, and nothing is published by
  the script.
- **The build is reproducible, and one of the builds in circulation is now
  identified.** Rebuilding from this commit's source gives byte-identical
  files, and `bitlogin.js` (144,005 bytes, sha256 `33b1affe…281b839a`) matches
  what `login.bitblocks.network` serves. A vendored copy with a different
  hash was built from other source.

## 2026-08-04 (security-audit response, same day)

- **External signers are now verified, not trusted.** NIP-07 and NIP-46
  `signEvent` results are checked for a valid signature, the session's
  identity, and field-for-field equality with the requested event; NIP-46
  `auth_url` is surfaced only as a validated https URL with its hostname
  shown. Relay queries enforce `filter.limit` locally, drop replayed
  duplicates, cap buffering, and can no longer be stranded by a relay dying
  mid-query. Passkey PRF fallback assertions are pinned to the
  just-created credential. If your integration relied on an extension
  returning altered events, that now errors — by design.

## 2026-08-04

- **CSP fix every self-hosting site needs: add `'wasm-unsafe-eval'` to
  `script-src`.** Argon2id (hash-wasm) compiles a WASM module in the crypto
  worker; a `script-src 'self'` policy without that keyword blocks
  `WebAssembly.compile` and breaks every password flow. The keyword permits
  WASM compilation only — JS `eval` stays banned. Related: if your service
  worker precaches the widget, fetch with `cache: "reload"` during install —
  an asset revalidating to a 304 keeps its OLD stored headers, and a worker
  script cached with a stale CSP runs under that stale policy (this shipped
  once; see the demo's `sw.js` for the pattern).
- **One login surface, four methods.** Behind a collapsed "More sign-in
  options" menu (password stays primary): NIP-07 extension delegation,
  NIP-46 remote signers (bunker:// paste + a dot-style nostrconnect QR;
  NIP-44 transport only; memory-only sessions), and passkey sign-in
  (WebAuthn PRF derives the account credential under a frozen contract —
  zero site setup). Alternative-method sessions are signer-only: no vault
  (`requestNwcConnection` resolves null), no persistence.
- **Host API additions.** `bitlogin-login` now carries `detail.method` and
  `detail.capabilities` (existing `detail.publicKey` unchanged);
  `window.bitlogin` gains `activeMethod()` / `activeSession()` — use these
  for session state, NOT `isActiveSigner()`, which stays a window.nostr
  ownership check and is deliberately false during NIP-07 sessions.
  `window.nostr` is now an element-routed provider that follows the active
  signer.
- **UI polish.** Screen headers with icon back buttons, right-aligned
  "Forgot password?", icon+description option rows with 56px touch targets.
- New widget dependency bundled in: `qrcode-generator` (QR for
  nostrconnect). File count and deployment layout unchanged.

## 2026-07-30

- **Widget: `requestNwcConnection()` — the Connection Vault authorization
  layer (reveal mode).** Apps ask for a wallet; the widget owns sign-in,
  one-tap approval for an origin-bound connection, or guided import via
  Bitcoin Connect's chooser (lazy chunks — never downloaded unless the flow
  opens) or a pasted URI, stored as an encrypted vault record. Dashboard
  gains a "Wallet connections" management screen (revoke app access vs
  remove-from-BitLogin, honestly distinguished). The vault root now rides
  the encrypted session cache, so restored sessions can use connections
  without re-login; the sudo key is never cached. New deploy note: the
  widget now ships FIVE files (two extra lazy chunks) that must travel
  together, and hosts using the wallet flow need `style-src-attr
  'unsafe-inline'` in their CSP.
- **Widget: `offerNwcConnection()` — offer-to-save for app-obtained
  wallets.** The inverse of `requestNwcConnection`: an app that got an NWC
  URI through its own chooser or paste box can offer the user a portable
  copy. Consent-gated in the widget's own UI, never silent (the write goes
  to the user's account); duplicates by wallet+secret resolve
  `already-saved` with a silent origin-binding refresh and no UI, so apps
  can fire it after every successful connect.
- **Connection Vault protocol layer in `@bitlogin/core`** (`src/vault/`):
  encrypted per-connection records signed by a derived vault identity, the
  finalized §CV6 key hierarchy with pinned test vectors, the NWC credential
  profile (lossless URI parse/export), relay sync with quorum readback and
  per-record rollback detection, and the two-tier model — connectable
  records vs sudo-gated personal records (`connection-vault.md` §18).
- **Capsules gained paired optional fields** `connection_vault_root` and
  `vault_sudo_key` (both or neither; validated). Registration mints them for
  new accounts; `enableConnectionVault` is the phrase-gated, fail-closed,
  idempotent migration for existing accounts. Login, password change, and
  phrase recovery all carry them forward.
  **Integration caveat:** a site on an OLDER vendored widget that performs a
  password change will rebuild the credential capsule WITHOUT these fields,
  stranding connectable records until a phrase ceremony repairs them —
  update vendored copies before enabling the vault for users.

## 2026-07-21

- **Fix: registration/login could fail quorum if a single built-in relay was
  down.** `BUILTIN_VAULT_RELAYS` had only 3 relays and `BUILTIN_DISCOVERY_RELAYS`
  only 2, sharing `relay.nostr.band` between both lists. `publishAndVerify()`
  requires a fixed `minAcks`/`minReadbacks` of 2 regardless of relay count, so
  losing that one relay left zero margin — surfacing as "Registration did not
  reach the required relay acknowledgement and readback quorum." Added
  `nostr.wine` and `relay.snort.social` to the vault list, and
  `nostr-pub.wellorder.net` to discovery. (`681f622`)
  **Re-vendor if:** your site uses the default built-in relay list (i.e. you
  don't pass your own `vault-relays`/`discovery-relays` attributes). If you
  already pass your own relay list, this doesn't affect you.

- **Fix: widget completely unstyled (giant logo, unstyled buttons) under a
  strict `style-src` CSP.** `element.ts` injected its CSS as an inline
  `<style>` tag inside the shadow root on every render. A host with
  `style-src 'self'` and no `'unsafe-inline'` silently drops an inline
  `<style>`'s rules entirely — visible as the brand SVG rendering at its raw
  ~590×119px intrinsic size instead of the intended 20px-tall lockup, with
  every other shadow-DOM element similarly falling back to unstyled browser
  defaults. Switched to building the stylesheet once as a `CSSStyleSheet` and
  assigning it via `adoptedStyleSheets`, which isn't subject to `style-src`.
  (`e8712f9`)
  **Re-vendor if:** your site's CSP sets `style-src` without `'unsafe-inline'`
  (check your CSP header/meta tag). If your `style-src` already includes
  `'unsafe-inline'`, or you have no CSP, this was invisible to you either
  way, but re-vendoring is still a good idea (this fix also drops needless
  per-render CSS reparsing).

- **Feature: NIP-04 support, for drop-in parity with a real NIP-07
  extension.** `window.nostr.nip04` (and the element-scoped
  `nip04Encrypt`/`nip04Decrypt`) didn't exist at all before this — only
  NIP-44 was implemented. A site (or its own legacy DM code path) calling
  `window.nostr.nip04.encrypt(...)` while BitLogin was the active signer got
  `Cannot read properties of undefined` instead of a working call. (`2838402`)
  **Re-vendor if:** your site (or any third-party code running on it) uses
  `window.nostr.nip04` — a real NIP-07 extension always has it, so anything
  written against "whatever `window.nostr` provides" may already assume it's
  there. No attribute/config changes needed; this is purely additive.

## 2026-07-22

- **Feature: sessions persist across a page reload.** Previously every reload
  destroyed the crypto worker, requiring the full login-name + password flow
  again — re-running Argon2id and a relay quorum read on every navigation,
  not just the first sign-in. After a successful register/login/recover/
  changePassword, the everyday private key and active capsule events are now
  cached in IndexedDB; `connectedCallback()` tries to restore that cache
  before ever showing the welcome screen, firing `bitlogin-login` exactly as
  a fresh login would if one is found. Logout clears it. (`9e3787d`)
  **Security note:** this means the decrypted everyday private key now sits
  in the browser's IndexedDB for that origin until logout — the same
  tradeoff every NIP-07 extension and crypto wallet already makes for the
  same "don't ask for the password every navigation" reason, scoped by
  IndexedDB's own per-origin isolation. The recovery phrase and login
  name/password are never cached.
  **Re-vendor if:** you want this — it's the reason to re-vendor this entry.
  No attribute/config or host-integration changes needed; a host page's
  existing `bitlogin-login` listener (see "Embedding BitLogin" below) fires
  the same way whether the sign-in was just typed or silently restored.
