/**
 * The browser run owner on a store in memory: the record's check, the paced record writes, the run lock's refusal of
 * a second start, the account channel and the account's stop, the write gate, the reads after a load, the pause while
 * offline, the stop, the next attempt and the finish, and the ends.
 */
import { describe, expect, it, vi } from 'vitest';
import { MemoryKeyValueStore } from '../index.js';
import {
  isRunRecord,
  openRunOwner,
  runLockName,
  type RunChannel,
  type RunJob,
  type RunLocks,
  type RunMessage,
  type RunOwnerOptions,
  type RunRecord,
} from '../runs.js';

/** Web Locks in memory, shared by every owner of the test: a held name refuses a second hold at once. */
function memoryLocks(): RunLocks & { names(): string[] } {
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  return {
    async hold(name) {
      if (held.has(name)) return null;
      held.add(name);
      return {
        release: () => {
          held.delete(name);
          for (const wake of waiting.get(name) ?? []) wake();
          waiting.delete(name);
        },
      };
    },
    async free(name) {
      return !held.has(name);
    },
    waitFree(name, ms) {
      if (!held.has(name)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms);
        waiting.set(name, [...(waiting.get(name) ?? []), () => { clearTimeout(timer); resolve(true); }]);
      });
    },
    names: () => [...held],
  };
}

/** The record locks: one queue per name, as a page's record locks behave. */
function recordLocks(): RunOwnerOptions['locks'] {
  const turns = new Map<string, Promise<void>>();
  return {
    request: (name, work) => {
      const turn = (turns.get(name) ?? Promise.resolve()).then(work);
      turns.set(name, turn.catch(() => undefined));
      return turn;
    },
  };
}

/** One channel bus for the test: every channel made under a name hears every other's messages, as tabs do. */
function bus(): (name: string) => RunChannel {
  const members = new Map<string, Set<(message: RunMessage) => void>>();
  return (name) => {
    const set = members.get(name) ?? new Set();
    members.set(name, set);
    let own: ((message: RunMessage) => void) | null = null;
    return {
      post: (message) => { for (const hear of set) if (hear !== own) hear(message); },
      listen: (hear) => { own = hear; set.add(hear); },
      close: () => { if (own) set.delete(own); },
    };
  };
}

/** A promise the test settles when it chooses. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const ACCOUNT = 'a'.repeat(32);
const KEY = 'f'.repeat(64);
const isChosen = (value: unknown): boolean => value === null || (typeof value === 'object' && value !== null && Object.keys(value).every((key) => key === 'file'));

function owner(store: MemoryKeyValueStore, runLocks: RunLocks, makeChannel: (name: string) => RunChannel | null, over: Partial<RunOwnerOptions> = {}) {
  return openRunOwner({ store, keyPrefix: 'lib/j/', account: ACCOUNT, locks: recordLocks(), lockName: (key) => `record-${key}`, runLocks, lockPrefix: 'test-run-', isChosen, channel: 'runs', makeChannel, now: () => clock, writeEvery: 1_000, beatEvery: 2_000, ...over });
}
let clock = 1_000;

/** A job that counts `items` items, one per `step()`, each written through the gate. */
function countingJob(items: number, gate: Array<() => Promise<void>>): RunJob {
  return {
    key: KEY, kind: 'library', way: null, unit: 'sessions', chosen: { file: { name: 'a.zip', size: 1, lastModified: 1 } }, network: false, total: items,
    async run(context) {
      for (let index = 0; index < items; index += 1) {
        if (context.signal.aborted) return { ended: 'stopped', counts: context.record().counts };
        const wrote = await context.write(async () => { await gate[index]?.(); return true; });
        if (typeof wrote === 'object' && 'fenced' in wrote) return { ended: 'fenced', counts: context.record().counts };
        context.counts({ applied: index + 1, pending: items - index - 1 });
      }
      return { ended: 'finished', counts: context.record().counts };
    },
  };
}

/** An export that makes its file and waits for the save. */
function unsavedExport(onAbort?: () => void): RunJob {
  return {
    key: KEY, kind: 'export', way: 'library', unit: 'sessions', chosen: null, network: false, total: 1,
    async run(context) {
      if (onAbort) context.signal.addEventListener('abort', onAbort);
      context.counts({ applied: 1, pending: 0 });
      return { ended: 'unsaved', counts: context.record().counts };
    },
  };
}

