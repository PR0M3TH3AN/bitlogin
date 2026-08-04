# Centralized On-Ramps — OAuth Sign-In as a Journey Toward Self-Custody

**Document version:** 0.4
**Status:** **SUPERSEDED — kept on the record.** All OAuth on-ramp
implementations described below (the §CO5 service handshake and the §CO3.3
serverless Google Drive rail) were **removed on 2026-08-04**, the same day
they shipped, by owner decision: every OAuth path requires per-site
provider registration (and for GitHub/Facebook, a server), which fails the
"static only, zero setup" requirement. The replacement is
[`passkey-login.md`](./passkey-login.md) — zero registration, zero servers,
custody still landing in the user's Google/Apple account via passkey sync.
What survives from this document: the journey framing (§CO6 graduation,
§CO7 honesty contract, Tier B2 phrase handling) all carried over to the
passkey rail, and the architecture analysis below remains the reference for
why OAuth cannot be done statically without a registered client.
Historical status at removal: the widget side of §CO5 was implemented
`onramp-url` / `onramp-name` / `onramp-providers` attributes, the popup
handshake below, "Continue with <Provider>" rows under the "Use an account
you already have" group (§CO11.1 resolved: that heading covers the whole
existing-account group — extension, remote signer, key import, and
centralized rails — with the custody statement carried by each row's
sub-label), client-side registration with optional §SF10 import, and the
Tier B2 "Secure your account" dashboard card. Reference services live
outside this repository by definition and do not yet exist.

**Handshake contract as implemented (v1):** the widget opens
`onramp-url?provider=<id>&state=<nonce>&origin=<page origin>` in a popup;
the popup posts to its opener exactly one
`{ type: "bitlogin:onramp:unlock", state, unlock: { loginName, password } }`
(returning user) or `{ …, register: { registrationToken,
suggestedLoginName? } }` (new user), accepted only from the configured
origin with the exact state nonce. For new users the widget registers
client-side, then `POST onramp-url` with
`{ type: "bitlogin:onramp:store", registrationToken, loginName, password }`;
a non-OK response forces the phrase ceremony immediately instead of
deferring it. Hosts must add the service origin to their CSP `connect-src`. Depends on
`docs/spec.md`, `docs/login-methods.md` (the one-login-surface model), and
`docs/second-factor.md` §SF10 (imported identities, implemented), which turns
out to be the graduation mechanism.
**Framing decision (owner, 2026-08-04):** centralized options are offered
openly and labeled honestly. The goal is normies using Nostr sites with
whatever sign-in they are already comfortable with — Google, GitHub, Facebook
— and a designed path that nudges them toward self-custody over time. "It's a
journey for all of us."

---

# CO1. Purpose and scope

BitLogin's native account is already the low-friction end of self-custody: a
login name and password, no extension, no server. But the true beginner does
not want *any* new credential — they want the button they already trust:
**Sign in with Google**.

This document designs that button as a fourth method behind the same
`<bitlogin-auth>` surface, such that:

1. The user gets a working Nostr identity — post, react, set a profile photo
   — with nothing but their existing OAuth account.
2. The centralized dependency is **labeled, bounded, and escapable**: the
   design maximizes what survives if the service or the OAuth provider
   disappears, and every tier has a defined graduation path to full
   self-custody **that keeps the same npub**.
3. The core protocol is untouched. Everything here is a deployment pattern
   composed from existing primitives — capsule accounts, NIP-46, §SF10
   import. `knownAnswer.test.ts` never notices.

Out of scope: implementing the services (they are server-side by nature and
cannot live in this static repo), and any change that would make a
centralized rail *required*. The native password path remains the default
presented to new users (login-methods.md §LM9.1).

# CO2. The principle: centralization as a rail, not a foundation

The test every design below must pass: **what does the user keep when the
centralized party is gone?**

