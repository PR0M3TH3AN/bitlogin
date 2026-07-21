/** RFC 8785 JSON Canonicalization Scheme (§11.9). */
import canonicalize from "canonicalize";
import { utf8ToBytes } from "./encoding.js";

export function canonicalJson(value: unknown): string {
  const result = canonicalize(value);
  if (result === undefined) {
    throw new Error("Value is not JSON-serializable for canonicalization.");
  }
  return result;
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return utf8ToBytes(canonicalJson(value));
}
