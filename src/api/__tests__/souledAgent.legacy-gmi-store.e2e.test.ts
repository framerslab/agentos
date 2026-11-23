import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnerUserScopeId, taggedScopeId } from '../../cognition/learning/scopes';
import { SqlLearningStore } from '../../cognition/learning/store/SqlLearningStore';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { gmi } from '../gmi';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const RUNTIME = 'gmi' as const;
const AGENT_ID = 'orchard-guide';
const ALICE = 'alice/1';
const BOB = 'bob';
const learning = { agentKey: AGENT_ID, namespace: 'orchard/keepers' };
const CANARY = 'The orchard lantern battery is amberquartz.';
const OTHER = 'The orchard watering can is cobalt.';
const STORE_LABEL = 'legacy GMI store';
const userScope = (userId: string) => learnerUserScopeId({ namespace: learning.namespace, userId });

type Store = { path: string } | { adapter: StorageAdapter };
type TraceRow = { id: string; content: string; deleted: number; retrieval_count: number };

let sequence = 0;
let directory: string;
let legacyFile: string;
let agent: SouledAgent | undefined;
let adapter: StorageAdapter | undefined;
let embeddings: ProviderScript;
let served: ProviderScript;
let events: Array<Record<string, unknown>>;

function route() {
  const apiKey = `legacy-gmi-route-${++sequence}`;
  served = script('openai', apiKey, { whole: true, replies: [
    reply.text('Orchard lantern noted.'),
    reply.text('Watering can noted.'),
  ] });
  return { provider: 'openai' as const, model: 'stub-model', apiKey, fallbackProviders: [] };
}

type Learning = typeof learning & { store?: SqlLearningStore };

function options(store: Store, learningOption: Learning = learning) {
  return {
    ...route(),
    learning: learningOption,
    memory: { store, embedding: { provider: 'openai' as const } },
    cognition: { mechanisms: false as const },
  };
}

async function seed(store: Store = { path: legacyFile }, learningOption: Learning = learning): Promise<void> {
  const previous = gmi({ ...options(store, learningOption), name: 'Orchard Guide' });
  try {
    await previous.session('old-alice', { userId: ALICE }).send(CANARY);
    await previous.session('old-bob', { userId: BOB }).send(OTHER);
  } finally {
    await previous.close();
  }
}

async function open(
  store: Store = { path: legacyFile },
  learningOption: Learning = learning,
  more: Partial<SouledAgentOptions> = {},
): Promise<SouledAgent> {
  agent = await souledAgent({
    ...options(store, learningOption),
    runtime: RUNTIME,
    soul: directory,
    compile: false,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'orchard-test-tombstones',
    ...more,
  });
  return agent;
}

async function close(): Promise<void> {
  const opened = agent;
  agent = undefined;
  await opened?.close();
}

async function legacyRows(user?: string): Promise<TraceRow[]> {
  const brain = await Brain.openSqlite(legacyFile, { brainId: AGENT_ID });
  try {
    const filter = user === undefined ? '' : "AND scope = 'user' AND scope_id = ?";
    return await brain.all<TraceRow>(
      `SELECT id, content, deleted, retrieval_count FROM memory_traces WHERE brain_id = ? ${filter} ORDER BY id`,
      user === undefined ? [AGENT_ID] : [AGENT_ID, userScope(user)],
    );
  } finally {
    await brain.close();
  }
}

async function legacyCanaryId(): Promise<string> {
  const row = (await legacyRows(ALICE)).find(({ content }) => content === CANARY);
  expect(row).toBeDefined();
  return row!.id;
}

async function withLegacyBrain<T>(work: (brain: Brain) => Promise<T>): Promise<T> {
  const brain = await Brain.openSqlite(legacyFile, { brainId: AGENT_ID });
  try {
    return await work(brain);
  } finally {
    await brain.close();
  }
}

