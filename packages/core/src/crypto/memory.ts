/**
 * Best-practical secret lifetime helpers (§11.10).
 *
 * JavaScript strings are immutable and cannot be reliably zeroed. Typed arrays
 * backed by ArrayBuffers can be overwritten in place, which is the only
 * "erasure" this runtime can actually offer. Callers should keep secrets in
 * Uint8Array form for as short a time as possible and call wipe() as soon as
 * an operation completes.
 */

export function wipe(...buffers: Array<Uint8Array | undefined | null>): void {
  for (const buf of buffers) {
    if (buf) buf.fill(0);
  }
}

/** Runs fn with a secret buffer and always wipes it afterward, even on throw. */
export async function withWiped<T>(
  buffer: Uint8Array,
  fn: (buffer: Uint8Array) => Promise<T> | T
): Promise<T> {
  try {
    return await fn(buffer);
  } finally {
    wipe(buffer);
  }
}
