/** Monotonic replacement timestamp rule (§24.6). Applies to every addressable-event replacement. */
export function nextCreatedAt(previousCreatedAt: number | null | undefined, nowSeconds?: number): number {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  if (previousCreatedAt === null || previousCreatedAt === undefined) return now;
  return Math.max(now, previousCreatedAt + 1);
}
