# BitLogin Multi-Account Switching

**Status:** A first version is built on `beta` (2026-11-19). See "What is
built" at the end: it is narrower than the design below, which is kept as
written.
**Document version:** 0.2
**Date:** July 22, 2026; built November 19, 2026

## 1. Summary

BitLogin should support keeping multiple independently authenticated accounts on
a device and switching between them without repeating the full password and
relay-login flow every time.

The first implementation should treat each account as an independent BitLogin
account with its own credentials, recovery phrase, capsules, Nostr identity,
relay preferences, messages, application state, connections, and entitlements.

```text
BitLogin on one device
├── Personal account
├── Business account
├── Anonymous account
└── Additional imported account
```

This feature is primarily a local session and user-interface capability. It does
not initially change the BitLogin wire protocol or place several independent
accounts beneath one recovery phrase.

## 2. Motivation

Nostr users commonly maintain more than one identity:

- A personal identity
- A business or project identity
- An anonymous or pseudonymous identity
- A test identity
- An identity dedicated to a specific application or community

Today, switching identities often requires logging out, re-entering credentials,
reloading extensions, or manually importing keys. BitLogin can make account
switching feel like an ordinary multi-profile application while preserving the
fact that each Nostr identity is independently owned and recoverable.

The product goal is:

> Add an account once, then switch identities deliberately and visibly.

## 3. Initial scope: independent accounts

Each remembered account remains cryptographically independent:

```text
Account A
├── login name + password
├── recovery phrase
├── credential capsule
├── recovery capsule
└── everyday Nostr identity

Account B
├── login name + password
├── recovery phrase
├── credential capsule
├── recovery capsule
└── everyday Nostr identity
```

Compromise or recovery of one account must not automatically expose another.

The local account switcher may remember encrypted or origin-scoped session
material for several accounts, but it must not merge their remote records or
recovery paths.

## 4. Future scope: identity collections

A later protocol version may support several operational Nostr identities under
one BitLogin recovery root:

```text
One recovery root
├── Personal identity
├── Business identity
└── Pseudonymous identity
```

That is a separate feature and requires explicit protocol design for:

- Identity creation and deletion
- Per-identity credential wrapping
- Recovery and identity rotation
- Connection Vault sharing or separation
- Cross-identity privacy
- Export and migration

The first account switcher must not imply that independently added accounts are
recoverable from one phrase.

## 5. Local account registry

The client may keep an origin-scoped local registry containing only the data
needed to render an account picker and locate the account's local session.

Example:

```json
{
  "schema": "bitlogin.local-account-registry.v1",
  "accounts": [
    {
      "local_account_id": "local-random-id",
      "npub": "npub1...",
      "display_name": "Adam",
      "picture": "https://example.com/avatar.jpg",
      "last_used_at": 1784750000,
      "session_state": "unlocked"
    }
  ],
  "active_local_account_id": "local-random-id"
}
```

The registry must not store:

- Login passwords
- Recovery phrases
- Password-derived keys
- Recovery signing keys
- Plaintext Connection Vault credentials
- Plaintext private messages

Display metadata is a cache and may be rebuilt from the account's signed profile.

## 6. Session storage

Each account session must be namespaced by an opaque local account identifier.
A single global `currentSession` record is insufficient.

Conceptual IndexedDB layout:

```text
bitlogin
├── account-registry
├── sessions/<local-account-id-a>
├── sessions/<local-account-id-b>
└── active-account
```

Each session should contain only the minimum material already accepted by the
BitLogin session-persistence model, independently encrypted or protected by the
origin's storage boundary.

A local attacker with access to the browser profile may obtain every unlocked
or persisted account session. The interface must state this limitation plainly.

## 7. Account states

An account may be:

```text
unlocked     usable immediately
locked       remembered, but credentials must be entered
unavailable  local metadata exists, but remote login failed
removed      deleted from this device only
```

Removing an account from one device does not delete its relay capsules, rotate
its identity, or revoke sessions on other devices.

## 8. Switching behavior

Switching accounts must be an explicit state transition:

1. Pause subscriptions and relay cursors associated with the current account.
2. Clear in-memory references to the current account's private keys and decrypted
   data from components that are not shared intentionally.
3. Activate the selected account's worker and session namespace.
4. Reconfigure the signer surface, relay lists, messaging state, Connection
   Vault, application state, and entitlements for the selected identity.
5. Dispatch an account-change event to the host application.
6. Refresh all account-dependent user interface.

The interface must never leave one account's profile visible while another
account's signer is active.

## 9. Signer behavior

The single global `window.nostr` slot can represent only one active signer.
Therefore:

- Only the active account may own BitLogin's global signer surface.
- Switching accounts must replace or rebind that surface atomically.
- Element-scoped BitLogin instances should expose the active account explicitly.
- Host applications must receive an account-change event and discard cached
  public keys, relay lists, permissions, and app state.

Suggested event:

```javascript
window.addEventListener("bitlogin-account-changed", event => {
  console.log(event.detail.previousPubkey);
  console.log(event.detail.currentPubkey);
});
```

No private key or credential is included in the event.

## 10. User interface

Suggested account picker:

```text
Accounts

● Adam
  npub1abc...xyz
  Current account

○ BitRoad
  npub1def...uvw
  Last used yesterday

○ Anonymous
  npub1ghi...rst
  Locked

[Add account] [Manage accounts]
```

