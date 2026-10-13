/**
 * @module channels/meetings/stores/fenced-outbox
 *
 * An outbox that holds a run's deliveries behind a fence across its purge, in the process that owns delivery: the
 * manager that purges, the dispatcher that sends and the host's purge path share one `FencedOutbox` over one outbox. A
 * purge aborts the run's send under way before it writes the fence, waits for that send to settle and then scrubs the
 * wrapped outbox; a send re-reads its delivery under the same per-run guard, after its destination was resolved; and once
 * the run is fenced, every delivery enqueued for it is stored content-free. The fence is kept in a {@link DeliveryFence},
 * which a durable implementation keeps across a restart and between processes.
 */
import type { IOutbox, OutboxDelivery } from './types.js';

/**
 * Where a {@link FencedOutbox} keeps the runs whose deliveries are fenced. A durable implementation keeps a fence across a
 * restart and between processes; {@link MemoryDeliveryFence} keeps it in this process alone.
 */
export interface DeliveryFence {
  /** Whether the run's deliveries are fenced. */
  isFenced(runId: string): Promise<boolean>;
  /** Fences the run's deliveries for good; fencing a fenced run again changes nothing. */
  fence(runId: string): Promise<void>;
  /**
   * Optional. Drops the run's fence when its outbox forgets the run (an in-memory host's whole-run eviction after the
   * retention grace). A durable fence omits it and keeps its fences.
   */
  forget?(runId: string): Promise<void>;
}

/** A {@link DeliveryFence} in this process's memory, for tests and a single process: a restart loses every fence. */
export class MemoryDeliveryFence implements DeliveryFence {
  private readonly ids = new Set<string>();

  /** Whether the run is fenced. */
  isFenced(runId: string): Promise<boolean> {
    return Promise.resolve(this.ids.has(runId));
  }

  /** Fences the run. */
  fence(runId: string): Promise<void> {
    this.ids.add(runId);
    return Promise.resolve();
  }

  /** Drops the run's fence. */
  forget(runId: string): Promise<void> {
    this.ids.delete(runId);
    return Promise.resolve();
  }
}

/**
 * Wraps an {@link IOutbox} so that a purge of a run reaches its deliveries in flight, not only its stored rows.
 *
 * - `purgeContent` aborts the run's send under way before it writes the fence, waits for that send to settle, then
 *   empties the run's content deliveries in the wrapped outbox, delivered ones included.
 * - `sendClaimed` sends one delivery under the run's guard: behind the fence it scrubs the run's content first, then reads
 *   the delivery again, so a purge that landed while the dispatcher resolved its destination sends the content-free
 *   `bot:purged` body in its place.
 * - Once the run is fenced, every delivery enqueued for it is stored as `bot:purged` with an empty payload, whatever its
 *   type (`bot:done` included): its destination learns only the delivery's ids and the run's.
 *
 * Wrap each outbox once per process and give that one wrapper to the manager and to the `OutboxDispatcher`: a second
 * wrapper of the same outbox does not see the first one's sends, so a purge through one cannot cancel a send through the
 * other. The operations of one run run one at a time, so an enqueue for a run waits for that run's send under way.
 * Over an outbox that evicts whole runs (an in-memory one) the wrapper has `forget` too, which forgets the run's fence
 * with its deliveries, so the manager's eviction after the retention grace goes on as it does without the wrapper.
 */
export class FencedOutbox implements IOutbox {
  /** The runs fenced in this process: seen at once, before the fence's write resolves. */
  private readonly fenced = new Set<string>();
  /** The last operation queued for each run, which the next one for that run waits for. */
  private readonly tails = new Map<string, Promise<void>>();
  /** The send under way for each run, which a purge of the run aborts. */
  private readonly active = new Map<string, AbortController>();

  /**
   * Present when the wrapped outbox has `forget`: forgets the run's deliveries there, and its fence here and in the
   * {@link DeliveryFence} when that forgets too. Call it only after the run's producers have stopped.
   */
  readonly forget?: (runId: string) => Promise<void>;

  /**
   * @param inner - The outbox the deliveries are kept in; wrap it once (see the class).
   * @param fences - Where the fence is kept; a durable one carries it across a restart.
   */
  constructor(private readonly inner: IOutbox, private readonly fences: DeliveryFence) {
    if (inner.forget) {
      const forgetInner = inner.forget.bind(inner);
      this.forget = (runId) =>
        this.locked(runId, async () => {
          await forgetInner(runId);
          await this.fences.forget?.(runId);
          this.fenced.delete(runId);
        });
    }
  }

