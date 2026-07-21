/** The recovery capsule event: kind 30078, `d` = bitlogin:recovery:v1, signed by the recovery identity (§14). */
import { signNostrEvent, verifyNostrEvent, type NostrEvent } from "../nostr/event.js";
import { KIND_APP_DATA, D_TAG_RECOVERY_CAPSULE } from "../nostr/kinds.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { recoveryCapsuleAad, decryptEnvelope, encryptEnvelope } from "./serialization.js";
import { validateRecoveryPayload } from "./validation.js";
import type { EncryptedEnvelope, RecoveryPayload } from "./types.js";

export async function buildRecoveryCapsuleEvent(params: {
  recoveryPrivateKey: Uint8Array;
  capsuleKey: Uint8Array;
  payload: RecoveryPayload;
}): Promise<NostrEvent> {
  const recoveryPubkey = getPublicKeyHex(params.recoveryPrivateKey);
  const envelope = await encryptEnvelope(params.payload, params.capsuleKey, recoveryCapsuleAad(recoveryPubkey));
  return signNostrEvent(
    {
      pubkey: recoveryPubkey,
      created_at: params.payload.created_at,
      kind: KIND_APP_DATA,
      tags: [["d", D_TAG_RECOVERY_CAPSULE]],
      content: JSON.stringify(envelope)
    },
    params.recoveryPrivateKey
  );
}

export async function decryptRecoveryCapsuleEvent(
  event: NostrEvent,
  capsuleKey: Uint8Array
): Promise<RecoveryPayload> {
  if (!verifyNostrEvent(event)) {
    throw new Error("Recovery capsule event has an invalid id or signature.");
  }
  const envelope = JSON.parse(event.content) as EncryptedEnvelope;
  const payload = await decryptEnvelope<RecoveryPayload>(envelope, capsuleKey, recoveryCapsuleAad(event.pubkey));
  validateRecoveryPayload(payload);
  return payload;
}
