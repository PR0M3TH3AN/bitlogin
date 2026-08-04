# Passkey Sign-In — Zero Registration, Zero Servers

**Document version:** 0.1
**Status:** **Implemented** (2026-08-04). Supersedes the OAuth on-ramps of
[`centralized-onramps.md`](./centralized-onramps.md) (removed the same day;
that document stays on the record with the analysis of why every OAuth path
requires per-site provider registration — the requirement this design
exists to escape).
**Depends on:** `docs/spec.md` (standard registration §15 and login §16 are
reused unchanged), `docs/second-factor.md` §SF10 (import), WebAuthn PRF
extension.

---

# PK1. What it is

"Continue with a passkey": the browser's own credential sheet — for most
users backed by Google Password Manager or iCloud Keychain, so it *feels*
like signing in with the account they already have — unlocks a standard
BitLogin capsule account. The site ships the static widget and does nothing
else. No OAuth client ID, no provider console, no app review, no server, no
stored credential file anywhere: the credential is **derived, not fetched**.

Mechanically: the passkey's WebAuthn **PRF extension** evaluates a fixed,
domain-separated input (`bitlogin:passkey-credential:v1`) and returns 32
bytes only that passkey can produce. `passkey.ts` derives from it — via
HKDF, under a frozen v1 contract — a login name (`pk-<12 hex>`) and a
256-bit password, which feed the ordinary, audited password flows. The
derivation chain of the core spec is untouched; to the protocol this is
just a password that arrives from an authenticator instead of a keyboard.

**The derivation is a compatibility contract.** `passkey.test.ts` pins
known-answer vectors; a failure there is never "update the expected value"
— same standing rule as `knownAnswer.test.ts`.

# PK2. Why this beats OAuth on-ramps

Every OAuth provider requires a pre-registered per-application credential —
that gatekeeping *is* their product — and most additionally require a
client secret (a server). Passkeys are a web-platform API: no registration
with anyone, works on every site the moment the widget loads, and the
custody still lands where normies already keep their digital lives (their
Google or Apple account, via passkey sync). It is the only design that is
simultaneously zero-site-setup, zero-server, and zero-third-party.

# PK3. Custody, loss, and recourse

Stated the way §CO7 demands — who can access, what happens on loss, how to
leave:

- **Who holds what:** the passkey (and thus the account credential it
  derives) lives in the user's authenticator — typically synced by Google
  Password Manager or iCloud Keychain, optionally a hardware key or a
  third-party manager. The site holds nothing. BitLogin holds nothing.
- **Lost phone or laptop: usually fine.** Synced passkeys are exactly the
  failure mode passkeys were built for — sign into the platform account on
  a new device and the passkey is there. This is *better* than a
  remembered password, which dies with the memory, and better than the
  removed Drive rail, which died with a client ID.
- **Lost platform account (Google/Apple ban or lockout), or a device-bound
  key that's gone: the passkey is gone.** Recourse, in order: the **12-word
  recovery phrase** (the dashboard's "Secure your account" card exists
  precisely for this — Tier B2 of the on-ramps design, retained); or a
  previously done password graduation (PK4). A user who claimed neither
  and lost the platform account has lost access — the same honest bottom
  line as every rail, which is why the phrase card is load-bearing.
- **One passkey = one account.** PRF output is per-credential, so a second
  passkey derives a *different* account — there is no "add a backup
  passkey" for the same account. The backup for the account is the phrase
  (or a held password), not a second passkey. The sync fabric is the
  passkey's own redundancy.
- **Per-site scoping.** Passkeys are bound to the site's domain (rpId), so
  like every on-ramp this is per-site convenience; cross-site portability
  is the capsule account's job, via password or phrase.

# PK4. Graduation

Unchanged ladder, same npub throughout: save the npub; claim the phrase
(one tap from the dashboard card while it's still in session memory);
rotate to a self-held password — the rotate screen tells passkey users
plainly that this retires the passkey unlock ("you hold it, nobody else");
or full export. §SF10 import remains the same-identity escape hatch in the
other direction: an existing nsec can be wrapped into a passkey-unlocked
account at setup.

# PK5. UX flow

- Menu row (shown when WebAuthn exists): "Continue with a passkey" / "Kept
  in your phone or browser's password manager."
- The passkey screen offers "Use my passkey" (primary) and "Create a new
  passkey." Sign-in with a passkey that has no account on this site routes
  into first-time setup *with the credential it already derived* — fresh
  identity or import — rather than erroring.
- Setup skips the upfront phrase ceremony (Tier B2): the dashboard card
  holds the phrase for the first session and nudges until claimed.
- Re-creating setup against a passkey whose account already exists simply
  signs in (`AccountAlreadyExistsError` → login with the same derived
  credential); a passkey sign-in against no account offers setup
  (`AccountNotFoundError`). Both directions are idempotent by construction.

# PK6. Support boundaries

PRF requires a modern authenticator stack (Chrome/Android and Google
Password Manager, recent Safari/iOS, hardware keys with hmac-secret).
Support cannot be feature-detected without running a ceremony, so an
unsupported combination surfaces as an honest in-flow message pointing at
the other methods. The password path remains the universal fallback — and
the primary method, per the standing password-first decision (§LM9.1).