Account-switch confirmation should be optional for ordinary switching but
required when an application has an operation awaiting signature or payment.

The active account must remain visibly identifiable in:

- Signer approval dialogs
- Wallet and storage permission dialogs
- Purchase and entitlement views
- Message composition
- Profile editing

## 11. Add-account flows

The client should support:

- Sign into an existing BitLogin account
- Recover an existing BitLogin account with its phrase
- Create a new independent BitLogin account
- Import an existing `nsec` and wrap it in a new BitLogin account

Adding an account must not silently log out or overwrite the current account.

## 12. Logout and removal

The interface should distinguish:

- **Lock account:** clear active in-memory secrets but retain the remembered
  account and any permitted encrypted session state.
- **Log out account:** clear that account's persisted session from this device.
- **Remove account from device:** remove local registry metadata and session data.
- **Log out all accounts:** clear every local BitLogin session.

None of these operations revoke a Nostr private key already exported elsewhere.

## 13. Privacy requirements

BitLogin should avoid creating remote records that publicly enumerate all
accounts used on one device. The account registry is local by default.

Independent accounts must not share:

- Locator identities
- Recovery identities
- Connection Vault roots
- Relay queries on one authenticated relay connection
- Application permission grants
- Messaging cursors

Network timing may still correlate accounts used from the same device or IP.
Separate relay connections and privacy-preserving transport remain recommended.

## 14. Application API

Conceptual API:

```javascript
const accounts = await bitlogin.accounts.list();

await bitlogin.accounts.switch(accounts[1].localAccountId);

await bitlogin.accounts.lock(accounts[0].localAccountId);

await bitlogin.accounts.removeFromDevice(accounts[2].localAccountId);
```

The API must never return passwords, recovery phrases, private keys, or plaintext
Connection Vault records.

## 15. Acceptance criteria

The initial feature is complete when:

1. At least two independent BitLogin accounts can remain remembered on one
   device.
2. Switching an unlocked account does not rerun Argon2id or fetch its capsule.
3. Locking one account does not lock or corrupt another account.
4. The signer, profile, relay configuration, messages, app state, connections,
   and entitlements always correspond to the visibly active account.
5. A host app receives an explicit account-change notification.
6. Removing an account deletes only its local state.
7. `Log out all accounts` clears every persisted BitLogin session.
8. No remote event exposes the device's account list.
9. Cross-account storage keys, cursors, and relay connections remain isolated.
10. Browser refresh restores the previously active account when its session is
    still available.

## 16. Recommended implementation order

1. Replace the single local session record with a namespaced session store.
2. Add an account registry and active-account pointer.
3. Add lock, logout, remove, and switch operations.
4. Make the crypto worker lifecycle account-aware.
5. Add host-application account-change events.
6. Add account-aware relay, messaging, app-state, entitlement, and Connection
   Vault modules.
7. Add tests for rapid switching, reload restoration, and cross-account leakage.

---

## What is built (2026-11-19, on `beta`)

Asked for by the owner on 2026-11-19, after the sign-in window signed them
in to a world as an account they did not mean to use.

**How it is kept.** Each account that signs in on a device gets a slot of
its own beside the active one (`worker/sessionCache.ts`, `keptSlot`):
the same record, encrypted under the same non-extractable device key, and
sealed under the optional lock where the lock is on. A list beside them
(`worker/keptAccounts.ts`) says which slots there are and what to call
them: the public key, and the name, picture and line from the account's
own signed profile as last read. It holds nothing secret. Eight accounts at
most; the one least lately used goes first.

**What a user can do.**

- **Sign in as another account** without signing the first out: "Add
  another account" on the signed-in view. Any ordinary sign-in keeps the
  account it replaces.
- **Switch** between kept accounts with one press: no password, no relay.
  A host page hears `bitlogin-logout` and then `bitlogin-login`.
- **Come back** to a kept account from the welcome screen ("Continue as").
- **Log out** forgets the signed-in account on that device and leaves the
  others. "Remove from this device" does the same for one that is not
  signed in.
- **In the sign-in window** (`/connect/`): "Use a different account" opens
  a chooser. Where more than one account is kept and the asking site has
  not been allowed before, the chooser comes first: which account is
  asked, never assumed.
- **A site** can open that chooser: `switchAccount()` on
  `createBitLoginClient`, or the window at `/connect/#switch`. The site
  never sees the list, only the account that was allowed.

**The lock** (`sign-in-window.md` §SW12) covers every kept account. Turning
it on, off, or changing the PIN seals every slot again. Locked, switching
asks for the PIN first. A password sign-in made while it is locked still
turns the lock off, as before; the other kept accounts were sealed under
it, so they are forgotten and signed in to again the ordinary way. Too
many wrong tries forgets every kept account.

**Where it stops short of the design above.**

- **No device-wide "sign out of everything".** Each account is logged out
  of in turn.
- **Sites keep the account they were allowed as.** Switching at the
  sign-in address does not change who a site signs as: the site asks again
  (its own "switch account"), and the user allows it as the other one.
  This is deliberate: a site is told nothing it was not allowed.
- **Extension and remote-signer sessions are not kept.** They hold no key
  here to keep.
- **A kept account is named by its profile.** One with no profile shows as
  "An account with no name" and its key. The login name is not kept.
- **Tried in Chromium only,** with passkey accounts, against the mock
  relays.
- **Nothing is shared between tabs live.** A second open tab learns of a
  switch when it is next loaded.