describe('isRunRecord', () => {
  const record = { id: 'r1', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: { file: { name: 'a.zip', size: 1, lastModified: 1 } }, counts: { total: 2, pending: 2, applied: 0, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 1 };
  it('passes a record of the fourteen fields with a chosen the given check allows, and refuses content, an unknown field, a bad key and an item with more than an index, a state and a name', () => {
    expect(isRunRecord(record, isChosen)).toBe(true);
    expect(isRunRecord({ ...record, bytes: new Uint8Array(1) }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, chosen: { text: 'hello' } }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, key: 'short' }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, items: [{ index: 0, state: 'failed', name: 'a.md', reason: 'x' }] }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, items: [{ index: 0, state: 'failed', name: 'a.md' }] }, isChosen)).toBe(true);
  });

  it("passes a connected source's pick the given check allows, and refuses a name on an item that did not fail and a value that is not a plain object", () => {
    const pick = { pick: { source: 'drive', organization: 'o1', collection: null, folder: 'f1', repository: null, ref: null, kept: null, files: Array.from({ length: 50 }, (_, index) => ({ id: `d${index}`, name: `${index}.md` })) } };
    const allowsPick = (value: unknown): boolean => typeof value === 'object' && value !== null && Object.keys(value).every((key) => key === 'pick');
    expect(isRunRecord({ ...record, chosen: pick }, allowsPick)).toBe(true);
    expect(isRunRecord({ ...record, chosen: pick }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, items: [{ index: 0, state: 'added', name: 'a.md' }] }, isChosen)).toBe(false);
    expect(isRunRecord({ ...record, counts: { ...record.counts, total: -1 } }, isChosen)).toBe(false);
    expect(isRunRecord(new Map(Object.entries(record)), isChosen)).toBe(false);
    expect(isRunRecord('not a record', isChosen)).toBe(false);
  });
});

