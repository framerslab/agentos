/**
 * The browser run owner in Chromium and in WebKit: the run locks on the page's own Web Locks, two owners of one account
 * in one page over the real BroadcastChannel (a second start refused, the watcher following the holder's counts, the
 * watcher's removal fencing the holder's next write), and the record written at once when the page is hidden away.
 * The page's globals are read structurally, without the DOM library, as the key-value store's browser test reads them.
 */
import { describe, expect, it, vi } from 'vitest';

import { MemoryKeyValueStore } from '../index.js';
import { openRunOwner, runLockName, webRunLocks, type RunJob, type RunOwnerOptions, type RunRecord } from '../runs.js';

/** The part of the page's Web Locks the tests use. */
interface PageLocks {
  request(name: string, options: { mode?: 'exclusive' | 'shared' }, callback: () => Promise<void>): Promise<void>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}

const pageLocks = (globalThis as unknown as { navigator: { locks: PageLocks } }).navigator.locks;

/** The names the page's Web Locks hold now. */
async function heldNames(): Promise<string[]> {
  return ((await pageLocks.query()).held ?? []).map((lock) => lock.name ?? '');
}

/** Record locks on the page's Web Locks, as a product's record locks take them. */
function webRecordLocks(): RunOwnerOptions['locks'] {
  return { request: (name, work) => pageLocks.request(name, { mode: 'exclusive' }, work) };
}

/** A promise the test settles when it chooses. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

const unique = (): string => Math.random().toString(36).slice(2, 10);
const ACCOUNT = 'a'.repeat(32);
const KEY = 'f'.repeat(64);
const isChosen = (value: unknown): boolean => value === null || (typeof value === 'object' && value !== null && Object.keys(value).every((key) => key === 'file'));
const CHOSEN = { file: { name: 'a.zip', size: 1, lastModified: 1 } };

describe('webRunLocks', () => {
  it('holds a name at once or answers null, frees it on release, and waits for it to be free', async () => {
    const runLocks = webRunLocks();
    const name = `run-test-${unique()}`;
    const first = await runLocks.hold(name);
    expect(first).not.toBeNull();
    expect(await runLocks.hold(name)).toBeNull();
    expect(await heldNames()).toContain(name);
    expect(await runLocks.free(name)).toBe(false);
    expect(await runLocks.waitFree(name, 50)).toBe(false);
    const waiting = runLocks.waitFree(name, 5_000);
    first?.release();
    expect(await waiting).toBe(true);
    expect(await runLocks.free(name)).toBe(true);
    expect(await heldNames()).not.toContain(name);
  });
});

describe('two owners of one account in one page', () => {
  it("refuses the second start of a held key, lets the watcher follow the holder's counts, and fences the holder's next write from the watcher's removal", async () => {
    const tag = unique();
    const store = new MemoryKeyValueStore();
    const make = () => openRunOwner({ store, keyPrefix: 'lib/j/', account: ACCOUNT, locks: webRecordLocks(), lockName: (key) => `record-${tag}-${key}`, runLocks: webRunLocks(), lockPrefix: `run-${tag}-`, isChosen, channel: `runs-${tag}` });
    const holder = make();
    const watcher = make();
    const between = deferred();
    let secondWrote = false;
    const job: RunJob = {
      key: KEY, kind: 'library', way: null, unit: 'sessions', chosen: CHOSEN, network: false, total: 2,
      async run(context) {
        await context.write(async () => true);
        context.counts({ applied: 1, pending: 1 });
        await between.promise;
        const wrote = await context.write(async () => { secondWrote = true; return true; });
        if (typeof wrote === 'object' && 'fenced' in wrote) return { ended: 'fenced', counts: context.record().counts };
        context.counts({ applied: 2, pending: 0 });
        return { ended: 'finished', counts: context.record().counts };
      },
    };
    const started = await holder.start(job);
    expect('id' in started).toBe(true);
    expect(await watcher.start(job)).toEqual({ refused: 'another-tab' });
    expect(await heldNames()).toContain(runLockName(`run-${tag}-`, ACCOUNT, KEY));
    await watcher.records();
    await vi.waitFor(() => expect(watcher.snapshot().runs[0]).toMatchObject({ status: 'watched', record: { counts: { applied: 1 } } }), { timeout: 5_000, interval: 50 });

    const stop = watcher.stopAccount('removal');
    await vi.waitFor(async () => expect(await store.keys('lib/j/')).toEqual([]), { timeout: 5_000, interval: 20 });
    between.resolve();
    await stop;
    expect(secondWrote).toBe(false);
    expect((await holder.whenIdle()).get('id' in started ? started.id : '')?.ended).toBe('fenced');
    expect(await heldNames()).not.toContain(runLockName(`run-${tag}-`, ACCOUNT, KEY));
    expect(holder.snapshot().runs).toEqual([]);
    holder.close();
    watcher.close();
  });
});

describe('the record at pagehide', () => {
  it('is written at once when the page is hidden away, though the paced write is not due', async () => {
    const tag = unique();
    const store = new MemoryKeyValueStore();
    const own = openRunOwner({ store, keyPrefix: 'lib/j/', account: ACCOUNT, locks: webRecordLocks(), lockName: (key) => `record-${tag}-${key}`, runLocks: webRunLocks(), lockPrefix: `run-${tag}-`, isChosen, channel: `runs-${tag}`, makeChannel: () => null, now: () => 1_000, writeEvery: 60_000 });
    const between = deferred();
    const started = await own.start({
      key: KEY, kind: 'library', way: null, unit: 'sessions', chosen: CHOSEN, network: false, total: 2,
      async run(context) {
        context.counts({ applied: 1, pending: 1 });
        await between.promise;
        return { ended: 'finished', counts: context.record().counts };
      },
    });
    const key = `lib/j/${'id' in started ? started.id : ''}`;
    expect((await store.get<RunRecord>(key))?.counts.applied).toBe(0);
    (globalThis as unknown as EventTarget).dispatchEvent(new Event('pagehide'));
    await vi.waitFor(async () => expect((await store.get<RunRecord>(key))?.counts.applied).toBe(1), { timeout: 5_000, interval: 20 });
    between.resolve();
    await own.whenIdle();
    await own.shown('id' in started ? started.id : '');
    own.close();
  });
});
