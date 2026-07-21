/** HKDF-SHA256 domain separation (§11.1, §11.4, §11.5). RFC 5869 via @noble/hashes. */
import { sha256 } from "@noble/hashes/sha2";
import { extract, expand } from "@noble/hashes/hkdf";
import { utf8ToBytes } from "./encoding.js";

/** HKDF-Extract(salt, IKM) -> PRK. `salt` is a domain-separation label already hashed by the caller. */
export function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Uint8Array {
  return extract(sha256, ikm, salt);
}

/** HKDF-Expand(PRK, info, length) -> output keying material. */
export function hkdfExpand(prk: Uint8Array, info: string | Uint8Array, length: number): Uint8Array {
  const infoBytes = typeof info === "string" ? utf8ToBytes(info) : info;
  return expand(sha256, prk, infoBytes, length);
}

/** SHA-256 of a UTF-8 label, used as an HKDF-Extract salt (§11.4, §11.5). */
export function labelSalt(label: string): Uint8Array {
  return sha256(utf8ToBytes(label));
}
