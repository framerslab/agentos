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

/** A job that writes nothing and returns once its signal is aborted. */
function untilStopped(): RunJob {
  return {
    ...countingJob(1, []),
    async run(context) {
      await new Promise<void>((resolve) => {
        if (context.signal.aborted) resolve();
        else context.signal.addEventListener('abort', () => resolve());
      });
      return { ended: 'stopped', counts: context.record().counts };
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
    const removal = own.stopAccount('removal');
    await new Promise((resolve) => setTimeout(resolve, 20)); // the stop has listed the records while the start still waits
    opened.resolve();
    const started = await starting;
    expect(await removal).toEqual({ complete: true }); // it waited for the start's record to be deleted
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

  it('answers whether the account stop deleted or marked every record, and false while the store refuses the listing or a deletion', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r9', { id: 'r9', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 2, pending: 1, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const own = owner(store, memoryLocks(), bus());
    const realDelete = store.delete.bind(store);
    store.delete = async () => { throw new Error('refused'); };
    expect(await own.stopAccount('removal')).toEqual({ complete: false });
    expect(await store.keys('lib/j/')).toEqual(['lib/j/r9']);
    store.delete = realDelete;
    expect(await own.stopAccount('signout')).toEqual({ complete: true });
    expect((await store.get<RunRecord>('lib/j/r9'))?.cut).toBe('signout');
    expect(await own.stopAccount('removal')).toEqual({ complete: true });
    expect(await store.keys('lib/j/')).toEqual([]);
    const realKeys = store.keys.bind(store);
    store.keys = async () => { throw new Error('refused'); };
    expect(await own.stopAccount('removal')).toEqual({ complete: false });
    store.keys = realKeys;
    own.close();
  });

  it('ends the account stop within its ten seconds while a write in flight holds its record lock, answers false, and deletes the record once the write returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const store = new MemoryKeyValueStore();
      const own = owner(store, memoryLocks(), bus());
      const stuck = deferred();
      const started = await own.start(countingJob(2, [() => stuck.promise, async () => undefined]));
      const id = 'id' in started ? started.id : '';
      let answer: unknown = null;
      void own.stopAccount('removal').then((result) => { answer = result; });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(answer).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(answer).toEqual({ complete: false });
      expect(await store.keys('lib/j/')).toEqual([`lib/j/${id}`]); // the deletion still waits for the write in flight
      stuck.resolve();
      expect((await own.whenIdle()).get(id)?.ended).toBe('fenced');
      await vi.waitFor(async () => expect(await store.keys('lib/j/')).toEqual([]));
      own.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers the account stop within its ten seconds while the store never answers its listing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const store = new MemoryKeyValueStore();
      const own = owner(store, memoryLocks(), bus());
      store.keys = () => new Promise<string[]>(() => undefined);
      let answer: unknown = null;
      void own.stopAccount('signout').then((result) => { answer = result; });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(answer).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(answer).toEqual({ complete: false });
      own.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['deleted', 'refused'] as const)("waits for a start still taking its run lock when the removal began, and answers by whether that start's record was %s", async (outcome) => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const taking = deferred();
    // The start's run lock is granted only once the test lets it, after the stop has listed the records.
    const own = owner(store, { ...locks, hold: async (name) => { await taking.promise; return locks.hold(name); } }, bus());
    const realDelete = store.delete.bind(store);
    try {
      const starting = own.start(untilStopped());
      let answer: unknown = null;
      const stopping = own.stopAccount('removal').then((result) => { answer = result; });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(answer).toBeNull(); // the start has written nothing yet, so the stop cannot answer for its record
      if (outcome === 'refused') store.delete = async () => { throw new Error('refused'); };
      taking.resolve();
      const started = await starting;
      const id = 'id' in started ? started.id : '';
      await stopping;
      expect(answer).toEqual({ complete: outcome === 'deleted' });
      expect(await store.keys('lib/j/')).toEqual(outcome === 'deleted' ? [] : [`lib/j/${id}`]);
      expect((await own.whenIdle()).get(id)?.ended).toBe('fenced');
    } finally {
      store.delete = realDelete;
      own.close();
    }
  });

  it("answers false when a start's record could not be deleted though that start settled before the stop's second listing answered", async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const taking = deferred();
    const listed = deferred();
    const own = owner(store, { ...locks, hold: async (name) => { await taking.promise; return locks.hold(name); } }, bus());
    const realKeys = store.keys.bind(store);
    const realDelete = store.delete.bind(store);
    try {
      let calls = 0;
      // The stop's second listing reads the records before the start writes its record, and answers only once the start has settled.
      store.keys = async (prefix) => {
        calls += 1;
        const keys = await realKeys(prefix);
        if (calls === 2) await listed.promise;
        return keys;
      };
      const starting = own.start(untilStopped());
      let answer: unknown = null;
      const stopping = own.stopAccount('removal').then((result) => { answer = result; });
      await vi.waitFor(() => expect(calls).toBe(2));
      store.delete = async () => { throw new Error('refused'); };
      taking.resolve();
      const started = await starting;
      const id = 'id' in started ? started.id : '';
      await own.whenIdle();
      listed.resolve();
      await stopping;
      expect(answer).toEqual({ complete: false });
      store.keys = realKeys;
      expect(await store.keys('lib/j/')).toEqual([`lib/j/${id}`]);
    } finally {
      store.keys = realKeys;
      store.delete = realDelete;
      own.close();
    }
  });

  it("answers the sign-out complete within its ten seconds though the last read of the rows never answers, since that read redraws and deletes or marks nothing", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const store = new MemoryKeyValueStore();
    const realKeys = store.keys.bind(store);
    try {
      await store.set('lib/j/r8', { id: 'r8', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 2, pending: 1, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
      const own = owner(store, memoryLocks(), bus());
      let calls = 0;
      // The stop's two listings answer; the read of the rows after them never does.
      store.keys = (prefix) => {
        calls += 1;
        return calls <= 2 ? realKeys(prefix) : new Promise<string[]>(() => undefined);
      };
      let answer: unknown = null;
      void own.stopAccount('signout').then((result) => { answer = result; });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(answer).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(answer).toEqual({ complete: true });
      store.keys = realKeys;
      expect((await store.get<RunRecord>('lib/j/r8'))?.cut).toBe('signout');
      own.close();
    } finally {
      store.keys = realKeys;
      vi.useRealTimers();
    }
  });

  it('answers false while a write of a run kept in memory alone is still in flight at the ten seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const store = new MemoryKeyValueStore();
    const realSet = store.set.bind(store);
    try {
      store.set = async () => { throw new Error('refused'); };
      const own = owner(store, memoryLocks(), bus());
      const entered = deferred();
      const stuck = deferred();
      const started = await own.start(countingJob(2, [async () => { entered.resolve(); await stuck.promise; }, async () => undefined]));
      const id = 'id' in started ? started.id : '';
      await entered.promise;
      expect(own.snapshot().unavailable).toBe(true);
      let answer: unknown = null;
      void own.stopAccount('removal').then((result) => { answer = result; });
      await vi.advanceTimersByTimeAsync(9_000);
      expect(answer).toBeNull();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(answer).toEqual({ complete: false }); // the write that holds no record lock had not returned
      stuck.resolve();
      expect((await own.whenIdle()).get(id)?.ended).toBe('fenced');
      own.close();
    } finally {
      store.set = realSet;
      vi.useRealTimers();
    }
  });

  it("fences a start another tab makes after it heard the removal, while the stop's second listing has already read the records", async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const made = bus();
    const stopper = owner(store, locks, made);
    const other = owner(store, locks, made);
    const realKeys = store.keys.bind(store);
    const read = deferred();
    const answering = deferred();
    try {
      let calls = 0;
      // The stop's second listing reads the records, then waits until the other tab's start has run.
      store.keys = async (prefix) => {
        calls += 1;
        const keys = await realKeys(prefix);
        if (calls === 2) {
          read.resolve();
          await answering.promise;
        }
        return keys;
      };
      const stopping = stopper.stopAccount('removal');
      await read.promise;
      let wrote = false;
      const started = await other.start({
        ...countingJob(1, []),
        async run(context) {
          const done = await context.write(async () => { wrote = true; return true; });
          return { ended: typeof done === 'object' ? 'fenced' : 'finished', counts: context.record().counts };
        },
      });
      const id = 'id' in started ? started.id : '';
      expect((await other.whenIdle()).get(id)?.ended).toBe('fenced');
      expect(wrote).toBe(false);
      answering.resolve();
      expect(await stopping).toEqual({ complete: true });
      store.keys = realKeys;
      await vi.waitFor(async () => expect(await store.keys('lib/j/')).toEqual([]));
    } finally {
      store.keys = realKeys;
      answering.resolve();
      stopper.close();
      other.close();
    }
  });

  it("fences a start made while the sign-out runs though the stop ends before the start's lock is granted", async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const taking = deferred();
    let slow = false;
    const own = owner(store, { ...locks, hold: async (name) => { if (slow) await taking.promise; return locks.hold(name); } }, bus());
    const realKeys = store.keys.bind(store);
    const entered = deferred();
    const reading = deferred();
    try {
      let calls = 0;
      // The stop's last read of the rows, past its wait for the starts in flight, waits until the next start has begun.
      store.keys = async (prefix) => {
        calls += 1;
        const keys = await realKeys(prefix);
        if (calls === 3) {
          entered.resolve();
          await reading.promise;
        }
        return keys;
      };
      const stopping = own.stopAccount('signout');
      await entered.promise;
      slow = true;
      let wrote = false;
      const starting = own.start({
        ...countingJob(1, []),
        async run(context) {
          const done = await context.write(async () => { wrote = true; return true; });
          return { ended: typeof done === 'object' ? 'fenced' : 'finished', counts: context.record().counts };
        },
      });
      reading.resolve();
      expect(await stopping).toEqual({ complete: true });
      taking.resolve();
      const started = await starting;
      const id = 'id' in started ? started.id : '';
      expect((await own.whenIdle()).get(id)?.ended).toBe('fenced');
      expect(wrote).toBe(false);
      store.keys = realKeys;
      expect((await store.get<RunRecord>(`lib/j/${id}`))?.cut).toBe('signout');
    } finally {
      store.keys = realKeys;
      own.close();
    }
  });

  it.each(['removal', 'signout'] as const)("stops a run that another owner's %s reached when no channel joins them, though the run waits offline", async (cut) => {
    const locks = memoryLocks();
    const store = new MemoryKeyValueStore();
    const holder = owner(store, locks, () => null, { online: { now: () => false, subscribe: () => () => undefined } });
    const stopper = owner(store, locks, () => null);
    try {
      let wrote = false;
      const started = await holder.start({
        ...countingJob(1, []), way: 'drive', unit: 'files', network: true,
        async run(context) {
          await context.waitOnline();
          if (context.signal.aborted) return { ended: 'stopped', counts: context.record().counts };
          await context.write(async () => { wrote = true; return true; });
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      const id = 'id' in started ? started.id : '';
      await vi.waitFor(async () => expect((await store.get<RunRecord>(`lib/j/${id}`))?.state).toBe('paused'));
      const before = Date.now();
      await stopper.stopAccount(cut);
      expect(Date.now() - before).toBeLessThan(5_000); // the holder's once-a-second read stopped its run, so its lock went well inside the ten seconds
      expect((await holder.whenIdle()).get(id)?.ended).toBe('fenced');
      expect(wrote).toBe(false);
    } finally {
      holder.close();
      stopper.close();
    }
  }, 15_000);

  it.each(['removal', 'signout'] as const)('leaves no live record of a run another owner started after the %s listed the records and before its message', async (cut) => {
    const locks = memoryLocks();
    const store = new MemoryKeyValueStore();
    const channels = bus();
    const holder = owner(store, locks, channels);
    const stopper = owner(store, locks, channels);
    const realKeys = store.keys.bind(store);
    try {
      let armed = false;
      let id = '';
      // The stop's first listing reads the records, then the other owner's start writes its record before the listing answers.
      store.keys = async (prefix) => {
        const first = armed;
        armed = false;
        const listed = await realKeys(prefix);
        if (first) {
          const started = await holder.start(untilStopped());
          id = 'id' in started ? started.id : '';
        }
        return listed;
      };
      armed = true;
      const answer = await stopper.stopAccount(cut);
      store.keys = realKeys;
      expect(id).not.toBe('');
      expect(answer).toEqual({ complete: true });
      const check = async () => {
        if (cut === 'removal') expect(await store.keys('lib/j/')).toEqual([]);
        else expect((await store.get<RunRecord>(`lib/j/${id}`))?.cut).toBe('signout');
      };
      await check();
      expect((await holder.whenIdle()).get(id)?.ended).toBe('fenced');
      await check(); // the run's end brought nothing back
    } finally {
      store.keys = realKeys;
      holder.close();
      stopper.close();
    }
  });

  it.each(['removal', 'signout'] as const)("deletes or marks its own run's record when it hears another tab's %s", async (cut) => {
    const store = new MemoryKeyValueStore();
    const channels = bus();
    const holder = owner(store, memoryLocks(), channels);
    const tab = channels('runs');
    tab.listen(() => undefined);
    try {
      const started = await holder.start(untilStopped());
      const id = 'id' in started ? started.id : '';
      expect(await store.keys('lib/j/')).toEqual([`lib/j/${id}`]);
      tab.post({ account: ACCOUNT, stop: cut });
      expect((await holder.whenIdle()).get(id)?.ended).toBe('fenced');
      await vi.waitFor(async () => {
        if (cut === 'removal') expect(await store.keys('lib/j/')).toEqual([]);
        else expect((await store.get<RunRecord>(`lib/j/${id}`))?.cut).toBe('signout');
      });
    } finally {
      holder.close();
      tab.close();
    }
  });

  it("draws an item's new state or name that another tab wrote while the counts stayed the same", async () => {
    const store = new MemoryKeyValueStore();
    const record: RunRecord = {
      id: 'r7', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 2, pending: 1, applied: 0, skipped: 0, failed: 1 },
      items: [{ index: 0, state: 'failed', name: 'a.txt' }, { index: 1, state: 'waiting' }], state: 'running', cut: null, phase: null, began: 1, progressed: 2,
    };
    await store.set('lib/j/r7', record);
    const watcher = owner(store, memoryLocks(), () => null);
    try {
      await watcher.records();
      expect(watcher.snapshot().runs[0]?.record.items).toEqual(record.items);
      const reading: RunRecord = { ...record, items: [{ index: 0, state: 'failed', name: 'a.txt' }, { index: 1, state: 'reading' }], progressed: 3 };
      await store.set('lib/j/r7', reading);
      await watcher.records();
      expect(watcher.snapshot().runs[0]?.record.items).toEqual(reading.items);
      const renamed: RunRecord = { ...reading, items: [{ index: 0, state: 'failed', name: 'b.txt' }, { index: 1, state: 'reading' }], progressed: 4 };
      await store.set('lib/j/r7', renamed);
      await watcher.records();
      expect(watcher.snapshot().runs[0]?.record.items).toEqual(renamed.items);
    } finally {
      watcher.close();
    }
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

  it("never deletes the record of a run another owner finished between the check and the deletion: the dismissal that reads the lock first holds it", async () => {
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
    const dismissing = a.dismiss('r4');
    await asked.promise;
    const finished = await b.finish('r4', countingJob(1, [async () => undefined]));
    late.resolve();
    expect(finished).toEqual({ refused: 'another-tab' });
    expect(await dismissing).toEqual({ ok: true });
    expect(await store.keys('lib/j/')).toEqual([]);
    a.close();
    b.close();
  });

  it('refuses a dismissal while another owner finishes the run, and keeps its record', async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r3', { id: 'r3', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 3, pending: 2, applied: 1, skipped: 0, failed: 0 }, items: [], state: 'running', cut: null, phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    const a = owner(store, locks, bus());
    const b = owner(store, locks, bus());
    await a.records();
    await b.records();
    const blocked = deferred();
    expect(await b.finish('r3', countingJob(1, [() => blocked.promise]))).toEqual({ id: 'r3' });
    expect(await a.dismiss('r3')).toEqual({ refused: 'another-tab' });
    expect(await store.keys('lib/j/')).toEqual(['lib/j/r3']);
    blocked.resolve();
    await b.whenIdle();
    a.close();
    b.close();
  });

  it("resumes a cut run from its record as stored, not from the copy this owner read before another tab's finish moved it on", async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r6', { id: 'r6', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 5, pending: 5, applied: 0, skipped: 0, failed: 0 }, items: [], state: 'running', cut: 'session', phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    // On channels of their own, so the first owner keeps the copy it read.
    const a = owner(store, locks, bus());
    const b = owner(store, locks, bus());
    try {
      await a.records();
      expect(a.snapshot().runs[0]?.status).toBe('cut');
      const moved = await b.finish('r6', {
        ...countingJob(5, []),
        async run(context) {
          context.counts({ applied: 2, pending: 3 });
          context.item(0, 'added');
          context.item(1, 'added');
          await context.cut('session');
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      expect(moved).toEqual({ id: 'r6' });
      await b.whenIdle();
      expect((await store.get<RunRecord>('lib/j/r6'))?.counts).toMatchObject({ applied: 2, pending: 3 });
      const resumedWith: RunRecord[] = [];
      const resumed = await a.finish('r6', {
        ...countingJob(5, []),
        async run(context) {
          resumedWith.push(context.record());
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      expect(resumed).toEqual({ id: 'r6' });
      await a.whenIdle();
      expect(resumedWith[0]?.counts).toMatchObject({ applied: 2, pending: 3 });
      expect(resumedWith[0]?.items).toEqual([{ index: 0, state: 'added' }, { index: 1, state: 'added' }]);
    } finally {
      a.close();
      b.close();
    }
  });

  it("refuses to finish a cut run from a copy whose key another tab's finish has changed while a third tab runs it, and draws the run from its record as stored", async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r8', { id: 'r8', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 5, pending: 5, applied: 0, skipped: 0, failed: 0 }, items: [], state: 'running', cut: 'session', phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    // On channels of their own, so the first owner keeps the copy it read, under the first key.
    const stale = owner(store, locks, bus());
    const second = owner(store, locks, bus());
    const third = owner(store, locks, bus());
    const hold = deferred();
    try {
      await stale.records();
      expect(stale.snapshot().runs[0]?.status).toBe('cut');
      // The second tab finishes the run under another pick's key and is cut again.
      const moved = await second.finish('r8', {
        ...countingJob(5, []),
        key: 'b'.repeat(64),
        async run(context) {
          context.counts({ applied: 1, pending: 4 });
          await context.cut('session');
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      expect(moved).toEqual({ id: 'r8' });
      await second.whenIdle();
      expect((await store.get<RunRecord>('lib/j/r8'))?.key).toBe('b'.repeat(64));
      // A third tab finishes it under a third key and is still running it.
      expect(await third.finish('r8', { ...countingJob(1, [() => hold.promise]), key: 'c'.repeat(64) })).toEqual({ id: 'r8' });
      let wrote = false;
      const late = await stale.finish('r8', {
        ...countingJob(1, []),
        key: 'd'.repeat(64),
        async run(context) {
          await context.write(async () => { wrote = true; return true; });
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      await stale.whenIdle();
      expect(late).toEqual({ refused: 'another-tab' });
      expect(wrote).toBe(false);
      expect((await store.get<RunRecord>('lib/j/r8'))?.key).toBe('c'.repeat(64));
      expect(stale.snapshot().runs).toEqual([expect.objectContaining({ status: 'watched', record: expect.objectContaining({ id: 'r8', key: 'c'.repeat(64) }) })]);
      hold.resolve();
      await third.whenIdle();
    } finally {
      hold.resolve();
      stale.close();
      second.close();
      third.close();
    }
  });

  it("draws a cut run that another tab finishes as running again, and counts its finish", async () => {
    const store = new MemoryKeyValueStore();
    const locks = memoryLocks();
    const made = bus();
    const watcher = owner(store, locks, made);
    const first = owner(store, locks, made);
    const second = owner(store, locks, made);
    const ends: string[] = [];
    watcher.subscribeEnds((_read, ended) => { ends.push(ended); });
    const mid = deferred();
    try {
      const started = await first.start({
        ...countingJob(2, []),
        async run(context) {
          await context.write(async () => true);
          await context.cut('session');
          return { ended: 'finished', counts: context.record().counts };
        },
      });
      const id = 'id' in started ? started.id : '';
      await first.whenIdle();
      await vi.waitFor(() => expect(ends).toEqual(['cut']));
      expect(await second.finish(id, {
        ...countingJob(2, []),
        async run(context) {
          await mid.promise;
          context.counts({ applied: 2, pending: 0 });
          return { ended: 'finished', counts: context.record().counts };
        },
      })).toEqual({ id });
      await vi.waitFor(() => expect(watcher.snapshot().runs.find((run) => run.record.id === id)).toMatchObject({ status: 'watched', ended: null }));
      mid.resolve();
      await second.whenIdle();
      await vi.waitFor(() => expect(ends).toEqual(['cut', 'finished']));
      expect(watcher.snapshot().ended.finished).toBe(1);
    } finally {
      mid.resolve();
      watcher.close();
      first.close();
      second.close();
    }
  });

  it("holds the run's lock while it deletes another tab's failed record once shown, so a finish meanwhile is refused", async () => {
    const store = new MemoryKeyValueStore();
    await store.set('lib/j/r5', { id: 'r5', key: KEY, account: ACCOUNT, kind: 'library', way: null, unit: 'sessions', chosen: null, counts: { total: 3, pending: 2, applied: 0, skipped: 0, failed: 1 }, items: [{ index: 0, state: 'failed', name: 'a.txt' }], state: 'failed', cut: null, phase: null, began: 1, progressed: 2 });
    const locks = memoryLocks();
    const asked = deferred();
    const late = deferred();
    let lag = false;
    // Once the test lags it, the showing owner reads (or takes) the run's lock, then waits while the other owner tries to finish the run.
    const lagging: RunLocks = {
      ...locks,
      free: async (name) => { const answer = await locks.free(name); if (lag) { asked.resolve(); await late.promise; } return answer; },
      hold: async (name) => { const grant = await locks.hold(name); if (lag) { asked.resolve(); await late.promise; } return grant; },
    };
    const a = owner(store, lagging, bus());
    const b = owner(store, locks, bus());
    const blocked = deferred();
    try {
      await a.records();
      expect(a.snapshot().runs[0]?.status).toBe('failed');
      lag = true;
      const showing = a.shown('r5');
      await asked.promise;
      lag = false;
      const finished = await b.finish('r5', countingJob(2, [() => blocked.promise]));
      late.resolve();
      await showing;
      expect(finished).toEqual({ refused: 'another-tab' });
      expect(await store.keys('lib/j/')).toEqual([]);
    } finally {
      late.resolve();
      blocked.resolve();
      await b.whenIdle();
      a.close();
      b.close();
    }
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
