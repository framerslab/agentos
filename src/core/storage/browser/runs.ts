/**
 * @fileoverview A page's long runs (an import, an export, an upload) above its views: one owner a page per account
 * that holds each run's AbortSignal, its content-free record in the given key-value store, a Web Lock named for the
 * run's job for its whole life, and a BroadcastChannel whose messages carry the account's id with the job's counts,
 * so a second tab draws the run and never starts it again. The owner knows no product: the store, the key prefix,
 * the record locks, the lock prefix, the check of what a job may record as chosen and the channel's name are the
 * caller's; it writes no log line, opens no database and never names a file's contents. Node-free and DOM-free but
 * for `navigator.locks` and `BroadcastChannel`, reached only when a caller gives `webRunLocks()` and a channel name,
 * and the page's `pagehide`, `visibilitychange`, `online` and `offline` events, listened to where the page has them.
 *
 * The record is fourteen fields (`RunRecord`) and `isRunRecord` refuses any other, so what a run keeps on the device
 * is its counts, its state and the caller's checked description of what was chosen, never a file's contents; its
 * strings (`kind`, `way`, a failed item's name, what `isChosen` lets `chosen` hold) are the caller's to keep plain.
 * It is written before the job's first content write and then at most once every `writeEvery` while the counts change,
 * at once when the page is hidden away and at the run's end; every write after the first changes a record that exists
 * and never makes one, so a write in flight after a removal cannot bring the record back.
 *
 * The run's lock (`RunLocks`, `webRunLocks()`) is held from `start` until the end has been shown (an export's until it
 * is saved or dismissed); a second `start` of the same job while it is held is refused at once, never queued. A record
 * in a live state whose lock is free was cut by a load (or marked by a sign-out or a session's end); one whose lock is
 * held is another tab's, watched. Silence on the channel never makes a run cut: only a free lock does.
 *
 * Every content write of a job goes through `context.write(work)`, which takes the record's own lock, reads the
 * record and runs `work` inside that lock only when the record exists and carries no cut mark: the write gate. The
 * account's stop (`stopAccount`) deletes or marks every record of the account under the same lock first, so a removal
 * or a sign-out lands before a write, which is then refused, or after it, never between the check and the write; then
 * it stops the account's runs here and, through the channel, in every other tab, and waits for their locks. A second
 * listing after the message fences a record another tab wrote between the first listing and the message, and a tab
 * that hears the stop fences its own runs' records too. The whole stop answers within ten seconds, and answers whether
 * every record was deleted or marked, the records of this owner's starts in flight among them. With no channel, each
 * owner reads the records once a second and stops a run of its own whose record another owner's stop deleted or marked.
 * A start still waiting for its lock when the account stops, or made while the stop runs, is fenced from its start; a
 * tab that heard another tab's stop counts it as running for the ten seconds after its message, the longest it runs.
 * @module agentos/core/storage/browser/runs
 */
import type { KeyValueStore } from '@framers/sql-storage-adapter/kv';

/** What a run counts. */
export type RunUnit = 'sessions' | 'files' | 'notes' | 'bytes';
/** Where one chosen item stands. */
export type RunItemState = 'waiting' | 'reading' | 'added' | 'skipped' | 'failed';
/** The states a record keeps. A finished or stopped run keeps its last live state until its end is shown. */
export type RunState = 'running' | 'paused' | 'stopping' | 'failed' | 'unsaved';
/** Why a run stopped short: a load (read, never written), a sign-out or the session's end on the server. */
export type RunCut = null | 'load' | 'signout' | 'session';
/** Which indeterminate line a run shows while it has no count to show. */
export type RunPhase = 'counting' | 'reading' | 'writing' | 'sending' | 'being-read' | null;
/** A run's counts: `total` is null until it is known; `failed` counts the items to try again. */
export interface RunCounts { total: number | null; pending: number; applied: number; skipped: number; failed: number }
/** One chosen item: its index and its state, with its name kept for a failed item alone. */
export interface RunItem { index: number; state: RunItemState; name?: string }
/** The record of one run attempt: these fourteen fields and no other. */
export interface RunRecord { id: string; key: string; account: string; kind: string; way: string | null; unit: RunUnit; chosen: unknown; counts: RunCounts; items: RunItem[]; state: RunState; cut: RunCut; phase: RunPhase; began: number; progressed: number }
/** How a job ended; `fenced` is a job the write gate refused or the account's stop reached, which draws no row. */
export type RunEnd = { ended: 'finished' | 'stopped' | 'failed' | 'unsaved' | 'cut' | 'fenced'; counts: RunCounts };
/** What a job is handed while it runs. */
export interface RunContext {
  /** This attempt's id, new at every `start` and `continueRun`; a finish keeps the cut record's. */
  id: string;
  /** Aborted by `stop`, by the account's stop and by `dismiss`: the job reads it between items. */
  signal: AbortSignal;
  /** Changes the counts; the record follows at most once every `writeEvery`. */
  counts(next: Partial<RunCounts>): void;
  /** Sets one item's state; a name is kept for a failed item alone. */
  item(index: number, state: RunItemState, name?: string): void;
  /** Sets the indeterminate line. */
  phase(next: RunPhase): void;
  /** Resolves at once while online; offline, marks the run paused and resolves when the page is back online. */
  waitOnline(): Promise<void>;
  /** The write gate: runs `work` under the record's lock while the record stands unmarked, else answers `{ fenced: true }`. */
  write<T>(work: () => Promise<T>): Promise<T | { fenced: true }>;
  /** Marks the record cut by the session's end and awaits the mark; the run ends as `cut`. */
  cut(reason: 'session'): Promise<void>;
  /** A copy of the run's record as it stands in memory. */
  record(): RunRecord;
}
/** One run a caller starts: its stable key (64 lowercase hexadecimal characters, the caller's), what it is, and its work. */
export interface RunJob { key: string; kind: string; way: string | null; unit: RunUnit; chosen: unknown; network: boolean; total: number | null; run(context: RunContext): Promise<RunEnd> }
/** The locks of runs' lives: a hold that is refused at once when the name is held, never queued. */
export interface RunLocks { hold(name: string): Promise<{ release(): void } | null>; free(name: string): Promise<boolean>; waitFree(name: string, ms: number): Promise<boolean> }
/**
 * What the owners of one account tell each other: a run's counts and state (`ended` once it has ended), or the
 * account's stop. A message carries no name, no file and no word.
 */
export type RunMessage =
  | { account: string; id: string; key: string; counts: RunCounts; state: RunState; phase: RunPhase; at: number; ended?: RunEnd['ended'] }
  | { account: string; stop: 'removal' | 'signout' | 'session' };
/** A channel between the tabs of one origin, as `BroadcastChannel` is: a post never reaches its own sender. */
export interface RunChannel { post(message: RunMessage): void; listen(hear: (message: RunMessage) => void): void; close(): void }
/** A run held by this owner, watched in another tab, cut, or failed with its lock free. */
export type RunStatus = 'held' | 'watched' | 'cut' | 'failed';
/** One run as read: its record, whose it is, and why it stopped short when it did (`'load'` when nothing marked it). */
export interface RunRead { record: RunRecord; status: RunStatus; cut: RunCut }
/**
 * The runs as drawn, newest first: each with `hidden` (this page stopped drawing it) and `ended` (how it ended, null
 * while it runs); the records the last read could not parse; whether the store refused a record, so a run is held in
 * memory alone; and how many runs this owner held or watched have finished and failed since it opened.
 */
