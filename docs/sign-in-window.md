# The Sign-In Window and the Signer Hand-Off

**Document version:** 0.2
**Date:** 2026-11-19
**Status:** Implemented, not deployed: the **signer hand-off** (§SW4:
`worker/handoff.ts`, three worker actions, four methods on the headless
signer); the **embedded signer** and its rules (§SW5: `embedded/signer.ts`,
`embedded/policy.ts`, built as `bitlogin-signer.js`); the **window's
finding and handing over** (§SW3: `embedded/window.ts`, built as
`bitlogin-window.js`); and both pages on BitLogin's own site
(`/signer/`, `/connect/`), with the headers of §SW6. NOT implemented: what
an application needs beyond a note and a reaction (§SW9), and adding a
passkey to an existing account (§SW7). Both are design only.
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
- **It is never stored.** Accepting a hand-off writes nothing to the
  session cache or the public record. Closing the page ends it.
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
- **It ends** when the site's page closes, when the site is told to lock
  (the user's own doing, from the site), or after four hours.
- **Nothing is addressed to "any origin".** Every message the signer sends
  goes to the site's address as the browser gave it, or to this origin. A
  site learns the signer is there by asking `state` once the frame has
  loaded.
- **The asking site's address is the browser's word:** `ancestorOrigins`
  where there is one, and otherwise the origin of the first message from
  the embedding page. Never anything a message says.
- **It never restores this origin's session,** and touches no storage: a
  site that shares a registrable domain with the sign-in address is treated
  like any other. A test reads the source for this.

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

# SW9. Applications (design only)

A note and a reaction are enough for a visitor to a world. They are not
enough for an application. The owner's own apps ask their signer today for
web-request proofs, private messages, lists, video events, deletions, zap
requests, application data, and encrypting and decrypting. Three things
are needed before an application can sign in this way:

1. **A permission the application declares and the user sees** in the
   window: which kinds, whether it may read private messages, whether it
   may spend. The signer holds it to that.
2. **A session between "can only sign" and "everything".** A handed-over
   session refuses to decrypt. An application that shows private messages
   needs one that may, for that application, because the user said so.
3. **Which address is the sign-in address.** BitLogin's own site is the
   default. It must not be the only one possible: the site is static, and
   anyone can serve it themselves.

# SW10. Not covered

- Safari, and phones, where a window is a tab: not tried.
- An asking site that cuts its link to windows it opens: the window finds
  no frame, and offers no Allow.
- Spending. The wallet mode in which BitLogin pays and the site never sees
  the connection is `nwc-connections.md`'s broker mode, and is not built.