/** Runs statements on the passed store's file through a connection of its own. */
async function onLegacyFile(statements: Array<[string, unknown[]]>): Promise<void> {
  const brain = await Brain.openSqlite(legacyFile, { brainId: AGENT_ID });
  try {
    for (const [sql, params] of statements) await brain.run(sql, params);
  } finally {
    await brain.close();
  }
}

function plantTrace(
  id: string,
  scope: string,
  scopeId: string,
  text = CANARY,
  createdAt = 1_700_000_000_000,
  speaker = 'user',
): Promise<void> {
  return withLegacyBrain(async (brain) => {
    await brain.run(
      `INSERT INTO memory_traces (brain_id, id, type, scope, scope_id, content, created_at, tags)
       VALUES (?, ?, 'episodic', ?, ?, ?, ?, ?)`,
      [AGENT_ID, id, scope, scopeId, text, createdAt, JSON.stringify([speaker])],
    );
  });
}

function traceSnapshot(brain: Brain): Promise<Record<string, unknown>[]> {
  return brain.all('SELECT * FROM memory_traces WHERE brain_id = ? ORDER BY id', [brain.brainId]);
}

/** Files a copy of one of the person's rows under their persona scope, as a persona note of an earlier GMI. */
async function plantPersonaNote(sourceId: string): Promise<string> {
  const id = 'orchard-persona-note';
  await onLegacyFile([
    ['CREATE TEMP TABLE planted AS SELECT * FROM memory_traces WHERE id = ?', [sourceId]],
    ["UPDATE planted SET id = ?, scope = 'persona', scope_id = ?, content = ?", [id, `${userScope(ALICE)}::orchard-guide`, 'The orchard ladder is teal.']],
    ['INSERT INTO memory_traces SELECT * FROM planted', []],
    ['DROP TABLE planted', []],
  ]);
  return id;
}

/** A learning store on a file of its own, beside the passed memory store. */
async function separateLearning(): Promise<{ learning: () => Learning; close(): Promise<void> }> {
  const opened = await resolveStorageAdapter({ filePath: join(directory, 'learning.sqlite'), priority: ['better-sqlite3'], quiet: true });
  return {
    learning: () => ({ ...learning, store: new SqlLearningStore({ adapter: opened }) }),
    close: () => opened.close().catch(() => undefined),
  };
}

function backup(): string {
  const file = join(directory, 'legacy-backup.sqlite');
  copyFileSync(legacyFile, file);
  return file;
}

function restore(file: string): void {
  copyFileSync(file, legacyFile);
  for (const suffix of ['-wal', '-shm']) rmSync(legacyFile + suffix, { force: true });
}

beforeEach(() => {
  globalLLMProviderHealth.reset();
  directory = mkdtempSync(join(tmpdir(), 'souled-legacy-gmi-'));
  legacyFile = join(directory, 'legacy.sqlite');
  writeFileSync(join(directory, 'SOUL.md'), `---\nname: Orchard Guide\nagentId: ${AGENT_ID}\n---\nYou are the orchard guide.`);
  const embeddingKey = `legacy-gmi-embed-${++sequence}`;
  embeddings = script('openai', embeddingKey);
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  events = [];
  setLogger(pino({ level: 'debug', base: undefined }, { write: (line) => { events.push(JSON.parse(line)); } }));
});