export interface RunsSnapshot {
  runs: Array<RunRead & { hidden: boolean; ended: RunEnd['ended'] | null }>;
  unreadable: number;
  unavailable: boolean;
  ended: { finished: number; failed: number };
}
/** What an owner is opened with. */
export interface RunOwnerOptions {
  /** The account's store, where the records live under `keyPrefix`. */
  store: KeyValueStore;
  keyPrefix: string;
  /** The account's id: the records, the locks and the messages of another account are never read. */
  account: string;
  /** The record locks: the same lock the caller takes to change or delete a record, named by `lockName(storeKey)`. */
  locks: { request(name: string, work: () => Promise<void>): Promise<void> };
  lockName: (key: string) => string;
  /** The runs' locks: `webRunLocks()` in a page. */
  runLocks: RunLocks;
  /**
   * What every run lock's name begins with.
   * @default 'run-'
   */
  lockPrefix?: string;
  /** The caller's check of what a job may record as chosen: it names every key each shape may hold. */
  isChosen: (value: unknown) => boolean;
  /** The channel's name. */
  channel: string;
  /** Makes the channel; null for none. Without it, a `BroadcastChannel` of the name, where the page has one. */
  makeChannel?: (name: string) => RunChannel | null;
  /** Whether the page is online, and its changes. Without it, `navigator.onLine` and the page's events, where it has them. */
  online?: { now(): boolean; subscribe(listener: () => void): () => void };
  /** @default Date.now */
  now?: () => number;
  /** @default 1000 */
  writeEvery?: number;
  /** @default 2000 */
  beatEvery?: number;
}
/** A page's run owner for one account. */
export interface RunOwner {
  /** Takes the job's lock, writes its record and runs it; refused at once while the job's lock is held anywhere. */
  start(job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }>;
  /** Stops a run after the item in hand. */
  stop(id: string): void;
  /** A stopped or failed run's rest as a new attempt under the same lock, from the page's memory. */
  continueRun(id: string, job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }>;
  /**
   * A cut run's rest after a load, under the cut record's id, with the job the caller builds from the new pick. Refused,
   * starting nothing, when the record cannot be found or read or another tab removed it, or when another tab finished it
   * under another key since this owner read it: that record is drawn again as stored, and a second finish takes its
   * current key's lock.
   */
  finish(id: string, job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }>;
  /**
   * Deletes the record and drops the run, for a run this owner holds or a record whose lock is free. Refused, the record
   * kept and drawn as stored, when another tab finished the run under another key since this owner read it.
   */
  dismiss(id: string): Promise<{ ok: true } | { refused: 'another-tab' }>;
  /** Stops drawing a run in this page alone; the record and the run are untouched. */
  hide(id: string): void;
  /**
   * The end was drawn: the record goes and the lock is let go, unless the run is an unsaved export. Another tab's failed
   * record is kept, and drawn as stored, when another tab finished it under another key since this owner read it.
   */
  shown(id: string): Promise<void>;
  /** An unsaved export was saved: its record goes and its lock is let go. */
  saved(id: string): Promise<void>;
  /**
   * Deletes (a removal) or marks (a sign-out, a session's end) every record, stops the account's runs in every tab and
   * waits for their locks, then lists the records again for a run another tab started meanwhile, and waits for this
   * owner's starts in flight; the whole stop answers within ten seconds. Answers `{ complete: true }` once the store
   * listed the records and every record of the account was deleted or marked, and `{ complete: false }` when the store
   * refused a listing, a read, a deletion or a mark, or a listing had not answered by the ten seconds, or a write or a
   * start was still in flight then (that record is deleted or marked once the write returns), a write of a run kept in
   * memory alone among them: call it again. The last
   * read of the rows after a sign-out or a session's end redraws them and leaves the answer as it is. A start made in
   * another tab within the ten seconds after that tab heard the stop is fenced there from its start, its record deleted
   * or marked by that tab; a deletion or a mark the store refuses there is not in this answer. With no channel, a
   * start in another tab that writes its record after the second listing is neither fenced nor in this answer.
   */
  stopAccount(cut: 'removal' | 'signout' | 'session'): Promise<{ complete: boolean }>;
  /**
   * Reads every record under the prefix that the store lets it read, with the runs this owner holds whether their
   * records remain or not; a listing or a read the store refuses leaves its records out, so this is no check that a
   * removal deleted them (`stopAccount`'s answer is).
   */
  records(): Promise<RunRead[]>;
  /** The runs as drawn; the same object until something changes. */
  snapshot(): RunsSnapshot;
  /** Called when the snapshot changes, at most four times a second. */
  subscribe(listener: () => void): () => void;
  /**
   * Called once when a run this owner holds or watches ends, fails or turns unsaved, and at no count. A run the
   * account's stop or a dismissal fenced calls it at no end, nor does one they reach while its last record write is in
   * flight. With no channel, a run watched in another tab calls it only when its record turns failed or unsaved: its
   * finish, stop or cut there is not heard.
   */
  subscribeEnds(listener: (read: RunRead, ended: RunEnd['ended']) => void): () => void;
  /** Each run's end, once every run this owner started has returned. */
  whenIdle(): Promise<Map<string, RunEnd>>;
  /** Sends every live run's message now. */
  beat(): void;
  /** Stops the owner's timers, listeners and channel; a run it holds goes on to its end. */
  close(): void;
}

type Ended = RunEnd['ended'];
type AccountStop = 'removal' | 'signout' | 'session';
type Timer = ReturnType<typeof setTimeout>;
type Interval = ReturnType<typeof setInterval>;

const UNITS: readonly RunUnit[] = ['sessions', 'files', 'notes', 'bytes'];
const ITEM_STATES: readonly RunItemState[] = ['waiting', 'reading', 'added', 'skipped', 'failed'];
const STATES: readonly RunState[] = ['running', 'paused', 'stopping', 'failed', 'unsaved'];
const LIVE: readonly RunState[] = ['running', 'paused', 'stopping', 'unsaved'];
const CUTS: readonly RunCut[] = [null, 'load', 'signout', 'session'];
const PHASES: readonly RunPhase[] = ['counting', 'reading', 'writing', 'sending', 'being-read', null];
const ENDS: readonly Ended[] = ['finished', 'stopped', 'failed', 'unsaved', 'cut', 'fenced'];
const STOPS: readonly AccountStop[] = ['removal', 'signout', 'session'];
const FIELDS = ['id', 'key', 'account', 'kind', 'way', 'unit', 'chosen', 'counts', 'items', 'state', 'cut', 'phase', 'began', 'progressed'] as const;
const COUNT_FIELDS = ['total', 'pending', 'applied', 'skipped', 'failed'] as const;
const ITEM_FIELDS = ['index', 'state', 'name'] as const;
const KEY_PATTERN = /^[0-9a-f]{64}$/;
/** How long the account's stop waits for the runs' locks in all. */
const STOP_WAIT = 10_000;
/** How often a page that draws another tab's run reads its lock, or the records with no channel. */
const WATCH_EVERY = 1_000;
/** The least time between two notices to `subscribe`'s listeners, and between two messages of one run. */
const NOTICE_EVERY = 250;

/** The run's lock name: the caller's prefix, the account and the job's key, so one job is one lock across tabs. */
export function runLockName(prefix: string, account: string, key: string): string {
  return `${prefix}${account}/${key}`;
}

