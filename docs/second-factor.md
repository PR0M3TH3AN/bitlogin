# BitLogin Second Factor, Backup Codes, and Imported Identities

**Document version:** 0.1 (draft addendum to the v0.3 core specification)
**Status:** Design proposal — not implemented, not final
**Depends on:** `docs/spec.md` (§ references below point there unless marked §SF)

---

# SF1. Purpose and scope

Mainstream users understand one second-factor ceremony: *scan a QR code, confirm
a six-digit code, save your backup codes, and approve sign-ins on your phone.*
This addendum specifies how BitLogin reproduces that exact ceremony — opt-in,
enable/disable at any time after account creation — without a server, using
only the primitives the core protocol already ships: capsules on relays,
NIP-44 encryption, and self-custodied Nostr keys.

It defines three opt-in features:

1. **Phone-approval sign-in** (§SF5–SF7): a real cryptographic second factor.
   The credential capsule key is split 2-of-2 between the password and a
   secret held on an enrolled phone; sign-in requires both.
2. **Backup codes** (§SF8): one-time high-entropy codes, each an independent
   recovery path, presented in the familiar "save these codes" format.
3. **Imported identities** (§SF10): using an existing Nostr `nsec` as the
   everyday identity under all of the above.

The recovery phrase remains the master path and is never gated by any of
these features (§SF9).

---

# SF2. Why literal TOTP is excluded

TOTP works because a server holds the shared secret and enforces attempt
limits. BitLogin has no server, and its capsules are downloadable by anyone
(§9.1, §23.3). The consequences are not fixable by implementation care:

1. A 6-digit code carries ~20 bits of entropy. Anything decryptable "given
   the right code" is brute-forced offline in milliseconds — 10⁶ candidate
   codes against a downloaded capsule is not an attack, it is a for-loop.
2. A code the client merely *asks for* in its UI, without the code being
   cryptographically necessary for decryption, is cosmetic. Any client that
   skips the UI decrypts with the password alone. UI-enforced 2FA in an open
   protocol protects nobody and trains users to trust theater.

Therefore: **no stored or login-gating secret in this design may have less
entropy than a generated credential (§9.2).** Short codes appear in exactly
one place — the interactive pairing confirmation of §SF6, where the code is
one-shot, ephemeral, human-compared between two live devices, and never
stored or transmitted as a secret.

The familiar *ceremony* survives; the mechanism underneath must differ. The
mapping:

```text
User sees                              Actually happening
─────────────────────────────────────  ─────────────────────────────────────
"Scan this QR with your phone"         One-time full-entropy enrollment
                                       secret transferred to the phone
"Enter the 6-digit code shown"         Interactive pairing confirmation
                                       (one-shot, never stored)
"Approve this sign-in on your phone"   Phone releases its 2-of-2 key share
                                       over an encrypted relay message
"Save these backup codes"              Each code is an independent
                                       high-entropy recovery credential
                                       backing its own capsule
```

---

# SF3. New identities and secrets

This addendum adds, per account (all optional):

* **Device factor keypair** — a secp256k1 keypair generated on the enrolled
  phone at enrollment time. Its private key never leaves the phone. Its
  public key ("device pubkey") is the address for approval requests. It is
  a fourth identity class alongside the recovery, everyday, and locator
  identities (§7), and like the locator it is never shown to the user as an
  account.
* **Device share** — 32 random bytes generated at enrollment, held only on
  the phone (wrapped at rest per §21.2: PIN, platform keystore, or passkey),
  and released only inside an approved sign-in (§SF7). Never published at
  rest, on any relay, in any capsule.
* **Backup-code secrets** — generated codes, each ≥ 77 bits of entropy
  (§SF8). Shown once, then existing only as the user's saved copy.

The enrollment QR payload contains a one-time secret from which the phone
derives nothing durable except its own locally-generated keys — the QR is a
transport for bootstrapping the pairing session (§SF6), not a long-term
secret. A photographed QR that is never used within its pairing window
confers nothing.

---

# SF4. Envelope changes: the gated envelope

