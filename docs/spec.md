# BitLogin

## Static, Relay-Backed Portable Account Protocol

**Document version:** 0.6
**Status:** Revised MVP specification (incorporates external protocol review)
**Date:** July 21, 2026
**Client architecture:** Static progressive web application
**Storage architecture:** Nostr relays
**Canonical identity:** Nostr public key
**Daily authentication:** Login name and strong password
**Recovery:** BIP-39 mnemonic phrase
**Email dependency:** None

---

## Changes from v0.5

1. **Registration and password rotation refuse to overwrite an existing account.** Neither `registerAccount` nor `changePassword` checked whether a credential capsule already existed at the locator address they were about to publish to. Since that address is a NIP-33 replaceable event fully determined by login name + password, registering (or rotating to a new password) with a login name + password combination that was already registered — by the same user re-registering by mistake, or by coincidence with someone else's account under a shared login name — silently destroyed the pre-existing account's identity binding, with no way back short of its own recovery phrase. Both flows now query for an existing capsule at the target locator first and refuse with `AccountAlreadyExistsError` if one is found, or with a retry-oriented error if no relay could be reached to check (§15.6, §18.1).

---

## Changes from v0.4

1. **Initial profile publication no longer overwrites an existing profile.** §15.8's kind `0`/`10002`/`10050` publication previously ran unconditionally after every successful registration, including nsec imports — since all three are NIP-01/NIP-65/NIP-17 *replaceable* events, this silently erased an imported identity's real, pre-existing profile and relay lists, replacing them with BitLogin defaults (just the chosen login name as `name`, and only the vault relays). The client now queries for an existing event of each kind before publishing and only fills in whichever one comes back empty, never overwriting one that already exists (§15.8, §28.1).

---

## Changes from v0.3