/** True for an object of the object literal's own kind (no `File`, `Blob`, `Map` or array). */
function isPlain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** True when `value` holds no key outside `allowed` and every key of `required`. */
function holdsOnly(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

/** True for a finite count of zero or more. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** True for the five counts and no other field. */
function isCounts(value: unknown): value is RunCounts {
  if (!isPlain(value) || !holdsOnly(value, COUNT_FIELDS, COUNT_FIELDS)) return false;
  return (value.total === null || isCount(value.total)) && isCount(value.pending) && isCount(value.applied) && isCount(value.skipped) && isCount(value.failed);
}

/** True for an item of an index and a state, with a name on a failed item alone. */
function isItem(value: unknown): boolean {
  if (!isPlain(value) || !holdsOnly(value, ITEM_FIELDS, ['index', 'state'])) return false;
  if (!isCount(value.index) || !Number.isInteger(value.index) || !ITEM_STATES.includes(value.state as RunItemState)) return false;
  return !Object.prototype.hasOwnProperty.call(value, 'name') || (value.state === 'failed' && typeof value.name === 'string');
}

/**
 * True for a record of the fourteen fields and no other, its `key` 64 lowercase hexadecimal characters, its items of
 * an index, a state and a name at most (a name on a failed item alone), and a `chosen` the given check allows.
 */
export function isRunRecord(value: unknown, isChosen: (value: unknown) => boolean): value is RunRecord {
  if (!isPlain(value) || !holdsOnly(value, FIELDS, FIELDS)) return false;
  if (typeof value.id !== 'string' || value.id === '' || typeof value.account !== 'string' || value.account === '') return false;
  if (typeof value.key !== 'string' || !KEY_PATTERN.test(value.key)) return false;
  if (typeof value.kind !== 'string' || (value.way !== null && typeof value.way !== 'string')) return false;
  if (!UNITS.includes(value.unit as RunUnit) || !STATES.includes(value.state as RunState)) return false;
  if (!CUTS.includes(value.cut as RunCut) || !PHASES.includes(value.phase as RunPhase)) return false;
  if (!isCounts(value.counts) || !Array.isArray(value.items) || !value.items.every(isItem)) return false;
  if (typeof value.began !== 'number' || !Number.isFinite(value.began) || typeof value.progressed !== 'number' || !Number.isFinite(value.progressed)) return false;
  try {
    return isChosen(value.chosen) === true;
  } catch {
    return false;
  }
}

/** True for a message of either form, its counts and state checked. */
function isRunMessage(value: unknown): value is RunMessage {
  if (!isPlain(value) || typeof value.account !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(value, 'stop')) return STOPS.includes(value.stop as AccountStop);
  return (
    typeof value.id === 'string' &&
    typeof value.key === 'string' &&
    isCounts(value.counts) &&
    STATES.includes(value.state as RunState) &&
    PHASES.includes(value.phase as RunPhase) &&
    typeof value.at === 'number' &&
    (value.ended === undefined || ENDS.includes(value.ended as Ended))
  );
}

/** A copy of a record, its counts and items copied too. */
function copyRecord(record: RunRecord): RunRecord {
  return { ...record, counts: { ...record.counts }, items: record.items.map((item) => ({ ...item })) };
}

/** A timer that never keeps a Node process alive. */
function later(work: () => void, ms: number): Timer {
  const timer = setTimeout(work, Math.max(0, ms));
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** What `promise` gives within `ms`, or null once `ms` has passed or when it rejects. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = later(() => resolve(null), ms);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** An interval that never keeps a Node process alive. */
function every(work: () => void, ms: number): Interval {
  const timer = setInterval(work, ms);
  (timer as unknown as { unref?: () => void }).unref?.();
  return timer;
}

/** A signal that aborts after `ms`. */
function timeoutSignal(ms: number): AbortSignal {
  const make = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof make.timeout === 'function') return make.timeout(Math.max(0, ms));
  const controller = new AbortController();
  later(() => controller.abort(), ms);
  return controller.signal;
}

/** A run attempt's id: the browser's random UUID, or random characters where it has none. */
function newId(): string {
  const webCrypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (webCrypto && typeof webCrypto.randomUUID === 'function') {
    try {
      return webCrypto.randomUUID();
    } catch {
      // An insecure context refuses it: the characters below serve.
    }
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** The part of the page's Web Locks the run locks use. */
interface LockManagerLike {
  request(name: string, options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => unknown): Promise<unknown>;
  query(): Promise<{ held?: Array<{ name?: string }> }>;
}

/** The page's own names, for a page with no Web Locks: one set for every owner of the page. */
let namesOfThisPage: RunLocks | null = null;

/** The page's own run names, made once and shared by every owner of the page. */
function pageNames(): RunLocks {
  if (namesOfThisPage) return namesOfThisPage;
  const held = new Set<string>();
  const waiting = new Map<string, Array<() => void>>();
  const wake = (name: string): void => {
    const wakers = waiting.get(name) ?? [];
    waiting.delete(name);
    for (const waker of wakers) waker();
  };
  namesOfThisPage = {
    async hold(name) {
      if (held.has(name)) return null;
      held.add(name);
      let released = false;
      return {
        release: () => {
          if (released) return;
          released = true;
          held.delete(name);
          wake(name);
        },
      };
    },
    async free(name) {
      return !held.has(name);
    },
    waitFree(name, ms) {
      if (!held.has(name)) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = later(() => resolve(false), ms);
        waiting.set(name, [...(waiting.get(name) ?? []), () => { clearTimeout(timer); resolve(true); }]);
      });
    },
  };
  return namesOfThisPage;
}

/**
 * Run locks on the browser's Web Locks: `hold` with `ifAvailable`, kept until `release()`; `free` from `query()`'s
 * held names; `waitFree` requests the name without `ifAvailable` under a timeout and lets it go at once. A page with
 * no Web Locks keeps the names in a set of its own, so the one-job rule holds inside that tab alone.
 */
export function webRunLocks(): RunLocks {
  const manager = (globalThis as unknown as { navigator?: { locks?: Partial<LockManagerLike> } }).navigator?.locks;
  if (!manager || typeof manager.request !== 'function' || typeof manager.query !== 'function') return pageNames();
  const locks = manager as LockManagerLike;
  return {
    hold(name) {
      return new Promise((resolve) => {
        let release: () => void = () => undefined;
        const kept = new Promise<void>((done) => { release = done; });
        let answered = false;
        locks
          .request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
            answered = true;
            if (lock === null || lock === undefined) {
              resolve(null);
              return undefined;
            }
            resolve({ release: () => release() });
            return kept;
          })
          .catch(() => {
            // The browser refused the request itself: the page's own names keep the rule in this tab.
            if (!answered) void pageNames().hold(name).then(resolve);
          });
      });
    },
    async free(name) {
      try {
        const state = await locks.query();
        return !(state.held ?? []).some((lock) => lock.name === name);
      } catch {
        return pageNames().free(name);
      }
    },
    async waitFree(name, ms) {
      try {
        await locks.request(name, { mode: 'exclusive', signal: timeoutSignal(ms) }, () => undefined);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** The page's `BroadcastChannel` of the name, or null where the page has none or refuses one. */
function browserChannel(name: string): RunChannel | null {
  interface ChannelLike {
    postMessage(message: unknown): void;
    addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
    close(): void;
    unref?: () => void;
  }
  const Channel = (globalThis as unknown as { BroadcastChannel?: new (name: string) => ChannelLike }).BroadcastChannel;
  if (typeof Channel !== 'function') return null;
  let channel: ChannelLike;
  try {
    channel = new Channel(name);
  } catch {
    return null;
  }
  channel.unref?.();
  return {
    post(message) {
      try {
        channel.postMessage(message);
      } catch {
        // A closed channel: the records and the locks still carry the run.
      }
    },
    listen(hear) {
      channel.addEventListener('message', (event) => {
        if (isRunMessage(event.data)) hear(event.data);
      });
    },
    close() {
      channel.close();
    },
  };
}

/** The page's own events and document, read structurally. */
interface PageScope {
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
  navigator?: { onLine?: unknown };
  document?: {
    visibilityState?: string;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
}

/** The page's globals, read structurally. */
function page(): PageScope {
  return globalThis as unknown as PageScope;
}

/** `navigator.onLine` and the page's `online` and `offline` events, or null where the page has neither. */
function browserOnline(): NonNullable<RunOwnerOptions['online']> | null {
  const scope = page();
  if (typeof scope.navigator?.onLine !== 'boolean' || typeof scope.addEventListener !== 'function' || typeof scope.removeEventListener !== 'function') return null;
  return {
    now: () => page().navigator?.onLine !== false,
    subscribe(listener) {
      scope.addEventListener?.('online', listener);
      scope.addEventListener?.('offline', listener);
      return () => {
        scope.removeEventListener?.('online', listener);
        scope.removeEventListener?.('offline', listener);
      };
    },
  };
}

/** A run this owner holds. */
interface Held {
  record: RunRecord;
  job: RunJob;
  controller: AbortController;
  /** Lets the run's lock go; null once it went (the end shown, the export saved, the run dropped). */
  release: (() => void) | null;
  /** The store refused the record: the run goes on in memory, fenced by the flags below alone. */
  memoryOnly: boolean;
  /** The run's first record was written, so a listing that lacks it read the record after another owner removed it. */
  written: boolean;
  ended: Ended | null;
  /** The account's stop reached the run, here or from another tab. */
  stopCut: AccountStop | null;
  /** `dismiss` dropped the run while it ran. */
  dropped: boolean;
  /** `context.cut`'s mark. */
  cutSelf: RunCut;
  lastWrite: number;
  dirty: boolean;
  paceTimer: Timer | null;
  lastPost: number;
  postTimer: Timer | null;
  done: Promise<void> | null;
}

/** A run this owner does not hold: watched in another tab, cut, or failed with its lock free. */
interface Seen {
  read: RunRead;
  /** When its last message came, by the owner's clock. */
  heard: number;
  ended: Ended | null;
  /** Kept in the page's memory after its record went (a failed row whose end was shown), until it is dismissed. */
  local: boolean;
}

type Progress = Extract<RunMessage, { id: string }>;

class BrowserRunOwner implements RunOwner {
  private readonly store: KeyValueStore;
  private readonly keyPrefix: string;
  private readonly account: string;
  private readonly locks: RunOwnerOptions['locks'];
  private readonly lockName: (key: string) => string;
  private readonly runLocks: RunLocks;
  private readonly lockPrefix: string;
  private readonly isChosen: (value: unknown) => boolean;
  private readonly now: () => number;
  private readonly writeEvery: number;
  private readonly beatEvery: number;
  private readonly online: NonNullable<RunOwnerOptions['online']> | null;
  private readonly channel: RunChannel | null;
  private readonly held = new Map<string, Held>();
  private readonly seen = new Map<string, Seen>();
  /** A message for a run whose record is being read, applied once it is. */
  private readonly early = new Map<string, Progress>();
  private readonly hidden = new Set<string>();
  private readonly ends = new Map<string, RunEnd>();
  private readonly running = new Set<Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly endListeners = new Set<(read: RunRead, ended: Ended) => void>();
  private readonly endedCounts = { finished: 0, failed: 0 };
  private unreadable = 0;
  private unavailable = false;
  private cached: RunsSnapshot | null = null;
  private noticeTimer: Timer | null = null;
  private noticePending = false;
  private beatTimer: Interval | null = null;
  private watchTimer: Interval | null = null;
  private watching = false;
  private closed = false;
  /** Every account stop this owner made or heard, in order, so a start that was waiting for its lock meanwhile fences itself. */
  private readonly stopCuts: AccountStop[] = [];
  /** This owner's account stops running now: a start that gets its lock while one runs fences itself too. */
  private readonly runningStops: AccountStop[] = [];
  /**
   * Another tab's account stops this owner heard, each counted as running until ten seconds after its message, the
   * longest that stop runs: its second listing may already have read the records, so a start made here meanwhile is
   * fenced from its start, as one made while this owner's own stop runs is.
   */
  private heardStops: Array<{ cut: AccountStop; until: number }> = [];
  /** The starts in flight, each settling once its record is written and fenced where a stop reached it. */
  private readonly starting = new Set<Promise<boolean>>();
  /** How many of this owner's fences of a start's record, or of its own records on a heard stop, the store refused. */
  private fenceFailures = 0;
  /** The writes in flight that hold no record lock (a run kept in memory alone, a record lock that failed). */
  private readonly loneWrites = new Set<Promise<void>>();
  private readonly onPageHide = (): void => this.flush();
  private readonly onVisibility = (): void => {
    if (page().document?.visibilityState === 'hidden') this.flush();
  };

  /** Opens the channel and the page's listeners; with no channel, the records are read once a second from now on. */
  constructor(options: RunOwnerOptions) {
    this.store = options.store;
    this.keyPrefix = options.keyPrefix;
    this.account = options.account;
    this.locks = options.locks;
    this.lockName = options.lockName;
    this.runLocks = options.runLocks;
    this.lockPrefix = options.lockPrefix ?? 'run-';
    this.isChosen = options.isChosen;
    this.now = options.now ?? (() => Date.now());
    this.writeEvery = options.writeEvery ?? 1_000;
    this.beatEvery = options.beatEvery ?? 2_000;
    this.online = options.online ?? browserOnline();
    this.channel = options.makeChannel ? options.makeChannel(options.channel) : browserChannel(options.channel);
    this.channel?.listen((message) => this.hear(message));
    const scope = page();
    scope.addEventListener?.('pagehide', this.onPageHide);
    scope.document?.addEventListener?.('visibilitychange', this.onVisibility);
    this.ensureTimers();
  }

  /** Takes the job's lock, writes its record and runs it; refused at once while the job's lock is held anywhere. */
  start(job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }> {
    return this.begin(job, {});
  }

  /** Marks the run stopping, writes and tells it at once, and aborts its signal: the job ends after the item in hand. */
  stop(id: string): void {
    const held = this.held.get(id);
    if (!held || held.ended !== null || held.controller.signal.aborted) return;
    held.record.state = 'stopping';
    held.record.progressed = this.now();
    void this.persist(held);
    this.post(held);
    this.touch();
    held.controller.abort();
  }

  /** The next attempt of a stopped or failed run, its lock handed over when the job is the same; the earlier attempt's record goes. */
  async continueRun(id: string, job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }> {
    const old = this.held.get(id);
    // An account stop that begins and ends while the attempt before this one returns fences this one too.
    const since = this.stopCuts.length;
    if (old && old.ended === null) await old.done;
    // The run's own lock passes to the next attempt of the same job, so the two take one lock.
    const lock = old && old.release !== null && old.job.key === job.key ? old.release : undefined;
    if (old && lock) old.release = null;
    const started = await this.begin(job, { carry: old?.record, lock, since });
    if ('id' in started && old && this.held.get(old.record.id) === old) {
      this.drop(old);
      await this.deleteRecord(old.record.id);
      this.touch();
    }
    return started;
  }

  /** A cut run's rest under its own id, from the record as read (a run this owner holds goes to `continueRun`). */
  async finish(id: string, job: RunJob): Promise<{ id: string } | { refused: 'another-tab' }> {
    if (this.held.has(id)) return this.continueRun(id, job);
    // An account stop that begins and ends while the record is read fences this finish too.
    const since = this.stopCuts.length;
    const resume = this.seen.get(id)?.read.record ?? (await this.readOne(id));
    // A finish goes on from the cut record alone: one another tab removed, or one the store cannot read, starts nothing.
    if (!resume) return { refused: 'another-tab' };
    return this.begin(job, { resume, since });
  }

  /** Deletes the record and drops the run; another tab's record only while its lock can be held here. */
  async dismiss(id: string): Promise<{ ok: true } | { refused: 'another-tab' }> {
    const held = this.held.get(id);
    if (held) {
      if (held.ended === null) {
        // Its end lets its lock go once the job has returned.
        held.dropped = true;
        held.controller.abort();
      } else {
        held.release?.();
        held.release = null;
      }
      this.held.delete(id);
      this.clearTimers(held);
      await this.deleteRecord(id);
    } else {
      const seen = this.seen.get(id);
      const record = seen?.read.record ?? (await this.readOne(id));
      if (record) {
        // Held while the record is deleted, so no tab can finish the run between the check and the deletion.
        const release = await this.hold(record.key);
        if (!release) return { refused: 'another-tab' };
        let moved: unknown = null;
        try {
          moved = await this.deleteUnderKey(id, record.key);
        } finally {
          release();
        }
        if (moved !== null) {
          // Another tab finished the run under another key since this owner read it: its record stays, drawn as stored.
          await this.redraw(moved);
          return { refused: 'another-tab' };
        }
      }
      this.seen.delete(id);
    }
    this.hidden.delete(id);
    this.ensureTimers();
    this.touch();
    return { ok: true };
  }

  /** Stops drawing a run in this page alone. */
  hide(id: string): void {
    this.hidden.add(id);
    this.touch();
  }

  /** The end was drawn: the record goes and the lock is let go, unless the run is an unsaved export. */
  async shown(id: string): Promise<void> {
    const held = this.held.get(id);
    if (held) {
      if (held.ended === null || held.ended === 'unsaved' || held.release === null) return;
      // Marked let go before the deletion, so no read takes the record's absence for another owner's removal; the lock
      // itself goes once the record has.
      const release = held.release;
      held.release = null;
      await this.deleteRecord(id);
      release();
    } else {
      const seen = this.seen.get(id);
      if (!seen || seen.read.status !== 'failed' || seen.local) return;
      // Held while the record is deleted, as a dismissal holds it, so no tab finishes the run between the check and the
      // deletion.
      const release = await this.hold(seen.read.record.key);
      if (!release) return;
      let moved: unknown = null;
      try {
        moved = await this.deleteUnderKey(id, seen.read.record.key);
      } finally {
        release();
      }
      // Another tab finished the run under another key since this owner read it: its record stays, drawn as stored.
      if (moved !== null) await this.redraw(moved);
      else seen.local = true;
    }
    this.ensureTimers();
    this.touch();
  }

  /** An unsaved export was saved: its record goes and its lock is let go. */
  async saved(id: string): Promise<void> {
    const held = this.held.get(id);
    if (!held || held.ended !== 'unsaved' || held.release === null) return;
    const release = held.release;
    held.release = null;
    await this.deleteRecord(id);
    release();
    this.ensureTimers();
    this.touch();
  }

  /** Logs the stop for the starts still waiting for their locks, then stops everything of the account. */
  async stopAccount(cut: AccountStop): Promise<{ complete: boolean }> {
    this.stopCuts.push(cut);
    this.runningStops.push(cut);
    try {
      return await this.stopEverything(cut);
    } finally {
      this.runningStops.splice(this.runningStops.indexOf(cut), 1);
    }
  }

  /** The records fenced under their locks, this owner's runs stopped, the other tabs told, their locks awaited, and the records listed again. */
  private async stopEverything(cut: AccountStop): Promise<{ complete: boolean }> {
    // The listings, the waits for the records' and the runs' locks, the starts in flight and the last read share the stop's ten seconds.
    const deadline = Date.now() + STOP_WAIT;
    // A start's fence that the store refuses while the stop runs leaves a record, whenever that start settles.
    const failuresBefore = this.fenceFailures;
    const names = new Set<string>();
    const first = await this.fenceListed(cut, deadline, names, new Set());
    for (const held of this.held.values()) if (held.release !== null) names.add(this.runName(held.job.key));
    // A BroadcastChannel never delivers to its sender, so this owner's own runs are stopped here, directly.
    this.stopHeld(cut);
    this.channel?.post({ account: this.account, stop: cut });
    await this.waitRuns(names, deadline);
    // A run another tab started after the first listing and before the message wrote a record that listing missed: a
    // second listing fences it, and its run's lock is awaited in what is left of the ten seconds.
    const found = new Set<string>();
    const second = await this.fenceListed(cut, deadline, found, new Set(first.keys));
    await this.waitRuns(found, deadline);
    // A start of this owner still taking its lock or writing its record when the stop began fences that record itself
    // once it is written; the stop waits for it in what is left of the ten seconds.
    const starts = [...this.starting];
    const started = starts.length === 0 ? [] : await within(Promise.all(starts), deadline - Date.now());
    // A write that holds no record lock is not held back by the fences above; the stop waits for those in flight.
    const lone = [...this.loneWrites];
    const loneReturned = lone.length === 0 ? [] : await within(Promise.all(lone), deadline - Date.now());
    // The rows are read again for the marks, inside the ten seconds as well; a read past them goes on alone. This read
    // redraws the rows and deletes or marks nothing, so it leaves the answer as it is.
    if (cut !== 'removal') await within(this.records(), deadline - Date.now());
    this.touch();
    const settled = started !== null && !started.includes(false) && this.fenceFailures === failuresBefore && loneReturned !== null;
    return { complete: first.complete && second.complete && settled };
  }

  /**
   * Lists the records and deletes or marks each one of the account that `skip` does not name, under its lock, within
   * the deadline; the names of their runs' locks go into `names`. Answers whether the store listed the records and
   * every fence landed in time, with the keys it listed.
   */
  private async fenceListed(cut: AccountStop, deadline: number, names: Set<string>, skip: ReadonlySet<string>): Promise<{ complete: boolean; keys: string[] }> {
    let listing: Promise<string[]>;
    try {
      listing = this.store.keys(this.keyPrefix);
    } catch {
      return { complete: false, keys: [] };
    }
    const keys = await within(listing, deadline - Date.now());
    // The store refused the list or had not answered by the deadline: the stops still end every run in memory.
    if (keys === null) return { complete: false, keys: [] };
    // A write in flight holds its record's lock until it returns, so its record's fence waits for it; one still waiting
    // at the deadline stays asked for and lands once the write returns, while the stop goes on.
    const fences = keys
      .filter((key) => !skip.has(key))
      .map((key) =>
        this.locks
          .request(this.lockName(key), async () => {
            const current = await this.store.get<unknown>(key);
            // Another account's record under the same prefix is that account's to stop.
            if (isPlain(current) && typeof current.account === 'string' && current.account !== this.account) return;
            if (isPlain(current) && typeof current.key === 'string') names.add(this.runName(current.key));
            if (cut === 'removal') await this.store.delete(key);
            else if (isPlain(current) && LIVE.includes(current.state as RunState) && current.cut === null) await this.store.set(key, { ...current, cut });
          })
          .then(
            () => true,
            // This record could not be reached: the stops still end its run.
            () => false,
          ),
      );
    if (fences.length === 0) return { complete: true, keys };
    const fenced = await within(Promise.all(fences), deadline - Date.now());
    return { complete: fenced !== null && !fenced.includes(false), keys };
  }

  /** Waits for each named run's lock to go, until the deadline. */
  private async waitRuns(names: Iterable<string>, deadline: number): Promise<void> {
    for (const name of names) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      try {
        await this.runLocks.waitFree(name, left);
      } catch {
        // Past the wait the gate still refuses every later write.
      }
    }
  }

  /**
   * Reads every record of the account under the prefix that the store lets it read, with the runs this owner holds.
   * With no channel, a run this owner holds whose record another owner's account stop deleted or marked is stopped
   * here, as a heard stop stops it.
   */
  async records(): Promise<RunRead[]> {
    const before = this.seenSignature();
    const reads: RunRead[] = [];
    const present = new Set<string>();
    const stops: Array<[Held, AccountStop]> = [];
    // The runs whose records were written before the listing, so a listing that lacks one read it after its removal.
    const written = [...this.held.values()].filter((held) => held.written && held.release !== null);
    let unreadable = 0;
    let keys: string[] | null = null;
    try {
      keys = await this.store.keys(this.keyPrefix);
    } catch {
      this.unavailable = true;
    }
    for (const key of keys ?? []) {
      let value: unknown;
      try {
        value = await this.store.get<unknown>(key);
      } catch {
        this.unavailable = true;
        continue;
      }
      if (!isRunRecord(value, this.isChosen)) {
        unreadable += 1;
        continue;
      }
      if (value.account !== this.account) continue;
      present.add(value.id);
      const mine = this.held.get(value.id);
      if (mine) {
        // A mark this owner did not make is another owner's sign-out or session's end.
        if (this.channel === null && (value.cut === 'signout' || value.cut === 'session') && mine.cutSelf === null) stops.push([mine, value.cut]);
        continue;
      }
      const read = await this.classify(value);
      if (!this.held.has(value.id)) reads.push(this.see(read).read);
    }
    if (keys !== null && this.channel === null) {
      const listed = new Set(keys);
      for (const held of written) if (held.release !== null && !listed.has(this.keyPrefix + held.record.id)) stops.push([held, 'removal']);
    }
    for (const [held, cut] of stops) this.stopFromRecord(held, cut);
    for (const held of this.held.values()) reads.push(this.heldRead(held));
    if (keys !== null) {
      this.unreadable = unreadable;
      for (const [id, seen] of this.seen) {
        if (present.has(id) || seen.local) continue;
        this.seen.delete(id);
        this.hidden.delete(id);
      }
    }
    this.ensureTimers();
    // A read that changed nothing notifies no one, so the once-a-second read with no channel draws nothing new.
    if (stops.length > 0 || this.seenSignature() !== before) this.touch();
    return reads.map((read) => ({ ...read, record: copyRecord(read.record) }));
  }

  /** What the runs this owner does not hold look like, to tell a read that changed something from one that did not. */
  private seenSignature(): string {
    const parts = [String(this.unreadable), String(this.unavailable)];
    for (const [id, seen] of this.seen) {
      const { record, status, cut } = seen.read;
      const counts = record.counts;
      // Each item's state and name, so a change to an item alone is drawn too.
      parts.push([id, status, cut, record.state, record.phase, counts.total, counts.pending, counts.applied, counts.skipped, counts.failed, JSON.stringify(record.items), seen.ended, seen.local, this.hidden.has(id)].join(':'));
    }
    return parts.join('|');
  }

  /** The runs as drawn, newest first; the same object until something changes. */
  snapshot(): RunsSnapshot {
    if (this.cached) return this.cached;
    const runs: RunsSnapshot['runs'] = [];
    for (const held of this.held.values()) runs.push({ ...this.heldRead(held), hidden: this.hidden.has(held.record.id), ended: held.ended });
    for (const seen of this.seen.values()) {
      runs.push({ record: copyRecord(seen.read.record), status: seen.read.status, cut: seen.read.cut, hidden: this.hidden.has(seen.read.record.id), ended: seen.ended });
    }
    runs.sort((a, b) => b.record.began - a.record.began);
    this.cached = { runs, unreadable: this.unreadable, unavailable: this.unavailable, ended: { ...this.endedCounts } };
    return this.cached;
  }

  /** Called when the snapshot changes, at most four times a second. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Called once at each end of a run this owner holds or watches, and at no count; never for a fenced run. */
  subscribeEnds(listener: (read: RunRead, ended: Ended) => void): () => void {
    this.endListeners.add(listener);
    return () => {
      this.endListeners.delete(listener);
    };
  }

  /** Each run's end, once every run this owner started has returned. */
  async whenIdle(): Promise<Map<string, RunEnd>> {
    for (let pending = [...this.running]; pending.length > 0; pending = [...this.running]) await Promise.all(pending);
    return new Map<string, RunEnd>([...this.ends].map(([id, end]): [string, RunEnd] => [id, { ended: end.ended, counts: { ...end.counts } }]));
  }

  /** Sends every live run's message now. */
  beat(): void {
    for (const held of this.held.values()) if (this.beats(held)) this.post(held);
  }

  /** Stops the timers, the listeners and the channel; a held run goes on to its end. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const held of this.held.values()) this.clearTimers(held);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.ensureTimers();
    const scope = page();
    scope.removeEventListener?.('pagehide', this.onPageHide);
    scope.document?.removeEventListener?.('visibilitychange', this.onVisibility);
    this.channel?.close();
    this.listeners.clear();
    this.endListeners.clear();
  }

  /** Takes the job's lock (or the one handed over), writes the record before the job's first write, and runs the job. */
  private async begin(
    job: RunJob,
    from: { resume?: RunRecord; carry?: RunRecord; lock?: () => void; since?: number },
  ): Promise<{ id: string } | { refused: 'another-tab' }> {
    const now = this.now();
    const fresh = { total: job.total, pending: job.total ?? 0, applied: 0, skipped: 0, failed: 0 };
    const record: RunRecord = from.resume
      ? { ...copyRecord(from.resume), key: job.key, kind: job.kind, way: job.way, unit: job.unit, chosen: job.chosen, state: 'running', cut: null, progressed: now }
      : {
          id: newId(), key: job.key, account: this.account, kind: job.kind, way: job.way, unit: job.unit, chosen: job.chosen,
          counts: from.carry ? { ...from.carry.counts } : fresh, items: from.carry ? from.carry.items.map((item) => ({ ...item })) : [],
          state: 'running', cut: null, phase: null, began: now, progressed: now,
        };
    if (!isRunRecord(record, this.isChosen) || record.account !== this.account) {
      from.lock?.();
      throw new TypeError('openRunOwner: the run record fails its check (a key of 64 lowercase hexadecimal characters, a chosen the given check allows, the known kinds of every field); nothing was started');
    }
    // A stop answers for the starts still in flight when it ends: each settles once its record is written and, when the
    // account's stop reached it meanwhile, deleted or marked, and settles false when that fence failed.
    let fenced = true;
    let settle: (ok: boolean) => void = () => undefined;
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    this.starting.add(settled);
    try {
      // The account stops logged since the caller began: one that ended before this start's lock was asked for counts.
      const stopsBefore = from.since ?? this.stopCuts.length;
      // A stop running now, here or heard from another tab, fences this start even when it ends before the start's lock
      // is granted.
      const stopsRunning = this.stopsRunningNow();
      let release = from.lock;
      if (!release) {
        // A finish holds the cut run's own lock too, so one tab alone finishes it whatever key its new pick makes.
        const names = from.resume && from.resume.key !== job.key ? [from.resume.key, job.key] : [job.key];
        const releases: Array<() => void> = [];
        for (const name of names) {
          const one = await this.hold(name);
          if (!one) {
            for (const letGo of releases) letGo();
            return { refused: 'another-tab' };
          }
          releases.push(one);
        }
        release = () => {
          for (const letGo of releases) letGo();
        };
      }
      const id = record.id;
      const held: Held = {
        record, job, controller: new AbortController(), release, memoryOnly: false, written: false, ended: null, stopCut: null, dropped: false, cutSelf: null,
        lastWrite: now, dirty: false, paceTimer: null, lastPost: 0, postTimer: null, done: null,
      };
      this.held.set(id, held);
      this.seen.delete(id);
      this.hidden.delete(id);
      this.ends.delete(id);
      // The account stopped while this start waited for its lock (here or in another tab), or is stopping now: the run is
      // fenced from its start, a removal among those stops winning over a sign-out or a session's end.
      const cuts = [...stopsRunning, ...this.stopCuts.slice(stopsBefore), ...this.runningStops];
      if (cuts.length > 0) {
        held.stopCut = cuts.includes('removal') ? 'removal' : cuts[cuts.length - 1];
        held.controller.abort();
      }
      const key = this.keyPrefix + id;
      let gone = false as boolean;
      // The record as stored when another tab's finish gave it a key other than the one whose run lock this finish took.
      let moved: unknown = null;
      try {
        await this.locks.request(this.lockName(key), async () => {
          if (from.resume) {
            // A finish never brings back a record another tab removed or dismissed meanwhile.
            const current = await this.store.get<unknown>(key);
            if (!isPlain(current) || current.id !== id) {
              gone = true;
              return;
            }
            // The run lock held here guards the key of the copy read earlier: once another tab's finish has changed the
            // record's key, that tab's attempt, or a later one, may run under locks this finish does not hold.
            if (current.key !== from.resume.key) {
              gone = true;
              moved = current;
              return;
            }
            // The stored progress wins over the copy read earlier, which another tab's finish and cut may have moved on.
            if (isRunRecord(current, this.isChosen) && current.account === this.account) {
              record.counts = { ...current.counts };
              record.items = current.items.map((item) => ({ ...item }));
              record.phase = current.phase;
              record.began = current.began;
            }
          }
          await this.store.set(key, copyRecord(record));
          held.written = true;
        });
        held.lastWrite = this.now();
      } catch {
        this.toMemory(held);
      }
      if (gone) {
        this.drop(held);
        // A record another tab moved on is drawn again as stored, so a second finish goes on from it.
        if (moved !== null) await this.redraw(moved);
        else this.touch();
        return { refused: 'another-tab' };
      }
      // The account's stop came while the record was written: the record it could not see is fenced now.
      if (held.stopCut !== null && !held.memoryOnly) {
        await this.fenceRecord(key, held.stopCut).catch(() => {
          fenced = false;
          this.fenceFailures += 1;
        });
      }
      if (held.stopCut === null) this.post(held);
      held.done = this.runJob(held);
      this.ensureTimers();
      this.touch();
      return { id };
    } finally {
      this.starting.delete(settled);
      settle(fenced);
    }
  }

  /** The account's stops running now: this owner's own, and those heard from another tab within their ten seconds. */
  private stopsRunningNow(): AccountStop[] {
    const now = Date.now();
    this.heardStops = this.heardStops.filter((stop) => stop.until > now);
    return [...this.runningStops, ...this.heardStops.map((stop) => stop.cut)];
  }

  /** Holds the run lock of a job's key, or answers null at once when it is held. */
  private async hold(key: string): Promise<(() => void) | null> {
    const grant = await this.runLocks.hold(this.runName(key));
    return grant ? () => grant.release() : null;
  }

  /** The run lock's name for a job's key in this account. */
  private runName(key: string): string {
    return runLockName(this.lockPrefix, this.account, key);
  }

  /** Whether no tab holds the run lock of a job's key; a lock that cannot be read counts as free. */
  private async lockFree(key: string): Promise<boolean> {
    try {
      return await this.runLocks.free(this.runName(key));
    } catch {
      return true;
    }
  }

  /** Runs the job, called before this returns so its first write is asked for at once. */
  private runJob(held: Held): Promise<void> {
    const context = this.contextFor(held);
    let result: Promise<RunEnd>;
    try {
      result = Promise.resolve(held.job.run(context));
    } catch (error) {
      result = Promise.reject(error);
    }
    const failed = (): RunEnd => ({ ended: 'failed', counts: { ...held.record.counts } });
    const done: Promise<void> = result
      .then((end) => (isPlain(end) && ENDS.includes(end.ended as Ended) ? end : failed()), failed)
      .then((end) => this.ended(held, end))
      .catch(() => undefined)
      .finally(() => {
        this.running.delete(done);
      });
    this.running.add(done);
    return done;
  }

  /** What the job is handed. */
  private contextFor(held: Held): RunContext {
    return {
      id: held.record.id,
      signal: held.controller.signal,
      counts: (next) => {
        if (held.ended !== null) return;
        const counts = held.record.counts;
        if (next.total === null || isCount(next.total)) counts.total = next.total;
        if (isCount(next.pending)) counts.pending = next.pending;
        if (isCount(next.applied)) counts.applied = next.applied;
        if (isCount(next.skipped)) counts.skipped = next.skipped;
        if (isCount(next.failed)) counts.failed = next.failed;
        this.changed(held);
      },
      item: (index, state, name) => {
        if (held.ended !== null || !isCount(index) || !Number.isInteger(index) || !ITEM_STATES.includes(state)) return;
        const entry: RunItem = state === 'failed' && typeof name === 'string' ? { index, state, name } : { index, state };
        const items = held.record.items;
        const last = items[items.length - 1];
        const at = last === undefined || last.index < index ? -1 : items.findIndex((item) => item.index === index);
        if (at === -1) items.push(entry);
        else items[at] = entry;
        if (at === -1 && last !== undefined && last.index > index) items.sort((a, b) => a.index - b.index);
        this.changed(held);
      },
      phase: (next) => {
        if (held.ended !== null || !PHASES.includes(next)) return;
        held.record.phase = next;
        this.changed(held);
      },
      waitOnline: () => this.waitOnline(held),
      write: <T>(work: () => Promise<T>) => this.gate<T>(held, work),
      cut: (reason) => this.cutRun(held, reason),
      record: () => copyRecord(held.record),
    };
  }

  /** A change in memory: the record follows at most once every `writeEvery`, the message at most four times a second. */
  private changed(held: Held): void {
    // A fenced run's record stays as the stop left it, and its counts go to no other tab.
    if (this.isFenced(held)) return;
    held.record.progressed = this.now();
    held.dirty = true;
    if (!held.memoryOnly) {
      const since = this.now() - held.lastWrite;
      if (since >= this.writeEvery) void this.persist(held);
      else if (held.paceTimer === null) {
        held.paceTimer = later(() => {
          held.paceTimer = null;
          if (held.dirty && held.ended === null) void this.persist(held);
        }, this.writeEvery - since);
      }
    }
    this.schedulePost(held);
    this.touch();
  }

  /** Writes the run's counts, items, state and phase into its record, which must exist and carry no cut mark. */
  private persist(held: Held): Promise<void> {
    if (held.memoryOnly) return Promise.resolve();
    held.dirty = false;
    held.lastWrite = this.now();
    if (held.paceTimer !== null) clearTimeout(held.paceTimer);
    held.paceTimer = null;
    const key = this.keyPrefix + held.record.id;
    return this.locks
      .request(this.lockName(key), async () => {
        const current = await this.store.get<unknown>(key);
        if (!isPlain(current) || current.id !== held.record.id || current.cut !== null) return;
        const record = held.record;
        await this.store.set(key, { ...current, counts: { ...record.counts }, items: record.items.map((item) => ({ ...item })), state: record.state, phase: record.phase, progressed: record.progressed });
      })
      .catch(() => {
        this.markUnavailable();
      });
  }

  /** The page is hidden away or leaving: every held run's record now. */
  private flush(): void {
    for (const held of this.held.values()) {
      if (held.release !== null && (held.dirty || held.ended === null)) void this.persist(held);
    }
  }

  /** The store refused the run's first record: the run goes on in memory, fenced by the account's stop, a dismissal and its own cut. */
  private toMemory(held: Held): void {
    held.memoryOnly = true;
    if (held.paceTimer !== null) clearTimeout(held.paceTimer);
    held.paceTimer = null;
    this.markUnavailable();
  }

  /** Notes that the store refused something, once. */
  private markUnavailable(): void {
    if (this.unavailable) return;
    this.unavailable = true;
    this.touch();
  }

  /** Whether the account's stop, a dismissal or the run's own cut fences its writes. */
  private isFenced(held: Held): boolean {
    return held.stopCut !== null || held.dropped || held.cutSelf !== null;
  }

  /**
   * The write gate. When the store cannot answer the record's read, this one write is fenced by the run's state in
   * memory (the account's stop, a dismissal, its own cut) and the next write reads the record again.
   */
  private async gate<T>(held: Held, work: () => Promise<T>): Promise<T | { fenced: true }> {
    if (held.memoryOnly) return this.isFenced(held) ? { fenced: true as const } : this.lone(work);
    const key = this.keyPrefix + held.record.id;
    let outcome = 'refused' as 'refused' | 'ran' | 'threw' | 'lockless';
    let value: T | undefined;
    let thrown: unknown;
    const run = async (): Promise<void> => {
      try {
        value = await work();
        outcome = 'ran';
      } catch (error) {
        thrown = error;
        outcome = 'threw';
      }
    };
    try {
      await this.locks.request(this.lockName(key), async () => {
        if (this.isFenced(held)) return;
        let current: unknown;
        try {
          current = await this.store.get<unknown>(key);
        } catch {
          this.markUnavailable();
          await run();
          return;
        }
        if (!isPlain(current) || current.id !== held.record.id || current.cut !== null) return;
        await run();
      });
    } catch {
      // The record lock itself failed before the work ran.
      if (outcome === 'refused') outcome = 'lockless';
    }
    if (outcome === 'threw') throw thrown;
    if (outcome === 'ran') return value as T;
    if (outcome === 'lockless' && !this.isFenced(held)) {
      this.markUnavailable();
      return this.lone(work);
    }
    return { fenced: true as const };
  }

  /** Runs a write that holds no record lock, kept in `loneWrites` until it returns, so the account's stop can wait for it. */
  private lone<T>(work: () => Promise<T>): Promise<T> {
    let running: Promise<T>;
    try {
      running = work();
    } catch (error) {
      running = Promise.reject(error);
    }
    const returned = running.then(
      () => undefined,
      () => undefined,
    );
    this.loneWrites.add(returned);
    void returned.then(() => this.loneWrites.delete(returned));
    return running;
  }

  /** Pauses a run while the page is offline, written and told at once, until it is back online or the run is aborted. */
  private async waitOnline(held: Held): Promise<void> {
    const online = this.online;
    const signal = held.controller.signal;
    if (online === null || online.now() || signal.aborted || held.ended !== null) return;
    if (held.record.state === 'running') held.record.state = 'paused';
    held.record.progressed = this.now();
    void this.persist(held);
    this.post(held);
    this.touch();
    await new Promise<void>((resolve) => {
      let off: (() => void) | null = null;
      let settled = false as boolean;
      const done = (): void => {
        if (settled) return;
        settled = true;
        off?.();
        signal.removeEventListener('abort', done);
        resolve();
      };
      off = online.subscribe(() => {
        if (online.now()) done();
      });
      if (settled) off();
      signal.addEventListener('abort', done);
      if (online.now()) done();
    });
    if (held.record.state === 'paused' && held.ended === null) {
      held.record.state = 'running';
      this.changed(held);
    }
  }

  /** Marks the run's record cut by the session's end with its counts, then aborts the run. */
  private async cutRun(held: Held, reason: 'session'): Promise<void> {
    if (held.ended !== null || held.cutSelf !== null) return;
    held.cutSelf = reason;
    if (!held.memoryOnly) {
      const key = this.keyPrefix + held.record.id;
      await this.locks
        .request(this.lockName(key), async () => {
          const current = await this.store.get<unknown>(key);
          if (!isPlain(current) || current.id !== held.record.id || current.cut !== null) return;
          const record = held.record;
          await this.store.set(key, { ...current, counts: { ...record.counts }, items: record.items.map((item) => ({ ...item })), state: record.state, phase: record.phase, progressed: record.progressed, cut: reason });
        })
        .catch(() => {
          this.markUnavailable();
        });
    }
    held.record.cut = reason;
    held.controller.abort();
    this.touch();
  }

  /** Under the record's lock: a removal deletes it, a sign-out or a session's end marks a live one. */
  private fenceRecord(key: string, cut: AccountStop): Promise<void> {
    return this.locks.request(this.lockName(key), async () => {
      if (cut === 'removal') {
        await this.store.delete(key);
        return;
      }
      const current = await this.store.get<unknown>(key);
      if (isPlain(current) && LIVE.includes(current.state as RunState) && current.cut === null) await this.store.set(key, { ...current, cut });
    });
  }

  /** Deletes a record under its lock. */
  private deleteRecord(id: string): Promise<void> {
    const key = this.keyPrefix + id;
    return this.locks.request(this.lockName(key), () => this.store.delete(key)).catch(() => undefined);
  }

  /**
   * Deletes another tab's record under its lock while its key is still `runKey`, the key whose run lock this owner
   * holds; answers the record as stored when another tab's finish has moved it to another key, and null otherwise.
   */
  private async deleteUnderKey(id: string, runKey: string): Promise<unknown> {
    const key = this.keyPrefix + id;
    let moved: unknown = null;
    await this.locks
      .request(this.lockName(key), async () => {
        const current = await this.store.get<unknown>(key);
        if (isPlain(current) && current.id === id && current.key !== runKey) {
          moved = current;
          return;
        }
        await this.store.delete(key);
      })
      .catch(() => undefined);
    return moved;
  }

  /** Draws a record another tab moved on as stored, watched while its lock is held, and watches it from now on. */
  private async redraw(stored: unknown): Promise<void> {
    if (isRunRecord(stored, this.isChosen) && stored.account === this.account) this.see(await this.classify(stored));
    this.ensureTimers();
    this.touch();
  }

  /** The job returned: its end, its record's last write, its message and its listeners. */
  private async ended(held: Held, end: RunEnd): Promise<void> {
    const counts = isCounts(end.counts) ? { ...end.counts } : { ...held.record.counts };
    held.record.counts = counts;
    held.record.phase = null;
    let ended: Ended = end.ended;
    if (held.stopCut !== null || held.dropped) ended = 'fenced';
    else if (held.cutSelf !== null) ended = 'cut';
    held.ended = ended;
    this.ends.set(held.record.id, { ended, counts: { ...counts } });
    if (ended === 'fenced') {
      // No row of its own; a removal's record is gone, a sign-out's stays marked, and the job deletes neither.
      this.drop(held);
      if (held.stopCut === 'signout' || held.stopCut === 'session') void this.records().catch(() => []);
      this.ensureTimers();
      this.touch();
      return;
    }
    if (ended === 'cut') {
      this.post(held);
      this.drop(held);
      const read: RunRead = { record: copyRecord(held.record), status: 'cut', cut: held.cutSelf };
      this.see(read);
      this.fire(read, 'cut');
      this.ensureTimers();
      this.touch();
      return;
    }
    if (ended === 'failed' || (ended === 'finished' && counts.failed > 0)) held.record.state = 'failed';
    else if (ended === 'unsaved') held.record.state = 'unsaved';
    else if (ended === 'stopped') held.record.state = 'stopping';
    held.record.progressed = this.now();
    await this.persist(held);
    // Dismissed, or reached by the account's stop, while that write was in flight: no end is posted or heard.
    if (this.held.get(held.record.id) !== held || this.isFenced(held)) {
      this.ensureTimers();
      this.touch();
      return;
    }
    this.post(held);
    this.fire(this.heldRead(held), ended);
    this.ensureTimers();
    this.touch();
  }

  /** Lets the run's lock go and forgets it. */
  private drop(held: Held): void {
    this.clearTimers(held);
    held.release?.();
    held.release = null;
    if (this.held.get(held.record.id) === held) this.held.delete(held.record.id);
  }

  /** Stops a run's paced write and its pending message. */
  private clearTimers(held: Held): void {
    if (held.paceTimer !== null) clearTimeout(held.paceTimer);
    if (held.postTimer !== null) clearTimeout(held.postTimer);
    held.paceTimer = null;
    held.postTimer = null;
  }

  /** The account's stop, here: every held run is aborted and fenced, and lets its lock go once its job has returned. */
  private stopHeld(cut: AccountStop): void {
    let returned = false;
    for (const held of [...this.held.values()]) {
      held.stopCut = cut;
      held.controller.abort();
      if (held.ended !== null) {
        this.drop(held);
        returned = true;
      }
    }
    if (cut === 'removal') {
      this.seen.clear();
      this.hidden.clear();
      this.early.clear();
    } else if (returned) {
      void this.records().catch(() => []);
    }
    this.ensureTimers();
    this.touch();
  }

  /** With no channel, another owner's account stop read in this run's record: the run is stopped as a heard stop stops it. */
  private stopFromRecord(held: Held, cut: AccountStop): void {
    if (this.held.get(held.record.id) !== held || held.stopCut !== null) return;
    held.stopCut = cut;
    held.controller.abort();
    if (held.ended !== null) this.drop(held);
  }

  /** A run this owner holds, as read. */
  private heldRead(held: Held): RunRead {
    return { record: copyRecord(held.record), status: 'held', cut: held.record.cut };
  }

  /** The account's record of an id, or null when there is none or it fails its check. */
  private async readOne(id: string): Promise<RunRecord | null> {
    try {
      const value = await this.store.get<unknown>(this.keyPrefix + id);
      return isRunRecord(value, this.isChosen) && value.account === this.account && value.id === id ? value : null;
    } catch {
      return null;
    }
  }

  /** A record this owner does not hold: watched while its lock is held, cut when live with its lock free, else failed. */
  private async classify(record: RunRecord): Promise<RunRead> {
    const copy = copyRecord(record);
    if (!(await this.lockFree(record.key))) return { record: copy, status: 'watched', cut: record.cut };
    if (LIVE.includes(record.state)) return { record: copy, status: 'cut', cut: record.cut ?? 'load' };
    return { record: copy, status: 'failed', cut: record.cut };
  }

  /** Keeps a run this owner does not hold, as read. */
  private see(read: RunRead): Seen {
    const id = read.record.id;
    const before = this.seen.get(id);
    // A hidden watched run is drawn again once it reads as cut or failed with its lock free.
    if (before?.read.status === 'watched' && read.status !== 'watched') this.hidden.delete(id);
    const seen: Seen = { read, heard: before?.heard ?? this.now(), ended: before?.ended ?? null, local: false };
    this.seen.set(id, seen);
    // With no channel, a watched run's end shows in its record alone.
    const turned = before !== undefined && before.read.record.state !== read.record.state;
    if (turned && read.status === 'watched' && seen.ended === null && (read.record.state === 'failed' || read.record.state === 'unsaved')) {
      seen.ended = read.record.state === 'failed' ? 'failed' : 'unsaved';
      this.fire(read, seen.ended);
    }
    return seen;
  }

  /** A message from another tab of the account. */
  private hear(message: RunMessage): void {
    if (this.closed || !isRunMessage(message) || message.account !== this.account) return;
    if ('stop' in message) {
      this.stopCuts.push(message.stop);
      // The stopping tab's stop goes on for up to ten seconds after its message, and its second listing may already
      // have read the records: a start made here meanwhile is fenced from its start.
      this.heardStops.push({ cut: message.stop, until: Date.now() + STOP_WAIT });
      // A run started here after the other tab listed the records has a record that listing missed: this owner deletes
      // or marks its own runs' records under their locks, as the stopping tab does.
      for (const held of this.held.values()) {
        if (!held.memoryOnly) {
          void this.fenceRecord(this.keyPrefix + held.record.id, message.stop).catch(() => {
            this.fenceFailures += 1;
          });
        }
      }
      this.stopHeld(message.stop);
      return;
    }
    if (this.held.has(message.id)) return;
    // A new attempt of a job replaces the one it continues.
    for (const [id, seen] of this.seen) {
      if (id !== message.id && seen.read.record.key === message.key && seen.read.status === 'watched') {
        this.seen.delete(id);
        this.hidden.delete(id);
      }
    }
    const seen = this.seen.get(message.id);
    if (!seen) {
      const first = !this.early.has(message.id);
      this.early.set(message.id, message);
      if (first) void this.learn(message.id);
      return;
    }
    this.apply(seen, message);
  }

  /** Reads the record of a run first heard on the channel, then applies the newest message heard meanwhile. */
  private async learn(id: string): Promise<void> {
    const record = await this.readOne(id);
    const message = this.early.get(id);
    this.early.delete(id);
    if (!record || this.held.has(id) || this.closed) return;
    const seen = this.see(await this.classify(record));
    if (message) this.apply(seen, message);
    this.ensureTimers();
    this.touch();
  }

  /** A watched run's counts and state from its holder's message. */
  private apply(seen: Seen, message: Progress): void {
    const record = seen.read.record;
    // A run drawn as ended that runs again under its id (another tab's finish of a cut run) is a new attempt: its end is
    // drawn and counted afresh.
    const again = message.ended === undefined && seen.ended !== null && LIVE.includes(message.state);
    if (again) seen.ended = null;
    const cut = again ? null : record.cut;
    seen.read = { record: { ...record, counts: { ...message.counts }, state: message.state, phase: message.phase, progressed: message.at, cut }, status: 'watched', cut };
    seen.heard = this.now();
    seen.local = false;
    if (message.ended !== undefined && seen.ended === null) {
      seen.ended = message.ended;
      this.fire(seen.read, message.ended);
    }
    this.ensureTimers();
    this.touch();
  }

  /** Each second while this page draws a run it does not hold: the records with no channel, else a silent run's lock. */
  private async watch(): Promise<void> {
    if (this.watching || this.closed) return;
    this.watching = true;
    try {
      if (this.channel === null) {
        await this.records();
        return;
      }
      for (const seen of [...this.seen.values()]) {
        if (seen.read.status !== 'watched' || this.now() - seen.heard < this.beatEvery) continue;
        const id = seen.read.record.id;
        if (!(await this.lockFree(seen.read.record.key))) continue;
        const record = await this.readOne(id);
        if (this.held.has(id) || this.seen.get(id) !== seen) continue;
        if (record === null) {
          this.seen.delete(id);
          this.hidden.delete(id);
        } else {
          this.see(await this.classify(record));
        }
        this.touch();
      }
    } catch {
      // The next second reads again.
    } finally {
      this.watching = false;
      this.ensureTimers();
    }
  }

  /** Whether a held run is live and sends a beat. */
  private beats(held: Held): boolean {
    return held.release !== null && (held.ended === null || held.ended === 'unsaved') && LIVE.includes(held.record.state);
  }

  /** Starts or stops the beat and the reads of other tabs' runs as the runs need them. */
  private ensureTimers(): void {
    const beating = !this.closed && [...this.held.values()].some((held) => this.beats(held));
    if (beating && this.beatTimer === null) this.beatTimer = every(() => this.beat(), this.beatEvery);
    if (!beating && this.beatTimer !== null) {
      clearInterval(this.beatTimer);
      this.beatTimer = null;
    }
    // With no channel, the records are read once a second at all times, so a run another tab starts is found.
    const watched = !this.closed && (this.channel === null || [...this.seen.values()].some((seen) => seen.read.status === 'watched'));
    if (watched && this.watchTimer === null) this.watchTimer = every(() => void this.watch(), WATCH_EVERY);
    if (!watched && this.watchTimer !== null) {
      clearInterval(this.watchTimer);
      this.watchTimer = null;
    }
  }

  /** Sends a held run's message now. */
  private post(held: Held): void {
    held.lastPost = Date.now();
    if (held.postTimer !== null) clearTimeout(held.postTimer);
    held.postTimer = null;
    if (this.channel === null || this.closed) return;
    const record = held.record;
    const message: RunMessage = {
      account: this.account, id: record.id, key: record.key, counts: { ...record.counts }, state: record.state, phase: record.phase, at: this.now(),
      ...(held.ended !== null && held.ended !== 'fenced' ? { ended: held.ended } : {}),
    };
    try {
      this.channel.post(message);
    } catch {
      // The beat and the records carry the run.
    }
  }

  /** Sends a held run's message now, or once the quarter second since the last one has passed. */
  private schedulePost(held: Held): void {
    if (this.channel === null || held.postTimer !== null) return;
    const since = Date.now() - held.lastPost;
    if (since >= NOTICE_EVERY) {
      this.post(held);
      return;
    }
    held.postTimer = later(() => {
      held.postTimer = null;
      if (this.held.get(held.record.id) === held) this.post(held);
    }, NOTICE_EVERY - since);
  }

  /** Counts an end and calls `subscribeEnds`' listeners. */
  private fire(read: RunRead, ended: Ended): void {
    if (ended === 'fenced') return;
    if (ended === 'unsaved' || (ended === 'finished' && read.record.counts.failed === 0)) this.endedCounts.finished += 1;
    else if (ended === 'failed' || ended === 'finished') this.endedCounts.failed += 1;
    const copy: RunRead = { ...read, record: copyRecord(read.record) };
    for (const listener of [...this.endListeners]) {
      try {
        listener(copy, ended);
      } catch {
        // A listener's error is its own.
      }
    }
  }

  /** Something changed: the snapshot is built again and the listeners hear of it. */
  private touch(): void {
    this.cached = null;
    this.notice();
  }

  /** Calls the listeners now, or once the quarter second since the last notice has passed. */
  private notice(): void {
    if (this.listeners.size === 0) return;
    if (this.noticeTimer !== null) {
      this.noticePending = true;
      return;
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A listener's error is its own.
      }
    }
    this.noticeTimer = later(() => {
      this.noticeTimer = null;
      if (!this.noticePending) return;
      this.noticePending = false;
      this.notice();
    }, NOTICE_EVERY);
  }
}

/**
 * Opens a page's run owner for one account. Open one a page per account and close it when the page lets the account
 * go; the runs, the records and the locks outlive no account: `stopAccount` ends them all.
 */
export function openRunOwner(options: RunOwnerOptions): RunOwner {
  return new BrowserRunOwner(options);
}