Core envelopes (§13) carry one AEAD payload. A second-factor-protected
credential capsule uses a two-layer **gated envelope**:

```json
{
  "version": 2,
  "algorithm": "aes-256-gcm",
  "gate": {
    "nonce": "<base64url>",
    "ciphertext": "<base64url>"
  },
  "nonce": "<base64url>",
  "ciphertext": "<base64url>"
}
```

* The **gate** is encrypted with the password-derived key alone
  (`password_capsule_key`, §11.4). Its plaintext names the device pubkey,
  the approval-relay hints, and the split parameters:

```json
{
  "second_factor": "device-approval-v1",
  "device_public_key": "lowercase-hex",
  "approval_relays": ["wss://..."],
  "split": "hkdf-2of2-v1"
}
```

* The **payload** is the ordinary credential payload (§12.1), encrypted with
  the split key of §SF5, which requires the device share.

Properties this buys:

1. **Trial decryption stays honest.** A client that knows only the password
   opens the gate, learns that a second factor is required and who to ask,
   and cannot read the payload. Wrong-password attempts fail at the gate
   exactly as they fail today — §16.3's indistinguishability is preserved.
2. **The device pubkey is not public.** Relays see a version-2 envelope
   (which does reveal *that* the account uses a second factor — accepted and
   disclosed, as with the `d`-tag decision in §13) but learn the device
   pubkey only if they crack the password. Correlating approval traffic to a
   specific capsule therefore requires the password.
3. **Version-1 envelopes remain valid.** Accounts without the feature are
   byte-for-byte unchanged.

---

# SF5. The 2-of-2 split key

With the second factor enabled, the credential payload key is:

```text
split_prk = HKDF-Extract(
  salt = SHA256("bitlogin/second-factor-split/v1"),
  IKM  = password_prk || device_share
)

split_capsule_key = HKDF-Expand(
  split_prk,
  "bitlogin/2fa-capsule-encryption/v1",
  32
)
```

where `password_prk` is the existing extract of §11.4 and `device_share` is
the phone-held 32-byte secret. Both inputs are required; neither alone
yields anything. The locator derivation (§11.4) is **unchanged** — the
capsule is *found* with the password alone and *opened* only with both.

Enabling or disabling the second factor is a **credential event** (§12.2):
the client republishes the credential capsule at the same locator with an
incremented generation and `created_at` per §24.6, switching between the
plain and gated envelope forms. No other machinery changes.

**Honest limitation (mirrors §18.3):** enabling the second factor does not
protect capsule generations an attacker downloaded *before* it was enabled.
Those old copies remain decryptable with the password alone, forever. The
enable screen must disclose this; users who suspect prior password
compromise need rotation (§18.4), not 2FA.

---

# SF6. Enrollment ceremony

Preconditions: user is signed in on a primary device; has the BitLogin PWA
(or a compatible client) on the phone to be enrolled; has confirmed saved
backup codes (§SF8) — **enrollment shall refuse to complete before backup
codes are confirmed**, because 2-of-2 with a lost phone would otherwise be a
lockout (§SF9).

1. Primary device generates an ephemeral pairing keypair and a pairing
   session id, and renders a QR: `{pairing_pubkey, session_id, relay_hints,
   expiry}` (expiry ≤ 5 minutes).
2. Phone scans the QR, generates its device factor keypair and device share,
   and opens an encrypted channel to the pairing pubkey over the hinted
   relays (NIP-44, ephemeral event kinds — relays are transport only and
   store nothing).
3. Both screens display a **short confirmation code** derived from the
   channel transcript hash (e.g. 6 digits of
   `SHA256(transcript)`). The user visually confirms they match and types
   the phone's code into the primary device. This is the familiar "enter the
   6-digit code" moment; it authenticates the pairing against a
   machine-in-the-middle on the relay path, is one-shot, and is never a
   stored secret (§SF2).
4. Phone sends its device pubkey (not the share) over the confirmed channel.
5. Primary device rebuilds the credential capsule in gated-envelope form:
   it derives `split_capsule_key` — which requires the device share, so the
   phone performs the HKDF locally and returns only the resulting
   `split_capsule_key` over the confirmed channel; the share itself still
   never leaves the phone — encrypts, publishes, verifies readback (§15.6).
