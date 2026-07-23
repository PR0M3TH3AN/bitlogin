# BitLogin Relay and Messaging Portability

**Status:** Experimental design
**Document version:** 0.1
**Date:** July 22, 2026
**Implementation status:** Partially planned in the core specification; not implemented as a complete user-facing system

## 1. Summary

BitLogin should make relay configuration and private-message synchronization
portable, understandable, and recoverable across devices.

The feature covers:

- General relay preferences
- DM inbox relay preferences
- DM outbox and sent-message recovery
- Relay role separation
- Relay health and redundancy checks
- Per-account message cursors and encrypted local indexes
- Conversation reconstruction on a clean device

The goal is not to invent a new messaging protocol. It is to provide one
coherent account-level implementation that compatible applications can reuse.

## 2. Motivation

Nostr applications often implement relay selection and messaging independently.
That creates several user-facing problems:

- The same account behaves differently in different apps.
- Users repeatedly configure the same relays.
- Private messages may appear on one device but not another.
- Sent messages may be missing after switching clients.
- Users cannot easily tell which relays are used for public posts, DMs, vault
  records, or discovery.
- A single unavailable relay can silently make an account appear empty.

BitLogin already has a portable identity and relay-backed recovery model. It is
a natural place to normalize relay and messaging behavior for compatible apps.

## 3. Relay roles

BitLogin should distinguish relay roles instead of presenting one undifferentiated
list.

```text
General relays
  Public profile, follows, notes, and ordinary events

DM inbox relays
  Receive encrypted messages addressed to the user

DM outbox relays
  Store or discover sent-message copies and delivery records

Discovery relays
  Locate relay lists and other account bootstrap records

Vault relays
  Store BitLogin capsules and encrypted portable records

Entitlement relays
  Optional source for signed purchase and access records
```

A relay may serve more than one role, but the interface and internal state must
record those roles explicitly.

## 4. Canonical relay preferences

The user's signed Nostr relay-list events remain the canonical public source for
ordinary and DM relay preferences where standards define them.

BitLogin should:

1. Retrieve the latest valid signed relay-list events.
2. Validate event signatures and timestamps.
3. Merge them with local bootstrap and vault requirements without overwriting
   unrelated user choices.
4. Republish only when the user confirms a change or when a defined repair flow
   is required.
5. Preserve signed copies in encrypted recovery exports.

BitLogin-specific relay roles that do not have a standard public event should be
stored in encrypted, independently replaceable account records rather than the
core capsules whenever practical.

## 5. Relay settings interface

Suggested interface:

```text
Relays

Public activity
  relay-one.example       Connected
  relay-two.example       Slow

Private messages
  inbox-one.example       Connected
  inbox-two.example       Unreachable

BitLogin vault
  vault-one.example       Healthy
  vault-two.example       Healthy
  vault-three.example     Healthy

[Add relay] [Test all] [Advanced]
```

For each relay, show:

- URL
- Assigned roles
- Connection status
- Last successful read
- Last successful write
- Authentication requirement
- Advertised limits when available
- Whether it is user-selected, discovered, or a BitLogin bootstrap relay

The interface should explain consequences in ordinary language, such as:

> You currently have only one reachable private-message inbox relay. If it goes
> offline, new messages may not reach this account until another inbox relay is
> added.

## 6. Relay health

BitLogin may run lightweight health checks while the account is active.

Checks may include:

- WebSocket connection success
- Read subscription success
- Auth challenge handling
- Write acknowledgement
- Read-after-write verification for BitLogin-owned records
- Advertised event-size limits
- Last observed latency

Health results are advisory and time-sensitive. A relay marked healthy can still
lose events or become unavailable later.

BitLogin must not continuously publish test events to public relays without user
consent. Read-only checks should be preferred where possible.

## 7. Messaging architecture

Conceptual flow:

```text
Signed relay preferences
        |
        +-- DM inbox relay list
        +-- general/outbox discovery
        |
BitLogin messaging synchronizer
        +-- downloads encrypted incoming messages
        +-- downloads sent-message copies
        +-- validates and decrypts locally
        +-- reconstructs conversations
        `-- updates encrypted local index
```

Sensitive message plaintext must remain local to the active account session.

## 8. Inbox synchronization

The inbox synchronizer should:

1. Determine the active account's current DM inbox relays.
2. Open account-scoped relay connections.
3. Fetch encrypted messages using persisted cursors and a bounded overlap window.
4. Validate event IDs, signatures, wrappers, and recipient binding.
5. Decrypt messages locally.
6. Deduplicate copies received from several relays.
7. Store an encrypted local message index.
8. Advance cursors only after durable local processing.

A message received from multiple relays is one logical message, not several
conversation entries.

## 9. Outbox and sent-message recovery

A portable inbox alone is insufficient. Users expect messages they sent on one
device to appear on another.

BitLogin should support sent-message recovery through the applicable messaging
protocol's sender-copy or outbox mechanism.

The synchronizer should recover:

- The sender's encrypted copy of outgoing messages
- Delivery metadata required to reconstruct threads
- Reactions or replies when supported
- Message timestamps and event IDs

BitLogin must not fabricate a sent-message history from recipient copies that the
user cannot decrypt or verify.

## 10. Conversation reconstruction

The local conversation model should be derived from validated message events.

Example internal record:

```json
{
  "conversation_id": "derived-local-id",
  "participants": ["<pubkey-a>", "<pubkey-b>"],
  "last_message_at": 1784750000,
  "unread_count": 2,
  "message_ids": ["<event-id-1>", "<event-id-2>"]
}
```

The local index is a cache and search aid. Signed encrypted events remain the
portable source material.

Conversation identifiers should not be published publicly unless required by a
standard protocol.

## 11. Local encrypted index

The message index may include:

- Event ID
- Conversation membership
- Sender and recipient pubkeys
- Decrypted timestamp
- Delivery status
- Unread state
- Search tokens or local full-text index
- Relay source metadata

The index must be encrypted at rest or protected within the established BitLogin
session-storage model. It must be namespaced by account.

Plaintext message bodies must never be included in analytics, logs, exceptions,
or unencrypted browser storage.

## 12. Read state and application interoperability

Read/unread state is application data rather than cryptographic message truth.
BitLogin may synchronize it as portable application state.

Suggested records:

```text
messaging/read-cursor/<conversation-id>
messaging/archive-state/<conversation-id>
messaging/mute-state/<conversation-id>
```

Compatible apps may choose to use BitLogin's normalized state or keep their own.
The user should be told when read state is device-local rather than portable.

## 13. Application API

Conceptual API:

```javascript
const relayConfig = await bitlogin.relays.getConfiguration();

