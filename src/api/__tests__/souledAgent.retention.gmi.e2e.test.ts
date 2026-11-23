/**
 * Retention on a souled agent on the GMI runtime with cognitive memory on, end to end over the real souledAgent(),
 * gmi(), GMI, cognitive memory manager, Memory store and Brain; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts), at its module boundary, and it embeds with a deterministic word hash.
 *
 * - One retention period governs everything held about a person: once their traces expire, `agent.sweepRetention()`
 *   leaves no trace of theirs, whichever side filed it, no archived original, no graph node, nothing in the mind's
 *   cache and no working-memory slot in their open session; `close()`, which sweeps before it compiles, leaves the same.
 * - `close()` says what it left through the host's logger and never the console: the turns and writes still pending at
 *   its deadline, a sweep that failed, a compile that failed, each with no text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import type { IMemoryArchive } from '../../cognition/memory/archive/IMemoryArchive';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { GMI } from '../../cognition/substrate/GMI';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { MemoryWriteRecord } from '../runtime/memoryWriteRecord';

/** The runtime every case runs on. */
const RUNTIME = 'gmi' as const;
/** Cognitive memory on, embedding through OpenAI, with no mechanism that rewrites a stored row. */
const COGNITIVE = { cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } };
const DAY = 86_400_000;

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-retention-gmi-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  events = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          events.push(JSON.parse(line));
        },
      },
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const embeddingKey = `k-souled-retention-gmi-embed-${++n}`;
  script('openai', embeddingKey, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
});
afterEach(async () => {
  vi.useRealTimers();
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);
const keyOf = (id: string) => conversationScopeKey('aria-1', { kind: 'user', id });

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a person's memory already holds. */
const spare = (count = 16): ProviderScript['replies'] => Array.from({ length: count }, () => reply.text(`Noted ${++replyNo}.`));

/** A souled agent on the GMI runtime with cognitive memory on, on the stubbed provider, which answers with `replies`. */
async function open(extra: Record<string, unknown> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-retention-gmi-${++n}`;
  script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: { days: 1 } },
    ...COGNITIVE,
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return a;
}
/** Closes an agent the case is done with. */
async function closed(a: SouledAgent): Promise<void> {
  const at = opened.indexOf(a);
  if (at >= 0) opened.splice(at, 1);
  await a.close();
}

/** Rows of the store's SQLite file, read by a connection of the test's own: open or closed, the agent's file reads the same. */
function rows<T>(sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dir, 'memory', '.store', 'memory.sqlite'), { readonly: true, fileMustExist: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
type Row = { id: string; content: string; metadata: string };
/** Every trace row under one key, soft-deleted ones included, in id order. */
const rowsUnder = (key: string): Row[] =>
  rows<Row>("SELECT id, content, metadata FROM memory_traces WHERE scope = 'conversation' AND scope_id = ? ORDER BY id", [key]);
const metaOf = (row: Row): Record<string, unknown> => JSON.parse(row.metadata || '{}') as Record<string, unknown>;
const among = (table: string, column: string, ids: readonly string[]): string[] =>
  ids.length === 0
    ? []
    : rows<{ id: string }>(`SELECT ${column} AS id FROM ${table} WHERE ${column} IN (${ids.map(() => '?').join(', ')})`, [...ids])
        .map((row) => row.id)
        .sort();
/** The trace ids among `ids` that hold an archived original in the store. */
const archivedAmong = (ids: readonly string[]) => among('archived_traces', 'trace_id', ids);
/** The ids among `ids` that hold a node in the store's own graph tables. */
const graphNodesAmong = (ids: readonly string[]) => among('knowledge_nodes', 'id', ids);

/** Plants an archived original of a trace, as a gist would have left it, through `archive`. */
async function plantOriginal(archive: IMemoryArchive, traceId: string, text: string): Promise<void> {
  await archive.store({
    traceId,
    agentId: 'aria-1',
    verbatimContent: text,
    contentHash: createHash('sha256').update(text, 'utf8').digest('hex'),
    traceType: 'episodic',
    emotionalContext: { valence: 0, arousal: 0, dominance: 0, intensity: 0, gmiMood: 'neutral' },
    entities: [],
    tags: [],
    createdAt: Date.now(),
    archivedAt: Date.now(),
    archiveReason: 'temporal_gist',
  });
}

/** The promise of a turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
}
/** The cognitive memory managers the agent's sessions built, in the order they were built. */
function managersBuilt(): () => CognitiveMemoryManager[] {
  const built = vi.spyOn(CognitiveMemoryManager.prototype, 'initialize');
  return () => built.mock.contexts as unknown as CognitiveMemoryManager[];
}
/** The GMIs built in the case, in order: a session that keeps history builds one, with its first turn. */
function builtGmis(): GMI[] {
  const built: GMI[] = [];
  const initialize = GMI.prototype.initialize;
  vi.spyOn(GMI.prototype, 'initialize').mockImplementation(async function (this: GMI, ...args) {
    built.push(this);
    return initialize.apply(this, args);
  });
  return built;
}
/** What a manager still holds of a set of traces: the live ones of its cache, and those its graph has a node of. */
function heldBy(manager: CognitiveMemoryManager, ids: readonly string[]): { cached: string[]; nodes: string[]; words: boolean } {
  const cache = manager.getStore().listTraces();
  const wanted = new Set(ids);
  return {
    cached: cache.filter((trace) => trace.isActive && wanted.has(trace.id)).map((trace) => trace.id).sort(),
    nodes: ids.filter((id) => manager.getGraph()?.hasNode(id) === true).sort(),
    words: cache.some((trace) => wanted.has(trace.id) && trace.content !== ''),
  };
}
/** The trace ids one GMI's working memory holds a slot of. */
const slotsOf = (gmi: GMI): string[] => gmi.getCognitiveMemoryManager()!.getWorkingMemory().getSlots().map((slot) => slot.traceId);
/** A gate a held call waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

describe.each(['agent.sweepRetention()', 'close()'] as const)('retention on a souled agent on the GMI runtime, run by %s', (by) => {
  it("leaves no trace, archived original, graph node or session slot of a person's expired memory", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    const managers = managersBuilt();
    const gmis = builtGmis();
    const a = await open({}, [reply.text('A canary, lovely.'), ...spare()]);
    await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
    // What she told the soul's provider: a row of her key with no mark of the mind.
    const told = await a.memory!.remember('Alice keeps a ferret named QUILL-9.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
    const hers = rowsUnder(keyOf('alice'));
    const herIds = hers.map((row) => row.id);
    const herMindIds = hers.filter((row) => metaOf(row).filedBy === 'mind').map((row) => row.id).sort();
    expect(hers).toHaveLength(3);
    expect(herMindIds).toHaveLength(2);
    expect(managers()).toHaveLength(1);
    const manager = managers()[0];
    await plantOriginal(manager.getConfig().archive!, herMindIds[0], 'My canary is named LARK-7, the yellow one.');
    expect(archivedAmong(herIds)).toEqual([herMindIds[0]]);
    expect(graphNodesAmong([told.id])).toEqual([told.id]);
    expect(heldBy(manager, herMindIds)).toEqual({ cached: herMindIds, nodes: herMindIds, words: true });
    expect(gmis).toHaveLength(1);
    expect(slotsOf(gmis[0])).toEqual(expect.arrayContaining(herMindIds));

    // Two days on, every trace of hers is past the one day her memory is kept.
    vi.setSystemTime(start + 2 * DAY);
    if (by === 'agent.sweepRetention()') {
      expect(await a.sweepRetention!()).toMatchObject({ traces: 3 });
      // Nothing of hers in the mind, and no slot of hers in her open session.
      expect(heldBy(manager, herIds)).toEqual({ cached: [], nodes: [], words: false });
      expect(slotsOf(gmis[0]).filter((id) => herIds.includes(id))).toEqual([]);
    } else {
      await closed(a);
    }

    expect(rowsUnder(keyOf('alice'))).toEqual([]);
    expect(archivedAmong(herIds)).toEqual([]);
    expect(graphNodesAmong(herIds)).toEqual([]);
    expect(lines('memory.retention_swept')).toEqual([expect.objectContaining({ traces: 3 })]);
  });
});

describe('close() on a souled agent on the GMI runtime', () => {
  it('says through the logger what it left, never on the console: writes still pending, a failed sweep, a failed compile', async () => {
    const a = await open({ pendingWritesTimeoutMs: 50 }, [reply.text('A canary, lovely.'), ...spare()]);
    await writeOf(await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.'));
    const [mine] = rowsUnder(keyOf('alice'));
    // A deletion of one memory that waits at its ownership check: still pending when close() has waited its deadline.
    const { gate, release } = gated();
    const owned = a.memory!.liveTraceIdsOf.bind(a.memory!);
    vi.spyOn(a.memory!, 'liveTraceIdsOf').mockImplementation(async (...args) => {
      await gate;
      return owned(...args);
    });
    const held = a.correctUserMemory!('alice', { traceIds: [mine.id] }).catch(() => undefined);
    // The sweep on close and the compile on close both fail, with text the logger never writes.
    vi.spyOn(a.memory!, 'listScopes').mockRejectedValue(new Error('the sweep found the disk full'));
    vi.spyOn(a.memory!, 'compileWiki').mockRejectedValue(new Error('the compile found the disk full'));
    try {
      await closed(a);
    } finally {
      release();
      await held;
    }

    // One line, counting what close() still waited for: the call, held on the person's chain, counts there too.
    const [pending] = lines('memory.close_pending');
    expect(lines('memory.close_pending')).toHaveLength(1);
    expect(pending.pending).toBeGreaterThanOrEqual(1);
    expect(lines('memory.close_sweep_failed')).toEqual([expect.objectContaining({ type: expect.any(String), code: expect.any(String) })]);
    expect(lines('memory.close_compile_failed')).toEqual([expect.objectContaining({ type: expect.any(String), code: expect.any(String) })]);
    expect(JSON.stringify(events)).not.toContain('disk full');
    const said = vi.mocked(console.warn).mock.calls.map((call) => call.map((part) => (typeof part === 'string' ? part : '')).join(' '));
    expect(said.filter((line) => line.includes('souledAgent'))).toEqual([]);
  });
});