  /** Runs `work` once every operation queued for the run before it has finished; answers what `work` answers. */
  private async locked<T>(runId: string, work: () => Promise<T>): Promise<T> {
    const before = this.tails.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = before.then(() => released);
    this.tails.set(runId, tail);
    await before;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(runId) === tail) this.tails.delete(runId);
    }
  }

  /** Whether the run is fenced, in this process or in the fence's store. */
  private async isFenced(runId: string): Promise<boolean> {
    return this.fenced.has(runId) || (await this.fences.isFenced(runId));
  }

  /**
   * Adds a pending delivery as the wrapped outbox does. Behind the fence it is stored content-free instead, as
   * `bot:purged` with an empty payload, and the run's content is scrubbed again, so a fence another process wrote reaches
   * this outbox's rows too.
   */
  async enqueue(delivery: Parameters<IOutbox['enqueue']>[0], now: number): Promise<void> {
    await this.locked(delivery.runId, async () => {
      const fenced = await this.isFenced(delivery.runId);
      await this.inner.enqueue(fenced ? { ...delivery, payload: '', type: 'bot:purged' } : delivery, now);
      if (fenced) await this.inner.purgeContent(delivery.runId);
    });
  }

  /**
   * Sends one delivery under the run's guard. Behind the fence the run's content is scrubbed first; then the delivery is
   * read again (a purge may have emptied it since `due` returned it) and, while it is still pending, `send` gets the fresh
   * row and a signal that a purge of the run aborts. True when `send` resolved; false when the delivery is gone or no
   * longer pending, or a purge cancelled the send; rejects with `send`'s own error otherwise.
   *
   * @param candidate - A delivery `due` returned.
   * @param send - Sends the fresh copy; it stops at the signal before it writes the body.
   */
  async sendClaimed(candidate: OutboxDelivery, send: (fresh: OutboxDelivery, signal: AbortSignal) => Promise<void>): Promise<boolean> {
    return this.locked(candidate.runId, async () => {
      const controller = new AbortController();
      this.active.set(candidate.runId, controller);
      try {
        if (await this.isFenced(candidate.runId)) await this.inner.purgeContent(candidate.runId);
        const fresh = (await this.inner.listByRun(candidate.runId)).find((row) => row.id === candidate.id);
        if (!fresh || fresh.state !== 'pending') return false;
        controller.signal.throwIfAborted();
        await send(fresh, controller.signal);
        return true;
      } catch (error) {
        if (controller.signal.aborted) return false;
        throw error;
      } finally {
        this.active.delete(candidate.runId);
      }
    });
  }

  /**
   * Fences the run's deliveries and empties its content deliveries in the wrapped outbox, delivered ones included. The
   * run's send under way here is aborted at once, before the fence's write, and again once the fence is written; the
   * purge then waits for that send to settle before it scrubs, so when it resolves no send of the run's content is still
   * in progress in this process. A send must therefore never wait for a purge of its own run.
   */
  async purgeContent(runId: string): Promise<void> {
    this.fenced.add(runId);
    // abort before the fence's asynchronous write; a send claimed after it finds the run in `fenced`
    this.active.get(runId)?.abort();
    await this.fences.fence(runId);
    this.active.get(runId)?.abort();
    await this.locked(runId, () => this.inner.purgeContent(runId));
  }

  /** The wrapped outbox's pending deliveries due at `now`. */
  due(now: number, limit?: number): Promise<OutboxDelivery[]> {
    return this.inner.due(now, limit);
  }

  /** Records in the wrapped outbox that the destination took the delivery. */
  markDelivered(id: string): Promise<void> {
    return this.inner.markDelivered(id);
  }

  /** Records a failed attempt in the wrapped outbox. */
  markFailed(id: string, now: number): Promise<void> {
    return this.inner.markFailed(id, now);
  }

  /** Makes the delivery pending again in the wrapped outbox; one a purge emptied goes out content-free. */
  replay(id: string, now: number): Promise<void> {
    return this.inner.replay(id, now);
  }

  /** Every delivery of the run in the wrapped outbox. */
  listByRun(runId: string): Promise<OutboxDelivery[]> {
    return this.inner.listByRun(runId);
  }
}