const conversations = await bitlogin.messaging.listConversations({
  limit: 50
});

const messages = await bitlogin.messaging.getMessages({
  conversationId: conversations[0].id,
  limit: 100
});

await bitlogin.messaging.send({
  recipients: ["<pubkey>"],
  plaintext: "Hello"
});
```

A host application should not need direct access to the everyday private key or
raw decrypted index database.

## 14. Permissions

Suggested scopes:

```text
relays:read
relays:manage
messages:list
messages:read
messages:send
messages:manage-state
```

A permission dialog should explain whether an app can:

- See relay URLs
- Read conversation metadata
- Read message contents
- Send messages as the user
- Change relay preferences

Reading relay configuration should not automatically grant access to private
messages.

## 15. Account switching

Every relay connection, cursor, message index, and permission must be scoped to
the active account.

Switching accounts must:

1. Stop or suspend subscriptions for the previous account.
2. Clear previous-account plaintext from visible components.
3. Activate the selected account's relay configuration.
4. Open new account-scoped subscriptions.
5. Switch to the selected account's encrypted message index.
6. Notify host applications that all cached messaging objects are stale.

The interface must never display one account's conversation while another
account's signer is active.

## 16. Recovery and clean-device behavior

On a clean device, BitLogin should:

1. Restore the everyday identity through the password or recovery path.
2. Retrieve signed general and DM relay preferences.
3. Restore BitLogin-specific encrypted relay-role records.
4. Connect to the configured inbox and outbox sources.
5. Download and validate encrypted messages.
6. Rebuild the encrypted local index.
7. Restore portable read state if enabled.

The process may be incremental. The interface should distinguish:

```text
Account unlocked
Relay settings restored
Messages syncing
Message history complete through <timestamp>
```

## 17. Export

A full encrypted BitLogin export should include:

- Latest signed relay-list events
- BitLogin-specific encrypted relay-role records
- Message events or a bounded encrypted message archive, according to user choice
- Relay cursors
- Encrypted local index metadata when useful
- Portable read and archive state

The export should state whether it contains message ciphertext only or decrypted
message content. Decrypted export must require explicit confirmation.

## 18. Failure handling

BitLogin should surface specific conditions:

- No reachable inbox relay
- Relay authentication failed
- Relay rejected event size
- Conflicting relay-list events
- Message decrypt failed
- Invalid signature or wrapper
- Cursor rollback or stale relay response
- Outbox history incomplete

The client should continue using healthy relays when one fails and should not
silently discard a user's configured relay merely because it is temporarily
offline.

## 19. Privacy and security

Relay use can reveal social relationships, timing, IP address, and account
linkage even when message contents are encrypted.

Implementations should:

- Use separate connections for identity-capsule and everyday-identity traffic.
- Avoid querying all account roles over one relay connection when separation is
  practical.
- Minimize unnecessary broad subscriptions.
- Avoid transmitting plaintext message content outside the local client.
- Keep per-account cursors isolated.
- Validate all event signatures and wrappers before indexing.
- Treat relay-provided metadata and limits as untrusted input.
- Make Tor, VPN, proxy, or privacy-relay support possible in future clients.

BitLogin cannot prevent network observers from correlating traffic from the same
device or IP.

## 20. Acceptance criteria

The first complete relay and messaging layer is ready when:

1. A user can view and manage relay roles in plain language.
2. General and DM relay preferences restore on a clean device.
3. Incoming encrypted messages synchronize from at least two relays.
4. Duplicate relay copies appear as one logical message.
5. Sent messages created on one device appear on another device.
6. Conversation history can be rebuilt from signed encrypted events.
7. Message and relay state remain isolated across account switching.
8. Relay failures are visible and do not block healthy alternatives.
9. App permissions distinguish relay access, message metadata, message content,
   and sending authority.
10. No plaintext messages are stored in logs or unencrypted analytics.

## 21. Recommended implementation order

1. Build the relay-role data model and dashboard.
2. Complete signed relay-list restoration and safe editing.
3. Implement account-scoped inbox synchronization and deduplication.
4. Add sent-message recovery and conversation reconstruction.
5. Add encrypted local indexing and search.
6. Add portable read/archive state through application-state records.
7. Expose a permission-scoped messaging API.
8. Integrate account switching, export, and relay-health diagnostics.