BitLogin's answer is layered. The identity key lives in capsules on public
relays (or in the user's eventual export), not in the service's database
wherever the tier allows it. The centralized party holds an *unlock
credential* — the thing that makes everyday login effortless — and its
disappearance costs convenience, not identity, at every tier above the
lowest. This is the structural difference from "Sign in with Google" as
normally deployed, where the provider's disappearance costs the account.

# CO3. Two architectures

## CO3.1 Architecture A — the OAuth-gated bunker (works today)

A service runs a NIP-46 remote signer. First OAuth sign-in mints a keypair
server-side; thereafter, a valid OAuth session authorizes signing. BitLogin
connects to it exactly as it connects to any bunker — the widget's existing
NIP-46 support (§LM5) is the whole client.

- **Custody:** full. The service holds the signing key and sees every event
  it signs.
- **What survives the service:** nothing, unless the service offers nsec
  export (it must — see CO6).
- **Cost to build:** zero widget changes. nsec.app's noauth already proves
  the pattern in production with email/passkey gating.
- **Role in this design:** the fastest possible proof point, and the
  compatibility answer for services that already exist. Not the recommended
  destination.

## CO3.3 Architecture C — provider storage: no server anywhere (implemented)

**Owner decision (2026-08-04): static only is the way.** Architecture B still
assumes *someone* runs the unlock service. For providers that expose
user-owned storage to pure browser clients, even that party disappears: the
credential of a standard capsule account lives in **the user's own cloud
storage**, readable only through the host's OAuth client ID. Google
authenticates the user; Google stores the user's own secret; the static
widget does everything else. Nobody else exists to trust, pay, or lose.

Implemented for Google (`onramp-google-client-id` attribute):

1. The "Continue with Google" row opens a popup on Google's OAuth endpoint —
   plain implicit grant, `response_type=token`, no external script, so a
   strict `script-src 'self'` CSP survives. Scope is `drive.appdata` only:
   no identity claims, no email, minimum disclosure.
2. The registered redirect URI is **the widget page itself** — no callback
   artifact to deploy. The widget instance in the popup recognizes the token
   fragment, relays it to the opener (same-origin, exact state nonce),
   scrubs the URL, and closes.
3. The opener reads `bitlogin-credential-v1.json` from the Drive app-data
   folder: present → ordinary password login (§16); absent → first-time
   setup (fresh identity or §SF10 import), client-side registration, then
   the credential is uploaded. An upload failure triggers the no-orphan
   rule: the phrase ceremony runs immediately.

Threat model: Google-account compromise = password compromise, exactly the
spec's §14 analysis; there is no second party to compromise. The app-data
file is plaintext by necessity — any encryption key would have to come from
the same OAuth gate it would be protecting against. Deployment notes: the
host registers its own OAuth client ID and the widget page's exact URL, and
adds `https://www.googleapis.com` to `connect-src`. Known dependency: the
implicit grant is legacy at Google; if it is ever sunset, the fallback is
Google Identity Services, which requires relaxing the CSP for one external
script — recorded here so that trade arrives as a decision, not a surprise.
The same pattern extends to Dropbox and Microsoft OneDrive (PKCE browser
flows with app-scoped storage); GitHub and Facebook offer no equivalent and
remain Architecture A/B territory.

Password rotation while Google-managed is the graduation step (CO6 step 2):
the Drive copy simply goes stale and dead, and the rotate screen says so
before the user commits.

**Scoping and blast radius (recorded 2026-08-04).** Drive app data is siloed
per OAuth client ID, so the Google rail is a per-site (or per-site-family)
convenience: a credential stored via Site A's client ID is invisible to
Site B, whose "Continue with Google" would offer to create a NEW account.
Cross-site portability is the underlying capsule account's job — password or
phrase work on every BitLogin site. If a HOST'S Google project is banned or
deleted, no Nostr account is lost (capsules live on public relays), but
ungraduated users are locked out in practice: their credential file sits in
their own Drive, readable only through an app bearing the dead client ID.
Graduated users lose nothing but a button. This is why the Tier B2 phrase
card is load-bearing, not decorative. A shared ecosystem-wide client ID
behind a static relay hub on bitlogin.network was considered and rejected:
it would make one domain and one Google project a chokepoint for every
deployment, and a shared client ID lets any federated site read the user's
credential file — worse centralization than the per-site silo it would fix.
`drive.appdata` is a Google "sensitive" scope: hosts should expect Google's
app-verification review before serving more than ~100 users.

## CO3.2 Architecture B — OAuth as the password manager (recommended)

The insight: a BitLogin account requires a high-entropy password, but the
protocol never cares *who remembers it*. So let the service remember it.

**First sign-in (registration):**

1. The widget completes the OAuth dance with the service (CO5).
2. The service verifies the OAuth token, sees a new user, and returns
   `register: true` plus a service-generated login name.
3. The **client** — the static widget, in the worker — runs the ordinary
   registration flow (§15): generates the password, derives everything,
   builds both capsules, publishes to relays. The recovery phrase is
   generated and the recovery capsule written, per spec.
4. The client sends the service the password (over TLS, after OAuth). The
   service stores `{oauth_subject → login_name, password}` and nothing else.
5. Phrase handling per deployment tier (CO4).

**Every later sign-in:** OAuth token in, `{loginName, password}` out, then
the client runs the standard password login (§16) — Argon2id, locator,
capsule decrypt, rollback checks, all client-side, all existing code.

- **Custody:** the service holds an unlock secret, never the signing key.
  Compromise of the service is password compromise, which the spec already
  analyzes (§14): no cryptographic authority over the recovery capsule,
  detectable rollback, phrase path unaffected.
- **What survives the service:** the account, fully — it is a standard
  capsule account on public relays. Anyone holding the password or phrase
  can use it with zero service involvement.
- **Privacy:** the service learns login times. It does not see events,
  contacts, or activity — the client talks to relays directly.
- **The service is one endpoint** plus OAuth plumbing:
  `POST /unlock {provider, oauth_token} → {loginName, password, register?}`.
  No relay access, no Nostr code, no key material. Small enough to audit.

# CO4. Phrase handling in Architecture B — the custody dial

Registration necessarily has the phrase in memory (§13); what happens to it
is a deployment choice, and each choice is a labeled tier:

- **Tier B1 — phrase shown at signup.** Maximum sovereignty, maximum
  friction; defeats the purpose for true normies. Offered, not default.
- **Tier B2 — phrase held for the first session, then discarded
  (recommended default).** The phrase stays in worker memory for the first
  session only. The dashboard shows a persistent, dismissible "Secure your
  account" card: view and verify the phrase any time before the session
  ends; afterward it is gone — nobody has it, and recovery rests on the
  OAuth rail until the user graduates (CO6). Honest failure mode: losing
  the OAuth account *and* the service before graduating loses account
  access (the npub itself can still be preserved — CO6, step 0).
- **Tier B3 — phrase escrowed by the service,** encrypted at rest, released
  only through the OAuth gate. Deepest custody, fullest recovery. A
  deployment offering B3 must label it as holding everything needed to
  take the account — functionally similar trust to Architecture A, with
  better privacy.

The tier is the deployment's call; the widget's labeling (CO7) states it in
one sentence either way.

# CO5. Widget integration

A fifth option row in the "More sign-in options" menu (login-methods.md UI),
under an explicit group heading:

```
Centralized options
  ⓖ  Continue with Google
      Convenient — AcmeSigner manages your sign-in
```

- The row is configured, never built-in: a host opts in via element
  attributes (`onramp-url`, `onramp-providers="google,github"`,
  `onramp-name="AcmeSigner"`). No configuration, no row — BitLogin ships no
  centralized dependency by default.
- Flow: the row opens the service's OAuth page (new tab, like the NIP-46
  auth_url ceremony). The service finishes OAuth and hands the widget its
  result — for Architecture B, `{loginName, password}` into the existing
  login flow; for a service that is an Architecture-A bunker, a `bunker://`
  URI into the existing NIP-46 flow. Either way the widget reuses a flow
  that already exists and already has tests.
