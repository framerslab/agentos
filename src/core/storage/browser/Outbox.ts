/**
 * @fileoverview Changes for a server, held on the device in order until each is confirmed. A flush sends the due
 * entries in order and stops at the first that must wait, so a later change to a subject never passes an earlier
 * one.
 * @module agentos/core/storage/browser/Outbox
 */

import type { KeyValueStore } from '@framers/sql-storage-adapter/kv';

/** One held change. */
export interface OutboxEntry<T = unknown> {
  /** The entry's key under the outbox's prefix. Entries are read in the order of their ids, oldest first. */
  id: string;
  /** What kind of change it is, in the caller's own words. */
  kind: string;
  /** The change itself, a value the structured clone can copy. */
  payload: T;
  /** What the change is about, for `waitingFor`. */
  subject: string | null;
  /** How many sends of it have ended in a retry. */
  attempts: number;
  /** When it was held, by the outbox's clock. */
  createdAt: number;
  /** The earliest time of its next send, by the outbox's clock. */
  nextAt: number;
}

/** What sending one entry came to: confirmed, refused for good, or to be tried again. */
export type OutboxSend = (entry: OutboxEntry) => Promise<'done' | 'drop' | 'retry'>;

/** How the outbox keeps time and waits. */
export interface OutboxOptions {
  /**
   * What every entry's key begins with in the store.
   * @default 'outbox/'
   */
  prefix?: string;
  /**
   * The clock, in milliseconds.
   * @default Date.now
   */
  now?: () => number;
  /**
   * How long an entry waits after its `attempts`th retry, in milliseconds.
   * @default 2 s doubling to 5 minutes
   */
  backoffMs?: (attempts: number) => number;
}

/** Orders the changes held within one millisecond, across every outbox of the page. */
let sequence = 0;

/** The flush asked for last of each store and prefix, which the next one waits for. */
const lastFlush = new WeakMap<KeyValueStore, Map<string, Promise<void>>>();

/**
 * An outbox over a key-value store. Its entries are the store's values under the prefix, so two outboxes made over
 * the same store object and prefix are one outbox: they hold the same entries, and their flushes take turns. Turns
 * are kept per store object, and `namespaced` makes a new one at each call: make the outboxes of one prefix over one
 * namespaced store, since outboxes over two hold the same entries and take no turns, as two tabs do.
 *
 * An entry is sent until the server confirms it, so the server can see one twice: a confirmation lost on the way, or
 * the page open in two tabs, whose flushes take no turns with each other. Between two tabs the order can break too:
 * one tab can send an earlier change after the other has sent a later one, and a retry in one tab puts back a change
 * the other has already sent, which is then sent again after the later one. Make every change safe to apply twice
 * and out of order, or let one tab flush at a time.
 *
 * Entries are ordered by the clock's time when they were held, then by the order they were held in on this page;
 * a clock that is set back puts a later change first. An entry's `createdAt` is that time, so it cannot order every
 * change for the server: two tabs can hold changes in the same millisecond, and a clock set back gives a later change
 * an earlier time. A server that must refuse a stale change compares a version it assigns itself.
 */
export class Outbox {
  private readonly prefix: string;
  private readonly now: () => number;
  private readonly backoffMs: (attempts: number) => number;

  /**
   * @param store - Where the entries are kept.
   * @param options - The prefix, the clock and the backoff.
   */
  constructor(private readonly store: KeyValueStore, options: OutboxOptions = {}) {
    this.prefix = options.prefix ?? 'outbox/';
    this.now = options.now ?? (() => Date.now());
    this.backoffMs = options.backoffMs ?? ((attempts) => Math.min(300_000, 2_000 * 2 ** Math.max(0, attempts - 1)));
  }

  /** Holds a change; answers the entry. */
  async add<T>(kind: string, payload: T, subject: string | null = null): Promise<OutboxEntry<T>> {
    const createdAt = this.now();
    sequence = (sequence + 1) % 1_000_000;
    const id = `${String(createdAt).padStart(15, '0')}-${String(sequence).padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: OutboxEntry<T> = { id, kind, payload, subject, attempts: 0, createdAt, nextAt: createdAt };
    await this.store.set(this.prefix + id, entry);
    return entry;
  }

  /** Every held change, oldest first. */
  async pending(): Promise<OutboxEntry[]> {
    const keys = await this.store.keys(this.prefix);
    const entries: OutboxEntry[] = [];
    for (const key of keys) {
      const entry = await this.store.get<OutboxEntry>(key);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * True when a change about `subject` is held. Each call reads every held change, so for many subjects read
   * `pending()` once and take the subjects from it.
   */
  async waitingFor(subject: string): Promise<boolean> {
    return (await this.pending()).some((entry) => entry.subject === subject);
  }

  /**
   * Sends what is due, in order, until the first that must wait. `done` and `drop` remove the entry; `retry`, or a
   * send that throws, keeps it until its backoff has passed, and nothing held after it is sent before it.
   *
   * One flush runs at a time for a store and prefix: a flush asked for while another runs starts when that one has
   * ended, and reads the entries then. A send that never settles therefore holds every later flush: give the
   * request a deadline. For the same reason a send never waits for a flush of its own outbox (the same store object
   * and prefix): that flush starts only when the one running the send has ended, so the two would wait for each
   * other for ever. A send returns, and the next flush sends the rest.
   *
   * @returns How many entries this flush confirmed, how many it dropped, and how many the store holds when it ends, a
   * change held while it ran among them.
   */
  flush(send: OutboxSend): Promise<{ sent: number; dropped: number; waiting: number }> {
    let turns = lastFlush.get(this.store);
    if (turns === undefined) {
      turns = new Map();
      lastFlush.set(this.store, turns);
    }
    const run = (turns.get(this.prefix) ?? Promise.resolve()).then(() => this.sendDue(send));
    // The next flush waits for this one however it ends.
    turns.set(
      this.prefix,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  /** One pass over the held entries, run when the flush's turn comes. */
  private async sendDue(send: OutboxSend): Promise<{ sent: number; dropped: number; waiting: number }> {
    const entries = await this.pending();
    let sent = 0;
    let dropped = 0;
    let index = 0;
    for (; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.nextAt > this.now()) break;
      let outcome: 'done' | 'drop' | 'retry';
      try {
        outcome = await send(entry);
      } catch {
        outcome = 'retry';
      }
      if (outcome === 'retry') {
        const attempts = entry.attempts + 1;
        await this.store.set(this.prefix + entry.id, { ...entry, attempts, nextAt: this.now() + this.backoffMs(attempts) });
        break;
      }
      await this.store.delete(this.prefix + entry.id);
      if (outcome === 'done') sent += 1;
      else dropped += 1;
    }
    // Counted from the store when the pass ends, so a change held while it ran is among those still waiting.
    return { sent, dropped, waiting: (await this.store.keys(this.prefix)).length };
  }
}