6. Both sides wipe the pairing keys. The phone stores its device private key
   and share wrapped per §21.2 and registers a relay subscription for
   approval requests addressed to its device pubkey.

---

# SF7. Sign-in approval flow

With the second factor enabled, any-device login (§16) gains one step:

1. Client derives the locator from login name + password, fetches the
   capsule (unchanged, §16.1–16.2).
2. Client decrypts the **gate** with the password-derived key. On success it
   learns the device pubkey and approval relays.
3. Client generates an ephemeral session keypair and publishes an
   **approval request**: an ephemeral-kind event, authored by the session
   key, p-tagged to the device pubkey, NIP-44-encrypted to it. Contents:
   session pubkey, a random challenge, requesting-client context strings
   (origin/user-agent as claimed, displayed to the user as *unverified*),
   and an expiry ≤ 2 minutes.
4. The phone displays: *"Approve sign-in? (details) — Approve / Deny."* On
   approve, it computes `split_capsule_key` locally (§SF5) and returns it
   NIP-44-encrypted to the session pubkey, then wipes the derived key.
   The device share itself is never transmitted.
5. Client decrypts the payload, validates per §12.4, proceeds as §16.4. All
   session-key material is wiped.

Failure behavior: timeout, denial, and offline phone are indistinguishable
to the requesting client ("approval not received") and surface the fallback
paths: backup code or recovery phrase. Relay unavailability degrades to the
same fallback — approval relays are listed in the gate and should overlap
the vault relays for availability.

Connection hygiene (§23.4) extends naturally: approval traffic uses the
session/device identities and shall not share connections with locator,
recovery, or everyday-identity operations.

---

# SF8. Backup codes

Backup codes reuse the password path's machinery with a different label —
each code is, mechanically, a generated single-use password with its own
locator.

* **Format:** `XXXXX-XXXXX-XXXXX-XXXXX`, Crockford base32, ≥ 80 bits of
  entropy per code. Default: 8 codes per issuance.
* **Derivation:** exactly §11.3–11.4 with the salt label
  `"bitlogin/backup-code-salt/v1"` and the code (uppercased, hyphens
  stripped) in place of the password; the login name is *not* an input, so a
  code alone suffices during recovery. Distinct HKDF info labels
  (`bitlogin/backup-locator-signing/v1`,
  `bitlogin/backup-capsule-encryption/v1`).
* **Capsule:** one kind-30078 event per code, `d` tag
  `bitlogin:backup:v1`, authored by the code's locator, containing a
  standard credential payload (§12.1) in a **plain** (version-1) envelope —
  backup codes are the escape hatch and are deliberately not gated by the
  second factor.
* **Issuance** requires only a signed-in session (everyday key in memory).
  Codes are displayed once. An encrypted registry of issued-code locator
  pubkeys (a NIP-78 record under the everyday identity) lets honest clients
  show "6 of 8 codes remaining" and support "regenerate all codes," which
  tombstones (§18.1) every outstanding code capsule and issues fresh ones.
* **Use:** "Sign in with a backup code" derives the locator, fetches,
  decrypts, restores the identity, forces establishment of a new login
  name/password (as §17.4), and then tombstones the used code's capsule and
  updates the registry.
* **Honest limitation:** as everywhere in this protocol (§18.3), tombstoning
  cannot revoke copies already downloaded. A backup-code capsule remains
  decryptable by its code for anyone who saved the ciphertext. Codes are
  high-entropy, so this is the same accepted risk as the password path —
  but "single-use" is a relay-layer promise, not a cryptographic one, and
  the interface must not claim otherwise.

---

# SF9. Interaction with the recovery phrase

The recovery phrase remains the root of last resort and is **never** gated
by the second factor:

* Phrase recovery (§17) proceeds identically whether or not 2FA is enabled,
  and — because it establishes a fresh credential capsule — recovery is also
  the *disable* path when the phone is lost: recover with the phrase (or a
  backup code), and the newly published credential capsule is ungated.
