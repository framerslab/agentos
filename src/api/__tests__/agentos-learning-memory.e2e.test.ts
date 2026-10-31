/**
 * @file agentos-learning-memory.e2e.test.ts
 * Memory on the full runtime with the learning flag on, end to end: AgentOS.create() with a memory tools facade and a
 * learning store the test holds, and a model (the OpenAI provider class stubbed at its module boundary) that calls the
 * memory tools. A learner's memory_add is filed under the learner's namespaced scope and recorded in the learner's
 * chain; a memory_search on the turn of another tenant's user of the same id finds none of it, while the learner's
 * own next session finds it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  replies: [] as Array<Array<Record<string, unknown>>>,
  seenMessages: [] as Array<Array<{ role: string; content: unknown }>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
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

import { AgentOS } from '../AgentOS';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { InMemoryLearningStore } from '../../cognition/learning/index';
import { chainKeyOf } from '../../cognition/learning/ledger/Ledger';
import { Memory } from '../../cognition/memory/io/facade/Memory';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';

const tutor = {
  id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0',
  baseSystemPrompt: 'You teach networking.', personalityTraits: { honesty: 0.9, openness: 0.5 },
} as unknown as IPersonaDefinition;

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
/** The content of the tool messages one model call received. */
const toolMessages = (messages: Array<{ role: string; content: unknown }> | undefined): string =>
  (messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content)).join('\n');

let booted: AgentOS | undefined;
let memory: Memory | undefined;
let dir: string | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  if (memory) await memory.close();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  booted = undefined;
  memory = undefined;
  dir = undefined;
  provider.replies.length = 0;
  provider.seenMessages.length = 0;
  vi.restoreAllMocks();
});

/** AgentOS with the learning flag on, a memory tools facade on a file of its own, and an in-process learning store. */
async function boot(): Promise<{ os: AgentOS; brain: Brain; store: InMemoryLearningStore }> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'learning-memory-e2e-'));
  memory = await Memory.createSqlite(path.join(dir, 'tools.sqlite'), { brainId: 'tools-brain', selfImprove: false });
  const store = new InMemoryLearningStore();
  booted = await AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [tutor],
    memoryTools: { memory },
    learning: { store, memoryTools: memory },
  } as any);
  return { os: booted, brain: (memory as unknown as { _brain: Brain })._brain, store };
}
async function send(agentos: AgentOS, input: Record<string, unknown>): Promise<void> {
  for await (const _chunk of agentos.processRequest({ textInput: 'Remember this.', selectedPersonaId: 'tutor', ...input } as any)) { /* drain */ }
}

describe('the memory tools on the full runtime with the learning flag on', () => {
  it("file a learner's memory_add under the learner's namespaced scope with its row, and another tenant's user of the same id finds none of it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { os: agentos, brain, store } = await boot();

    provider.replies.push(toolCall('memory_add', { content: 'Canary LARK-7.' }));
    await send(agentos, { userId: 'ana', sessionId: 's-a', organizationId: 'A' });
    provider.replies.push(toolCall('memory_search', { query: 'canary' }));
    await send(agentos, { userId: 'ana', sessionId: 's-b', organizationId: 'B' });
    provider.replies.push(toolCall('memory_search', { query: 'canary' }));
    await send(agentos, { userId: 'ana', sessionId: 's-c', organizationId: 'A' });

    expect(await brain.all('SELECT scope, scope_id, content FROM memory_traces WHERE deleted = 0')).toEqual([
      { scope: 'user', scope_id: 'A/ana', content: 'Canary LARK-7.' },
    ]);
    const rows = await store.chainRows(chainKeyOf({ namespace: 'A', agentKey: 'tutor', userId: 'ana' }));
    expect(rows.filter((row) => row.kind === 'memory_write').map((row) => [row.rowType, row.verdict])).toEqual([
      ['candidate', 'pending'],
      ['verdict', 'kept'],
    ]);
    // Tenant A's next session finds it, so its absence from tenant B's search is the scopes' doing.
    expect(toolMessages(provider.seenMessages[5])).toContain('LARK-7');
    expect(toolMessages(provider.seenMessages[3])).not.toContain('LARK-7');
  });
});