afterEach(async () => {
  try {
    await close();
  } finally {
    await adapter?.close().catch(() => undefined);
    adapter = undefined;
    resetLoggerFactory();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('a passed store on a souled GMI', () => {
  it('counts the passed store once at open and keeps its traces out of turns', async () => {
    await seed();
    const gone = (await legacyRows(BOB))[0];
    await onLegacyFile([['UPDATE memory_traces SET deleted = 1 WHERE id = ?', [gone.id]]]);
    const before = await legacyRows();
    expect(before.some(({ content }) => content === CANARY)).toBe(true);
    const joined = await open();
    const turn = await joined.session('joined', { userId: ALICE }).send('What is the orchard lantern battery?');
    await turn.memoryWrite;
    expect(served.seen).toHaveLength(1);
    expect(JSON.stringify(served.seen[0].messages)).not.toContain('amberquartz');
    expect(await legacyRows()).toEqual(before);
    expect(events.filter(({ event }) => event === 'memory.legacy_gmi_store')).toEqual([
      expect.objectContaining({ traces: before.filter(({ deleted }) => deleted === 0).length, call: 'copyLegacyGmiMemory' }),
    ]);
  });

  it('forgets the named person in the passed store and leaves the other person’s traces', async () => {
    await seed();
    await legacyCanaryId();
    const other = await legacyRows(BOB);
    expect(other.length).toBeGreaterThan(0);
    const joined = await open();
    const report = await joined.forgetUser!(ALICE);
    expect(await legacyRows(ALICE)).toEqual([]);
    expect(await legacyRows(BOB)).toEqual(other);
    expect(report.complete).toBe(true);
    expect(report.stores).toContainEqual({ store: STORE_LABEL, reached: true, deleted: expect.any(Number) });
  });

  it('exports the named person’s passed traces and corrects an id owned by that person', async () => {
    await seed();
    const id = await legacyCanaryId();
    const joined = await open();
    const exported = await joined.exportUserMemory!(ALICE);
    expect.soft(exported.held.legacyGmiStore).toContainEqual(expect.objectContaining({ id, text: CANARY }));
    expect(JSON.stringify(exported)).not.toContain(OTHER);
    await expect(joined.correctUserMemory!(BOB, { traceIds: [id] })).rejects.toThrow();
    expect(await legacyCanaryId()).toBe(id);

    const correction = await joined.correctUserMemory!(ALICE, { traceIds: [id], text: 'The lantern battery is copper.' });
    expect(correction).toMatchObject({ deleted: 1, correctionTraceId: expect.any(String) });
    expect((await legacyRows(ALICE)).map((row) => row.id)).not.toContain(id);
    expect(JSON.stringify(await joined.exportUserMemory!(ALICE))).not.toContain(CANARY);
  });

  it('reapplies a user tombstone to a restored passed store', async () => {
    await seed();
    const id = await legacyCanaryId();
    const saved = backup();
    const first = await open();
    await first.forgetUser!(ALICE);
    await close();

    restore(saved);
    expect(await legacyCanaryId()).toBe(id);
    embeddings.failEmbedding = () => true;
    events.length = 0;
    const reopened = await open();
    expect(await legacyCanaryId()).toBe(id);
    // The passed store's failed replay says why, as well as counting it.
    expect(events).toContainEqual(expect.objectContaining({ event: 'memory.erasure_unfinished', type: expect.any(String) }));
    embeddings.failEmbedding = undefined;
    await reopened.applyTombstones!();
    expect(await legacyRows(ALICE)).toEqual([]);
    expect((await legacyRows(BOB)).some(({ content }) => content === OTHER)).toBe(true);
  });

  it('deletes a corrected passed trace again at open after a restore', async () => {
    await seed();
    const id = await legacyCanaryId();
    const saved = backup();
    const first = await open();
    await first.correctUserMemory!(ALICE, { traceIds: [id], text: 'The lantern battery is copper.' });
    await close();
    restore(saved);
    expect(await legacyCanaryId()).toBe(id);

    const reopened = await open();
    expect((await legacyRows(ALICE)).map((row) => row.id)).not.toContain(id);
    const exported = await reopened.exportUserMemory!(ALICE);
    expect(JSON.stringify(exported)).not.toContain(CANARY);
    expect(exported.traces).toContainEqual(expect.objectContaining({ text: 'The lantern battery is copper.' }));
    await (await reopened.session('after-restore', { userId: ALICE }).send('What is the orchard lantern battery?')).memoryWrite;
    expect(served.seen).toHaveLength(1);
    expect(JSON.stringify(served.seen[0].messages)).not.toContain('amberquartz');
  });

  it('deletes soul memory and records a tombstone while the passed store’s embedding probe fails', async () => {
    await seed();
    const id = await legacyCanaryId();
    const joined = await open();
    const scopeId = conversationScopeKey(AGENT_ID, { kind: 'user', id: ALICE });
    const trace = await joined.memory!.remember('The soul store has an orchard note.', { scope: 'conversation', scopeId });

    embeddings.failEmbedding = () => true;
    const report = await joined.forgetUser!(ALICE);
    expect(report.tombstone).toEqual({ form: 'keyed', written: true });
    expect(report.parts).toContainEqual(expect.objectContaining({ part: 'tombstone', reached: true }));
    expect(report.parts).toContainEqual(expect.objectContaining({ part: 'store', reached: true }));
    expect(await brainOf(joined.memory!).get('SELECT id FROM memory_traces WHERE id = ?', [trace.id])).toBeFalsy();
    expect.soft(report.complete).toBe(false);
    expect.soft(report.stores).toContainEqual({ store: STORE_LABEL, reached: false, reason: expect.any(String) });
    // The learning layer's deletion did not finish, so its own store keeps the person's rows too.
    expect(report.stores).toContainEqual({ store: 'learning store', reached: false, reason: expect.any(String) });
    expect(await legacyCanaryId()).toBe(id);

    embeddings.failEmbedding = undefined;
    await joined.applyTombstones!();
    expect(await legacyRows(ALICE)).toEqual([]);
  });

  it('exports available memory and names a closed passed adapter as unread', async () => {
    adapter = await resolveStorageAdapter({ filePath: legacyFile, priority: ['better-sqlite3'], quiet: true });
    await seed({ adapter });
    const joined = await open({ adapter });
    const scopeId = conversationScopeKey(AGENT_ID, { kind: 'user', id: ALICE });
    await joined.memory!.remember('The soul store remains readable.', { scope: 'conversation', scopeId });

    await adapter.close();
    const exported = await joined.exportUserMemory!(ALICE);
    expect(exported.traces).toContainEqual(expect.objectContaining({ text: 'The soul store remains readable.' }));
    expect(exported.unread).toContainEqual({ store: STORE_LABEL, reason: expect.any(String) });
  });

  it('previews the people and unattributed scopes without changing either store', async () => {
    await seed();
    const hostUser = 'registered-by-host';
    await plantTrace('from-host', 'user', userScope(hostUser));
    await plantTrace('session-only', 'user', taggedScopeId('anonymous-session', learning.namespace));
    await plantTrace('unknown-person', 'user', userScope('unknown-person'));
    await plantTrace('thread-only', 'thread', taggedScopeId('old-thread', learning.namespace));
    await plantTrace('persona-only', 'persona', `${userScope(ALICE)}::orchard`);
    await withLegacyBrain(async (brain) => {
      await brain.run('UPDATE memory_traces SET metadata = ? WHERE brain_id = ? AND id = ?', [
        JSON.stringify({ turnUserId: 'unknown-person' }), AGENT_ID, 'unknown-person',
      ]);
    });

    const joined = await open();
    const soul = brainOf(joined.memory!);
    await joined.memory!.remember('A note already in the soul store.', {
      scope: 'conversation',
      scopeId: conversationScopeKey(AGENT_ID, { kind: 'user', id: ALICE }),
    });
    const legacyBefore = await withLegacyBrain(traceSnapshot);
    const soulBefore = await traceSnapshot(soul);
    const report = await joined.copyLegacyGmiMemory!({
      users: [hostUser, ALICE, hostUser],
    });
    expect(report).toEqual({
      dryRun: true,
      people: expect.arrayContaining([
        { userId: ALICE, traces: await legacyRows(ALICE).then((rows) => rows.length) },
        { userId: BOB, traces: await legacyRows(BOB).then((rows) => rows.length) },
        { userId: hostUser, traces: 1 },
      ]),
      unattributed: expect.arrayContaining([
        { scope: 'user', scopes: 1, traces: 1, reason: expect.stringMatching(/session/i) },
        { scope: 'user', scopes: 1, traces: 1, reason: expect.stringMatching(/user|person|learner/i) },
        { scope: 'thread', scopes: 1, traces: 1, reason: expect.any(String) },
        { scope: 'persona', scopes: 1, traces: 1, reason: expect.any(String) },
      ]),
      forgotten: 0,
    });
    expect(report.people).toHaveLength(3);
    expect(report.unattributed).toHaveLength(4);
    expect(await withLegacyBrain(traceSnapshot)).toEqual(legacyBefore);
    expect(await traceSnapshot(soul)).toEqual(soulBefore);
  });

  it('moves by id in date order, resumes after an interrupted delete, and leaves unknown and forgotten rows', async () => {
    await seed();
    const first = await open();
    await first.forgetUser!(BOB);
    await close();
    const dropped = 'The screen drops this note.';
    const failed = 'The screen fails on this note.';
    const joined = await open(undefined, learning, {
      screen: async (text) => {
        if (text === dropped) return null;
        if (text === failed) throw new Error('screen unavailable');
        return text;
      },
    });
    const oldDate = 1_700_000_000_001;
    const newDate = oldDate + 86_400_000;
    await plantTrace('dated-new', 'user', userScope(ALICE), CANARY, newDate, 'assistant');
    await plantTrace('dated-old', 'user', userScope(ALICE), CANARY, oldDate);
    await plantTrace('forgotten-person', 'user', userScope(BOB), OTHER);
    await plantTrace('unmapped-person', 'user', userScope('unknown-person'), OTHER);
    await plantTrace('screen-drop', 'user', userScope(ALICE), dropped, newDate);
    await plantTrace('screen-failure', 'user', userScope(ALICE), failed, newDate);
    await withLegacyBrain(async (brain) => {
      await brain.exec(`CREATE TRIGGER interrupt_legacy_delete BEFORE DELETE ON memory_traces
        WHEN OLD.id = 'dated-old' BEGIN SELECT RAISE(ABORT, 'interrupted legacy delete'); END`);
    });

    const soul = brainOf(joined.memory!);
    const embeddedBefore = [...embeddings.embedded];
    embeddings.failEmbedding = () => true;
    const source = (await legacyRows(ALICE)).filter(({ id }) => !id.startsWith('screen-'));
    const move = () => joined.copyLegacyGmiMemory!({
      dryRun: false, users: [BOB],
    });
    const interrupted = await move();
    expect(interrupted).toMatchObject({
      dryRun: false,
      people: [{ userId: ALICE, moved: 0, kept: 2, failed: expect.any(String) }],
      forgotten: 1,
    });
    // The source rows go in one batch once their copies are filed: the batch's failed delete leaves every one.
    expect((await traceSnapshot(soul)).map(({ id }) => id)).toEqual(source.map(({ id }) => id));
    expect((await legacyRows(ALICE)).map(({ id }) => id)).toEqual(expect.arrayContaining(source.map(({ id }) => id)));
    await withLegacyBrain(async (brain) => {
      await brain.exec('DROP TRIGGER interrupt_legacy_delete');
    });

    expect(await move()).toMatchObject({
      dryRun: false,
      people: [{ userId: ALICE, moved: source.length, kept: 2 }],
      forgotten: 1,
    });
    const after = await traceSnapshot(soul);
    const scopeId = conversationScopeKey(AGENT_ID, { kind: 'user', id: ALICE });
    expect(after.map(({ id }) => id)).toEqual(source.map(({ id }) => id));
    for (const [id, date, speaker] of [['dated-old', oldDate, 'user'], ['dated-new', newDate, 'assistant']] as const) {
      const row = after.find((trace) => trace.id === id);
      expect(row).toMatchObject({ id, created_at: date, content: CANARY, scope: 'conversation', scope_id: scopeId });
      expect(JSON.parse(String(row?.metadata))).toMatchObject({
        speaker, subject: { kind: 'user', id: ALICE }, turnUserId: ALICE, copiedFrom: 'gmi-store',
      });
    }
    expect((await legacyRows(ALICE)).map(({ id }) => id)).toEqual(['screen-drop', 'screen-failure']);
    expect((await legacyRows()).map(({ id }) => id)).toEqual([
      'forgotten-person', 'screen-drop', 'screen-failure', 'unmapped-person',
    ]);
    const repeated = await move();
    expect(repeated).toMatchObject({
      dryRun: false, people: [{ userId: ALICE, moved: 0, kept: 2 }], forgotten: 1,
    });
    expect(await traceSnapshot(soul)).toEqual(after);
    expect(embeddings.embedded).toEqual(embeddedBefore);
  });

  it('leaves the forgotten person’s words in neither file of the passed store while the agent is open', async () => {
    await seed();
    await legacyCanaryId();
    const joined = await open();
    const report = await joined.forgetUser!(ALICE);
    expect(report.complete).toBe(true);
    expect(readFileSync(legacyFile).includes(CANARY)).toBe(false);
    const log = `${legacyFile}-wal`;
    expect(existsSync(log) && readFileSync(log).includes(CANARY)).toBe(false);
  });

  it('deletes a forgotten person’s passed traces again after a restore of that store alone, with learning on a store of its own', async () => {
    const own = await separateLearning();
    try {
      await seed({ path: legacyFile }, own.learning());
      const id = await legacyCanaryId();
      const saved = backup();
      const first = await open({ path: legacyFile }, own.learning());
      await first.forgetUser!(ALICE);
      expect(await legacyRows(ALICE)).toEqual([]);
      await close();

      restore(saved);
      expect(await legacyCanaryId()).toBe(id);
      await open({ path: legacyFile }, own.learning());
      expect(await legacyRows(ALICE)).toEqual([]);
      expect((await legacyRows(BOB)).some(({ content }) => content === OTHER)).toBe(true);
    } finally {
      await close();
      await own.close();
    }
  });

  it('forgets the persona notes the passed store indexes for the person when learning moved to a store of its own', async () => {
    await seed();
    const note = await plantPersonaNote(await legacyCanaryId());
    const own = await separateLearning();
    try {
      const joined = await open({ path: legacyFile }, own.learning());
      await joined.forgetUser!(ALICE);
      expect(await legacyRows(ALICE)).toEqual([]);
      expect((await legacyRows()).map((row) => row.id)).not.toContain(note);
      expect((await legacyRows(BOB)).some(({ content }) => content === OTHER)).toBe(true);
    } finally {
      await close();
      await own.close();
    }
  });

  it('finishes an interrupted move after the agent is opened again, and never files over a trace that holds the id', async () => {
    await seed();
    const carol = 'carol';
    const carolKey = conversationScopeKey(AGENT_ID, { kind: 'user', id: carol });
    const oldDate = 1_700_000_000_001;
    await plantTrace('reopen-old', 'user', userScope(ALICE), CANARY, oldDate);
    await plantTrace('carol-first', 'user', userScope(carol), OTHER, oldDate);
    await plantTrace('carol-clash', 'user', userScope(carol), CANARY, oldDate + 1);
    await withLegacyBrain(async (brain) => {
      await brain.exec(`CREATE TRIGGER interrupt_legacy_delete BEFORE DELETE ON memory_traces
        WHEN OLD.id = 'reopen-old' BEGIN SELECT RAISE(ABORT, 'interrupted legacy delete'); END`);
    });
    const first = await open();
    const held = 'A note of the soul store under the same id.';
    await first.memory!.remember(held, { id: 'carol-clash', scope: 'conversation', scopeId: carolKey });
    const aliceRows = (await legacyRows(ALICE)).map(({ id }) => id).sort();

    const interrupted = await first.copyLegacyGmiMemory!({ dryRun: false, users: [carol] });
    expect(interrupted.people).toContainEqual({ userId: ALICE, moved: 0, kept: 0, failed: expect.any(String) });
    expect(interrupted.people).toContainEqual({ userId: carol, moved: 1, kept: 0, failed: expect.any(String) });
    await close();
    await withLegacyBrain(async (brain) => {
      await brain.exec('DROP TRIGGER interrupt_legacy_delete');
    });

    const reopened = await open();
    const soul = brainOf(reopened.memory!);
    const resumed = await reopened.copyLegacyGmiMemory!({ dryRun: false, users: [carol] });
    expect(resumed.people).toContainEqual({ userId: ALICE, moved: aliceRows.length, kept: 0 });
    expect(resumed.people).toContainEqual({ userId: carol, moved: 0, kept: 0, failed: expect.any(String) });
    const aliceKey = conversationScopeKey(AGENT_ID, { kind: 'user', id: ALICE });
    const moved = await soul.all<{ id: string }>(
      'SELECT id FROM memory_traces WHERE brain_id = ? AND scope_id = ? ORDER BY id',
      [soul.brainId, aliceKey],
    );
    expect(moved.map(({ id }) => id)).toEqual(aliceRows);
    expect(await legacyRows(ALICE)).toEqual([]);
    expect(await soul.get('SELECT content, deleted FROM memory_traces WHERE brain_id = ? AND id = ?', [soul.brainId, 'carol-clash']))
      .toEqual({ content: held, deleted: 0 });
    expect((await legacyRows(carol)).map(({ id, content, deleted }) => ({ id, content, deleted })))
      .toEqual([{ id: 'carol-clash', content: CANARY, deleted: 0 }]);
  });

  it('deletes the passed store’s copy too when a trace an interrupted move left in both stores is corrected', async () => {
    await seed();
    const moving = 'The orchard gate code is 4417.';
    const oldDate = 1_700_000_000_001;
    await plantTrace('moving-live', 'user', userScope(ALICE), moving, oldDate);
    // The source row stays live: neither its mark nor its delete lands.
    await withLegacyBrain(async (brain) => {
      await brain.exec(`CREATE TRIGGER hold_legacy_mark BEFORE UPDATE ON memory_traces
        WHEN OLD.id = 'moving-live' BEGIN SELECT RAISE(ABORT, 'held legacy mark'); END`);
      await brain.exec(`CREATE TRIGGER hold_legacy_delete BEFORE DELETE ON memory_traces
        WHEN OLD.id = 'moving-live' BEGIN SELECT RAISE(ABORT, 'held legacy delete'); END`);
    });
    const joined = await open();
    const soul = brainOf(joined.memory!);
    const stopped = await joined.copyLegacyGmiMemory!({ dryRun: false });
    expect(stopped.people).toContainEqual({ userId: ALICE, moved: 0, kept: 0, failed: expect.any(String) });
    expect(await soul.get('SELECT deleted FROM memory_traces WHERE brain_id = ? AND id = ?', [soul.brainId, 'moving-live']))
      .toEqual({ deleted: 0 });
    expect((await legacyRows(ALICE)).find(({ id }) => id === 'moving-live')).toMatchObject({ deleted: 0 });
    await withLegacyBrain(async (brain) => {
      await brain.exec('DROP TRIGGER hold_legacy_mark');
      await brain.exec('DROP TRIGGER hold_legacy_delete');
    });

    const corrected = await joined.correctUserMemory!(ALICE, { traceIds: ['moving-live'] });
    expect(corrected).toMatchObject({ deleted: 1 });
    expect((await legacyRows(ALICE)).map(({ id }) => id)).not.toContain('moving-live');
    expect(JSON.stringify(await joined.exportUserMemory!(ALICE))).not.toContain(moving);

    // A move whose source row was marked and not deleted leaves its words in the passed store as well.
    await plantTrace('moving-marked', 'user', userScope(ALICE), moving, oldDate);
    await withLegacyBrain(async (brain) => {
      await brain.exec(`CREATE TRIGGER hold_legacy_delete BEFORE DELETE ON memory_traces
        WHEN OLD.id = 'moving-marked' BEGIN SELECT RAISE(ABORT, 'held legacy delete'); END`);
    });
    expect((await joined.copyLegacyGmiMemory!({ dryRun: false })).people)
      .toContainEqual({ userId: ALICE, moved: 0, kept: 0, failed: expect.any(String) });
    expect((await legacyRows(ALICE)).find(({ id }) => id === 'moving-marked')).toMatchObject({ deleted: 1 });
    await withLegacyBrain(async (brain) => {
      await brain.exec('DROP TRIGGER hold_legacy_delete');
    });
    // The correction's text is the copy's: the copy stays as the correction, and the passed store's row goes.
    const reused = await joined.correctUserMemory!(ALICE, { traceIds: ['moving-marked'], text: moving });
    expect(reused).toMatchObject({ correctionTraceId: 'moving-marked' });
    expect((await legacyRows(ALICE)).map(({ id }) => id)).not.toContain('moving-marked');
  });

  it('leaves in the passed store the rows of an account kept from memory and of a child on a store kept until deletion', async () => {
    await seed();
    const child = 'young-reader';
    await plantTrace('child-note', 'user', userScope(child), OTHER);
    const joined = await open(undefined, learning, {
      memoryPolicy: ({ userId }) =>
        userId === BOB ? { longTerm: 'off' } : userId === child ? { longTerm: 'compiled', minor: true } : { longTerm: 'compiled' },
    });
    const soul = brainOf(joined.memory!);
    const aliceRows = await legacyRows(ALICE);
    const bobRows = await legacyRows(BOB);
    events.length = 0;
    const report = await joined.copyLegacyGmiMemory!({ dryRun: false, users: [child] });
    expect(report.people).toEqual(expect.arrayContaining([
      { userId: ALICE, moved: aliceRows.length, kept: 0 },
      { userId: BOB, moved: 0, kept: bobRows.length },
      { userId: child, moved: 0, kept: 1 },
    ]));
    expect(await legacyRows(BOB)).toEqual(bobRows);
    expect((await legacyRows(child)).map(({ id }) => id)).toEqual(['child-note']);
    for (const id of [BOB, child]) {
      const key = conversationScopeKey(AGENT_ID, { kind: 'user', id });
      expect(await soul.all('SELECT id FROM memory_traces WHERE brain_id = ? AND scope_id = ?', [soul.brainId, key])).toEqual([]);
    }
    expect(events.filter(({ event }) => event === 'memory.write_refused').map(({ reason }) => reason).sort())
      .toEqual(['minor_no_retention', 'policy_off']);
  });

  it('removes a source row a move marked deleted once the soul’s copy of it has expired', async () => {
    await seed();
    const expired = 'The orchard well was capped long ago.';
    await plantTrace('swept-old', 'user', userScope(ALICE), expired, 1_700_000_000_001);
    await withLegacyBrain(async (brain) => {
      await brain.exec(`CREATE TRIGGER hold_legacy_delete BEFORE DELETE ON memory_traces
        WHEN OLD.id = 'swept-old' BEGIN SELECT RAISE(ABORT, 'held legacy delete'); END`);
    });
    const joined = await open(undefined, learning, { retention: { traces: { days: 30 } } });
    const soul = brainOf(joined.memory!);
    expect((await joined.copyLegacyGmiMemory!({ dryRun: false })).people)
      .toContainEqual(expect.objectContaining({ userId: ALICE, moved: 0, failed: expect.any(String) }));
    expect((await legacyRows(ALICE)).find(({ id }) => id === 'swept-old')).toMatchObject({ deleted: 1 });
    await withLegacyBrain(async (brain) => {
      await brain.exec('DROP TRIGGER hold_legacy_delete');
    });
    await joined.sweepRetention!();
    expect(await soul.get('SELECT id FROM memory_traces WHERE brain_id = ? AND id = ? AND deleted = 0', [soul.brainId, 'swept-old']))
      .toBeUndefined();

    await joined.copyLegacyGmiMemory!({ dryRun: false });
    expect((await legacyRows(ALICE)).map(({ id }) => id)).not.toContain('swept-old');
  });
});
