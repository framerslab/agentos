/**
 * @file agentos-learning-tenants.e2e.test.ts
 * Two tenants with one user id on one adapter and one Brain, on the full runtime with the learning flag on: the GMIs'
 * memory, the standalone facade (its tools, its long-term retriever and its rolling-summary sink), the learning store
 * and the runtime's conversations (under conversationManagerConfig.tablePrefix, without which the runtime refuses an
 * adapter that holds a Brain) all on one SQLite adapter, the GMIs' memory and the facade on one brain id. What tenant
 * A's user 42 said, what A's agent stored with memory_add on that user's turn and what the sink filed from A's
 * compaction reach A's next session and no request of tenant B's user 42, whose memory_search finds none of it;
 * forgetUser for A's 42 deletes all three, with the knowledge-graph copies the GMIs' memory wrote, and keeps B's
 * traces. A memory_delete reaches by id only its own tenant's trace, and takes the copy of a trace the GMI filed with
 * it. A JSON export of A's 42 imported into a fresh Brain is read for A's 42 only and goes with forgetUser. Two
 * anonymous sessions file their memory tools' writes under their own forms, each with a row of no user, and find
 * nothing of each other. With the learning flag off the same runtime files and reads under the plain ids, keeps
 * memory_reflect in the memory tools pack and makes no table of the learning store. AgentOS.create(); only the OpenAI
 * provider class is stubbed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  replies: [] as Array<Array<Record<string, unknown>>>,
  seenMessages: [] as Array<Array<{ role: string; content: unknown }>>,
  completion: 'ok' as string,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: provider.completion }, finishReason: 'stop' }], responseText: provider.completion };
    }
    async *generateCompletionStream(_modelId: string, messages: Array<{ role: string; content: unknown }>) {
      provider.seenMessages.push(JSON.parse(JSON.stringify(messages)));
      const reply = provider.replies.shift() ?? [
        { responseTextDelta: 'Done.' },
        { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }] },
      ];
      for (const chunk of reply) yield chunk;
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { resolveStorageAdapter, type StorageAdapter } from '@framers/sql-storage-adapter';
import { AgentOS } from '../AgentOS';
import { createAgentOSConfig } from '../../core/config/AgentOSConfig';
import { chainKeyOf } from '../../cognition/learning/ledger/Ledger';
import { closeMemory, managerOnBrain } from '../../cognition/learning/__tests__/helpers/memoryFixtures';
import { Memory } from '../../cognition/memory/io/facade/Memory';
import { copyKey } from '../../cognition/memory/retrieval/graph/knowledge/memoryCopies';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';

const tutor = {
  id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0',
  baseSystemPrompt: 'You teach networking.', personalityTraits: { honesty: 0.9 },
} as unknown as IPersonaDefinition;
/** The user and persona scopes on, as a host's request turns them on for the retriever and the sink. */
const SCOPES = { memoryControl: { longTermMemory: { scopes: { user: true, persona: true } } } };
const CANARIES = ['BRIDGE-1', 'TOOL-2', 'SINK-3'];

