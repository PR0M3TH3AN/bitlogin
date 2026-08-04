/** NIP-46 remote-signer sessions (§LM5): the signer backend for a connected bunker.
 *
 * Thin by construction: the actual client -- ephemeral keypair, relay
 * subscriptions, request correlation -- lives in the crypto worker (§LM5.4),
 * and this class only forwards facade calls to it. The user pubkey is fixed at
 * connect time (the worker validated it), so getPublicKey answers locally.
 * Deadlines and typed errors come from the worker/core layers.
 */
import type { NostrEvent } from "@bitlogin/core/nostr";
import type { UnsignedEventForSigning } from "../provider.js";
import type { WorkerClient } from "../worker/workerClient.js";
import type { Signer, SignerCapabilities } from "./types.js";

export class Nip46Signer implements Signer {
  readonly method = "nip46" as const;
  /** The NIP-46 RPC surface always carries all four encryption calls; whether a
   *  particular signer approves them is a per-request policy decision that
   *  surfaces as its error, not a missing capability. */
  readonly capabilities: SignerCapabilities = { nip44: true, nip04: true, getRelays: false };

  constructor(
    private readonly worker: WorkerClient,
    private readonly userPubkey: string
  ) {}

  getPublicKey(): Promise<string> {
    return Promise.resolve(this.userPubkey);
  }

  signEvent(event: UnsignedEventForSigning): Promise<NostrEvent> {
    return this.worker.nip46SignEvent({
      kind: event.kind,
      content: event.content,
      tags: event.tags,
      created_at: event.created_at
    });
  }

  async nip44Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return (await this.worker.nip46Nip44Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }

  async nip44Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return (await this.worker.nip46Nip44Decrypt({ peerPublicKey, payload })).plaintext;
  }

  async nip04Encrypt(peerPublicKey: string, plaintext: string): Promise<string> {
    return (await this.worker.nip46Nip04Encrypt({ peerPublicKey, plaintext })).ciphertext;
  }

  async nip04Decrypt(peerPublicKey: string, payload: string): Promise<string> {
    return (await this.worker.nip46Nip04Decrypt({ peerPublicKey, payload })).plaintext;
  }
}
