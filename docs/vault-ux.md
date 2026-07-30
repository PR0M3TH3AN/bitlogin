# Connection Vault — UX walkthroughs

**Status:** Agreed product direction (2026-07-30)
**Role:** These scenarios are the acceptance criteria for the Phase D
authorization layer (`connection-vault.md` §12, §18). The design principle
running through all of them: **friction appears exactly where danger is, and
nowhere else.** Count the friction across the whole set: one phrase entry
ever, one budget-facing tap per app, one tap per new device, sudo or phone
approval only at genuinely dangerous reveals. Everything else is silence.

## 1. Turning the vault on — existing account

Account manager card: *"Connection Vault — store wallet and storage
connections once, use them on every device."* Enabling asks for the recovery
phrase with the reason stated plainly (*"the vault must survive both your
password and your phrase"*), rewrites both capsules with quorum readback, and
fails closed with a retry that reuses the same roots
(`enableConnectionVault`). New accounts skip this scenario entirely — the
roots are minted at registration.

*Deliberate friction:* the phrase entry, once per account ever.

## 2. Connecting a wallet the first time — inside an app

The app calls the request API with a reason string. The sheet walks the user
through pasting/scanning an NWC URI, parses it, and shows what it learned —
provider, relay, and **the budget in large type**. No budget draws an amber
warning recommending a budgeted connection, never a hard block. Label
pre-filled from the app name. The final line before reveal is honest:
*"[App] will receive this connection and can spend within its budget until
you revoke it."* Save binds the record to the requesting origin.

*Deliberate friction:* one explicit share tap, budget staring at the user.
*Removed friction:* naming, binding, storage.

## 3. The payoff — new phone

Sign into the app's BitLogin, and at the first payment moment:

> **Use "Satisfied spending wallet"?**
> *You connected this wallet to Satisfied on another device. Budget: 500 sats/day.*

One tap. Zero pasting. This screen is the entire reason the vault exists.
A new device seeing a credential for the first time must never happen
silently, even with a durable grant.

## 4. Every ordinary day after

Nothing. No prompt, no branding. The grant is durable per origin per device;
the vault's best UX is absence.

## 5. Connected apps — management

Account manager page listing origin → connection → grant date → devices, with
**Revoke access** per row and one **"Revoke all app access"** panic button.
Each connection's detail page separates two red actions honestly:

- **Remove from BitLogin** — deletes the stored copy; the credential itself
  keeps working for anyone who already holds it.
- **Revoke at wallet/provider** — an instruction with a guide, not a button
  pretending BitLogin can reach into the wallet (§11).

## 6. S3 connections

Same sheet pattern; the import screen teaches while it collects: scoped IAM
key vs root key question, a recommended object-prefix field, amber warning on
unscoped credentials. Reveal to an app requires sudo mode — S3 secrets guard
buckets, not a 500-sat budget.

## 7. Personal tier — passwords and secure notes

Exists ONLY in the first-party account manager. No app can request, list, or
learn these records exist (the tier is invisible to the app-facing API by
construction — see §18.2). Viewing requires sudo mode: re-enter the account
password, ~5-minute window. Copy button, auto-clearing field. The copy is
honest: a safe place for a few important secrets, not a password manager —
autofill and site-matching wait for the extension generation. Seed phrases
stay banned.

## 8. Phone approval (after §SF5–7 ships)

High-tier reveals push to the enrolled phone; the record key is 2-of-2
derived so a laptop cryptographically cannot proceed on its own. Budgeted NWC
connections deliberately do NOT phone-prompt — the budget is already the
lock, and prompting every payment trains reflexive approval.

## 9. Disaster — phrase-only recovery

Twelve words on a clean device restore identity, then the vault roots ride
the recovery capsule (§13.2), so connections reappear: wallets, buckets,
passwords. The phrase remains the ungated master path (§SF9). The flow nudges
re-enrolling a phone and rotating anything sensitive.

## Build order for Phase D

The screens, in dependency order: request/consent sheet (2, 3) → guided NWC
import (2) → Connected apps + connection detail (5) → S3 import (6) → sudo
mode (7). The personal tier and phone approval layer on later without
reshaping anything before them.
