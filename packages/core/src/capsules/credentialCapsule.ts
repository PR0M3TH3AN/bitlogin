/** The credential capsule event: kind 30078, `d` = bitlogin:password:v1, signed by the locator identity (§13). */
import { signNostrEvent, verifyNostrEvent, type NostrEvent } from "../nostr/event.js";
import { KIND_APP_DATA, D_TAG_PASSWORD_CAPSULE } from "../nostr/kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { credentialCapsuleAad, decryptEnvelope, encryptEnvelope } from "./serialization.js";
import { validateCredentialPayload } from "./validation.js";
import type { CredentialPayload, EncryptedEnvelope } from "./types.js";

export async function buildCredentialCapsuleEvent(params: {
  locatorPrivateKey: Uint8Array;
  capsuleKey: Uint8Array;
  payload: CredentialPayload;
}): Promise<NostrEvent> {
  const locatorPubkey = getPublicKeyHex(params.locatorPrivateKey);
  const envelope = await encryptEnvelope(params.payload, params.capsuleKey, credentialCapsuleAad(locatorPubkey));
  return signNostrEvent(
    {
      pubkey: locatorPubkey,
      created_at: params.payload.created_at,
      kind: KIND_APP_DATA,
      tags: [["d", D_TAG_PASSWORD_CAPSULE]],
      content: JSON.stringify(envelope)
    },
    params.locatorPrivateKey
  );
}

/** Signed replacement with empty content: shrinks exposure on honest relays (§18.1). Confers no revocation over already-downloaded copies. */
export function buildCredentialTombstoneEvent(params: {
  oldLocatorPrivateKey: Uint8Array;
  createdAt: number;
}): NostrEvent {
  const pubkey = getPublicKeyHex(params.oldLocatorPrivateKey);
  return signNostrEvent(
    {
      pubkey,
      created_at: params.createdAt,
      kind: KIND_APP_DATA,
      tags: [["d", D_TAG_PASSWORD_CAPSULE]],
      content: ""
    },
    params.oldLocatorPrivateKey
  );
}

export async function decryptCredentialCapsuleEvent(
  event: NostrEvent,
  capsuleKey: Uint8Array
): Promise<CredentialPayload> {
  if (!verifyNostrEvent(event)) {
    throw new Error("Credential capsule event has an invalid id or signature.");
  }
  const envelope = JSON.parse(event.content) as EncryptedEnvelope;
  const payload = await decryptEnvelope<CredentialPayload>(envelope, capsuleKey, credentialCapsuleAad(event.pubkey));
  validateCredentialPayload(payload);
  return payload;
}
