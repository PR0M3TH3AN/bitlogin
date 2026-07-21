/** NIP-19 bech32-encoded entity references: nsec/npub (§3.4, §28.1). */
import { bech32 } from "@scure/base";
import { hexToBytes, bytesToHex } from "../crypto/encoding.js";

export function encodeNpub(publicKeyHex: string): string {
  return bech32.encodeFromBytes("npub", hexToBytes(publicKeyHex));
}

export function encodeNsec(privateKey: Uint8Array): string {
  return bech32.encodeFromBytes("nsec", privateKey);
}

export function decodeNpub(npub: string): string {
  const { prefix, bytes } = bech32.decodeToBytes(npub);
  if (prefix !== "npub" || bytes.length !== 32) throw new Error("Not a valid npub.");
  return bytesToHex(bytes);
}

export function decodeNsec(nsec: string): Uint8Array {
  const { prefix, bytes } = bech32.decodeToBytes(nsec);
  if (prefix !== "nsec" || bytes.length !== 32) throw new Error("Not a valid nsec.");
  return bytes;
}
