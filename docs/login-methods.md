# BitLogin as the Single Login Surface — NIP-07 and NIP-46 Methods

**Document version:** 0.3
**Status:** §LM4 (NIP-07) and §LM5 (NIP-46, memory-only phase) are
**implemented** (2026-08-04): `signers/` in `@bitlogin/widget`, the NIP-46
client in `@bitlogin/core`'s `nostr/nip46.ts` with the ephemeral key held in
the crypto worker, both `bunker://` paste and the nostrconnect QR (rendered
as dot-style inline SVG), thin sessions per §LM7, password-first per §LM9.1.
NIP-46 *persistence* (§LM5.3 phase two) remains gated on the external vault
review. §LM6 records a settled rejection (nsec paste as a login method),
kept on the record.
**Depends on:** `docs/spec.md` (§ references point there unless marked §LM or
§SF), `docs/second-factor.md` §SF10 (imported identities, implemented)

---

# LM1. Purpose and scope

Today `<bitlogin-auth>` offers exactly one way in: a BitLogin login name and
password. A site that wants to serve existing Nostr users — extension holders,
bunker users — has to build its own login chooser and treat BitLogin as one
button in that menu.

This proposal inverts that. The widget becomes the login menu: one embed, one
host-facing surface, and the user picks their method behind it:

1. **BitLogin login name + password** — the existing derived-account flow,
   unchanged, and still the default presented to new users.
2. **NIP-07** — delegate to a signer extension already installed in the
   browser (§LM4).
3. **NIP-46** — connect to a remote signer ("bunker") over relays (§LM5).

§26.4 already names NIP-07 and NIP-46 as anticipated future signer support;
this document is the design for that line.

Out of scope, permanently: accepting a pasted `nsec` as a login method
(§LM6). Users holding a raw key are routed to the implemented §SF10 import
flow instead, which wraps the key into a full BitLogin account once rather
than handling it at every sign-in.

# LM2. Why aggregate rather than be aggregated

The bottleneck for BitLogin is developer adoption, and a developer evaluating
a login widget hears one objection immediately: *my existing users have
extensions and bunkers; a password-only widget doesn't cover them.* Supporting
all three methods behind one embed removes that objection, and every embed
then distributes BitLogin's native method as the easy path for everyone who
does not already have Nostr keys.

Prior art validates the shape: `nostr-login` (nostrband) is an embeddable
widget aggregating extension, NIP-46, and other methods, and it occupies the
"one login surface" niche today. BitLogin's differentiator is not the
aggregator layer — that part is commodity — but the derived-account custody
underneath it. The aggregator is worth building because it is the wedge that
gets the custody in front of users, not because it is novel.

The positioning consequence is worth stating plainly: with this change, a site
never needs a login UI other than BitLogin, and BitLogin's security story —
*no method ever puts a root key on the page* — holds across every method it
offers (§LM6).

A fourth family of methods — clearly labeled centralized OAuth on-ramps
(Google, GitHub, …) that manage the credential while the account stays a
standard capsule account — is designed separately in
[`centralized-onramps.md`](./centralized-onramps.md).

# LM3. Architecture: one facade, pluggable signers

The widget already exposes a NIP-07-shaped provider — installed as
`window.nostr` (element.ts installs and releases it, taking over from an
extension where configurable) and mirrored as an element-scoped API. Hosts
program against that facade, not against the derivation machinery. That
boundary is exactly where the abstraction goes.

```text
host page ── window.nostr / <bitlogin-auth> API   (unchanged surface)
                     │
             provider facade
                     │
              active Signer
              ┌──────┼──────────────┐
        DerivedSigner  Nip07Signer  Nip46Signer
        (existing       (delegates   (bunker client
         worker path)    to the       over relays)
                         extension's
                         provider)
```

A `Signer` implements the calls the facade already promises — `getPublicKey`,
`signEvent`, NIP-44 and NIP-04 encrypt/decrypt — plus metadata:

- `method`: `"bitlogin" | "nip07" | "nip46"`, surfaced to the host in the
  sign-in event so applications can adapt (e.g. hide password-rotation UI for
  non-BitLogin sessions).
- `capabilities`: which optional calls this signer actually supports.
  Extensions vary — some lack `nip44` — and the facade must report honestly
  rather than throw surprises (§LM4).

Rules that hold for every signer:

- **No silent hangs.** Every facade call has a timeout and a typed failure.
  This restates the Tier 1 rule from the 2026-07-30 audit for a world where a
  signature may wait on a phone that is asleep (§LM5).
- **The facade is the only surface.** No signer leaks its backend (extension
  provider object, bunker connection, worker handle) to the host page.
- **One active signer per element.** Method choice happens at sign-in;
  switching methods is a sign-out and sign-in, composing with (not
  complicating) the account-switching design.

# LM4. NIP-07: delegate to an installed extension

The cheapest method: no key custody, no new stored secrets, no relay traffic.
The widget detects an injected `window.nostr` that is not its own, offers
"Sign in with extension," and the `Nip07Signer` passes facade calls through
to the extension's provider.

Design points:

1. **Arbitration inverts, not disappears.** The current element takes over
   `window.nostr` at sign-in and warns when an extension's property is
   non-configurable. With a NIP-07 session the widget must *not* fight the
   extension — the extension's provider is the backend. The existing
   install/release logic stays for BitLogin-method sessions; NIP-07 sessions
   leave `window.nostr` alone (or install a passthrough only where the
   extension injected late). The detection must also snapshot the extension's
   provider *before* the widget's own install, so the two never confuse each
   other.
2. **Capability probing.** `nip44` presence is checked on the extension
   object and reported in `capabilities`; absent calls reject with a typed
   "unsupported by this signer" error rather than a TypeError from an
   undefined property.