* Corollary, stated plainly: **the second factor does not protect against
  phrase theft** (§29.6 is unchanged), nor against theft of an unused backup
  code. It protects one thing well: a stolen or cracked *password* alone no
  longer opens the current account.
* Consequently the lockout matrix is:

```text
Lost phone                    → sign in with backup code or phrase; re-enroll
Lost phone + forgot password  → backup code or phrase
Lost everything except phrase → phrase (unchanged, §17)
Lost everything incl. phrase  → unrecoverable (unchanged, §19.4)
```

---

# SF10. Imported identities

An existing Nostr identity may be used as the everyday identity under all
of the above (§28.1 anticipated this; the everyday key is by design never
derived from any BitLogin secret, §7.2, §10.4).

**Flow:** the import screen accepts an `nsec` or 32-byte hex key. The client
validates the scalar, derives the public key, and displays it for the user
to confirm against their known `npub`. Registration then proceeds exactly as
§15 with key generation skipped: a **new** BitLogin recovery phrase is
generated, both capsules are built around the imported key, and the
second factor and backup codes layer on with no differences whatsoever.
The public key is the only pre-existing material; the wrapper is identical.

**Required disclosures:**

1. *Prior exposure is out of scope.* BitLogin secures its own storage of the
   key. Copies that already exist — browser extensions, other signers, old
   clipboard managers, backups — remain live attack surface, and the
   security of the imported account is the minimum of BitLogin's guarantees
   and the key's prior handling. If the key may already be compromised,
   the correct move is rotation to a fresh identity (§18.4), not import.
2. *The paste is the risk.* Entering an `nsec` into any web page is the most
   dangerous single action in Nostr use. The import field follows §11.10
   (read once, straight to the worker, cleared), the client warns about
   clipboard history, and a malicious build (§22.1) captures the key
   regardless — import on a build you trust.
3. The `npub` alone cannot be imported; the private key is what the capsules
   wrap.

---

# SF11. Threat notes

```text
Adversary holds…                        Outcome with this addendum
──────────────────────────────────────  ──────────────────────────────────────
Password only (current capsule gated)   Locates capsule; opens gate; cannot
                                        decrypt payload; phone shows an
                                        approval prompt the user can deny —
                                        which is also a breach alarm
Password + pre-2FA capsule copy         Full compromise (unchanged, §18.3);
                                        disclosed at enable time
Password + stolen phone                 Full compromise if the phone's §21.2
                                        wrapping (PIN/passkey) is defeated;
                                        software-only PIN wrapping is brute-
                                        forceable by a thief — platform
                                        keystore/passkey wrapping recommended
Stolen phone only                       Nothing (share is not a path by
                                        itself; no capsule decrypts with it)
One unused backup code                  Full account recovery — codes are
                                        credentials; store them like the
                                        phrase
Recovery phrase                         Full compromise (unchanged, §29.6)
Relay operator                          Sees version-2 envelope (2FA in use),
                                        approval-traffic timing between
                                        pseudonymous keys; content and
                                        linkage to the everyday identity
                                        remain encrypted (§SF4, §23.4)
```

Availability note: phone-approval sign-in adds a live relay round-trip to
login. The phone being offline, or approval relays being unreachable, must
degrade to backup-code/phrase fallback with a clear message — never to an
indefinite spinner.

---

# SF12. Open questions

1. Should the approval response return the derived `split_capsule_key`
   (as specified — simplest) or a blinded share via an OPRF-style exchange
   so the phone learns nothing about login timing content? (Current design
   already reveals only timing to the phone; likely fine.)
2. Passkey/WebAuthn-PRF as the device factor on platforms that support it —
   same protocol, share held by the authenticator, removes the
   PIN-brute-force row from §SF11. Target for the first revision.
3. Multiple enrolled devices (any-of-N approval)? Requires per-device gates
   in the envelope; deferred.
4. Should backup-code capsules pad to the smallest bucket always (they are
   uniform), and should issuance count be user-configurable?
5. Ephemeral-kind number registration for the pairing/approval events, and
   whether approval relays should be required to support NIP-42 AUTH.
```
