# BitLogin: Future Recovery-Path Options

**Document version:** 0.1
**Status:** Options for future consideration only. Nothing here is decided,
scheduled, or implemented, and this is not a development plan — it's a
record of the tradeoffs so the decision can be revisited with the reasoning
intact, rather than re-litigated from scratch.
**Depends on:** `docs/spec.md` and `docs/second-factor.md` (§SF5 describes the
2-of-2 split-key mechanism referenced throughout).

---

## The core distinction: a second factor vs. a recovery path

These are different shapes of feature, and conflating them is the easiest
way to accidentally weaken the account:

- **A second factor (AND-gate).** Something *additional* required alongside
  the password. It can only make login harder to complete without it — it
  can never, by itself, grant access. If you lose the second factor, you
  fall back to whatever recovery paths already existed (today: the recovery
  phrase).
- **A recovery path (OR-gate).** An *independent* way to reach the account
  without the password (or without anything else). BitLogin already has
  exactly one of these: the 12-word recovery phrase. Every recovery path is
  a full-power master key — anyone who has it can take over the account
  completely, with nothing else needed.

The question that prompted this document: could a WebAuthn passkey (Face
ID / Touch ID / Windows Hello, via the PRF extension) serve as **both** — a
2FA hardening layer on the password path, **and** a way to sign back in and
reset the password without the phrase, the way "reset via authenticator"
flows work on many consumer services today?

Mechanically, yes. Whether to build it is a real tradeoff, laid out below.

---

## Option A — Passkey as a pure second factor (AND-gate only)

**How it works:** the credential-capsule payload key becomes a 2-of-2 split
between the password and a device-held secret (see `second-factor.md` §SF5
for the exact derivation). The passkey's WebAuthn PRF output unlocks the
device's share of that split. Without the password, the capsule can't even
be located — the locator itself is password-derived — so the passkey alone
grants nothing. The recovery phrase remains the *only* way to recover
without the password.

**Pros**
- Matches the "bank 2FA" mental model most users already have: forgot your
  password still means "use your recovery phrase," full stop. No new
  master key exists.
- Smallest attack-surface increase of any option here — it can only ever
  make an account *harder* to break into, never easier.
- Fully backward-compatible and additive to the shipped protocol (see
  `second-factor.md` §SF4 for why the envelope-versioning approach doesn't
  disturb existing accounts).
- No dependency on a third party's account security (Apple ID, Google
  Account) for anything account-critical. If a synced passkey is lost or
  its sync account is compromised, the attacker still needs the password —
  the phrase alone remains the recovery answer either way.

**Cons**
- Doesn't solve "I forgot my password and can't find my 12 words" — the
  exact moment a lot of real users hit. The convenience win from a
  Face-ID-driven "reset" flow doesn't materialize under this option.
- One more thing enrolled per account (a device/credential registry) for a
  security property that's arguably nice-to-have rather than essential —
  BitLogin's generated high-entropy passwords already carry most of the
  defensive load against the threat 2FA typically addresses (credential
  stuffing / reused passwords), which matters less here since manual
  passwords are opt-in and discouraged.

---

## Option B — Passkey as an independent recovery path (OR-gate, full parity with the phrase)

**How it works:** using WebAuthn's *discoverable credentials*, a browser can
present "sign in with a passkey" and hand back an identity without the site
supplying a username first. The passkey would derive its own locator and
capsule — structurally parallel to how the recovery phrase works today —
letting a user tap the passkey, get logged in, and set a brand-new login
name and password. No phrase required.

**Pros**
- Solves the actual "forgot password" moment with the lowest possible
  friction: Face ID, done. This is the flow users already expect from
  "Sign in with passkey" buttons elsewhere on the web.
- No paper to lose, no drawer to search.

**Cons — the significant one first**
- **Most real users will have a *synced* passkey** (iCloud Keychain, Google
  Password Manager) — that's the default, low-friction path on every
  mainstream device, and there's no realistic way to force people onto
  non-syncing hardware keys. A synced passkey lives inside the user's
  Apple ID / Google account. If this option grants full account recovery
  with no phrase required, **the account's real security floor becomes
  whatever protects that Apple/Google account** — not BitLogin's own
  cryptography. Account takeovers via compromised iCloud/Google
  credentials (phishing, SIM-swap) are a common, well-documented attack
  pattern, not a hypothetical.
- That directly reopens the exact dependency BitLogin's entire design
  exists to avoid: no operator, no support desk, no third party that can be
  compelled, breached, or phished into handing over the account. This
  option quietly relocates that dependency to Apple or Google instead of
  removing it.
- It's a second full-power master key, full stop — doubling the number of
  ways to fully take over an account, independent of how carefully it's
  implemented.
- It is not a small add-on. Matching the recovery capsule's existing
  guarantees (its own address, its own hash chain for gap/replay detection,
  its own tombstone/vandalism-resistance story per §14.2) means building an
  entire second, parallel recovery-capsule system — real protocol surface,
  not a UI feature.
- Two "I forgot everything" buttons that do fundamentally different things
  is a support and mental-model problem. A user may stop safeguarding their
  phrase ("I have Face ID") and only discover it was the one real backup
  after a new phone or a changed Apple ID quietly drops the synced passkey.

---

## Option C — Constrained passkey recovery (same-credential-only)

**How it works:** a middle path on Option B — recovery is permitted only
through the *specific* passkey credential ID already enrolled for 2FA
(Option A), never a freshly minted one. Enrolling a new passkey requires
already being logged in; recovery never accepts an unfamiliar credential.

**Pros**
- Closes off the specific case of "attacker takes over my iCloud account,
  mints a brand-new passkey there, uses it to recover" — a fresh credential
  can never be used for recovery, only ones already on file.
- Somewhat lower engineering cost than a fully independent Option B, since
  it reuses the same enrolled-credential registry as the 2FA design.

**Cons**
- Does **not** close the main hole: if the *already-enrolled* passkey is
  itself synced, an attacker who compromises the Apple/Google account gets
  a working copy of that exact credential too — "same credential only"
  and "any new credential" become equally reachable once the sync account
  is owned. This mitigation only fully works for non-syncing, single-device
  passkeys, which most users won't have.
- Inherits most of Option B's structural cost (a second recovery-capsule
  system) for a partial fix.
- A serverless design has no good way to add the mitigations centralized
  services normally layer onto "recover without your password" flows —
  a delay window with a chance to cancel, an out-of-band notification to
  the real owner, a manual review step. There's no server to hold that
  state and no reliable channel to notify anyone (BitLogin has no email,
  and a signed Nostr DM only reaches a device that happens to be online and
  watching). That gap is a property of the architecture, not something this
  option can design around — it's worth naming plainly rather than
  pretending a technical constraint could close it.

---

## Summary comparison

```text
                          Forgot-password    New master-key    Depends on
                          UX improvement?     risk added?      Apple/Google?
Option A (2FA only)              no             minimal            no
Option B (full recovery)        yes              full              yes (synced case)
Option C (constrained)          yes            partial‑reduced     yes (synced case)
```

None of these are mutually exclusive with each other or with the existing
password + phrase design — Option A could ship on its own, or as a
foundation that C or B build on top of later. The point of this document is
only to make the tradeoff explicit before any of them is chosen.