1. **Rollback detection is now enforced, not just displayed.** §16.2 step 6 previously surfaced a regression against the local generation high-water mark as a warning string while still granting the session — meaning an old, rotated-away password replayed from a relay that never processed its tombstone (§18.1) could fully unlock the account on any device that happened to query that relay. The client now fails closed by default in this case (`RollbackDetectedError`), on both password login and password change; a caller may explicitly override this (`acknowledgeRollback`) for the narrower, non-adversarial case of a single relay merely lagging behind on the *same* password's own capsule. This closes the gap between §16.2's stated guarantee ("a single relay withholding the newest capsule cannot silently roll the account back on a device that has seen the newer generation") and what the reference implementation actually did. The brand-new-device weak case described in §16.2 is unchanged by this — a device with no prior high-water mark still has only the quorum requirement.
2. **NIP-44 extended-length payloads.** The `window.nostr.nip44` surface previously capped plaintext at 65535 bytes; it now implements the full extended-length prefix for payloads up to 2^32-1 bytes, matching the reference `nostr-tools` implementation byte-for-byte (verified by direct cross-implementation round-trip testing, not just unit tests against this codebase's own encoder/decoder pair).
3. **Element-scoped NIP-44 methods.** `<bitlogin-auth>` now exposes `nip44Encrypt`/`nip44Decrypt` directly on the element instance, alongside the existing `getPublicKey`/`signEvent`. A host page holding a reference to its own widget instance can now reach every signing/encryption capability without going through the single shared `window.nostr` slot, which another provider may have since claimed. (The current `window.nostr` shim and this element-scoped mirror are a widget-level convenience layered on top of this protocol, not part of the core numbered spec; see the README's "Embedding BitLogin" section for the full API.)

---

## Changes from v0.2

1. **Padding redefined against relay limits.** Buckets are now specified against the final encoded event size (roughly 2/3.5/6 KiB events via 1024/2048/4096-byte plaintext buckets), and clients must inspect NIP-11 `max_content_length` / `max_message_length` before selecting vault relays. The claim that padding hides capsule *type* is removed — the public `d` tags already distinguish the capsules; padding hides contents and growth only (§11.8).
2. **Monotonic replacement timestamps.** NIP-01 addressable replacement is governed by `created_at` (lowest event ID winning ties), not by the encrypted generation counter. All capsule replacements, tombstones, recovery refreshes, and relay-list updates now use `new_created_at = max(current_time, previous_created_at + 1)`, with clock-skew handling (§24.6).
3. **Argon2 profile honestly labeled.** RFC 9106's second recommended profile uses parallelism 4; BitLogin's `p=1` variant is now explicitly a BitLogin-specific browser-compatibility profile *inspired by* that recommendation, with a published-rationale requirement (§11.2). The default passphrase moves from five to six words for margin (§9.2).
4. **Rollback and recovery guarantees softened.** Password compromise grants no signing authority over the recovery capsule, but recovery *availability and freshness* still depend on relay retention, quorum quality, and the recovery export; an attacker holding an old credential capsule can replay the embedded old recovery event to empty or stale relays. Recovery generations are now hash-chained via `previous_recovery_event_id` for gap detection, and the spec acknowledges that no purely static system can prove a brand-new client has found the globally newest event (§12.3, §14.2, §16.2, §29.7).
5. **Memory claims made implementable.** Secrets necessarily pass through DOM inputs and JS strings; WASM linear memory is itself an ArrayBuffer, and workers compartmentalize but are not a boundary against malicious same-origin code. Requirements now specify shortest-practical-lifetime handling rather than absolute containment (§11.10, §33).
6. **The capsule at the password locator is renamed and minimized.** It is now the **credential capsule**, containing only infrequently changed access material. Profile, contacts, general/DM relay preferences, connected applications, and UI settings are explicitly excluded to avoid multi-device last-write-wins clobbering of a single addressable event (§12.2). Protocol constants retain the `password` naming (§30).
7. **Discovery relays.** The maintainer-signed relay list now also names discovery relays; clients must republish kinds `10002`/`10050` to them, and the recovery export carries the latest signed copies, so phrase recovery has a defined place to find relay preferences (§15.8, §17.4, §19.6).

---

## Changes from v0.1

1. **Split capsule payloads.** The recovery capsule now carries a minimal, immutable payload written only when the recovery phrase is present in memory. The credential capsule carries the full mutable account payload. This resolves the v0.1 gap in which the recovery capsule could never be updated after registration because the recovery signing key is derived from the phrase, which the client does not retain.
2. **Recovery capsule replica repair without the phrase.** The complete signed recovery event is embedded in the credential capsule payload, the local encrypted cache, and the recovery export, so any logged-in client can rebroadcast it to relays that lack it. Rebroadcasting a signed event requires no key material.
3. **Recovery-path vandalism resistance.** Because no password-derived material can sign as the recovery identity, an attacker who cracks the password cannot overwrite or delete the recovery capsule. Password compromise is severe (§29.7) but does not destroy the phrase-recovery path.
4. **Manual passwords prohibited in the alpha.** Users must accept a generated credential. The default is a generated multiword passphrase (§9).
5. **Salt honesty.** The specification now states explicitly that the login name contributes no security and that users sharing a login name share an Argon2id salt, enabling cross-account precomputation for common names (§11.3).
6. **Fixed-size capsule padding.** All capsule plaintexts are padded to fixed size buckets before encryption to remove ciphertext-length fingerprinting (§11.8).
7. **Exact scalar-retry and canonical-serialization rules.** The counter procedure for invalid secp256k1 scalars and the canonical JSON scheme (RFC 8785 JCS) are now precisely specified so independent clients produce identical test vectors (§11.4, §11.9).
8. **Rollback resistance.** Capsule reads require a quorum, and clients maintain a local generation high-water mark and warn on regression (§16.2, §24).
9. **Mandatory tombstones.** Known-password changes must overwrite the old locator's capsule and issue a NIP-09 deletion request (§18.1).
10. **Bootstrap relay update channel.** A maintainer-signed relay-list event plus HTTPS fallback endpoints replace the fully static relay list (§19.1).
11. **NIP-42 AUTH.** The locator and recovery identities are specified as the AUTH signers for capsule queries (§16.1, §17.3).
12. **Network-layer linkage.** The privacy model now covers IP and timing correlation between locator, recovery, and everyday identities, with required client behavior (§23.4).
13. **Secret memory handling.** Sensitive material must live only in WASM linear memory or ArrayBuffers, never JS strings; Argon2id runs in a worker (§11.10, §22.4).
14. **Relay preferences recovered from public events.** Phrase recovery restores relay preferences from the user's own kind 10002 and 10050 events rather than from capsule contents, which is what makes the minimal immutable recovery payload sufficient (§17.4).

---

# 1. Executive Summary

BitLogin provides a familiar account experience:

```text
Login name
Password
Forgot password?
```

Underneath, the account is a portable Nostr identity whose encrypted credentials and messages are retrieved from user-accessible Nostr relays.

BitLogin requires no conventional account server, email address, password-reset email, SMTP service, or centralized user database.

The static BitLogin client performs all sensitive cryptographic operations locally:

```text
Login name + password
        ↓
Password-derived locator identity
        ↓
Encrypted account capsule from Nostr relays
        ↓
Everyday Nostr identity
        ↓
Profile, contacts, messages and applications
```

The account is also protected by an independent recovery layer:

```text
12-word recovery phrase
        ↓
Hidden recovery identity
        ↓
Encrypted recovery capsule from Nostr relays
        ↓
Same everyday Nostr identity
```

The password and recovery phrase provide two independent paths to the same operational Nostr identity.

The two paths are deliberately asymmetric:

* The **credential capsule** (published at the password-derived locator) is minimally mutable: it holds only infrequently changed access material and is rewritten only on credential events such as a password change.
* The **recovery capsule** is minimal and immutable. It is written only at moments when the user has entered the recovery phrase, and it contains only what is needed to reconstruct the everyday identity. Everything else is recovered from the user's own public Nostr events.

The central product principle is:

> A familiar login for an identity the user can actually take with them.

---

# 2. Product Definition

BitLogin is a static client and open account format that stores encrypted account material across Nostr relays.

It is not:

* An email service
* A centralized identity provider
* A custodial key service
* A conventional password database
* A public Nostr relay
* A cryptocurrency wallet
* A guarantee of globally unique usernames

It is:

* A static account client
* A relay-backed encrypted vault
* A password-based roaming login system
* A mnemonic-based recovery system
* A Nostr identity manager
* A foundation for application authentication
* A portable user-account format

---

# 3. MVP User Experience

## 3.1 Create account

The user sees:

```text
Create your BitLogin

Login name
[Generated passphrase, displayed]
```

The client generates the credential. The alpha does not accept user-invented passwords (§9.3).

After account creation, the client displays:

```text
Save your recovery phrase

These 12 words can recover your identity if you forget
your password or lose all of your devices.

We cannot recover these words for you.
```

The user confirms selected words before registration completes.

The client then offers (and strongly encourages) download of an encrypted recovery export file (§19.5).

## 3.2 Sign in on any device

The user opens any compatible BitLogin client and enters:

```text
Login name
Password
```

The client derives a private locator from those credentials, finds the encrypted account capsule on Nostr relays, decrypts the everyday Nostr identity locally, and downloads the user's encrypted messages.

No prior browser storage is required.

## 3.3 Recover account

The user selects:

```text
Recover with phrase
```

They enter the 12-word recovery phrase.

The client derives the hidden recovery identity, locates the recovery capsule, restores the everyday Nostr identity, restores relay preferences from the user's public relay-list events, and asks the user to establish a new login name and password.

Because the phrase is in memory at this moment, the client also refreshes the recovery capsule (§17.5).

## 3.4 Export identity

The user may export:

* The everyday `nsec`
* A password-encrypted `ncryptsec`
* The everyday `npub`
* A BitLogin recovery file
* Relay configuration
* Encrypted application data

The recovery identity remains an internal BitLogin mechanism and should not ordinarily be shown as the user's public identity.

---

# 4. Design Principles

## 4.1 Static first

The complete account client shall be deployable as static files:

```text
index.html
application JavaScript
WebAssembly cryptography modules
stylesheets
manifest
service worker
icons and static assets
```

No application backend is required for registration, login, recovery, profile access, or message synchronization.

## 4.2 Keys remain local

The client shall never transmit plaintext versions of:

* The recovery phrase
* The recovery secret
* The recovery private key
* The password
* The password-derived keys
* The everyday private key
* Decrypted private messages

## 4.3 Relays store ciphertext

Nostr relays serve as a redundant remote storage and synchronization layer.

NIP-78 defines kind `30078` as an addressable event for arbitrary application data and explicitly permits applications to use Nostr relays as personal remote databases. BitLogin uses this capability for encrypted account capsules.

## 4.4 Public key is canonical

The public everyday Nostr key is the actual account identity.

The login name is only a credential input and usability aid. It is not the canonical identity, is not guaranteed to be globally unique, and contributes no security (§11.3).

## 4.5 Passwords are roaming secrets

A password is not merely a server-authentication credential. It deterministically derives:

1. A private relay locator identity
2. A capsule-decryption key

That allows a new device to find and decrypt the correct account without consulting a central database.

## 4.6 Recovery is independent — in both directions

The recovery phrase derives an independent recovery identity and encryption key.

The recovery path does not depend on:

* The password
* The login name
* An email address
* A telephone number
* A particular device
* A BitLogin-operated server

Symmetrically, the password path holds no material that can sign as the recovery identity. An attacker who learns the password can read and impersonate the account (§29.7) but cannot overwrite, replace, or delete the recovery capsule. Password compromise therefore grants no authority over the recovery path — though recovery availability and freshness still depend on relay retention and the user's recovery export (§14.2).

## 4.7 Recovery state is minimal and immutable

The recovery capsule is written only when the phrase is present in memory: at registration, after a phrase recovery, and during rare structural operations that already require the phrase (identity rotation, recovery migration).

It therefore must not carry state that changes during normal use. It carries only what is needed to reconstruct the everyday identity; relay preferences and profile state are recovered from the user's own public Nostr events (kinds `10002` and `10050`) after the everyday key is restored.

## 4.8 Honest limitations

BitLogin must state clearly that publishing a password-encrypted capsule permits offline password guessing.

NIP-49 explicitly recommends against publishing password-encrypted Nostr private keys because attackers can collect the ciphertexts and attempt password cracking. BitLogin accepts this tradeoff only because the credential is generated with high entropy by the client, manual passwords are prohibited in the alpha, and the derivation function is intentionally expensive.

---

# 5. Goals

The MVP shall:

1. Run as a static web application.
2. Create a standard Nostr operational identity.
3. Permit login on a completely new device using a login name and password.
4. Permit recovery using a 12-word phrase.
5. Store only encrypted account material on relays.
6. Download and decrypt private Nostr messages after login.
7. Work without email infrastructure.
8. Work without a centralized account database.
9. Permit identity export.
10. Support multiple redundant relays.
11. Detect corrupted or malicious account capsules.
12. Distinguish forgotten-password recovery from credential-compromise response.
13. Avoid publicly linking the recovery identity, password locator, and everyday identity, at both the event layer and the network layer.
14. Remain implementable by independent compatible clients, with published test vectors.
15. Ensure password compromise grants no signing authority over the recovery capsule.

---

# 6. MVP Non-Goals

The first release will not provide:

* Email addresses
* Email verification
* Password-reset emails
* Inbound or outbound SMTP
* Globally unique usernames
* NIP-05 hosting
* Guaranteed revocation of an old password
* Guaranteed permanent relay retention
* Organization accounts
* Shared family vaults
* Hardware-signing support
* NIP-46 remote signing
* Full password-manager functionality
* Cryptocurrency-wallet functionality
* Custodial account recovery
* Attachments or large-file storage
* Complete forward secrecy for messaging
* Protection against a malicious BitLogin client build
* User-invented passwords (alpha)

---

# 7. Identity and Key Hierarchy

BitLogin uses two durable Nostr identities and one password-derived locator identity.

## 7.1 Recovery identity

The recovery identity is deterministically derived from the recovery phrase.

It is used only to:

* Sign the recovery capsule
* Locate the recovery capsule
* Authenticate to relays (NIP-42) during recovery
* Support emergency recovery
* Authorize recovery-protocol migrations

It shall not be used for:

* Public profiles
* Social posts
* Direct messages
* Payments
* NIP-05
* Application authentication
* Normal user activity

The recovery signing key exists in client memory only while the phrase itself is in memory. It is never stored in the credential capsule, the local cache, or any export.

## 7.2 Everyday identity

The everyday identity is a randomly generated secp256k1 Nostr keypair.

It is used for:

* The public Nostr profile
* Direct messages
* Contacts and follows
* Application authentication
* Signed user events
* Future BitLogin integrations

The everyday identity is not derived directly from the recovery phrase.

This permits BitLogin to:

* Import an existing `nsec`
* Rotate an operational identity
* Store multiple identities under one recovery root
* Add application-specific keys later
* Change the account structure without changing the recovery phrase

## 7.3 Password locator identity

The login name and password deterministically derive a third Nostr-compatible keypair.

This locator identity is not presented to the user as an account.

Its public key functions as the private address of the credential capsule:

```text
login name + password
        ↓
Argon2id
        ↓
HKDF-separated locator private key
        ↓
Locator public key
        ↓
Query relays for its kind-30078 event
```

Because the locator public key appears pseudorandom, relays do not need to receive the plaintext login name.

## 7.4 Conceptual hierarchy

```text
Recovery phrase
├── Recovery signing identity        (in memory only while phrase is entered)
└── Recovery capsule encryption key
         ↓
   Recovery capsule (minimal, immutable)
         ↓
   Everyday identity

Login name + password
├── Password locator identity
└── Credential capsule encryption key
         ↓
   Credential capsule (minimal, credential events only)
         ↓
   Everyday identity
         +
   Embedded signed recovery event (for rebroadcast repair only)
```

## 7.5 Write-authority matrix

```text
Operation                              Requires
─────────────────────────────────────  ─────────────────────────
Publish/replace credential capsule       Password (locator key)
Tombstone old credential capsule         Old password (old locator key)
Publish/replace recovery capsule       Recovery phrase
Rebroadcast existing recovery event    Nothing (event is already signed)
Rotate everyday identity               Recovery phrase
Publish everyday events                Everyday key
```

---

# 8. Login Name Model

## 8.1 Purpose

The login name is an input to password-key derivation. It is not a public identifier and it is not a security factor (§11.3).

A user may have:

```text
Login name: adam
Public display name: Adam Malin
Public identity: npub1...
```

These are separate concepts.

## 8.2 Normalization

For MVP compatibility, login names shall:

* Be normalized to lowercase
* Trim leading and trailing whitespace
* Contain only ASCII characters
* Permit `a-z`, `0-9`, `.`, `_`, and `-`
* Be between 3 and 32 characters
* Not begin or end with punctuation
* Not contain consecutive punctuation

A future protocol version may support broader Unicode names with a precisely specified normalization process.

## 8.3 No global uniqueness

Two users may independently choose the same login name.

They remain separate because their passwords derive different locator identities.

```text
adam + password A → locator A
adam + password B → locator B
```

Applications must never use the BitLogin login name as an immutable user ID.

## 8.4 Changing login names

Changing a login name changes the password-derived salt and therefore changes the locator identity.

Login-name changes are excluded from the MVP user interface, except as the natural consequence of phrase recovery (§17.4).

---

# 9. Password Requirements

## 9.1 Offline-attack threat

An attacker can download the encrypted credential capsule and attempt guesses without interacting with BitLogin.

There is no server-side rate limit in a fully static system.

Security therefore depends on:

* Password entropy
* Memory-hard key derivation
* Correct cryptographic implementation
* User protection of the password

Because users who share a login name share an Argon2id salt (§11.3), a manually invented password receives even less protection than in a conventional system: an attacker targeting a common login name amortizes each Argon2id computation across every account using that name.

## 9.2 Generated credentials

The client generates one of:

* A random multiword passphrase (default — memorable, suitable as a roaming credential)
* A random character password (offered for users who rely on a password manager)

The generated credential must provide comfortably more than 64 bits of entropy. The passphrase default is six words drawn from a large wordlist (for example, the EFF long list at ~12.9 bits per word, giving roughly 77 bits) — a deliberate margin above the 64-bit floor, since password entropy carries most of the defensive load in this design (§11.2).

The client shall not generate credentials from:

* User names
* Dates
* Dictionary phrases
* Quotes
* Repeated patterns
* User-provided personal information

## 9.3 Manual passwords prohibited in alpha

The alpha shall not accept a user-invented password. The "choose your own password" affordance is the single largest avoidable risk in this design, because a downloadable capsule cannot be rate-limited.

A later release may permit manual passwords behind an advanced setting with:

* A hard minimum-entropy estimate
* Rejection of known weak and breached patterns
* An explicit warning that offline guessing cannot be prevented
* A one-tap replacement with a generated passphrase

A conventional requirement such as "eight characters, one number, and one symbol" is inadequate for this design and must never be presented as sufficient.

---

# 10. Recovery Phrase

## 10.1 Format

The MVP uses a 12-word English BIP-39 mnemonic generated from 128 bits of cryptographically secure randomness.

BIP-39 defines 12-word mnemonics for 128 bits of initial entropy plus a checksum. It specifies conversion from the mnemonic into a 512-bit seed using PBKDF2-HMAC-SHA512.

## 10.2 BitLogin-specific use

The recovery phrase is a **BitLogin recovery phrase**, not a Bitcoin-wallet seed.

The interface shall display:

> Never enter a Bitcoin or other cryptocurrency-wallet recovery phrase into BitLogin.

The phrase must be newly generated for BitLogin.

## 10.3 No BIP-39 passphrase in MVP

The optional BIP-39 passphrase feature shall not be exposed in the MVP.

A hidden additional passphrase could produce a valid but entirely different recovery identity, creating a serious support and permanent-loss risk.

## 10.4 Operational key independence

BitLogin does not use NIP-06 to derive the everyday identity.

NIP-06 currently describes BIP-39-based Nostr derivation but marks the method as draft, optional, and unrecommended in favor of a single `nsec`. BitLogin instead uses the mnemonic only to derive its hidden recovery root; the everyday `nsec` remains an ordinary random Nostr key.

---

# 11. Cryptographic Construction

## 11.1 Required primitives

BitLogin v1 requires:

* Cryptographically secure random generation
* BIP-39 English mnemonic encoding
* PBKDF2-HMAC-SHA512 for BIP-39 seed production
* Argon2id for password derivation
* HKDF-SHA256 for domain-separated subkeys
* secp256k1 Schnorr signatures
* SHA-256
* AES-256-GCM authenticated encryption
* RFC 8785 canonical JSON serialization (JCS)
* Canonical UTF-8 processing

Implementations must use audited, well-maintained libraries and the published BitLogin test vectors (§32, Phase 0 deliverable).

## 11.2 Password KDF profile

BitLogin v1 uses:

```text
Algorithm: Argon2id
Memory: 64 MiB
Iterations: 3
Parallelism: 1
Output: 32 bytes
Version: 0x13
```

RFC 9106 describes Argon2 as a memory-hard password function and identifies Argon2id as the required general variant. Note that the RFC's second recommended profile is three passes over 64 MiB **with parallelism 4**; `bitlogin-argon2id-v1` deliberately reduces parallelism to 1 because multithreaded Argon2 in browser WASM (SharedArrayBuffer, cross-origin-isolation headers) is unreliable across deployment targets, and a single fixed parameter set must derive identically everywhere. It is therefore a BitLogin-specific profile *inspired by* RFC 9106, not the RFC profile itself, and the published rationale and benchmarks must say so. The reduced parallelism is acceptable because generated high-entropy credentials (§9.2) carry most of the defensive load.

The implementation must benchmark this profile on representative mobile and desktop hardware before release, and must run the computation in a Web Worker so the interface remains responsive (§11.10).

A future BitLogin version may add stronger KDF profiles, but v1 credentials must derive identically across compatible clients.

## 11.3 Password salt — properties and honesty

The deterministic password salt is:

```text
SHA256(
  "bitlogin/password-salt/v1"
  || 0x00
  || normalized_login_name
)
```

The first 16 bytes are supplied as the Argon2id salt.

The deterministic salt is necessary because a new client must derive the locator before downloading account data. It has two consequences that the specification states plainly:

1. **The login name contributes no security.** All credential entropy comes from the password. The login name is a convenience and a salt input, nothing more.
2. **Users sharing a login name share a salt.** An attacker who bulk-collects BitLogin capsules can compute Argon2id once per (common login name, candidate password) pair and test the result against every collected capsule simultaneously. Per-account salt separation exists only between distinct login names.

There is no fix for this within deterministic derivation; it is the reason generated high-entropy credentials are mandatory in the alpha (§9.3).

## 11.4 Password key separation

Let:

```text
password_root = Argon2id(
  password = NFKC(password),
  salt = password_salt,
  profile = bitlogin-argon2id-v1
)
```

Then:

```text
password_prk = HKDF-Extract(
  salt = SHA256("bitlogin/password-root/v1"),
  IKM = password_root
)
```

Derive:

```text
locator_material = ScalarExpand(
  password_prk,
  "bitlogin/password-locator-signing/v1"
)

password_capsule_key = HKDF-Expand(
  password_prk,
  "bitlogin/password-capsule-encryption/v1",
  32
)
```

**ScalarExpand** is defined exactly as follows so that independent implementations agree:

```text
ScalarExpand(prk, info):
  for counter in 0x00 .. 0xFF:
    candidate = HKDF-Expand(prk, info || 0x00 || counter, 32)
    interpret candidate as a big-endian 256-bit integer d
    if 1 <= d < n (secp256k1 group order):
      return d
  fail
```

`info || 0x00 || counter` means the UTF-8 bytes of the info string, followed by a single zero byte, followed by a single counter byte. The first candidate (counter `0x00`) is valid with overwhelming probability; the loop exists so that the rare invalid case is handled identically everywhere and appears in the test vectors.

The same raw material must never be used directly for both signing and encryption.

## 11.5 Recovery root derivation

The BIP-39 phrase is converted to a 64-byte seed using an empty BIP-39 passphrase.

Then:

```text
recovery_prk = HKDF-Extract(
  salt = SHA256("bitlogin/recovery-root/v1"),
  IKM = bip39_seed
)
```

Derive:

```text
recovery_signing_material = ScalarExpand(
  recovery_prk,
  "bitlogin/recovery-signing/v1"
)

recovery_capsule_key = HKDF-Expand(
  recovery_prk,
  "bitlogin/recovery-capsule-encryption/v1",
  32
)
```

## 11.6 Everyday identity generation

The client generates 32 random bytes using the browser's cryptographically secure random generator.

The value is rejected and regenerated if it is not a valid secp256k1 private scalar.

The corresponding Nostr public key is calculated and verified before any capsule is published.

## 11.7 Capsule encryption

Each capsule uses AES-256-GCM with:

```text
Key: Credential capsule key or recovery capsule key
Nonce: Fresh random 96-bit nonce
Plaintext: Padded, canonically serialized payload (§11.8, §11.9)
Associated data: Capsule context string
```

Password-capsule associated data:

```text
bitlogin|password-capsule|v1|<locator-pubkey>|30078|bitlogin:password:v1
```

Recovery-capsule associated data:

```text
bitlogin|recovery-capsule|v1|<recovery-pubkey>|30078|bitlogin:recovery:v1
```

A nonce must never be reused with the same key. Since each publication uses a freshly generated nonce and capsule rewrites are infrequent, random 96-bit nonces are acceptable.

## 11.8 Payload padding

Before encryption, the serialized payload is padded to a fixed plaintext bucket:

```text
padded = payload_length (4 bytes, big-endian) || payload || zero bytes
```

The padded length shall be the smallest of `1024`, `2048`, or `4096` bytes that fits. A payload exceeding 4096 bytes minus overhead is invalid.

Buckets are sized against **final encoded event size**, not plaintext ambition: after AES-GCM, base64url encoding, and event JSON overhead, these buckets produce complete events of roughly 2, 3.5, and 6 KiB. NIP-11 lets relays advertise `max_content_length` and `max_message_length`, with example limits around 8 KiB of content and 16 KiB per WebSocket message; the largest BitLogin event must clear common limits with room to spare. Clients shall read a relay's NIP-11 document before selecting it as a vault relay and reject relays whose advertised limits cannot carry the largest bucket.

Rationale: §23.1 identifies ciphertext size as relay-visible. Fixed buckets prevent observers from fingerprinting approximate payload contents or watching a specific account's payload grow over time. Padding does **not** hide capsule type — the public `d` tags (`bitlogin:password:v1`, `bitlogin:recovery:v1`) already distinguish credential from recovery capsules explicitly.

## 11.9 Canonical serialization

All capsule payloads are serialized using RFC 8785 (JSON Canonicalization Scheme) before padding and encryption. The AEAD tag therefore covers a byte-exact canonical form, and independent implementations produce identical ciphertext inputs for identical logical payloads.

## 11.10 Secret memory handling

JavaScript strings are immutable and freely copied by the engine; "zeroing" them is not meaningful. Some exposure is also unavoidable: the password and mnemonic must be typed into and displayed by the DOM, WASM linear memory is itself exposed to JavaScript as an `ArrayBuffer`, and a Web Worker compartmentalizes work but is not a security boundary against malicious same-origin code. The requirements are therefore about minimizing lifetime and surface, not absolute containment:

* Sensitive values shall have the shortest practical lifetime in DOM and JavaScript string form: input fields are read once, their values transferred immediately to the cryptographic worker, and the fields cleared.
* Derived secrets and private keys live in the worker's WASM linear memory or `ArrayBuffer`s and are overwritten when the operation completes or the session locks.
* Argon2id and PBKDF2 run inside a Web Worker holding its own WASM instance, keeping expensive derivation off the UI thread and key material out of UI-thread scope.
* Secrets must never be persisted, logged, or included in exceptions, analytics, `postMessage` payloads to non-worker contexts, or serialized application state.

This does not defeat a compromised browser or a malicious application build (§22.1, §29.8); it prevents casual persistence and accidental copies.

---

# 12. Capsule Payloads

v0.3 defines two payload schemas. The credential capsule carries only infrequently changed access material. The recovery capsule carries a minimal immutable core. Earlier draft schema identifiers (`bitlogin.account.v1/v2`, `bitlogin.recovery.v2`) are void — no deployment used them — and must be rejected.

## 12.1 Credential payload (credential capsule)

```json
{
  "schema": "bitlogin.credential.v1",
  "account_id": "base64url-128-bit-random-id",
  "generation": 4,
  "operational_private_key": "base64url-32-bytes",
  "operational_public_key": "lowercase-hex",
  "recovery_public_key": "lowercase-hex",
  "recovery_capsule_event": { "...complete signed kind-30078 event..." },
  "created_at": 1784600000,
  "vault_relay_hints": [
    "wss://relay-one.example",
    "wss://relay-two.example",
    "wss://relay-three.example"
  ],
  "protocol": {
    "password_kdf": "argon2id-v1",
    "capsule_encryption": "aes-256-gcm-v1",
    "recovery_derivation": "bitlogin-bip39-hkdf-v1"
  }
}
```

`recovery_capsule_event` is the complete signed recovery event (§14). It exists so that any logged-in client can rebroadcast the recovery capsule to relays that lack it (§24.4) — rebroadcasting a signed event requires no key material. It confers no signing ability.

## 12.2 What the credential capsule deliberately excludes

The credential capsule is an addressable event replaced wholesale on every write. Two simultaneously active devices that both rewrite it race on `created_at` (§24.6), and the loser's changes are silently clobbered. The only defense available to a last-write-wins record is to keep it small and rarely written.

Therefore the following live **outside** the capsule, in the user's own public or separately encrypted Nostr events, where per-record replacement semantics apply:

* Profile → kind `0`
* General relay preferences → kind `10002`
* DM relay preferences → kind `10050`
* Contacts → kind `3`
* Connected applications, UI settings → separate encrypted application records (NIP-78 events under the everyday identity, out of MVP scope)

The login name is also excluded: it is a derivation input, not stored state.

The capsule is rewritten only on credential events — registration, password change, phrase recovery, KDF migration, identity rotation — never during normal use.

## 12.3 Recovery payload (recovery capsule)

```json
{
  "schema": "bitlogin.recovery.v1",
  "account_id": "base64url-128-bit-random-id",
  "recovery_generation": 3,
  "previous_recovery_event_id": "lowercase-hex-or-null",
  "operational_private_key": "base64url-32-bytes",
  "operational_public_key": "lowercase-hex",
  "recovery_public_key": "lowercase-hex",
  "created_at": 1784600000,
  "vault_relay_hints": [
    "wss://relay-one.example",
    "wss://relay-two.example"
  ],
  "protocol": {
    "capsule_encryption": "aes-256-gcm-v1",
    "recovery_derivation": "bitlogin-bip39-hkdf-v1"
  }
}
```

The recovery payload deliberately excludes everything that changes during normal use. `vault_relay_hints` is a best-effort snapshot from the moment of writing; recovery must succeed from bootstrap relays alone. Current relay preferences are restored after recovery from the user's own public kind `10002` and `10050` events on the discovery relays (§17.4, §19.6).

`recovery_generation` increments only when a new recovery capsule is written, which occurs only when the phrase is in memory (§14.1). `previous_recovery_event_id` is the event ID of the recovery capsule being replaced (null at registration), forming a hash chain: when a client can see multiple recovery generations, it can detect gaps and replays. The chain aids detection, not proof — no purely static system can prove that a brand-new client has found the globally newest event without trusted prior state, an external witness, or an authoritative service. That boundary is fundamental, and the interface must not imply otherwise.

## 12.4 Required validation

After decryption, the client shall verify:

1. The schema is supported.
2. The account ID is correctly formed.
3. The private key is exactly 32 bytes and a valid scalar.
4. The calculated public key matches `operational_public_key`.
5. The recovery public key has valid encoding, and — for the credential capsule — matches the author of the embedded `recovery_capsule_event`.
6. The embedded recovery event, if present, has a valid event ID and signature.
7. All relay URLs use an allowed scheme.
8. The generation is within supported bounds.
9. When multiple recovery generations are available, the `previous_recovery_event_id` chain is consistent; a broken chain triggers a warning.
10. The declared payload length (§11.8) is consistent and within the bucket.
11. No unknown required features are present.

Failure of any validation aborts login.

---

# 13. Credential Capsule Event

The credential capsule is published as:

```json
{
  "pubkey": "<password-locator-public-key>",
  "created_at": 1784600000,
  "kind": 30078,
  "tags": [
    ["d", "bitlogin:password:v1"]
  ],
  "content": "<encoded-encrypted-envelope>",
  "sig": "<locator-signature>"
}
```

The encrypted envelope contains:

```json
{
  "version": 1,
  "algorithm": "aes-256-gcm",
  "nonce": "<base64url>",
  "ciphertext": "<base64url>"
}
```

The event is signed by the password-derived locator key. Replacements follow the monotonic timestamp rule of §24.6.

The event contains no public login name, everyday public key, recovery public key, message metadata, or profile information.

Note on discoverability: the constant `d` tag makes every BitLogin credential capsule trivially collectible by anyone querying relays. This is accepted rather than hidden — the capsules are pseudonymous ciphertext addressed by pseudorandom keys, and their security rests entirely on the generated credential and the KDF (§4.8, §11.3). Obscuring the `d` tag would add negligible protection since kind 30078 alone narrows the set.

---

# 14. Recovery Capsule Event

The recovery capsule is published as:

```json
{
  "pubkey": "<recovery-public-key>",
  "created_at": 1784600000,
  "kind": 30078,
  "tags": [
    ["d", "bitlogin:recovery:v1"]
  ],
  "content": "<encoded-encrypted-envelope>",
  "sig": "<recovery-signature>"
}
```

The event is signed by the hidden recovery identity.

## 14.1 Write moments

A new recovery capsule may be created only at moments when the recovery phrase is in client memory:

1. Registration (§15).
2. Completion of a phrase recovery (§17.5).
3. Everyday-identity rotation (§18.4), which requires the phrase.
4. Recovery-derivation migration (§30.2), which requires the phrase.

At all other times the recovery capsule is immutable. Clients repair replicas by rebroadcasting the embedded signed event (§24.4), never by re-signing.

## 14.2 Vandalism resistance

Because the password path holds no recovery signing material, compromise of the password cannot be escalated into forging or re-signing the recovery capsule. Relays only accept a replacement for this addressable event from its author.

Two honest caveats bound this property. First, an attacker holding an old credential capsule also holds the old signed recovery event embedded in it, and can replay that valid event to relays that are empty or have lost the newer one; honest relays already holding the newer event will not regress, because NIP-01 replacement retains the higher `created_at` (§24.6), but freshness on stale relays is not guaranteed. Second, availability of the recovery capsule at all depends on relay retention and quorum quality.

The accurate statement is therefore: **password compromise alone grants no cryptographic authority to replace the recovery capsule; recovery availability and freshness still depend on relay retention, quorum quality, and the user's recovery export.** Within those limits, the phrase-recovery and identity-rotation path (§18.4) remains open to the victim, and the hash chain (§12.3) lets clients detect replayed stale generations whenever a newer one is also visible.

---

# 15. Registration Flow

## 15.1 User input

The user selects a login name. The client generates the credential (§9.2).

## 15.2 Recovery generation

The client:

1. Generates 128 bits of secure randomness.
2. Encodes it as a 12-word BIP-39 mnemonic.
3. Displays the phrase.
4. Requires confirmation of randomly selected words.
5. Derives the recovery signing identity and recovery capsule key.

## 15.3 Everyday identity

The client:

1. Generates the everyday private key.
2. Calculates the everyday public key.
3. Creates the account ID.

## 15.4 Recovery capsule first

The client:

1. Builds the recovery payload (§12.3), with `previous_recovery_event_id` null.
2. Serializes canonically, pads, and encrypts with the recovery capsule key.
3. Signs the recovery capsule event with the recovery identity.

The recovery capsule is built before the credential capsule so its signed event can be embedded in the account payload.

## 15.5 Password path

The client:

1. Normalizes the login name and password.
2. Derives the deterministic Argon2id salt.
3. Runs Argon2id in a worker.
4. Derives the locator signing key and credential capsule key.
5. Builds the credential payload (§12.1), embedding the signed recovery event.
6. Serializes canonically, pads, and encrypts.
7. Signs the credential capsule event.

## 15.6 Publication

Before publishing anything, the client checks whether a credential capsule already exists
at the locator address this login name + password derive to. That address is a NIP-33
replaceable event: publishing over one that already exists there would silently destroy
whatever account is already bound to it, with no way back short of that other account's
own recovery phrase. Any validly signed event found at the address — decryptable by this
client or not — refuses registration outright (`AccountAlreadyExistsError`); if no relay
can be reached to check, registration also refuses rather than proceed on an unverifiable
assumption of emptiness. This check requires knowing the same login name + password an
existing account was registered with, so it is not subject to §16.3's login/no-account
non-disclosure rule — reaching this state is already equivalent to being able to log in
as that account.

Once the check passes, both the recovery and credential events are published to the
configured vault relays.

The registration succeeds only when:

* At least two relays acknowledge each capsule.
* At least two relays return the correct event during readback.
* All returned signatures and event IDs validate.
* The client can decrypt both downloaded copies.

After success, the recovery signing key and phrase-derived material are erased from memory (§11.10).

## 15.7 Recovery export

The client then offers the encrypted recovery export (§19.5) and strongly encourages the user to save it before continuing.

## 15.8 Initial profile publication

After successful capsule backup, the client may publish:

* Kind `0` profile metadata
* Kind `10002` general relay preferences
* Kind `10050` preferred DM relays

NIP-65 uses kind `10002` for general read/write relay preferences and recommends small relay lists. NIP-17 uses kind `10050` for preferred private-message relays. These public events are also what phrase recovery uses to restore relay preferences (§17.4), so publishing kinds `10002` and `10050` is required, not optional, in the MVP — and they must be published to the discovery relays (§19.6) in addition to the user's own general relays, so that phrase recovery has a defined place to find them.

Kinds `0`, `10002`, and `10050` are all NIP-01/NIP-65/NIP-17 *replaceable* events: a relay keeps only the newest one it has seen for a given public key, and every other client treats that newest copy as authoritative. This matters because the everyday identity behind a BitLogin account is not always brand new (§28.1) — an imported `nsec` may already have a real kind `0` profile (display name, bio, avatar, NIP-05) and/or kind `10002`/`10050` lists published elsewhere. Before publishing any of the three, the client **must** query the target relays for an existing event of that kind for this public key; it publishes a default only for whichever kind comes back empty, and never overwrites one that already exists. A freshly generated identity has nothing to find, so this check is a no-op for the common case and only changes behavior for imports.

Everyday-identity events shall not be published over the same relay connections used for capsule operations in the same session (§23.4).

---

# 16. Any-Device Password Login

A completely new client performs the following:

```text
Login name + password
        ↓
Normalize inputs
        ↓
Argon2id (worker)
        ↓
Derive locator identity and capsule key
        ↓
Query bootstrap relays (quorum)
        ↓
Download credential capsule
        ↓
Verify event signature
        ↓
Decrypt account payload
        ↓
Verify everyday keypair
        ↓
Load Nostr account
```

## 16.1 Relay query

The client queries each bootstrap relay for:

```json
{
  "kinds": [30078],
  "authors": ["<locator-public-key>"],
  "#d": ["bitlogin:password:v1"],
  "limit": 5
}
```

`limit: 5` exists to collect multiple candidate versions for generation selection (§16.2), not because multiple valid events are expected.

If a relay demands NIP-42 AUTH before serving the query, the client authenticates with the locator key. The locator identity is the AUTH signer for password-capsule operations; the everyday identity must not be used, as that would link the identities at the relay.

## 16.2 Capsule selection and rollback resistance

The client:

1. Queries all configured bootstrap relays and waits for responses (or timeouts) from a quorum — at least ⌈N/2⌉ of N configured relays — before selecting.
2. Rejects invalid event IDs, invalid signatures, and unsupported schemas.
3. Groups valid events by generation.
4. Attempts decryption from newest to oldest.
5. Accepts the highest valid generation.
6. Compares the accepted generation against the device's stored high-water mark for this account, if any. A regression fails closed by default (§29.7): the client refuses to grant a session rather than merely warning, since it cannot distinguish an old, rotated-away password being replayed from a relay that never processed its tombstone (§18.1) from a relay that is simply lagging behind. A caller may explicitly override this (`acknowledgeRollback`) for the latter case; the client must still surface the same warning to the human either way.
7. Updates the local high-water mark on success.
8. Warns if responsive relays disagree about the latest generation.

A single relay withholding the newest capsule therefore cannot silently roll the account back on a device that has seen the newer generation — step 6 is now an enforced refusal, not just a display. A brand-new device has only the quorum requirement, which is a weaker defense: if a majority of responsive relays are stale, censored, or malicious, a new device cannot detect the rollback. This is a fundamental limit of trust-on-first-use in a static system, and the interface must not overstate the protection.

## 16.3 Failure behavior

The public error should be:

```text
Account not found or credentials incorrect.
```

The client should not disclose whether the locator event exists, whether a login name is in use, or whether a capsule failed to decrypt.

## 16.4 Successful unlock

The everyday private key remains in WASM/ArrayBuffer memory only (§11.10).

It must not be stored in plaintext in local storage, IndexedDB, cookies, service-worker caches, crash reports, analytics, or console logs.

---

# 17. Recovery Flow

## 17.1 Phrase entry

The user enters the 12-word phrase.

The client validates word count, wordlist membership, BIP-39 checksum, and Unicode normalization.

## 17.2 Recovery derivation

The client derives the recovery signing key, recovery public key, and recovery capsule key.

## 17.3 Recovery lookup

The client queries bootstrap relays (and any relays from a supplied recovery export) for:

```json
{
  "kinds": [30078],
  "authors": ["<recovery-public-key>"],
  "#d": ["bitlogin:recovery:v1"],
  "limit": 5
}
```

The same quorum rule as §16.2 applies. If AUTH is demanded, the recovery identity signs it.

## 17.4 Identity reconstruction

The client:

1. Verifies the recovery event.
2. Decrypts the capsule and validates the everyday keypair.
3. Displays the recovered public identity.
4. Fetches the user's kind `10002` and `10050` events by everyday public key from the discovery relays (§19.6), from any relays named in a supplied recovery export (which carries signed copies of these events, §19.5), and from `vault_relay_hints` as additional targets.
5. Asks the user to establish a login name and new password.
6. Publishes a new credential capsule with an incremented generation.

The everyday Nostr identity remains unchanged.

## 17.5 Recovery capsule refresh

Because the phrase is in memory during this flow, the client shall also:

1. Build a fresh recovery payload with incremented `recovery_generation`, `previous_recovery_event_id` set to the event ID of the capsule being replaced, and current vault-relay hints.
2. Encrypt, sign (with `created_at` per §24.6), and publish it as a replacement recovery capsule.
3. Embed the new signed recovery event in the credential capsule published in §17.4.

This is one of the only moments the recovery capsule can be legitimately updated (§14.1), so the client must not skip it.

---

# 18. Password Change and Reset Semantics

BitLogin must distinguish three situations. None of them touches the recovery capsule (§14.1), which is the point of the split-payload design.

## 18.1 Known-password change

The user knows the current password and chooses a new one.

The client:

1. Unlocks the everyday identity.
2. Derives the new locator and capsule key.
3. Checks whether a credential capsule already exists at the *new* locator address (§15.6's same reasoning: this address is fully determined by login name + the chosen new password, and is just as replaceable). If one is found, this refuses with `AccountAlreadyExistsError` rather than proceed — the new password happens to already be registered under this login name by a different account, and rotating onto it would silently destroy that other account's capsule.
4. Publishes a new credential capsule with incremented generation and `created_at` per §24.6.
5. **Mandatorily** publishes a tombstone at the old locator: a replacement kind-30078 event with the same `d` tag, signed by the old locator key, whose content is an empty envelope. Addressable replacement propagates the tombstone to cooperative relays.
6. **Mandatorily** publishes a NIP-09 deletion request from the old locator for the old capsule event.
7. Deletes the old local cache and updates the generation high-water mark.

Steps 4 and 5 shrink the exposure window on honest relays. They do not defeat an attacker who already downloaded the old capsule (§18.3), and the interface must not claim otherwise.

## 18.2 Forgotten-password reset

The user recovers with the phrase (§17) and publishes a new credential capsule. The old credential capsule cannot be tombstoned — its locator key derives from the forgotten password — and this limitation is disclosed (§27.4). The same everyday identity is preserved.

## 18.3 Suspected password compromise

A pure relay-based system cannot guarantee that all copies of the old credential capsule have been deleted.

An attacker who saved the old capsule and possesses the old password may continue to recover the everyday private key.

Therefore:

> Password reset restores access but does not cryptographically revoke an old password-encrypted capsule.

This limitation is fundamental to downloadable, offline-decryptable credentials.

## 18.4 Compromise response

For suspected compromise, BitLogin should recommend operational-identity rotation:

1. Recover the existing identity with the phrase.
2. Generate a new everyday identity.
3. Publish a signed migration statement from the old identity.
4. Republish profile and relay preferences.
5. Notify contacts.
6. Create a new recovery capsule (the phrase is in memory) and a new credential capsule.
7. Retire the old identity from future use.

A compromised Nostr private key itself cannot be revoked retroactively.

Note that §14.2 is what keeps this procedure available: the attacker cannot have destroyed the recovery capsule using the cracked password.

Identity rotation is outside the initial MVP but must be designed before public launch.

---

# 19. Relay Architecture

## 19.1 Bootstrap relays and their evolution

Every BitLogin-compatible client ships with a versioned list of bootstrap vault relays. The MVP should use at least three independent relays.

A pinned list in a static build is the system's most serious long-horizon single point of failure: every dead relay strands old client builds. Therefore v0.2 adds an update channel that preserves the no-server property:

1. **Maintainer relay-list event.** The BitLogin maintainers hold a well-known, pinned public key. They publish a kind-30078 event with `d` tag `bitlogin:bootstrap-relays:v1` whose content is a signed, versioned relay list naming both **vault bootstrap relays** and **discovery relays** (§19.6). Clients query all currently known relays for a newer list at startup, verify the maintainer signature, and merge — never replace — their built-in list with it. A newer list can add relays and mark relays deprecated; it cannot remove the client's ability to query built-in relays.
2. **HTTPS fallback.** The client may additionally fetch the same signed relay-list document from two or more well-known static URLs on independent hosts. The document is verified by the same pinned signature; the transport is untrusted.
3. Compromise of the maintainer key can add hostile relays but cannot read capsules (ciphertext) or forge them (author signatures). The worst case is availability degradation, and built-in relays remain queried.

## 19.2 User vault relays

The decrypted capsule may contain additional user-selected vault relays. Before accepting any relay as a vault relay, the client verifies via its NIP-11 document that advertised size limits can carry the largest capsule bucket (§11.8).

After successful login, the client shall query the additional relays, compare capsule generations, repair missing replicas, and republish the current capsule when appropriate.

## 19.3 Relay independence

No single relay is authoritative. The client determines validity using event signatures, event IDs, capsule decryption, generation numbers, and internal key consistency.

## 19.4 Relay loss

If every relay deletes both account capsules and the user has no exported backup:

* Password login cannot locate the account.
* Phrase recovery cannot locate the account.
* The phrase still derives the recovery identity, but the randomly generated everyday key is unavailable.

The client must therefore strongly encourage the encrypted offline recovery export at registration (§15.7) and periodically remind users who have not saved one.

## 19.5 Recovery export

The recovery file contains:

```json
{
  "schema": "bitlogin.recovery-export.v3",
  "recovery_public_key": "<hex>",
  "vault_relays": ["wss://..."],
  "recovery_capsule_events": ["<complete-signed-event>"],
  "relay_list_events": ["<signed-kind-10002-event>", "<signed-kind-10050-event>"],
  "created_at": 1784600000
}
```

The recovery file contains the already encrypted recovery capsule, but must not contain the recovery phrase or any phrase-derived key.

Possession of the file without the phrase must not reveal the everyday private key. With the file plus the phrase, recovery succeeds even if every relay has deleted the capsules: the client verifies and decrypts the embedded event locally and can rebroadcast it to fresh relays.

## 19.6 Discovery relays

Phrase recovery restores relay preferences from the user's public kind `10002` and `10050` events (§17.4), but no NIP guarantees that an arbitrary bootstrap relay holds them — NIP-17 in particular directs DMs only to the relays in the recipient's own `10050` list. Recovery therefore needs a defined place to look.

The maintainer-signed relay list (§19.1) names a small set of discovery relays. Clients shall republish the user's kinds `10002` and `10050` (and may republish kind `0`) to the discovery relays whenever those events change. These events are public and signed by the everyday identity, so this introduces no new secret and no new linkage beyond what the events themselves already publish.

The recovery export (§19.5) additionally carries the latest signed copies of these events, so recovery succeeds even if the discovery relays have pruned them.

---

# 20. Message Synchronization

## 20.1 Messaging protocol

The everyday identity uses NIP-17 private direct messages.

NIP-17 defines kind `14` chat-message rumors, sealed kind `13` events, and kind `1059` gift wraps encrypted using NIP-44 and NIP-59. It describes messages as recoverable by clients possessing the user's private key.

## 20.2 Login synchronization

After unlocking the everyday identity, the client:

1. Loads the user's kind `10050` DM relay list.
2. Connects to those relays.
3. Authenticates where required (as the everyday identity — DM relays already know this identity).
4. Requests kind `1059` events addressed to the user.
5. Verifies each outer event.
6. Decrypts the gift wrap and verifies the seal.
7. Verifies that the seal author matches the inner rumor author.
8. Reconstructs conversations.
9. Stores an encrypted local index.

NIP-17 explicitly requires checking that the seal and rumor identify the same sender to prevent impersonation.

## 20.3 Sender copy

When sending a message, the client shall create a gift-wrapped copy for every recipient and a separate gift-wrapped copy for the sender, so sent history can be reconstructed on another device.

## 20.4 Message limitations

NIP-44 does not provide full forward secrecy or post-compromise security. A compromised long-term key may expose prior or future encrypted conversations.

BitLogin must not market Nostr messaging as equivalent to a specialized high-risk secure messenger.

## 20.5 Relay retention

Message recovery depends on relay retention. BitLogin should support multiple DM relays, a user-selected archival relay, encrypted local exports, and future encrypted backup identities.

---

# 21. Local Storage

## 21.1 Locked local cache

The client may store encrypted message indexes and bodies, relay cursors, encrypted profile cache, encrypted account preferences, public event data, capsule event copies (including the signed recovery event for rebroadcast), and the per-account generation high-water mark (§16.2).

## 21.2 Device cache key

A random device-cache key is generated locally. It may be wrapped using the user password, a platform passkey, operating-system secure storage, or a WebAuthn credential in a future release.

## 21.3 Plaintext restrictions

The following must never be persisted in plaintext:

* Everyday private key
* Recovery seed or phrase
* Recovery signing key
* Password-root output
* Decrypted messages
* Vault encryption keys

## 21.4 Logout

Logout shall:

1. Overwrite sensitive WASM/ArrayBuffer memory (§11.10).
2. Terminate relay subscriptions.
3. Clear unlocked key objects.
4. Remove decrypted views.
5. Preserve only encrypted cache data and the generation high-water mark.
6. Invalidate in-memory session state.

---

# 22. Static Client Security

## 22.1 Malicious-client limitation

A static web host can serve modified JavaScript that captures passwords, recovery phrases, private keys, and decrypted messages. No browser-based cryptographic system can eliminate this risk when the provider controls the delivered application code.

## 22.2 Required mitigations

BitLogin should provide:

* Open-source client code
* Reproducible builds
* Signed release manifests and published build hashes
* Strict Content Security Policy
* No third-party scripts on sensitive pages; no advertising or behavioral analytics
* Pinned cryptographic dependencies and dependency scanning
* Subresource integrity where applicable
* Independent client implementations
* Installable PWA releases
* Future browser-extension and native clients

## 22.3 Service worker behavior

The service worker may cache static application assets, icons, fonts, and public protocol configuration.

It must not cache recovery phrases, passwords, plaintext private keys, decrypted messages, or sensitive form submissions.

## 22.4 Execution isolation

All key derivation and secret handling occurs in dedicated Web Workers with their own WASM instances (§11.10). The UI thread receives only public keys, signed events, and decrypted display content — never raw key material.

---

# 23. Privacy Model

## 23.1 Relay-visible information

Vault relays can observe locator public keys, recovery public keys, event kinds, `d` tags, event timestamps, fixed-bucket ciphertext sizes (§11.8), client IP addresses, and read/write activity.

They should not learn login names, passwords, everyday public keys from capsules, recovery phrases, everyday private keys, decrypted messages, or account settings.

## 23.2 Public linkage

The password locator event and recovery event must not publicly tag or reference the everyday identity. Their encrypted payloads may contain the everyday key.

## 23.3 Credential probing

A correct password guess derives the correct locator and reveals a decryptable event. This makes relay data an offline credential-verification target. The system's security therefore relies on generated high-entropy credentials rather than server-enforced attempt limits (§9, §11.3).

## 23.4 Network-layer linkage

Event-layer unlinkability (§23.2) is defeated if a relay can correlate identities by connection. A client that fetches a credential capsule and then publishes everyday-identity events over the same connection, from the same IP, within seconds, hands the relay a trivial join.

Required behavior:

1. Capsule operations (locator or recovery identity) and everyday-identity operations shall use separate relay connections.
2. Where a relay serves both roles, the client shall close the capsule connection before opening the everyday connection, and should insert a randomized delay.
3. NIP-42 AUTH during capsule operations uses only the locator or recovery identity (§16.1, §17.3), never the everyday identity.

Residual limitation, stated honestly: a relay can still correlate by IP address and coarse timing. Users with strong unlinkability requirements need Tor or a VPN; BitLogin's client-side measures raise the cost of correlation but do not eliminate it.

---

# 24. Reliability and Conflict Resolution

## 24.1 Generation counters

The credential payload carries `generation`, incremented on every credential-capsule rewrite. The recovery payload carries `recovery_generation`, incremented only at the write moments of §14.1. The counters are independent; clients must not compare them to each other.

## 24.2 Addressable replacement

Kind `30078` is addressable by author and `d` tag, allowing a newer event from the same identity to replace an earlier version on cooperative relays. This is also the tombstone mechanism (§18.1).

## 24.3 Conflicting events

When relays return conflicting valid events with the same generation, the client shall:

1. Attempt decryption of each.
2. Compare account IDs and public keys.
3. Reject unrelated payloads.
4. Prefer the newest event only when account identity matches.
5. Display a security warning.
6. Preserve all conflicting events for diagnostics.

## 24.4 Replica repair

Following successful login, the client should:

1. Republish the current credential capsule to vault relays that lack it, hold an older generation, or return an invalid copy.
2. Rebroadcast the embedded signed recovery event (§12.1) to vault relays that lack the recovery capsule or hold a lower `recovery_generation`. This requires no key material and must not involve re-signing.

## 24.5 Corruption detection

AES-GCM authentication, Nostr event signatures, event IDs, and keypair consistency must all pass. There is no partial-recovery mode for corrupted cryptographic data.

## 24.6 Replacement timestamps

NIP-01 addressable-event replacement is decided by `kind + pubkey + d tag + created_at`, with the lexicographically lowest event ID retained on a timestamp tie. The encrypted generation counters are invisible to relays and play no role in which event a relay keeps.

Every replacement — credential-capsule updates, tombstones, recovery-capsule refreshes, and maintainer relay-list updates — shall therefore set:

```text
new_created_at = max(current_unix_time, previous_event_created_at + 1)
```

where `previous_event_created_at` is the highest `created_at` the client has observed for that address, from relay reads, the local cache, or the embedded recovery event. This guarantees relay-visible monotonicity even when the device clock is behind, and prevents a valid higher-generation capsule from being silently discarded because its timestamp is not newer than the event it replaces.

Clients shall tolerate modest clock skew when reading — a capsule timestamped slightly in the future is not invalid — and shall warn rather than fail when decrypted generation order and event timestamp order disagree, since that combination indicates replay or relay misbehavior (§16.2, §24.3).

---

# 25. Static Deployment

BitLogin may be deployed through Cloudflare Pages, GitHub Pages, Vercel, Netlify, IPFS gateways, Blossom-backed static hosting, local application bundles, and desktop or mobile wrappers.

The static build shall contain no deployment secrets.

Any compatible mirror should be able to access the same account using the same login name, password, protocol version, and bootstrap relay configuration. This permits the user to leave one BitLogin host without abandoning the identity.

---

# 26. Application Authentication

## 26.1 Canonical application subject

Applications shall identify a BitLogin user by the everyday Nostr public key, not by login name.

## 26.2 MVP authentication

The initial client may support signing a displayed challenge, copying the resulting signed event, opening compatible Nostr applications, and exporting the everyday public key.

## 26.3 Future redirect flow

A future "Sign in with BitLogin" flow may use:

```text
Application
    ↓ redirect with challenge and state
BitLogin static client
    ↓ user unlocks identity
Signed Nostr authentication response
    ↓ callback
Application
```

The signed challenge should include the requesting origin, a random nonce, issue and expiration times, requested permissions, callback URI, and application-provided state.

## 26.4 Future signer support

Later releases may support NIP-07, NIP-46, native mobile signers, browser extensions, hardware-backed signing, and permission-scoped application keys.

---

# 27. User Interface Requirements

## 27.1 Protocol terminology

The normal onboarding interface should use: login name, password, recovery phrase, account, messages, profile. It should avoid requiring familiarity with `nsec`, `npub`, NIP numbers, event kinds, Argon2id, or relay filters. These may be shown under Advanced Settings.

## 27.2 Password disclosure

Before account creation:

> Your encrypted account can be downloaded from public relays. BitLogin generates your password because no server can rate-limit guesses against a downloadable file.

## 27.3 Recovery disclosure

Before displaying the phrase:

> Anyone with these words can control your BitLogin identity. BitLogin cannot replace or recover them.

## 27.4 Forgotten-password disclosure

During recovery:

> Recovery preserves your identity, but it cannot erase copies of an older password-encrypted account capsule.

## 27.5 Wallet warning

The recovery screen must state:

> Do not enter a Bitcoin or cryptocurrency-wallet seed phrase.

## 27.6 Export reminder

Users who have not saved a recovery export receive a periodic, dismissible reminder referencing the relay-loss risk (§19.4) in plain language.

---

# 28. Import and Export

## 28.1 Import existing identity

The client may allow the user to import an existing raw `nsec`, hexadecimal private key, or `ncryptsec`. The imported identity becomes the everyday identity and is wrapped by newly generated BitLogin password and recovery capsules.

Wrapping the key in new capsules must never touch anything the identity already had published under its own name. In particular, the initial-profile-publication step (§15.8) applies its existing-event check here specifically: an imported identity commonly already has a real kind `0` profile and/or relay lists, and the client must leave all of that exactly as it found it rather than replacing it with BitLogin defaults.

## 28.2 NIP-49 export

NIP-49 defines the `ncryptsec` format using scrypt and XChaCha20-Poly1305 for password-encrypted Nostr private keys. BitLogin may use it for user-controlled export even though the internal roaming capsule uses a separate versioned format.

## 28.3 Full account export

A complete export should contain the everyday public identity, encrypted everyday private key, signed profile events, relay configuration, encrypted messages or message index, both capsule events, and protocol metadata.

The export must not contain the plaintext recovery phrase unless the user explicitly requests a plainly labeled dangerous export.

---

# 29. Security Threats

## 29.1 Offline password cracking

Mitigations: generated high-entropy credentials only (alpha), Argon2id, salt-sharing disclosure (§11.3), password-manager support, KDF profile upgrades, strong warnings.

## 29.2 Malicious client update

Mitigations: reproducible builds, signed releases, independent mirrors, native and extension clients, no third-party scripts, community verification.

## 29.3 Relay deletion

Mitigations: multiple relays, readback verification, replica repair including recovery-event rebroadcast (§24.4), encrypted offline recovery export, user-selected archival relay.

## 29.4 Relay censorship

Mitigations: replaceable relay list with signed update channel (§19.1), multiple bootstrap relays, manual relay entry, importable recovery events, independent clients.

## 29.5 Capsule substitution and rollback

Mitigations: author signature verification, event-ID verification, AEAD authentication with context-bound associated data, keypair consistency checks, account ID validation, generation checks, quorum reads, the local generation high-water mark (§16.2), monotonic replacement timestamps (§24.6), and the recovery hash chain (§12.3). None of these protects a brand-new device against a stale or malicious relay majority (§16.2).

## 29.6 Recovery-phrase theft

Consequences: everyday identity disclosure, ability to create new password and recovery capsules, complete and irreversible account compromise.

Mitigations: one-time phrase display, secure physical backup, no cloud clipboard, no screenshots by default, optional hardware recovery in later releases.

## 29.7 Password theft

Consequences: everyday identity disclosure from any retained capsule, historical and future impersonation, potential message disclosure.

Changing the password does not invalidate retained old ciphertext (§18.3). The attacker gains no signing authority over the recovery capsule, though they can replay an old embedded recovery event to stale or empty relays (§14.2); within the availability limits stated there, the phrase-recovery and identity-rotation path (§18.4) remains open to the victim. On any device that has previously logged in to the account since the rotation (and so holds a local generation high-water mark), §16.2 step 6 now refuses such a replayed old capsule outright rather than merely warning — the residual exposure is a brand-new device with no local high-water mark, which retains only the weaker quorum defense described in §16.2.

## 29.8 Device malware

BitLogin cannot protect keys after the device or browser execution environment is compromised. §11.10 limits accidental persistence; it is not a defense against a hostile environment.

---

# 30. Protocol Versioning

Every cryptographic object shall include an explicit version. Version identifiers include:

```text
bitlogin.credential.v1
bitlogin.recovery.v1
bitlogin.recovery-export.v3
bitlogin:password:v1
bitlogin:recovery:v1
bitlogin:bootstrap-relays:v1
bitlogin-argon2id-v1
bitlogin-bip39-hkdf-v1
aes-256-gcm-v1
```

Protocol constants containing the word `password` (the `d` tag, AAD strings, derivation labels) are retained even though the payload is now called the credential capsule; renaming wire-level constants for cosmetic consistency would be a compatibility hazard with no security value.

A client must never silently reinterpret an object using a different version.

## 30.1 KDF migration

A stronger password profile creates a new locator identity. The client shall decrypt the old capsule, derive the new locator and key, publish a new capsule, tombstone the old locator (§18.1), retain compatibility instructions, and warn that archived old capsules remain decryptable by the old password.

## 30.2 Recovery migration

Changing recovery derivation requires access to the existing recovery phrase — one of the defined write moments (§14.1). The client must publish a newly encrypted recovery capsule before considering migration complete.

---

# 31. MVP Technical Modules

```text
src/
├── account/
│   ├── create
│   ├── login
│   ├── recover
│   ├── export
│   └── validation
├── crypto/            (WASM boundary; no UI dependencies)
│   ├── random
│   ├── bip39
│   ├── argon2id       (worker-hosted)
│   ├── hkdf
│   ├── scalar-expand
│   ├── aes-gcm
│   ├── padding
│   ├── jcs            (RFC 8785)
│   ├── secp256k1
│   └── memory-handling
├── capsules/
│   ├── password-capsule
│   ├── recovery-capsule
│   ├── serialization
│   └── versioning
├── nostr/
│   ├── events
│   ├── relays         (connection separation per §23.4)
│   ├── auth           (NIP-42, identity-scoped)
│   ├── profiles
│   ├── nip17 / nip44 / nip59
│   └── bootstrap      (signed relay-list channel per §19.1)
├── storage/
│   ├── encrypted-cache
│   ├── high-water-mark
│   ├── relay-cursors
│   └── recovery-export
├── ui/
│   ├── onboarding
│   ├── login
│   ├── recovery
│   ├── inbox
│   └── advanced
└── service-worker/
```

Cryptographic modules expose narrow typed interfaces over WASM memory and must not depend on UI code.

---

# 32. Development Phases

## Phase 0: Cryptographic proof of concept

Demonstrate:

```text
Login name + password
→ deterministic locator
→ kind-30078 lookup
→ capsule decryption
→ same Nostr key on two clean devices
```

And:

```text
12-word phrase
→ recovery identity
→ recovery-capsule lookup
→ same operational key
```

**Phase 0 deliverable:** published test vectors covering Argon2id derivation, ScalarExpand (including a forced counter increment), JCS serialization, padding, replacement-timestamp computation, both capsule encryptions, and both signed events.

**Phase 0 prototype scenarios (two clean devices, three relays):**

```text
create → publish → clean-device password login
recover → rotate password → clean-device login
relay loss → replica repair (including keyless recovery-event rebroadcast)
stale relay → rollback warning
```

## Phase 1: Account MVP

Static application shell, account creation, generated passphrases, phrase confirmation, multi-relay publication with quorum readback, password login, phrase recovery with recovery-capsule refresh, tombstoned password change, identity export, recovery export, encrypted local cache.

## Phase 2: Messaging

Profile publishing, relay preferences (kinds 10002/10050 required), NIP-17 inbox, compose and reply, sent-message recovery, conversation reconstruction, message search over encrypted local index.

## Phase 3: Application identity

Challenge signing, redirect authentication, application permission display, connected-app management, NIP-07 or extension integration.

## Phase 4: Hardening

Independent security review, reproducible builds, native applications, hardware-backed recovery, key-rotation tools, multiple protocol implementations, formal verification of test vectors across implementations.

---

# 33. MVP Acceptance Criteria

The MVP is complete when:

1. The application can be hosted as static files.
2. A new user can create an account without providing email or telephone information.
3. The client generates a valid everyday Nostr identity and a valid 12-word recovery phrase.
4. Password and recovery capsules are encrypted locally, padded to fixed buckets, and published to at least two relays with verified readback.
5. A clean browser on another device can recover the account using only login name and password.
6. A clean browser can recover the account using only the recovery phrase, including restoration of relay preferences from public events.
7. Both paths produce the exact same everyday Nostr public key.
8. Phrase recovery refreshes the recovery capsule and re-embeds it in the new credential capsule.
9. A known-password change tombstones the old locator and issues a NIP-09 deletion request.
10. Incorrect credentials reveal no useful distinction between account absence and decryption failure.
11. The client rejects invalid signatures, corrupted capsules, and generation rollback below the local high-water mark (fails closed by default; an explicit override exists for the non-adversarial relay-lag case, §16.2).
12. Sensitive values have the shortest practical lifetime in DOM and JavaScript string form, are transferred immediately to the cryptographic worker, are never persisted, logged, or serialized, and are never sent to a server or relay in plaintext.
13. Capsule operations and everyday-identity operations never share a relay connection.
14. The client can publish a Nostr profile and kinds 10002/10050.
15. The client can download and decrypt NIP-17 messages; sent messages can be reconstructed on another device.
16. The user can export the everyday identity and an encrypted recovery package, and the recovery package alone plus the phrase suffices to restore the account with all relays lost.
17. Loss of one relay does not prevent login.
18. The interface clearly explains the old-password revocation limitation.
19. No email infrastructure is present in the deployed system.
20. Independent implementation of the published test vectors reproduces identical locators, keys, ciphertext inputs, and replacement timestamps.
21. Every capsule replacement and tombstone is retained by a compliant relay even when the device clock is up to five minutes slow (§24.6).
22. Kinds 10002/10050 are republished to the discovery relays, and the recovery export includes their latest signed copies; phrase recovery on a clean device restores relay preferences from these sources.
23. The largest padded capsule event fits within the NIP-11 limits of every shipped bootstrap relay.

---

# 34. Open Decisions

Resolved since v0.1: manual passwords (prohibited in alpha, §9.3); default credential form (multiword passphrase, §9.2); recovery-capsule update authority (phrase-only write moments, §14.1); tombstones (mandatory, §18.1); bootstrap relay updates (signed maintainer channel, §19.1).

Resolved since v0.2: padding buckets and relay-limit compliance (§11.8); replacement-timestamp semantics (§24.6); Argon2 profile labeling and six-word default (§9.2, §11.2); credential-capsule minimization (§12.2); discovery relays (§19.6); recovery hash chain (§12.3).

Resolved since v0.3: generation-rollback detection now enforced (fail-closed) rather than warn-only (§16.2); NIP-44 extended-length payload support, verified against the `nostr-tools` reference implementation; element-scoped `nip44Encrypt`/`nip44Decrypt` on `<bitlogin-auth>` (see README).

Resolved since v0.4: initial profile publication (§15.8) now checks for an existing kind `0`/`10002`/`10050` event before publishing and never overwrites one that already exists, closing the profile-clobbering gap for imported identities (§28.1).

Resolved since v0.5: registration and password rotation (§15.6, §18.1) now check for an existing credential capsule at the target locator address before publishing and refuse with `AccountAlreadyExistsError` rather than silently overwrite another account's identity binding.

Still open before implementation:

1. Which bootstrap relays ship with the client, and who holds the maintainer relay-list key (single key, or threshold)?
2. How many relay acknowledgments are required — two, or three?
3. Should the recovery phrase use 12 or 24 words?
4. Should the recovery export be mandatory (blocking) rather than strongly encouraged?
5. How long should an unlocked identity remain in memory before auto-lock?
6. Should the local cache be password-encrypted or passkey-encrypted?
7. Should an existing `nsec` be importable during the MVP?
8. Should the MVP include a basic NIP-17 inbox, or ship account-only first?
9. Should public-profile creation be optional (note: kinds 10002/10050 are required regardless, §15.8)? Independent of this, publishing now never overwrites an existing profile/relay-list event (§15.8) — this decision is only about whether to publish a *default* at all when nothing already exists.
10. Should BitLogin operate a dedicated archival vault relay?
11. Should future password login offer an optional OPAQUE overlay for hosted deployments that want revocable credentials? (Framed as an overlay, not a protocol evolution: OPAQUE reintroduces exactly the server dependency the base protocol exists to eliminate, so it must remain strictly optional and interoperable with pure-relay login.)
12. Should identity rotation be included before public beta?
13. Should the protocol be proposed as a public NIP after implementation experience?
14. Which portions of the client and protocol receive independent security audits?

---

# 35. Recommended Initial Decisions

```text
Application:
Static progressive web application

Login:
Login name plus generated six-word passphrase (~77 bits entropy)

Manual passwords:
Prohibited in alpha

Login-name uniqueness:
Not globally enforced; login name contributes no security

Password derivation:
Argon2id, 64 MiB, three iterations, parallelism 1
(BitLogin-specific browser profile inspired by RFC 9106), worker-hosted

Recovery:
12-word English BIP-39 phrase; BIP-39 passphrase disabled

Everyday identity:
Randomly generated standard Nostr key

Recovery identity:
BitLogin-specific HKDF derivation from BIP-39 seed;
signing key exists in memory only while phrase is entered

Capsule model:
Minimally mutable credential capsule (access material only);
minimal immutable recovery capsule (phrase-only write moments);
signed recovery event embedded for keyless rebroadcast;
recovery generations hash-chained

Account storage:
Encrypted, padded NIP-78 kind-30078 capsules
(1/2/4 KiB plaintext buckets; NIP-11 limits verified per relay)

Serialization:
RFC 8785 JCS

Vault relays:
Three to five bootstrap relays; signed maintainer update channel

Discovery relays:
Maintainer-listed; kinds 10002/10050 republished there

Timestamps:
max(now, previous + 1) on every replacement

Required registration success:
Two relay acknowledgments plus readback (revisit for three)

Reads:
Quorum of configured relays; local generation high-water mark

Messaging:
NIP-17, NIP-44 and NIP-59; kinds 10002/10050 required

Connection hygiene:
Capsule and everyday identities never share a relay connection

Local cache:
Encrypted IndexedDB

Identity export:
nsec and ncryptsec; encrypted recovery export strongly encouraged

Email:
Entirely excluded

NIP-05:
Deferred

Launch:
Experimental invite-only alpha

Password changes:
Supported; mandatory tombstone + NIP-09; explicit non-revocation warning

Compromise response:
Identity rotation deferred but designed before beta;
password compromise grants no recovery-capsule signing authority
(freshness still depends on relay retention and recovery export)
```

---

# 36. Final Product Definition

BitLogin is:

> A static, relay-backed account system that lets a person use a familiar login name and password to unlock a portable Nostr identity from any device.

Its architecture separates three responsibilities:

```text
Password
→ Convenient any-device access (minimal credential state; relay-layer revocation only)

Recovery phrase
→ Independent emergency authority (minimal immutable state, survives password compromise)

Everyday Nostr key
→ Canonical portable identity
```

Nostr relays provide encrypted storage and synchronization.

The static client provides key generation, password derivation, encryption, recovery, signing, message decryption, and account export.

No central provider must possess the identity, operate an account database, or send a password-reset email.

BitLogin succeeds when an ordinary user experiences a normal account while retaining the ability to recover, export, and use the underlying identity through independent compatible clients.
