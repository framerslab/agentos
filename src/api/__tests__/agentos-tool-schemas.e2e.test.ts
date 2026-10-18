/**
 * @file agentos-tool-schemas.e2e.test.ts
 * Tool calls on the full runtime, checked against the tools' JSON Schemas: AgentOS.create() with the OpenAI provider
 * class stubbed at its module boundary, a first completion that calls the tools, and the tool messages the next
 * completion receives. The built-in getCurrentDateTime, whose input schema names a format Ajv does not define ("time-zone"),
 * answers the time; two host tools whose input schemas are copies of one schema under a shared $id both run, and a
 * call that leaves out a required argument is answered with the schema's error.
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

const assistant = {
  id: 'assistant', name: 'Assistant', description: 'Answers with its tools.', version: '1.0.0',
  baseSystemPrompt: 'You answer with your tools.',
} as unknown as IPersonaDefinition;

/** A completion step that calls the tools given, in order. */
const toolCalls = (calls: Array<{ id: string; name: string; args: Record<string, unknown> }>): Array<Record<string, unknown>> => [
  {
    isFinal: true,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: calls.map(({ id, name, args }) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })),
      },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  },
];

/** Boots the full runtime with the stubbed OpenAI provider and the one persona; `extra` adds to its config (`tools`). */
async function boot(extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [assistant],
    ...extra,
  } as any);
}
/** Sends one turn in a session and reads its stream to the end. */
async function send(os: AgentOS, sessionId: string): Promise<void> {
  for await (const _chunk of os.processRequest({ userId: 'ana', sessionId, textInput: 'Go.', selectedPersonaId: 'assistant' } as any)) { /* drain */ }
}
/** The content of the tool messages one completion call received, in order. */
const toolMessages = (messages: Array<{ role: string; content: unknown }> | undefined): string[] =>
  (messages ?? []).filter((m) => m.role === 'tool').map((m) => String(m.content));

let booted: AgentOS | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
  provider.replies.length = 0;
  provider.seenMessages.length = 0;
  vi.restoreAllMocks();
});

describe('tool calls checked against their JSON Schemas on the full runtime', () => {
  it('run the built-in getCurrentDateTime, whose input schema names a format Ajv does not define', async () => {
    booted = await boot();
    provider.replies.push(toolCalls([{ id: 'call-time', name: 'getCurrentDateTime', args: { timezone: 'UTC' } }]));
    await send(booted, 's-time');
    const results = toolMessages(provider.seenMessages[1]);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('"timezoneUsed":"UTC"');
  });

  it('check the arguments of two host tools whose input schemas are copies of one schema under a shared $id', async () => {
    // Two tools built from one schema file each hold their own copy of it, under the same $id.
    const argsSchema = () => ({ $id: 'urn:example:text-args', type: 'object', properties: { text: { type: 'string' } }, required: ['text'] });
    booted = await boot({
      tools: {
        echo: { description: 'Echo the text.', parameters: argsSchema(), execute: async ({ text }: { text: string }) => ({ echoed: text }) },
        shout: { description: 'Shout the text.', parameters: argsSchema(), execute: async ({ text }: { text: string }) => ({ shouted: text.toUpperCase() }) },
      },
    });
    provider.replies.push(toolCalls([
      { id: 'call-echo', name: 'echo', args: { text: 'hi' } },
      { id: 'call-shout', name: 'shout', args: { text: 'hi' } },
      { id: 'call-shout-empty', name: 'shout', args: {} },
    ]));
    await send(booted, 's-shared-id');
    const results = toolMessages(provider.seenMessages[1]);
    expect(results).toHaveLength(3);
    expect(results[0]).toContain('"echoed":"hi"');
    expect(results[1]).toContain('"shouted":"HI"');
    expect(results[2]).toContain("Invalid arguments for tool 'shout'");
  });

  it("answer a tool whose output schema does not compile with the schema's error, after the tool has run", async () => {
    const execute = vi.fn(async () => ({ success: true, output: { text: 'hi' } }));
    // 'nonsense' is no JSON Schema type.
    const odd = {
      id: 'odd-v1', name: 'odd', displayName: 'Odd', description: 'Answers with an output its schema cannot check.',
      inputSchema: { type: 'object', properties: {} }, outputSchema: { type: 'nonsense' }, execute,
    };
    booted = await boot({ tools: { odd } });
    provider.replies.push(toolCalls([{ id: 'call-odd', name: 'odd', args: {} }]));
    await send(booted, 's-odd');
    expect(execute).toHaveBeenCalledTimes(1);
    const results = toolMessages(provider.seenMessages[1]);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain("Error from tool 'odd'");
    expect(results[0]).toContain("The output schema of tool 'odd' does not compile");
  });
});
