/**
 * @file agentos-launch-agency-guardrails.e2e.test.ts
 * launch_agency on the full runtime under an output guardrail that judges tool calls (`config.evaluateToolCalls`):
 * the calls a team's seats make, a nested team's included, are judged as the launching turn's own calls are, before
 * they run. AgentOS.create() with the OpenAI provider class stubbed at its module boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  /** One entry per streamed model call: the chunks to stream. The default answers "Done.". */
  replies: [] as Array<Array<Record<string, unknown>>>,
  /** Every streamed model call: its messages and the names of the tools it offered. */
  seen: [] as Array<{ messages: Array<{ role: string; content: unknown }>; tools: string[] }>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() {
      this.isInitialized = true;
    }
    async generateCompletion() {
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }],
        responseText: 'ok',
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      };
    }
    async *generateCompletionStream(
      _modelId: string,
      messages: Array<{ role: string; content: unknown }>,
      options?: { tools?: Array<{ function: { name: string } }> },
    ) {
      provider.seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools: (options?.tools ?? []).map((tool) => tool.function.name) });
      const next = provider.replies.shift() ?? [
        { responseTextDelta: 'Done.' },
        { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
      ];
      for (const chunk of next) yield chunk;
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
import { AgentOSResponseChunkType, type AgentOSToolCallRequestChunk } from '../types/AgentOSResponse';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import type { IRetrievalAugmentor, RagRetrievedChunk } from '../../cognition/rag/IRetrievalAugmentor';
import type { ITool } from '../../core/tools/ITool';
import { GuardrailAction, type GuardrailOutputPayload, type IGuardrailService } from '../../safety/guardrails/IGuardrailService';

let callIds = 0;
/** A model step that calls tools, each `[name, args]`. */
const toolStep = (...calls: Array<[string, Record<string, unknown>]>): Array<Record<string, unknown>> => [
  {
    isFinal: true,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args]) => ({ id: `call-${++callIds}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) },
      finishReason: 'tool_calls',
    }],
    usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
  },
];
/** A model step that answers `text`. */
const textStep = (text: string): Array<Record<string, unknown>> => [
  { responseTextDelta: text },
  { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
];
/** The content of the tool messages a model call received. */
const toolMessages = (messages: Array<{ role: string; content: unknown }>): string[] => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));

const lead = { id: 'lead', name: 'lead', description: 'The lead.', version: '1.0.0', baseSystemPrompt: 'You are the lead.', defaultProviderId: 'openai', defaultModelId: 'stub-model', allowedCapabilities: ['agency:launch'] } as unknown as IPersonaDefinition;

/** A config tool with no side effects that records each run under its name. */
function recordingTool(name: string, runs: string[]): ITool {
  return {
    id: `${name}-v1`,
    name,
    displayName: name,
    description: `The ${name} tool.`,
    inputSchema: { type: 'object', properties: {} },
    hasSideEffects: false,
    execute: async () => {
      runs.push(name);
      return { success: true, output: 'done' };
    },
  };
}

/** An output guardrail that judges tool calls: it records the name of every call it is asked about and blocks `danger`. */
function dangerGuard(judged: string[]): IGuardrailService {
  return {
    id: 'no-danger',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      const names = (chunk as AgentOSToolCallRequestChunk).toolCalls.map((call) => call.name);
      judged.push(...names);
      return names.includes('danger') ? { action: GuardrailAction.BLOCK, reason: 'No danger.', reasonCode: 'NO_DANGER' } : null;
    },
  };
}

/** A source the lead's turn retrieves, marked confidential. */
const CONFIDENTIAL: RagRetrievedChunk = { id: 'chunk-payroll', content: 'October payroll.', originalDocumentId: 'doc-payroll', metadata: { classification: 'confidential' } };

/**
 * An output guardrail that judges tool calls: it blocks `danger` in a turn whose retrieved sources hold a confidential
 * one, and records each call it judges, marked when it saw such a source beside it.
 */
function confidentialGuard(judged: string[]): IGuardrailService {
  return {
    id: 'confidential-danger',
    config: { evaluateToolCalls: true },
    async evaluateOutput({ chunk, ragSources }: GuardrailOutputPayload) {
      if (chunk.type !== AgentOSResponseChunkType.TOOL_CALL_REQUEST) return null;
      const confidential = (ragSources ?? []).some((source) => source.metadata?.classification === 'confidential');
      const names = (chunk as AgentOSToolCallRequestChunk).toolCalls.map((call) => call.name);
      judged.push(...names.map((name) => (confidential ? `${name} (confidential)` : name)));
      return confidential && names.includes('danger')
        ? { action: GuardrailAction.BLOCK, reason: 'Not after confidential sources.', reasonCode: 'CONFIDENTIAL' }
        : null;
    },
  };
}

async function boot(runs: string[], guard: IGuardrailService, extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [lead],
    tools: { danger: recordingTool('danger', runs) },
    guardrailService: guard,
    agencies: { launch: true },
    ...extra,
  } as any);
}

async function send(os: AgentOS, sessionId: string): Promise<void> {
  for await (const _chunk of os.processRequest({ textInput: 'Go.', userId: 'ana', selectedPersonaId: 'lead', sessionId } as any)) {
    /* drain */
  }
}

let booted: AgentOS | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
  provider.replies.length = 0;
  provider.seen.length = 0;
  vi.restoreAllMocks();
});

describe('launch_agency on the full runtime, under output guardrails that judge tool calls', () => {
  it("a seat's tool call is judged by the guardrails that judge the launching turn's own calls, and refused before it runs", async () => {
    const runs: string[] = [];
    const judged: string[] = [];
    booted = await boot(runs, dangerGuard(judged));
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Run danger.', seats: [{ role: 'doer', instructions: 'Call danger.', tools: ['danger'] }] }]),
      toolStep(['danger', {}]),
      textStep('Could not.'),
      textStep('Done.'),
    );
    await send(booted, 's-1');
    // The guardrail judged the lead's own call (the precondition), and the seat was offered danger and asked for it.
    expect(judged).toContain('launch_agency');
    expect(provider.seen[1].tools).toEqual(['danger']);
    // The seat's call was judged and refused before it ran: the tool never ran, and the seat's model read the refusal.
    expect(judged).toContain('danger');
    expect(runs).toEqual([]);
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('No danger.');
    expect(provider.seen).toHaveLength(4);
  });

  it("a nested team's seat's tool call is judged by the same guardrails, and refused before it runs", async () => {
    const runs: string[] = [];
    const judged: string[] = [];
    booted = await boot(runs, dangerGuard(judged));
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Plan the work.', seats: [{ role: 'planner', instructions: 'Hand the work on.', tools: ['launch_agency', 'danger'] }] }]),
      toolStep(['launch_agency', { goal: 'Run danger.', seats: [{ role: 'doer', instructions: 'Call danger.', tools: ['danger'] }] }]),
      toolStep(['danger', {}]),
      textStep('Could not.'),
      textStep('Handed on.'),
      textStep('Done.'),
    );
    await send(booted, 's-2');
    // The planner launched the doer's team from its seat (the precondition): the doer was offered danger and asked for it.
    expect(provider.seen[2].tools).toEqual(['danger']);
    // The doer's call was judged and refused before it ran.
    expect(judged).toContain('danger');
    expect(runs).toEqual([]);
    expect(toolMessages(provider.seen[3].messages)[0]).toContain('No danger.');
    expect(provider.seen).toHaveLength(6);
  });

  it("a seat's tool call is judged beside the sources the launching turn retrieved", async () => {
    const runs: string[] = [];
    const judged: string[] = [];
    // The lead retrieves on its user's input; the store answers with the confidential source.
    const reader = { ...lead, memoryConfig: { enabled: true, ragConfig: { enabled: true, retrievalTriggers: { onUserQuery: true } } } } as unknown as IPersonaDefinition;
    const augmentor = {
      retrieveContext: async (queryText: string) => ({ queryText, augmentedContext: CONFIDENTIAL.content, retrievedChunks: [CONFIDENTIAL] }),
      ingestDocuments: async () => ({ ingestedIds: [], failedCount: 0, errors: [] }),
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    } as unknown as IRetrievalAugmentor;
    booted = await boot(runs, confidentialGuard(judged), { personas: [reader], retrievalAugmentor: augmentor });
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Run danger.', seats: [{ role: 'doer', instructions: 'Call danger.', tools: ['danger'] }] }]),
      toolStep(['danger', {}]),
      textStep('Could not.'),
      textStep('Done.'),
    );
    await send(booted, 's-3');
    // The guardrail judged the lead's own call beside the confidential source its turn read (the precondition), and the
    // seat was offered danger and asked for it.
    expect(judged).toContain('launch_agency (confidential)');
    expect(provider.seen[1].tools).toEqual(['danger']);
    // The seat's turn retrieved nothing of its own: its call was judged beside the launching turn's sources, and refused.
    expect(judged).toContain('danger (confidential)');
    expect(runs).toEqual([]);
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('Not after confidential sources.');
  });
});