3. **User-visible identity.** After `getPublicKey`, the widget shows the
   `npub` it got, so the user can notice a wrong-profile extension state
   before the host application acts on it.
4. **No session material of its own.** A NIP-07 session persists nothing —
   on reload the extension is simply asked again. This makes NIP-07 the
   right first shipping increment (§LM8).

# LM5. NIP-46: connect to a remote signer

The user's key lives in a bunker (nsecBunker, Amber, or similar); the widget
holds only a client keypair and a connection secret, and requests signatures
over relays. This is the method most aligned with BitLogin's security story —
the widget custodies a *revocable credential*, never the key. If a
compromised host exfiltrates the connection, the user revokes it at the
signer; contrast a stolen `nsec`, which is unrotatable (§LM6).

Design points:

1. **Connect flow.** Accept a `bunker://` URI or nostrconnect handshake;
   surface the signer's `auth_url` approval ceremony inside the widget UI
   (open in a new tab, show pending state, resume on approval). The connect
   ceremony is widget UI work of the same kind as the NWC REVEAL flow that
   shipped 2026-07-30.
2. **Latency is a feature of the method, not a bug to hide.** Every
   `signEvent` is a relay round trip to a device that may be offline. The
   facade shows a pending state, applies a timeout, and fails with a typed,
   retryable error. A host that got instant signatures from the derived
   path must not discover NIP-46 latency as a hang.
3. **Persistence of the connection secret — deliberately phased.**
   - *Phase one: memory-only.* The connection lives for the session; a
     reload means reconnecting. Nothing new is stored anywhere, so nothing
     new needs review.
   - *Phase two: a Connection Vault record.* A NIP-46 connection is shaped
     like the NWC credentials the vault already models — relay URLs plus a
     secret, revocable at the far end, scoped in authority. Persisting it as
     a vault record profile falls squarely under the standing gate:
     **external security review before the vault holds anything beyond a
     budget-capped NWC connection.** Phase two therefore waits on that
     review; phase one does not.
4. **Client keypair hygiene.** The ephemeral client key for the NIP-46
   conversation is generated by the CSPRNG chokepoint like every other key
   in the codebase, and lives in the worker, not the DOM thread.

# LM6. Rejected: nsec paste as a login method

Considered and rejected, on the record.

A paste box for `nsec` on an embedded, same-origin widget means the root key
transits every host page that embeds BitLogin, at every sign-in, forever. An
XSS on *any* embedding site exfiltrates a key that Nostr provides no way to
rotate. §SF10 already states the principle: *the paste is the risk* — entering
an `nsec` into a web page is the most dangerous single action in Nostr use.
A login method institutionalizes that action as a habit; it also breaks the
claim §LM2 leans on, that no BitLogin method ever puts a root key on the page.

The sanctioned path for a user holding a raw key is the **implemented §SF10
import flow**: paste once, on a build you trust, and the key is wrapped into
a full BitLogin account — capsules built around the imported key, a fresh
recovery phrase, password sign-in from then on. The login surface should
route to it: an "I have an nsec" affordance that opens the import flow, so
the user's need is met without the recurring paste.

The distinction in one line: **import custodies the key once, under the
account's full protections; a login method would handle it on every sign-in,
under none of them.**

# LM7. Sessions are thin for non-BitLogin methods

Everything in the portable account layer — Connection Vault, portable app
state, entitlements, second factor — is built on capsule custody. A NIP-07 or
NIP-46 session has no capsule, so in this design those sessions are **signer
sessions only**: the host gets `window.nostr`, the sign-in event with
`method` and `capabilities`, and nothing else. No vault, no portable state,
no second factor.

This is deliberate:

- It keeps the aggregator commodity-cheap — the expensive, review-gated
  machinery stays exclusive to derived accounts.
- It creates the honest upsell: "create a BitLogin password to get your
  settings and connections on every device." The widget may offer this to a
  signed-in NIP-07/NIP-46 user; note that upgrading an extension or bunker
  identity to a *full* account requires the private key BitLogin never sees
  for those methods, so the upsell mints a derived account (new identity) or,
  for a user who separately holds their key, points at §SF10 import.

Extending capsule-backed features to non-derived identities is possible in
principle but is a protocol-surface expansion this document explicitly does
not propose.

# LM8. Phasing

1. **NIP-07** — smallest increment: detection, delegation, capability
   probing, arbitration inversion. No new secrets, no relay traffic, no
   review gate touched. **Shipped 2026-08-04.**
2. **NIP-46, memory-only** — connect ceremony (bunker:// paste and a
   nostrconnect QR), pending/timeout UX, typed errors. Still nothing
   persisted. **Shipped 2026-08-04.** Transport is NIP-44 only, per the
   current NIP-46 spec; legacy NIP-04-only bunkers are not supported.
3. **NIP-46 persistence as a vault profile** — after the external security
   review the vault is already gated on.

Each step ships independently; the login UI grows one option at a time.

# LM9. Open questions

1. **Resolved 2026-08-04 (owner decision):** username/password stays the
   primary presentation; alternative methods appear as secondary affordances
   below it, never promoted above the password path even when an extension is
   detected. Pinned by `securityPolicy.test.ts`.
2. Should a NIP-07 session survive reload by silently re-asking the
   extension, or require an explicit click each visit (extension prompt
   fatigue vs. surprise sessions)?
3. Does the sign-in event schema need versioning now that `method` and
   `capabilities` are added to it?
4. Whether the widget should expose "which methods are enabled" as element
   attributes so a host can, e.g., disable NIP-46 (`methods="bitlogin,nip07"`).