describe('the run owner', () => {
  it('writes the record before the first write, then at most once a second, and never makes one after a deletion', async () => {
    const store = new MemoryKeyValueStore();
    const set = vi.spyOn(store, 'set');
    const made = bus();
    const own = owner(store, memoryLocks(), made);
    const gate = Array.from({ length: 2_000 }, () => async () => { clock += 1; });
    const started = await own.start(countingJob(2_000, gate));
    expect('id' in started).toBe(true);
    await own.whenIdle();
    const writes = set.mock.calls.filter(([key]) => String(key).startsWith('lib/j/')).length;
    expect(writes).toBeLessThanOrEqual(5); // the first, two paced ones over two seconds of clock, the end
    await own.shown('id' in started ? started.id : '');
    expect(await store.keys('lib/j/')).toEqual([]);
    expect(set.mock.calls.filter(([key]) => String(key).startsWith('lib/j/')).length).toBe(writes);
  });

  it('refuses a second start of a held key at once, never queued, across two owners over one lock set', async () => {
    const locks = memoryLocks();
    const made = bus();
    const a = owner(new MemoryKeyValueStore(), locks, made);
    const b = owner(new MemoryKeyValueStore(), locks, made);
    const hold = deferred();
    await a.start(countingJob(1, [() => hold.promise]));
    expect(await b.start(countingJob(1, [async () => undefined]))).toEqual({ refused: 'another-tab' });
    expect(locks.names()).toEqual([runLockName('test-run-', ACCOUNT, KEY)]);
    hold.resolve();
  });

  it("drops another account's messages, keeps a watched run watched through its beat, and reads a live record as cut from its lock alone", async () => {
    const locks = memoryLocks();
    const made = bus();
    const store = new MemoryKeyValueStore();
    const holder = owner(store, locks, made);
    const watcher = owner(store, locks, made);
    const other = owner(store, locks, made, { account: 'b'.repeat(32) });
    const hold = deferred();
    await holder.start(countingJob(1, [() => hold.promise]));
    await watcher.records();
    expect(watcher.snapshot().runs[0]?.status).toBe('watched');
    expect(other.snapshot().runs).toEqual([]);
    clock += 5_000; // past five seconds of silence, the beat keeps it watched
    holder.beat();
    expect(watcher.snapshot().runs[0]?.status).toBe('watched');
    hold.resolve();
    await holder.whenIdle();
  });

  it('reads the records once a second with no channel, and an unsaved record with a free lock as cut', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r9', { id: 'r9', key: KEY, account: ACCOUNT, kind: 'export', way: 'library', unit: 'sessions', chosen: null, counts: { total: 40, pending: 0, applied: 40, skipped: 0, failed: 0 }, items: [], state: 'unsaved', cut: null, phase: null, began: 1, progressed: 2 });
    const own = owner(store, memoryLocks(), () => null);
    const read = await own.records();
    expect(read).toEqual([expect.objectContaining({ status: 'cut', cut: 'load' })]);
    own.close();
  });

  it('follows the record once a second when no channel reaches the other owner', async () => {
    const locks = memoryLocks();
    const store = new MemoryKeyValueStore();
    const holder = owner(store, locks, () => null);
    const watcher = owner(store, locks, () => null);
    const between = deferred();
    await holder.start({
      ...countingJob(3, []),
      async run(context) {
        await context.write(async () => true);
        context.counts({ applied: 2, pending: 1 });
        await between.promise;
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    await watcher.records();
    expect(watcher.snapshot().runs[0]?.record.counts.applied).toBe(0);
    await vi.waitFor(() => expect(watcher.snapshot().runs[0]).toMatchObject({ status: 'watched', record: { counts: { applied: 2 } } }), { timeout: 5_000, interval: 100 });
    between.resolve();
    await holder.whenIdle();
    holder.close();
    watcher.close();
  });

  it('refuses a write after the record is deleted or marked cut, and waits for a write in flight before a removal deletes', async () => {
    const store = new MemoryKeyValueStore();
    const made = bus();
    const own = owner(store, memoryLocks(), made);
    const first = deferred();
    const started = await own.start(countingJob(3, [() => first.promise, async () => undefined, async () => undefined]));
    const removal = own.stopAccount('removal');
    await Promise.resolve();
    expect(await store.keys('lib/j/')).toHaveLength(1); // the delete waits for the write in flight
    first.resolve();
    await removal;
    expect(await store.keys('lib/j/')).toEqual([]);
    const end = await own.whenIdle();
    expect(end.get('id' in started ? started.id : '')?.ended).toBe('fenced');
  });

  it('stopAccount reaches a second owner of the account through the channel and none of another account', async () => {
    const locks = memoryLocks();
    const made = bus();
    const store = new MemoryKeyValueStore();
    const a = owner(store, locks, made);
    const b = owner(store, locks, made);
    const c = owner(new MemoryKeyValueStore(), locks, made, { account: 'b'.repeat(32) });
    const heldB = deferred();
    await b.start(countingJob(2, [() => heldB.promise, async () => undefined]));
    const cRun = c.start({ ...countingJob(1, [async () => undefined]), key: 'e'.repeat(64) });
    const stop = a.stopAccount('signout');
    const marked = async () => (await store.get<{ cut: string }>((await store.keys('lib/j/'))[0] ?? ''))?.cut;
    await vi.waitFor(async () => expect(await marked()).toBe('signout'));
    heldB.resolve();
    await stop;
    expect(await marked()).toBe('signout');
    expect((await b.whenIdle()).values().next().value?.ended).toBe('fenced');
    expect('id' in (await cRun)).toBe(true);
  });

  it("stopAccount stops and drops this owner's own unsaved export at once, though the channel never echoes to its sender", async () => {
    const store = new MemoryKeyValueStore();
    const own = owner(store, memoryLocks(), bus());
    let dropped = false;
    const started = await own.start(unsavedExport(() => { dropped = true; })); // the product's job drops its zip at the abort
    await own.whenIdle();
    const before = Date.now();
    await own.stopAccount('removal');
    expect(Date.now() - before).toBeLessThan(1_000); // its own lock is let go, not waited out for ten seconds
    expect(dropped).toBe(true);
    expect(await store.keys('lib/j/')).toEqual([]);
    expect('id' in started).toBe(true);
  });

  it("runs on in memory when the store refuses its record, and the account's stop still fences it", async () => {
    const store = new MemoryKeyValueStore();
    store.get = async () => { throw new Error('refused'); };
    store.set = async () => { throw new Error('refused'); };
    const own = owner(store, memoryLocks(), bus());
    const hold = deferred();
    await own.start(countingJob(2, [() => hold.promise, async () => undefined]));
    expect(own.snapshot().unavailable).toBe(true);
    const stop = own.stopAccount('removal');
    hold.resolve();
    await stop;
    expect((await own.whenIdle()).values().next().value?.ended).toBe('fenced');
  });

  it('subscribeEnds fires once at an end and never at a count; dismiss of a record another owner holds is refused and hide deletes nothing', async () => {
    const locks = memoryLocks();
    const made = bus();
    const store = new MemoryKeyValueStore();
    const holder = owner(store, locks, made);
    const watcher = owner(store, locks, made);
    const ends = vi.fn();
    holder.subscribeEnds(ends);
    const hold = deferred();
    const started = await holder.start(countingJob(5, [() => hold.promise, ...Array.from({ length: 4 }, () => async () => undefined)]));
    const id = 'id' in started ? started.id : '';
    await watcher.records();
    expect(await watcher.dismiss(id)).toEqual({ refused: 'another-tab' });
    watcher.hide(id);
    expect(watcher.snapshot().runs[0]).toMatchObject({ status: 'watched', hidden: true });
    expect(await store.keys('lib/j/')).toHaveLength(1);
    hold.resolve();
    await holder.whenIdle();
    expect(ends).toHaveBeenCalledTimes(1);
    expect(ends).toHaveBeenCalledWith(expect.objectContaining({ status: 'held' }), 'finished');
  });

  it('skips and counts a record it cannot read', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/bad', 'not a record');
    const own = owner(store, memoryLocks(), () => null);
    expect(await own.records()).toEqual([]);
    expect(own.snapshot().unreadable).toBe(1);
    own.close();
  });

  it('pauses a network run while offline, writes the pause at once, and goes on from the item in hand when back online', async () => {
    const store = new MemoryKeyValueStore();
    let online = false;
    const listeners = new Set<() => void>();
    const own = owner(store, memoryLocks(), bus(), { online: { now: () => online, subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); } } });
    const wrote: number[] = [];
    const started = await own.start({
      ...countingJob(2, []), way: 'drive', unit: 'files', network: true,
      async run(context) {
        for (let index = 0; index < 2; index += 1) {
          await context.waitOnline();
          await context.write(async () => { wrote.push(index); return true; });
          context.counts({ applied: index + 1, pending: 1 - index });
        }
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    const key = `lib/j/${'id' in started ? started.id : ''}`;
    await vi.waitFor(async () => expect((await store.get<RunRecord>(key))?.state).toBe('paused'));
    expect(wrote).toEqual([]);
    online = true;
    for (const listener of [...listeners]) listener();
    await own.whenIdle();
    expect(wrote).toEqual([0, 1]);
    expect((await store.get<RunRecord>(key))?.state).toBe('running');
    own.close();
  });

  it('ends a stopped run after the item in hand, keeps its record until it is shown, and keeps a name on a failed item alone', async () => {
    const store = new MemoryKeyValueStore();
    const own = owner(store, memoryLocks(), bus());
    const inHand = deferred();
    const started = await own.start({
      ...countingJob(3, []),
      async run(context) {
        for (let index = 0; index < 3; index += 1) {
          if (context.signal.aborted) return { ended: 'stopped', counts: context.record().counts };
          await context.write(async () => { if (index === 0) await inHand.promise; return true; });
          context.item(index, index === 0 ? 'added' : 'failed', `${index}.md`);
          context.counts({ applied: index + 1, pending: 2 - index });
        }
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    const id = 'id' in started ? started.id : '';
    own.stop(id);
    expect(own.snapshot().runs[0]?.record.state).toBe('stopping');
    inHand.resolve();
    const end = (await own.whenIdle()).get(id);
    expect(end).toEqual({ ended: 'stopped', counts: expect.objectContaining({ applied: 1, pending: 2 }) });
    const kept = await store.get<RunRecord>(`lib/j/${id}`);
    expect(kept?.state).toBe('stopping');
    expect(kept?.items).toEqual([{ index: 0, state: 'added' }]);
    await own.shown(id);
    expect(await store.keys('lib/j/')).toEqual([]);
    expect(own.snapshot().runs[0]).toMatchObject({ status: 'held', ended: 'stopped' }); // the row stays until it is dismissed
    expect(await own.dismiss(id)).toEqual({ ok: true });
    expect(own.snapshot().runs).toEqual([]);
    own.close();
  });

  it('shown deletes a finished and a failed record and keeps an unsaved export\'s until it is saved', async () => {
    const store = new MemoryKeyValueStore();
    const own = owner(store, memoryLocks(), bus());
    const failing = await own.start({
      ...countingJob(2, []),
      async run(context) {
        await context.write(async () => true);
        context.item(1, 'failed', 'b.md');
        context.counts({ applied: 1, pending: 0, failed: 1 });
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    await own.whenIdle();
    const failedId = 'id' in failing ? failing.id : '';
    expect(await store.get<RunRecord>(`lib/j/${failedId}`)).toMatchObject({ state: 'failed', items: [{ index: 1, state: 'failed', name: 'b.md' }] });
    expect(own.snapshot().ended).toEqual({ finished: 0, failed: 1 });
    await own.shown(failedId);
    expect(await store.keys('lib/j/')).toEqual([]);
    await own.dismiss(failedId);
    const exported = await own.start({ ...unsavedExport(), key: 'd'.repeat(64) });
    await own.whenIdle();
    const exportId = 'id' in exported ? exported.id : '';
    await own.shown(exportId);
    expect(await store.get<RunRecord>(`lib/j/${exportId}`)).toMatchObject({ state: 'unsaved' });
    await own.saved(exportId);
    expect(await store.keys('lib/j/')).toEqual([]);
    own.close();
  });

  it('takes the same lock for a second attempt of one key, and refuses it when another owner took the key meanwhile', async () => {
    const locks = memoryLocks();
    const store = new MemoryKeyValueStore();
    const a = owner(store, locks, bus());
    const b = owner(new MemoryKeyValueStore(), locks, bus());
    const first = await a.start({
      ...countingJob(2, []),
      async run(context) {
        await context.write(async () => true);
        context.counts({ applied: 1, pending: 1 });
        return { ended: 'failed', counts: context.record().counts };
      },
    });
    await a.whenIdle();
    const firstId = 'id' in first ? first.id : '';
    expect(await b.start(countingJob(1, [async () => undefined]))).toEqual({ refused: 'another-tab' });
    const again = await a.continueRun(firstId, countingJob(1, [async () => undefined]));
    const againId = 'id' in again ? again.id : '';
    expect(againId).not.toBe('');
    expect(againId).not.toBe(firstId);
    expect(locks.names()).toEqual([runLockName('test-run-', ACCOUNT, KEY)]);
    await a.whenIdle();
    expect(await store.keys('lib/j/')).toEqual([`lib/j/${againId}`]);
    await a.shown(againId);
    expect(locks.names()).toEqual([]);
    const later = deferred();
    await b.start(countingJob(1, [() => later.promise]));
    expect(await a.continueRun(againId, countingJob(1, [async () => undefined]))).toEqual({ refused: 'another-tab' });
    later.resolve();
    await b.whenIdle();
    a.close();
    b.close();
  });

  it('finishes a cut run under its own id, setting it back to running with no cut, and keeps a beat-held unsaved export watched', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r7', { id: 'r7', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: { file: { name: 'a.zip', size: 1, lastModified: 1 } }, counts: { total: 3, pending: 2, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: 'signout', phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    const made = bus();
    const own = owner(store, locks, made);
    expect(await own.records()).toEqual([expect.objectContaining({ status: 'cut', cut: 'signout' })]);
    const between = deferred();
    expect(await own.finish('r7', countingJob(3, [async () => undefined, () => between.promise, async () => undefined]))).toEqual({ id: 'r7' });
    expect(await store.get<RunRecord>('lib/j/r7')).toMatchObject({ state: 'running', cut: null });
    between.resolve();
    expect((await own.whenIdle()).get('r7')?.counts.applied).toBe(3);

    const watcher = owner(store, locks, made);
    await own.shown('r7');
    await own.dismiss('r7');
    const exported = await own.start(unsavedExport());
    await own.whenIdle();
    await watcher.records();
    expect(watcher.snapshot().runs[0]?.status).toBe('watched');
    clock += 6_000;
    own.beat();
    await watcher.records();
    expect(watcher.snapshot().runs[0]).toMatchObject({ status: 'watched', record: { id: 'id' in exported ? exported.id : '' } });
    own.close();
    watcher.close();
  });

  it('fences a start still waiting for its lock when the account stops, and a start made while the stop waits', async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const opened = deferred();
    const slow: RunLocks = { ...locks, hold: async (name) => { await opened.promise; return locks.hold(name); } };
    const own = owner(store, slow, bus());
    let wrote = false;
    const writing: RunJob = {
      ...countingJob(1, []),
      async run(context) {
        const done = await context.write(async () => { wrote = true; return true; });
        return { ended: typeof done === 'object' ? 'fenced' : 'finished', counts: context.record().counts };
      },
    };
    const starting = own.start(writing);
    await own.stopAccount('removal');
    opened.resolve();
    const started = await starting;
    const ends = await own.whenIdle();
    expect(wrote).toBe(false);
    expect(await store.keys('lib/j/')).toEqual([]);
    expect(ends.get('id' in started ? started.id : '')?.ended).toBe('fenced');

    const inHand = deferred();
    await own.start({ ...countingJob(1, [() => inHand.promise]), key: 'c'.repeat(64) });
    const stopping = own.stopAccount('signout'); // waits for the first run's item in hand
    await Promise.resolve();
    wrote = false;
    const during = await own.start(writing);
    inHand.resolve();
    await stopping;
    const after = await own.whenIdle();
    expect(wrote).toBe(false);
    expect(after.get('id' in during ? during.id : '')?.ended).toBe('fenced');
    own.close();
  });

  it("fences a start still waiting for its lock when another tab's stop arrives, the removal winning over a later sign-out", async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const made = bus();
    const opened = deferred();
    const slow: RunLocks = { ...locks, hold: async (name) => { await opened.promise; return locks.hold(name); } };
    const own = owner(store, slow, made);
    const other = owner(store, locks, made);
    let wrote = false;
    const starting = own.start({
      ...countingJob(1, []),
      async run(context) {
        const done = await context.write(async () => { wrote = true; return true; });
        return { ended: typeof done === 'object' ? 'fenced' : 'finished', counts: context.record().counts };
      },
    });
    await other.stopAccount('removal');
    await other.stopAccount('signout');
    opened.resolve();
    const started = await starting;
    const ends = await own.whenIdle();
    expect(wrote).toBe(false);
    expect(await store.keys('lib/j/')).toEqual([]);
    expect(ends.get('id' in started ? started.id : '')?.ended).toBe('fenced');
    own.close();
    other.close();
  });

  it("stops the account's own records alone when two accounts share one store and prefix", async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/other', { id: 'other', key: KEY, account: 'b'.repeat(32), kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 2, pending: 1, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const own = owner(store, memoryLocks(), bus());
    await own.stopAccount('signout');
    expect((await store.get<RunRecord>('lib/j/other'))?.cut).toBeNull();
    await own.stopAccount('removal');
    expect(await store.keys('lib/j/')).toEqual(['lib/j/other']);
    own.close();
  });

  it('finds a run another owner starts later when no channel reaches it', async () => {
    const locks = memoryLocks();
    const store = new MemoryKeyValueStore();
    const watcher = owner(store, locks, () => null);
    expect(await watcher.records()).toEqual([]);
    const holder = owner(store, locks, () => null);
    const between = deferred();
    await holder.start({
      ...countingJob(1, []),
      async run(context) {
        await between.promise;
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    await vi.waitFor(() => expect(watcher.snapshot().runs).toEqual([expect.objectContaining({ status: 'watched' })]), { timeout: 5_000, interval: 100 });
    between.resolve();
    await holder.whenIdle();
    holder.close();
    watcher.close();
  });

  it('reads the record again for the next write after one read the store refused, so a record deleted meanwhile still fences it', async () => {
    const store = new MemoryKeyValueStore();
    const realGet = store.get.bind(store);
    let refuse = false;
    store.get = async <T,>(key: string): Promise<T | undefined> => {
      if (refuse) {
        refuse = false;
        throw new Error('refused');
      }
      return realGet<T>(key);
    };
    const own = owner(store, memoryLocks(), bus());
    const second = deferred();
    let wroteFirst = false;
    let wroteSecond = false;
    const started = await own.start({
      ...countingJob(2, []),
      async run(context) {
        refuse = true;
        await context.write(async () => { wroteFirst = true; return true; }); // the store cannot answer: the fence in memory stands
        await second.promise;
        const done = await context.write(async () => { wroteSecond = true; return true; });
        return { ended: typeof done === 'object' ? 'fenced' : 'finished', counts: context.record().counts };
      },
    });
    const id = 'id' in started ? started.id : '';
    await vi.waitFor(() => expect(wroteFirst).toBe(true));
    expect(own.snapshot().unavailable).toBe(true);
    await store.delete(`lib/j/${id}`); // another tab's removal, with no channel to say so
    second.resolve();
    expect((await own.whenIdle()).get(id)?.ended).toBe('fenced');
    expect(wroteSecond).toBe(false);
    own.close();
  });

  it('lets one owner alone finish a cut run, whatever key its new pick makes', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r5', { id: 'r5', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 3, pending: 2, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    const a = owner(store, locks, bus());
    const b = owner(store, locks, bus());
    await a.records();
    await b.records();
    const hold = deferred();
    expect(await a.finish('r5', { ...countingJob(1, [() => hold.promise]), key: 'c'.repeat(64) })).toEqual({ id: 'r5' });
    expect(await b.finish('r5', { ...countingJob(1, [async () => undefined]), key: 'd'.repeat(64) })).toEqual({ refused: 'another-tab' });
    hold.resolve();
    await a.whenIdle();
    a.close();
    b.close();
  });

  it('refuses to finish a cut run whose record was removed meanwhile, and writes nothing', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r6', { id: 'r6', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 3, pending: 2, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const own = owner(store, memoryLocks(), bus());
    expect(await own.records()).toEqual([expect.objectContaining({ status: 'cut' })]);
    await store.delete('lib/j/r6'); // another tab's removal
    let wrote = false;
    const finished = await own.finish('r6', {
      ...countingJob(1, []),
      async run(context) {
        await context.write(async () => { wrote = true; return true; });
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    await own.whenIdle();
    expect(finished).toEqual({ refused: 'another-tab' });
    expect(await store.keys('lib/j/')).toEqual([]);
    expect(wrote).toBe(false);
    own.close();
  });

  it('never deletes the record of a run another owner finished between the check and the deletion', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r4', { id: 'r4', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 3, pending: 2, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    const asked = deferred();
    const late = deferred();
    // The dismissing owner reads (or takes) the run's lock, then waits while the other owner tries to finish the run.
    const lagging: RunLocks = {
      ...locks,
      free: async (name) => { const answer = await locks.free(name); asked.resolve(); await late.promise; return answer; },
      hold: async (name) => { const grant = await locks.hold(name); asked.resolve(); await late.promise; return grant; },
    };
    const a = owner(store, lagging, bus());
    const b = owner(store, locks, bus());
    await b.records();
    const blocked = deferred();
    const dismissing = a.dismiss('r4');
    await asked.promise;
    const finished = await b.finish('r4', countingJob(1, [() => blocked.promise]));
    late.resolve();
    const dismissed = await dismissing;
    if ('id' in finished) {
      expect(dismissed).toEqual({ refused: 'another-tab' });
      expect(await store.keys('lib/j/')).toEqual(['lib/j/r4']);
    } else {
      expect(dismissed).toEqual({ ok: true });
      expect(await store.keys('lib/j/')).toEqual([]);
    }
    blocked.resolve();
    await b.whenIdle();
    a.close();
    b.close();
  });

  it("marks its own record cut for the session, refuses the writes after it, lets its lock go and reads as cut with the session's mark", async () => {
    const store = new MemoryKeyValueStore();
    const own = owner(store, memoryLocks(), bus());
    let wroteAfter = false;
    const started = await own.start({
      ...countingJob(2, []), network: true,
      async run(context) {
        await context.write(async () => true);
        await context.cut('session');
        await context.write(async () => { wroteAfter = true; return true; });
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    const id = 'id' in started ? started.id : '';
    expect((await own.whenIdle()).get(id)?.ended).toBe('cut');
    expect(wroteAfter).toBe(false);
    expect(await store.get<RunRecord>(`lib/j/${id}`)).toMatchObject({ cut: 'session' });
    expect(await own.records()).toEqual([expect.objectContaining({ status: 'cut', cut: 'session' })]);
    own.close();
  });
});