/** A model step that calls one tool. */
const toolCall = (name: string, args: Record<string, unknown>): Array<Record<string, unknown>> => [
  {
    isFinal: true,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: [{ id: `call-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  },
];
/** The compactor's answer, as the rolling-summary phase reads it (a JSON object). */
const compactorAnswer = (line: string): string =>
  JSON.stringify({ summary_markdown: `- ${line}`, memory_json: { facts: [{ text: line }] } });

let booted: AgentOS | undefined;
let adapter: StorageAdapter | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  await closeMemory();
  if (adapter) await adapter.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  booted = undefined;
  adapter = undefined;
  dir = undefined;
  provider.replies.length = 0;
  provider.seenMessages.length = 0;
  provider.completion = 'ok';
  vi.restoreAllMocks();
});

/**
 * The full runtime on one SQLite adapter: the learning store, the GMIs' memory and a standalone facade, the last two
 * on brain `tutor`, and the runtime's conversations under the table prefix `agentos_` (the Brain has a
 * `conversations` table of its own); compaction on every turn (one message is enough, none is kept back). The
 * learning flag is on unless `options.learning` is `false`.
 */
async function bootOneBrain(
  facadeOver?: (adapter: StorageAdapter) => Promise<Memory>,
  // `tablePrefix: null` leaves the conversation tables under their plain names.
  options: { tablePrefix?: string | null; learning?: boolean } = {},
): Promise<{ os: AgentOS; db: StorageAdapter; facade: Memory }> {
  const tablePrefix = options.tablePrefix === undefined ? 'agentos_' : options.tablePrefix;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-tenants-e2e-'));
  const db = await resolveStorageAdapter({ filePath: path.join(dir, 'one.sqlite'), priority: ['better-sqlite3', 'sqljs'], quiet: true });
  adapter = db;
  // Neither Brain is closed here: closing a Brain closes the adapter, which afterEach closes last.
  const shared = await managerOnBrain(await Brain.openWithAdapter(db, { brainId: 'tutor' }));
  const facade = facadeOver ? await facadeOver(db) : await Memory.createWithAdapter(db, { brainId: 'tutor', selfImprove: false });
  const base = await createAgentOSConfig();
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [tutor],
    storageAdapter: db,
    conversationManagerConfig: { ...base.conversationManagerConfig, ...(tablePrefix === null ? {} : { tablePrefix }) },
    gmiManagerConfig: { ...base.gmiManagerConfig, cognitiveMemoryFactory: () => shared.forSession() },
    standaloneMemory: { memory: facade, tools: true, longTermRetriever: true, rollingSummarySink: true },
    orchestratorConfig: {
      maxToolCallIterations: 5,
      defaultAgentTurnTimeoutMs: 120000,
      enableConversationalPersistence: true,
      rollingSummaryCompactionConfig: {
        enabled: true,
        modelId: 'gpt-4o-mini',
        cooldownMs: 0,
        headMessagesToKeep: 0,
        tailMessagesToKeep: 0,
        minMessagesToSummarize: 1,
        maxMessagesToSummarizePerPass: 48,
        maxOutputTokens: 900,
      },
    },
    learning: options.learning ?? true,
  } as any);
  return { os: booted, db, facade };
}

async function send(agentos: AgentOS, input: Record<string, unknown>): Promise<void> {
  for await (const _chunk of agentos.processRequest({ textInput: 'Hello.', selectedPersonaId: 'tutor', ...SCOPES, ...input } as any)) { /* drain */ }
}

/** The live traces of brain `tutor` on the adapter: their id, their scope id and their text. */
const tracesOf = (db: StorageAdapter) =>
  db.all<{ id: string; scope_id: string; content: string }>("SELECT id, scope_id, content FROM memory_traces WHERE brain_id = 'tutor' AND deleted = 0");
/** The text of every knowledge-graph copy of brain `tutor` on the adapter. */
const copiesOf = async (db: StorageAdapter): Promise<string[]> =>
  (await db.all<{ label: string }>("SELECT label FROM knowledge_nodes WHERE brain_id = 'tutor' AND type = 'memory'")).map((row) => row.label);
/** The content of the tool messages one model call received. */
const toolMessagesOf = (messages: Array<{ role: string; content: unknown }> | undefined): string =>
  (messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');
/** Whether brain `tutor` holds the knowledge-graph copy of a trace. */
const hasCopy = async (db: StorageAdapter, traceId: string): Promise<boolean> =>
  (await db.get("SELECT id FROM knowledge_nodes WHERE brain_id = 'tutor' AND id = ?", [copyKey(traceId)])) != null;

describe("the runtime's conversations on the adapter of a memory Brain", () => {
  it("are kept under conversationManagerConfig.tablePrefix, and without one the runtime refuses to start, naming the option", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(bootOneBrain(undefined, { tablePrefix: null })).rejects.toThrow(/conversationManagerConfig\.tablePrefix/);
    await closeMemory();
    await adapter!.close();
    adapter = undefined;
    fs.rmSync(dir!, { recursive: true, force: true });

    const { os: agentos, db } = await bootOneBrain();
    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a1', textInput: 'Canary WREN-8: I row on Tuesdays.' });
    await agentos.shutdown();
    booted = undefined;
    // Saved at shutdown, if not before.
    const kept = await db.all<{ content: string }>('SELECT content FROM agentos_conversation_messages');
    expect(kept.some((row) => row.content.includes('WREN-8'))).toBe(true);
    // The Brain's own conversations table keeps its columns.
    expect(await db.all("SELECT brain_id, id FROM conversations WHERE brain_id = 'tutor'")).toEqual([]);
  });
});

describe('two tenants with one user id on one adapter and one Brain', () => {
  it("keep A's 42's words, tool writes and summaries from every request of B's 42, and forgetUser for A's 42 deletes them all with their copies and keeps B's", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { os: agentos, db } = await bootOneBrain();

    // A's 42: the user's own words (filed by the GMI), a memory_add, and a compaction (filed by the sink).
    provider.replies.push(toolCall('memory_add', { content: 'Canary TOOL-2: prefers green tea.' }));
    provider.completion = compactorAnswer('Canary SINK-3: flies kites on Sundays.');
    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a1', textInput: 'Canary BRIDGE-1: my locker code is 4411.' });
    // The pipeline hands the sink its upsert without waiting for it.
    await vi.waitFor(async () => expect((await tracesOf(db)).some((row) => row.content.includes('SINK-3'))).toBe(true));
    provider.completion = 'ok';
    const filedForA = await tracesOf(db);
    for (const canary of CANARIES) {
      const rows = filedForA.filter((row) => row.content.includes(canary));
      expect(rows.length, canary).toBeGreaterThan(0);
      expect(rows.every((row) => row.scope_id.startsWith('A/42') || row.scope_id === 'A//s-a1'), canary).toBe(true);
    }
    // The GMIs' memory wrote a knowledge-graph copy of the user's words into the one Brain.
    expect((await copiesOf(db)).some((label) => label.includes('BRIDGE-1'))).toBe(true);

    // A's 42 in a new session: the retriever reads what the sink and the tool filed.
    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a2', textInput: 'What about the canary kites and the tea?' });
    const aNext = JSON.stringify(provider.seenMessages.at(-1));
    expect(aNext).toContain('SINK-3');
    expect(aNext).toContain('TOOL-2');

    // B's 42: a turn and a memory_search; none of A's canaries reaches any of B's requests.
    const before = provider.seenMessages.length;
    provider.replies.push(toolCall('memory_search', { query: 'canary' }));
    await send(agentos, { userId: '42', organizationId: 'B', sessionId: 's-b1', textInput: 'What do you know about the canary?' });
    const ofB = JSON.stringify(provider.seenMessages.slice(before));
    expect(provider.seenMessages.length - before).toBe(2);
    // The search ran: its result is a list, not a tool error.
    expect(toolMessagesOf(provider.seenMessages[before + 1])).toContain('{"results":[');
    for (const canary of CANARIES) expect(ofB).not.toContain(canary);
    expect((await tracesOf(db)).some((row) => row.scope_id === 'B/42')).toBe(true);

    const report = await agentos.getLearningLayer()!.forgetUser!('42', { namespace: 'A' });
    expect(report.stores).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ store: 'memory manager of brain tutor', reached: true }),
        expect.objectContaining({ store: 'memory tools facade of brain tutor', reached: true }),
      ]),
    );
    const left = await tracesOf(db);
    for (const canary of CANARIES) expect(left.some((row) => row.content.includes(canary)), canary).toBe(false);
    expect(left.some((row) => row.scope_id === 'B/42')).toBe(true);
    expect(left.some((row) => row.scope_id.startsWith('A/'))).toBe(false);
    const copies = await copiesOf(db);
    for (const canary of CANARIES) expect(copies.some((label) => label.includes(canary)), canary).toBe(false);
    expect(copies.some((label) => label.includes('What do you know about the canary?'))).toBe(true);
    expect(await db.all("SELECT id FROM agentos_learning_ledger WHERE namespace = 'A' AND user_id = '42'")).toEqual([]);
  });

  it("let a memory_delete reach by id only its own tenant's trace, and take the copy of a trace the GMI filed with it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { os: agentos, db } = await bootOneBrain();
    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a1', textInput: 'Canary MOTH-5: my bike is blue.' });
    const filed = (await tracesOf(db)).filter((row) => row.content.includes('MOTH-5'));
    expect(filed.map((row) => row.scope_id)).toEqual(['A/42']);
    const traceId = filed[0]!.id;
    expect(await hasCopy(db, traceId)).toBe(true);

    // B's 42 names A's trace by its id: it reads as not found, and the trace and its copy stay.
    provider.replies.push(toolCall('memory_delete', { traceId }));
    await send(agentos, { userId: '42', organizationId: 'B', sessionId: 's-b1', textInput: 'Forget my bike.' });
    expect(toolMessagesOf(provider.seenMessages.at(-1))).toContain('"deleted":false');
    expect((await tracesOf(db)).some((row) => row.id === traceId)).toBe(true);
    expect(await hasCopy(db, traceId)).toBe(true);

    // A's 42 deletes it: the row is soft-deleted and its knowledge-graph copy goes.
    provider.replies.push(toolCall('memory_delete', { traceId }));
    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a2', textInput: 'Forget my bike.' });
    expect(toolMessagesOf(provider.seenMessages.at(-1))).toContain('"deleted":true');
    expect(await db.get("SELECT deleted FROM memory_traces WHERE brain_id = 'tutor' AND id = ?", [traceId])).toEqual({ deleted: 1 });
    expect(await hasCopy(db, traceId)).toBe(false);
  });

  it("read a JSON export of A's 42, imported into a fresh Brain, for A's 42 alone, and forgetUser for A's 42 deletes it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A first runtime files A's 42's memory_add, and its facade's Brain is exported as JSON.
    const first = await bootOneBrain();
    provider.replies.push(toolCall('memory_add', { content: 'Canary EXPORT-4: keeps bees.' }));
    await send(first.os, { userId: '42', organizationId: 'A', sessionId: 's-a1' });
    const exported = await first.facade.exportToString();
    await first.os.shutdown();
    booted = undefined;
    await closeMemory();
    await first.db.close();
    adapter = undefined;
    fs.rmSync(dir!, { recursive: true, force: true });

    // A fresh runtime on a fresh Brain that imported the export.
    const { os: agentos, db } = await bootOneBrain(async (fresh) => {
      const facade = await Memory.createWithAdapter(fresh, { brainId: 'tutor', selfImprove: false });
      await facade.importFromString(exported, 'json');
      return facade;
    });
    expect((await tracesOf(db)).filter((row) => row.content.includes('EXPORT-4')).map((row) => row.scope_id)).toEqual(['A/42']);

    await send(agentos, { userId: '42', organizationId: 'A', sessionId: 's-a2', textInput: 'Do I keep bees?' });
    expect(JSON.stringify(provider.seenMessages.at(-1))).toContain('EXPORT-4');
    const before = provider.seenMessages.length;
    provider.replies.push(toolCall('memory_search', { query: 'bees' }));
    await send(agentos, { userId: '42', organizationId: 'B', sessionId: 's-b1', textInput: 'Do I keep bees?' });
    expect(provider.seenMessages.length - before).toBe(2);
    expect(toolMessagesOf(provider.seenMessages[before + 1])).toContain('{"results":[');
    expect(JSON.stringify(provider.seenMessages.slice(before))).not.toContain('EXPORT-4');

    await agentos.getLearningLayer()!.forgetUser!('42', { namespace: 'A' });
    expect((await tracesOf(db)).some((row) => row.content.includes('EXPORT-4'))).toBe(false);
  });
});

describe('a turn with no learner on the full runtime', () => {
  it("files each anonymous session's memory_add under its own form with a row of no user, and the sessions find nothing of each other", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { os: agentos, db } = await bootOneBrain();
    provider.replies.push(toolCall('memory_add', { content: 'Canary ANON-6: parks by the river.' }));
    await send(agentos, { userId: 'anonymous_user', sessionId: 's-x' });
    expect((await tracesOf(db)).filter((row) => row.content.includes('ANON-6')).map((row) => row.scope_id)).toEqual(['/s-x']);
    const agentChain = chainKeyOf({ namespace: '', agentKey: 'tutor', userId: null });
    const rows = await db.all<{ chain_key: string; user_id: string | null; turn_user_id: string | null; row_type: string }>(
      // The tool's rows: the turn's compaction records an upsert of its own on the same chain.
      "SELECT chain_key, user_id, turn_user_id, row_type FROM agentos_learning_ledger WHERE kind = 'memory_write' AND subject NOT LIKE 'rolling_summary:%' ORDER BY seq",
    );
    expect(rows).toEqual([
      { chain_key: agentChain, user_id: null, turn_user_id: null, row_type: 'candidate' },
      { chain_key: agentChain, user_id: null, turn_user_id: null, row_type: 'verdict' },
    ]);

    const before = provider.seenMessages.length;
    provider.replies.push(toolCall('memory_search', { query: 'river' }));
    await send(agentos, { userId: 'anonymous_user', sessionId: 's-y', textInput: 'Where do I park?' });
    expect(provider.seenMessages.length - before).toBe(2);
    expect(toolMessagesOf(provider.seenMessages[before + 1])).toContain('{"results":[');
    expect(JSON.stringify(provider.seenMessages.slice(before))).not.toContain('ANON-6');
  });
});

describe('the same runtime with the learning flag off', () => {
  it('files and reads under the plain ids, keeps memory_reflect in the pack, and makes no table of the learning store', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // Self-improvement on, so the facade has memory_reflect to offer.
    const { os: agentos, db } = await bootOneBrain((shared) => Memory.createWithAdapter(shared, { brainId: 'tutor' }), { learning: false });
    expect(agentos.getLearningLayer()).toBeUndefined();
    expect(await agentos.getToolOrchestrator().getTool('memory_reflect')).toBeDefined();

    // The user's words (filed by the GMI), a memory_add, and a compaction (filed by the sink).
    provider.replies.push(toolCall('memory_add', { content: 'Canary PLAIN-8: rides a bike.' }));
    provider.completion = compactorAnswer('Canary PLAIN-9: likes rain.');
    await send(agentos, { userId: 'ana', organizationId: 'A', sessionId: 's-1', textInput: 'Canary PLAIN-7: my bike is red.' });
    const scopeIdsOf = async (canary: string): Promise<string[]> =>
      (await tracesOf(db)).filter((row) => row.content.includes(canary)).map((row) => row.scope_id).sort();
    // The sink files the summary and its fact under the conversation (the session, as the request names none), the
    // user and persona, and the user, one target after another, and the pipeline does not wait for it.
    await vi.waitFor(async () => expect(await scopeIdsOf('PLAIN-9')).toEqual(['ana', 'ana', 'ana::tutor', 'ana::tutor', 's-1', 's-1']));
    provider.completion = 'ok';
    // The GMI files the user's words under the plain user id, and memory_add files there too.
    expect(await scopeIdsOf('PLAIN-7')).toEqual(['ana']);
    expect(await scopeIdsOf('PLAIN-8')).toEqual(['ana']);

    // The user's next session: the retriever reads the sink's summary, and memory_search reads the tool's trace under
    // the user scope.
    let before = provider.seenMessages.length;
    provider.replies.push(toolCall('memory_search', { query: 'bike', scope: 'user' }));
    await send(agentos, { userId: 'ana', organizationId: 'A', sessionId: 's-2', textInput: 'Does it rain where I ride my bike?' });
    expect(provider.seenMessages.length - before).toBe(2);
    expect(JSON.stringify(provider.seenMessages[before])).toContain('PLAIN-9');
    expect(toolMessagesOf(provider.seenMessages[before + 1])).toContain('PLAIN-8');

    // Another user of the same organization finds none of it.
    before = provider.seenMessages.length;
    provider.replies.push(toolCall('memory_search', { query: 'bike', scope: 'user' }));
    await send(agentos, { userId: 'bo', organizationId: 'A', sessionId: 's-3', textInput: 'Does it rain where I ride my bike?' });
    expect(provider.seenMessages.length - before).toBe(2);
    // The search ran: its result is a list, not a tool error.
    expect(toolMessagesOf(provider.seenMessages[before + 1])).toContain('{"results":[');
    const ofBo = JSON.stringify(provider.seenMessages.slice(before));
    for (const canary of ['PLAIN-7', 'PLAIN-8', 'PLAIN-9']) expect(ofBo, canary).not.toContain(canary);

    // SQLite's own catalog: no table of the learning store, its ledger included. GLOB reads `_` as itself.
    expect(await db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name GLOB 'agentos_learning_*'")).toEqual([]);
  });
});