- Session shape: an Architecture-B session **is** a BitLogin account session
  — vault, rotation, export all work. `bitlogin-login` gains an optional
  `detail.onramp` (e.g. `"oauth:google"`) so a host can know the rail
  without a new method value; `detail.method` stays `"bitlogin"` because
  that is what the session is. Architecture-A sessions are `"nip46"`
  sessions, unchanged.
- The credential handoff (password in a redirect/postMessage payload) must
  be same-origin-verified, single-use, and never appear in a URL that hits
  server logs (fragment or postMessage, not query string).

# CO6. Graduation — the journey, mechanically

The nudge sequence, from most passive to full self-custody. Every step is
optional and every step keeps the same npub.

**Step 0 — know your npub.** The dashboard already shows it. Add a "save
your npub" affordance (copy/share card) with one line of copy: *this is your
public identity; it works on every Nostr app, not just this site.* Even a
user who saves nothing else has learned their identity is portable — and a
lost account's npub can still be referenced, cited, followed.

**Step 1 — secure your account (Tier B2's first-session card).** View the
phrase, verify three words, done: the user now holds the sovereign recovery
path and the OAuth rail becomes pure convenience. This is the cheapest
meaningful graduation and the one to nudge hardest.

**Step 2 — hold your own password.** Rotate the password (existing §18
flow) to one the user stores in their own password manager, and tell the
service to drop its copy. OAuth stops working as a rail; the account is now
fully native. Offered when engagement suggests readiness (CO8).

**Step 3 — full export.** The existing identity-export screen (npub, nsec,
recovery export file). For users leaving for another signer entirely —
that is also success. The goal is Nostr users, not captive BitLogin users.

**Graduating out of custody (Architecture A, or B3, or a B2 user past their
first session):** the service exposes "export my key" (required — CO9), and
the user runs the **implemented §SF10 import flow**: paste the nsec once,
wrap it in a self-chosen BitLogin account with a fresh phrase. Same npub,
new custody. For Architecture A the service *held* the key, so the honest
copy must say so and recommend watching for misuse — or, for the cautious,
identity rotation (§18.4) with its social cost stated plainly. For
Architecture B the service never had the key, so import-graduation carries
no such asterisk; only the password should be rotated afterward.

# CO7. Labeling — the honesty contract

Every centralized option carries, at the point of choice and on the
dashboard, plain-language answers to three questions:

1. **Who can access this account?** ("AcmeSigner can sign in as you" /
   "AcmeSigner holds your key and signs for you" per tier.)
2. **What happens if they disappear?** ("Your account keeps working with
   your recovery phrase" / "your password" / "your account is lost —
   secure it below to change that.")
3. **How do I leave?** One tap to the relevant graduation step.

No dark patterns in either direction: centralized options are not shamed
(they are the on-ramp, not the enemy), and self-custody is not oversold
(a phrase the user loses is worse than a Google account they keep). The
nudge is informed comfort, not fear.

# CO8. Nudge mechanics

- First session (B2): the "Secure your account" card, persistent until
  completed or explicitly dismissed with "later."
- Milestone nudges, capped and dismissible: after the account's Nth sign-in
  or first vault connection, one card — never a modal, never blocking —
  offering step 1 or 2. A dismissed nudge stays dismissed for a long, fixed
  interval; nagging teaches users to dismiss, not to graduate.
- The dashboard always shows the current standing ("Signed in via Google ·
  AcmeSigner manages your sign-in") with the three CO7 answers one tap away
  — the ambient reminder that costs no interruption.

# CO9. Requirements on a conforming service

A service a BitLogin deployment points at must:

1. Export on demand: password + recovery-export file (B), or nsec (A/B3),
   through the OAuth gate, without support tickets.
2. Delete on demand (its stored credential), completing step 2.
3. State its tier in a machine-readable descriptor the widget can render
   (`/.well-known/bitlogin-onramp.json`: tier, custody statement, export
   endpoints), so the CO7 labels are generated, not hand-maintained lies.
4. Rate-limit and log unlock attempts; the endpoint is the account's
   front door.

# CO10. Threat model summary

| Actor compromised | Architecture A | Architecture B (B2) |
| --- | --- | --- |
| OAuth provider account | Attacker signs as user until service session revoked | Attacker gets password → full session access (§14 limits); phrase path unaffected; detectable rollback |
| On-ramp service | Key compromised; identity rotation required | Password compromised (§14); identity key never present; rotate password |
| Both gone (no compromise, just gone) | Account lost unless previously exported | Account intact; sign in with password/phrase if graduated, else lost access (npub preservable) |
| Relays | Availability only, as core spec | Availability only, as core spec |

# CO11. Open questions

1. Should the widget cache the Architecture-B password in the existing
   session cache (it already caches session material for reload-survival),
   or re-OAuth every visit?
2. `detail.onramp` shape: string rail identifier vs. structured
   `{ provider, service, tier }`.
3. Whether Tier B2's first-session phrase window should survive a reload
   within some time budget, or end strictly with the worker.
4. **Resolved 2026-08-04 (owner decision):** the group heading is "Use an
   account you already have," covering every existing-account path — Nostr
   extension, remote signer, key import, and centralized rails alike — with
   the custody statement carried entirely by each centralized row's
   sub-label ("<Service> manages your sign-in").
