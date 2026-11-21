# A Person's Files, on Blossom Servers

**Date:** 2026-11-21
**Status:** Built on `beta`. Not on `main`. Tried against a mock Blossom
server, in tests and in a browser. Real servers were only asked whether
they would take a file (nothing was uploaded): **no file has been saved to
a real Blossom server.** Experimental.

Asked for by the owner on 2026-11-21: file storage through BitLogin for
the apps that use it, so that people in BitPortal can send, post, receive
and save files in an in-game file browser; public and private files and
folders; servers ranked, free and paid; storage limits and usage shown
clearly. Decided the same day: each world gets a folder of its own,
automatically, and the person can choose another place; files can be
moved, copied and deleted, as in a file browser; a server that charges is
paid without asking up to a limit the person sets.

Written from the Blossom documents themselves (BUD-01, 02, 03, 04, 06, 07,
10, 11, 12, read 2026-11-21), not from memory.

## F1. What Blossom is, and what it is not

A Blossom server stores a blob under the SHA-256 of its bytes and hands it
to anyone who asks for that hash (BUD-01). Uploading and deleting need a
short-lived permission note, a signed Nostr event of kind 24242 (BUD-11).
A person publishes the list of servers they use, most trusted first, as
kind 10063 (BUD-03).

Blossom has **no names, no folders, no private files, and no way for a
server to say how much room an account has, what it has used, or what it
charges**. A server says "too large" (413), "limit reached" (429) or
"payment required" (402) only when asked to take a file. Listing an
account's blobs is marked unrecommended (BUD-12). Everything a file
browser needs beyond bytes-by-hash is therefore BitLogin's own.

## F2. The index: names, folders, keys

`drive/tree.ts`. One record per folder: its name, the folder it is in, and
its files. Each file: a name, the hash and size of the bytes a server
holds, which servers hold it, and, for a private file, its key.

- **Move, copy, rename, delete,** as in a file browser. Two things in one
  folder never share a name ("report (2).pdf").
- **A copy uploads nothing:** it is a second name for the same bytes. The
  bytes are deleted from their servers only when the last name for them is
  removed.
- **A folder for each site,** made the first time that site saves a file:
  `Files > Worlds > <the site's address>`. It is found by the address it
  was made for, so the person may rename or move it.
- **Limits:** 200 files in a folder (so its record stays small enough for
  any relay), 300 folders, 50 MB a file.

## F3. Where the index is kept

`worker/driveStore.ts`. The same rule as the ecash wallet: **this browser
first, then relays.** One sealed record per folder (NIP-78 application
data, kind 30078, `d` = `bitlogin-drive:<folder id>`), sealed to the
account's own key. A relay sees how many folders there are and when they
change, and nothing else: no name, no server, no hash, no key.

- A record no relay takes stays in the browser and is sent again when the
  drive is next opened. With no relay answering, the drive opens from the
  browser's copy, and says so.
- For each folder the newer record wins. A removal is a record too, so a
  folder removed on one device does not come back from another.
- Two devices changing the same folder at once: the later one wins, and
  the earlier change to that folder is lost. Not merged.

## F4. Public and private

- **Public:** uploaded as it is. Anyone with its link
  (`<server>/<sha256>`) can fetch it.
- **Private:** sealed on BitLogin's page before upload (AES-256-GCM, a key
  made for that file alone; the 12-byte nonce, then the sealed bytes), and
  sent as `application/octet-stream`. Its server holds bytes that say
  nothing: not the words, not the kind of file. The key is in the index.
  It has no link. The same file sealed twice is two different blobs.
- New files are private unless the person says otherwise.

## F5. Servers

- **Permission notes are as narrow as Blossom allows:** one verb, one
  file (`x`), one server (`server`), five minutes. Never a note that could
  be used at another server, or for another file. Signed by the worker,
  for a full session only: no embedded signer, and so no site, can have
  one signed.
- **A file is saved to the person's first two servers** (BUD-03 asks for
  at least the first). Fetched from whichever still has it, and **checked
  against its hash**: a server is believed only as far as the hash goes.
- **Servers people use** are counted from the kind 10063 lists people
  publish, one voice per account, the person's own follows first; one
  stranger's word alone is not shown. Each is then asked whether it would
  take a file from this account (BUD-06), and marked **Free, any file**,
  **Pictures and video only**, **Charges**, **Not open to you** or
  **Didn't say**. A count is a hint, and the screen says so.
- **Many public servers take pictures and video only.** Asked on
  2026-11-21 with a throwaway key and nothing uploaded, five of the eight
  most listed servers refused `application/octet-stream` or did not
  answer the question. A private file is sealed, so a server can't see
  what kind it is, and such a server refuses it. A private file is kept
  on the first of the person's servers that takes any file; with none,
  it can't be kept, and the person is told why.
- **Usage is shown from the index:** how much, in how many files, on each
  server. **Limits can't be shown ahead of time,** because no server says
  them; when a server refuses a file as too large or over a limit, its own
  words are shown.
- **A server that charges (BUD-07)** is paid from the ecash wallet
  (`docs/ecash.md`) with its Lightning invoice: without asking up to the
  sats the person set for one file, and otherwise only on a yes. Paying
  with a Cashu token (`X-Cashu`) is not built. A server whose price the
  browser can't read (it must expose the header) can't be used.

## F6. What a site may ask

Two more things put to the person (`sign-in-window.md` §SW20), each
answered `asking` at once:

| The site sends its signer | And later, under the same `id` |
|---|---|
| `{ t: "file-save", id, name, type, bytes, private? }` | `{ t: "file-saved", id, name, size, private, url? }`, or `refused` |
| `{ t: "file-pick", id }` | `{ t: "file", id, name, type, bytes, url? }`, or `refused` |

- **Saving:** the person's file browser opens in that site's own folder,
  with the name to save under. They may go to another folder, change the
  name, and choose public or private (private unless the site said
  otherwise). The site hears the name it was given, and a link only if it
  was kept public. Never where it is, on which server, or a key.
- **Picking:** the file browser opens; the person chooses one file and
  confirms; that file is fetched, opened if private, and handed over.
- **25 MB** at most in one file either way. Each is a press. A site sees
  nothing of what the person keeps: not a list, not its own folder.

## F7. Not built

- A site keeping files in its own folder **without a press**, or listing
  that folder. The embedded signer may reach relays and nothing else, so
  it can't upload; this needs a design of its own.
- Mirroring to another server after the fact (BUD-04); `blossom:` links
  (BUD-10); paying with a Cashu token; resuming an interrupted upload;
  files over 50 MB; sharing a private file with another person.
- `saveFile` / `pickFile` on the client library, for an application.
- A real Blossom server has not been tried.
