# BitLogin Multi-Account Switching

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Not implemented

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
