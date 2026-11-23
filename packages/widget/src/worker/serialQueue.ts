/**
 * Runs worker RPC handlers one at a time. Session-changing calls perform relay
 * and KDF work before adopting state; without ordering, a later logout could
 * finish first and then be overwritten by the older call.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const settled = (p: Promise<unknown>): Promise<void> =>
  p.then(
    () => undefined,
    () => undefined
  );

/**
 * The same ordering, with one line per store (docs/panel-speed-2026-11-23.md). Work in a line runs one at a time,
 * in order, as before; lines for different stores run side by side, so a slow read of the wallet doesn't hold up the
 * folders. Anything not in a line (signing in or out, the lock, switching accounts, every other action) runs alone:
 * it waits for every line to finish what it was given, and nothing given after it starts until it is done.
 */
export class LaneQueue {
  private alone: Promise<void> = Promise.resolve();
  private readonly lanes = new Map<string, Promise<void>>();

  run<T>(lane: string | null, operation: () => Promise<T>): Promise<T> {
    if (lane === null) {
      const before = Promise.all([this.alone, ...this.lanes.values()]);
      const result = before.then(operation, operation);
      this.alone = settled(result);
      // Each line's next piece of work waits for this, which waited for them.
      this.lanes.clear();
      return result;
    }
    const before = Promise.all([this.alone, this.lanes.get(lane) ?? Promise.resolve()]);
    const result = before.then(operation, operation);
    this.lanes.set(lane, settled(result));
    return result;
  }
}
