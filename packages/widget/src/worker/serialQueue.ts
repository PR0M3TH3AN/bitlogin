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
