# A World's Guest List and Block List

**Date:** 2026-11-22
**Status:** Built, on `beta` and then `main`. Tried in a browser in
BitLogin's own test, with a pretend world. Not yet tried with a world built
on the NSWP kit asking.

Asked for by the coordinating session on the owner's word (NSWP
`docs/plans/a-world-by-invitation.md`, section 4). The owner decided on
2026-11-21 that an owner's lists may be readable by anyone.

## What a world asks

`{ t: "guests", id, world: "37300:<publisher>:<d>", list: <the newest list
the world found, or null>, change: "allow" | "unallow" | "block" |
"unblock", key: "<64 hex>", none?: true }` → `asking` → `{ t: "signed", id,
event }` or `refused`.

One person, one change. Not for an application. Counted ten a minute and
sixty an hour for one world.

## What BitLogin does

On its own page (the window, or the panel), every time:

1. It reads the asking site's own `/.well-known/nswp.json`, from that
   site's address as the browser gives it. The world named must be one a
   publisher in that file lists, and its entry must be at that address.
   The keepers are the entry's `keepers` (up to four keys), or else the
   publishers that list it. The signed-in account must be one of them.
2. The list handed over must be this account's own list for that world,
   and the one the change belongs to: `allow`/`unallow` change the guest
   list (`user-allow`), `block`/`unblock` the block list (`user-deny`).
3. It asks relays for the newest of this account's lists for that world.
   One newer than what the world handed over means the world's is out of
   date: it says so, and nothing changes.
4. It shows, in words: "Let Ana into home?", "Take Ana off the list for
   home?", "Block Ana from home?", "Unblock Ana in home?", with the
   person's name from their own profile and their whole key, the world's
   address, how many people the list will name, and "Anyone can read this
   list."
5. With no list handed over, starting one must be ticked: "No guest list
   for home was found. Start a new one, naming only Ana." So a relay that
   was down can't wipe a list.
6. On Yes, the worker builds the new list itself (`guestListSign`) and
   signs it. The world's signer frame checks it is exactly the list handed
   over with the one change, by this account, for that world, before
   passing it on (`isListAsked`). The world sends it to relays.

A keeper can't put themselves on or take themselves off their own lists.

## The list

BitGate's shape (`docs/governance-lists.md` in PR0M3TH3AN/bitgate): kind
30078, `d` = `nswp:governance:<scope>:v1:<world coordinate>`, one `v` =
`1`, one `scope`, one `subject` equal to the coordinate, no `client`
tag (readers ignore one), empty content, one `p` a person in order of their
keys, at most 500 written (2,000 read), dated a second after the list it
replaces where that is later than now. The writer matches NSWP's
`vectors/owner-list-writing.json` (copied as
`embedded/owner-list-writing.vectors.json`). `embedded/guests.ts` reads it by BitGate's own vectors
(`embedded/governance-lists.vectors.json`, copied unchanged).

Kind 30078 stays on the never list for every site's `sign` and `propose`.
The worker's two actions (`guestListFind`, `guestListSign`) work only at
BitLogin's own sign-in addresses, and build nothing a world wrote but the
people.

## Left out

- The owner-wide block list (`user-deny` with no world): a world must not
  change every world's list from one page.
- Several keepers changing one list together, helpers and moderators.
- Anything inside a headset view: the panel can't be shown there.
- An application client method for it.
