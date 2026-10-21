/**
 * @file agentos-learning-tools.e2e.test.ts
 * The self-modification tools on the full runtime, end to end: AgentOS.create() with the self-improvement tools on,
 * a model (the OpenAI provider class stubbed at its module boundary) that calls them, and the tool results the next
 * model call receives. With the learning flag on, a placeholder user's turn has no learner and the tools refuse
 * (`no_learner`); in mode `off` they refuse (`off`). With the flag off adapt_personality changes an editable trait as
 * before, and the trait it changes reaches no prompt; honesty and emotionality it refuses on every host
 * (`operator_only`), since only the persona definition sets them.
 */
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

const HEADING = '## Personality & Communication Style';
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

async function boot(extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [tutor],
    emergent: true,
    emergentConfig: { selfImprovement: { enabled: true } },
    ...extra,
  } as any);
}
async function send(os: AgentOS, input: Record<string, unknown>): Promise<void> {
  for await (const _chunk of os.processRequest({ textInput: 'Adjust yourself.', selectedPersonaId: 'tutor', ...input } as any)) { /* drain */ }
}
/** The content of the tool messages one model call received. */
const toolMessages = (messages: Array<{ role: string; content: unknown }> | undefined): string[] =>
  (messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));
const systemTextOf = (messages: Array<{ role: string; content: unknown }> | undefined): string =>
  (messages ?? []).filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n\n');

let booted: AgentOS | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
  provider.replies.length = 0;
  provider.seenMessages.length = 0;
  vi.restoreAllMocks();
});

describe('the self-modification tools on the full runtime', () => {
  it("refuse on a placeholder user's turn with the learning flag on", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: true });
    provider.replies.push(toolCall('adapt_personality', { trait: 'openness', delta: 0.02, reasoning: 'Livelier.' }));
    await send(booted, { userId: 'anonymous_user', sessionId: 's-1' });
    const results = toolMessages(provider.seenMessages[1]);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('adapt_personality refused (no_learner)');
  });

  it('act as before with the flag off, and the trait adapt_personality changes reaches no prompt', async () => {
    booted = await boot();
    provider.replies.push(toolCall('adapt_personality', { trait: 'openness', delta: 0.1, reasoning: 'Livelier.' }));
    await send(booted, { userId: 'ana', sessionId: 's-1' });
    await send(booted, { userId: 'ana', sessionId: 's-1', textInput: 'Again.' });
    const [first, afterTool, nextTurn] = provider.seenMessages;
    expect(toolMessages(afterTool)[0]).toContain('"newValue"');
    expect(systemTextOf(first)).not.toContain(HEADING);
    expect(systemTextOf(afterTool)).toBe(systemTextOf(first));
    expect(systemTextOf(nextTurn)).toBe(systemTextOf(first));
  });

  it.each(['honesty', 'emotionality'] as const)('keep %s to the persona definition with the flag off: adapt_personality refuses it (operator_only)', async (trait) => {
    booted = await boot();
    provider.replies.push(toolCall('adapt_personality', { trait, delta: -0.2, reasoning: 'Soften the answers.' }));
    await send(booted, { userId: 'ana', sessionId: 's-1' });
    const results = toolMessages(provider.seenMessages[1]);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain(
      `adapt_personality refused (operator_only): only the persona definition sets ${trait}; nothing was changed.`,
    );
    expect(results[0]).not.toContain('"newValue"');
  });

  it("refuse in mode off on a learner's turn", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: { mode: 'off' } });
    provider.replies.push(toolCall('forge_tool', {
      name: 'noop', description: 'Does nothing.', inputSchema: { type: 'object' },
      // forge_tool's input schema asks for a step and a test case at least, and the executor checks it before the tool runs.
      implementation: { mode: 'compose', steps: [{ name: 'only', tool: 'echo', inputMapping: {} }] },
      testCases: [{ input: {} }],
    }));
    await send(booted, { userId: 'ana', sessionId: 's-1' });
    expect(toolMessages(provider.seenMessages[1])[0]).toContain('forge_tool refused (off)');
  });
});
