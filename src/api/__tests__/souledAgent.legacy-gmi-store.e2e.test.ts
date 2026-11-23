import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import pino from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { learnerUserScopeId } from '../../cognition/learning/scopes';
import { SqlLearningStore } from '../../cognition/learning/store/SqlLearningStore';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { gmi } from '../gmi';
import { souledAgent, type SouledAgent } from '../souledAgent';
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

async function open(store: Store = { path: legacyFile }, learningOption: Learning = learning): Promise<SouledAgent> {
  agent = await souledAgent({
    ...options(store, learningOption),
    runtime: RUNTIME,
    soul: directory,
    compile: false,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'orchard-test-tombstones',
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

/** Runs statements on the passed store's file through a connection of its own. */
async function onLegacyFile(statements: Array<[string, unknown[]]>): Promise<void> {
  const brain = await Brain.openSqlite(legacyFile, { brainId: AGENT_ID });
  try {
    for (const [sql, params] of statements) await brain.run(sql, params);
  } finally {
    await brain.close();
  }
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
});
