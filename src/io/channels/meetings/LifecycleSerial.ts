/**
 * Orders asynchronous lifecycle operations and invalidates pending starts synchronously.
 *
 * A start takes a {@link LifecycleSerial.stamp} before its first await and checks {@link LifecycleSerial.allows} before
 * it publishes anything; a suspension or an end calls {@link LifecycleSerial.invalidate} at once, before it queues its
 * own work, so a start still in flight can never publish after it. An end (`invalidate(true)`) is irreversible.
 */
export class LifecycleSerial {
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  private ending = false;

  /** The current generation, for a start to check later with {@link LifecycleSerial.allows}. */
  stamp(): number { return this.generation; }
  /** Whether work stamped with `stamp` may still act: nothing invalidated it since, and the lifecycle is not ending. */
  allows(stamp: number): boolean { return !this.ending && stamp === this.generation; }
  /** Whether an end has invalidated the lifecycle for good. */
  get ended(): boolean { return this.ending; }

  /** Invalidates every stamp taken so far; with `ending`, every later stamp too, for good. */
  invalidate(ending = false): void {
    this.generation += 1;
    this.ending ||= ending;
  }

  /** Runs `work` after every operation queued before it, whether those resolved or rejected; answers its result. */
  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
