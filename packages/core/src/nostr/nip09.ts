/** NIP-09 deletion requests, used for mandatory old-locator tombstones (§18.1). */
import { KIND_DELETION_REQUEST } from "./kinds.js";
import { signNostrEvent, type NostrEvent } from "./event.js";
import { getPublicKeyHex } from "../crypto/secp256k1.js";

export function buildDeletionRequest(params: {
  privateKey: Uint8Array;
  eventIdToDelete: string;
  deletedEventKind: number;
  createdAt: number;
  reason?: string;
}): NostrEvent {
  const pubkey = getPublicKeyHex(params.privateKey);
  return signNostrEvent(
    {
      pubkey,
      created_at: params.createdAt,
      kind: KIND_DELETION_REQUEST,
      tags: [
        ["e", params.eventIdToDelete],
        ["k", String(params.deletedEventKind)]
      ],
      content: params.reason ?? ""
    },
    params.privateKey
  );
}
