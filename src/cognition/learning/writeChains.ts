/**
 * @module learning/writeChains
 *
 * One promise chain per key in the process. A write of a user's memory holds its user's chain from its admission to
 * its verdict, and `forgetUser` takes the same chain, so it deletes only after every write this process admitted
 * before it has reached its verdict. A user's chain is keyed by the namespace and user id its tombstone is, so a
 * learner's writes, that user's writes as a second user on another session and the user's deletion share one chain;
 * a write that names no user takes its session's chain.
 */

/** The chain of one user in one namespace: the key of the user's tombstone. */
export function userChainKey(namespace: string, userId: string): string {
  return `user\u0000${namespace}\u0000${userId}`;
}

/** The chain of a session's writes that name no user. */
export function sessionChainKey(sessionId: string): string {
  return `session\u0000${sessionId}`;
}

export class WriteChains {
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Runs `fn` once every call queued on `key` before it has settled, and holds the key until `fn` settles. A call that
   * throws rejects its own promise and does not stop the calls after it.
   */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Whether a call holds or waits on `key`. */
  busy(key: string): boolean {
    return this.tails.has(key);
  }
}
