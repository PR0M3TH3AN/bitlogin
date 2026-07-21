/**
 * A NIP-07-shaped signer over an in-memory everyday private key (§26.2, §26.4).
 * This is the "foundation for application authentication" (§2): any static
 * site can hold one of these (typically inside a Web Worker, per §11.10,
 * §22.4) and expose it as a window.nostr-compatible provider.
 */
import { getPublicKeyHex } from "../crypto/secp256k1.js";
import { getConversationKey, nip44Decrypt, nip44Encrypt } from "../crypto/nip44.js";
import { wipe } from "../crypto/memory.js";
import { signNostrEvent, type NostrEvent, type NostrTag } from "../nostr/event.js";

export interface UnsignedEventInput {
  kind: number;
  tags?: NostrTag[];
  content: string;
  created_at?: number;
}

export class NostrSigner {
  private readonly privateKey: Uint8Array;
  private readonly publicKeyHex: string;
  private destroyed = false;

  constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey;
    this.publicKeyHex = getPublicKeyHex(privateKey);
  }

  private assertAlive(): void {
    if (this.destroyed) throw new Error("This signer has been destroyed (session locked or logged out).");
  }

  getPublicKey(): string {
    this.assertAlive();
    return this.publicKeyHex;
  }

  signEvent(input: UnsignedEventInput): NostrEvent {
    this.assertAlive();
    return signNostrEvent(
      {
        pubkey: this.publicKeyHex,
        created_at: input.created_at ?? Math.floor(Date.now() / 1000),
        kind: input.kind,
        tags: input.tags ?? [],
        content: input.content
      },
      this.privateKey
    );
  }

  nip44Encrypt(peerPublicKeyHex: string, plaintext: string): string {
    this.assertAlive();
    return nip44Encrypt(getConversationKey(this.privateKey, peerPublicKeyHex), plaintext);
  }

  nip44Decrypt(peerPublicKeyHex: string, payload: string): string {
    this.assertAlive();
    return nip44Decrypt(getConversationKey(this.privateKey, peerPublicKeyHex), payload);
  }

  /** Best-practical secret wipe (§11.10, §21.4): overwrites the private key buffer in place. */
  destroy(): void {
    wipe(this.privateKey);
    this.destroyed = true;
  }
}
