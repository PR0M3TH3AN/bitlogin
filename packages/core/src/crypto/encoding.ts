/** Shared byte/base64url/hex helpers. No Node Buffer dependency, works in browser and Node. */

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("Invalid hex string length.");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

const B64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function bytesToBase64url(bytes: Uint8Array): string {
  let result = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!, b2 = bytes[i + 2]!;
    result += B64URL_CHARS[b0 >> 2];
    result += B64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += B64URL_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)];
    result += B64URL_CHARS[b2 & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    result += B64URL_CHARS[b0 >> 2];
    result += B64URL_CHARS[(b0 & 0x03) << 4];
  } else if (remaining === 2) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!;
    result += B64URL_CHARS[b0 >> 2];
    result += B64URL_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    result += B64URL_CHARS[(b1 & 0x0f) << 2];
  }
  return result;
}

const B64URL_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64URL_CHARS.length; i++) map[B64URL_CHARS[i]!] = i;
  return map;
})();

export function base64urlToBytes(input: string): Uint8Array {
  const clean = input.replace(/=+$/u, "");
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B64URL_LOOKUP[ch];
    if (val === undefined) throw new Error("Invalid base64url character.");
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function utf8ToBytes(input: string): Uint8Array {
  return new TextEncoder().encode(input);
}

export function bytesToUtf8(input: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(input);
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
