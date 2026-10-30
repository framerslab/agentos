/**
 * @file agentos-launch-agency.e2e.test.ts
 * launch_agency on the full runtime, end to end: AgentOS.create() with `agencies`, personas with and without the
 * agency:launch capability, and the OpenAI provider class stubbed at its module boundary. A persona's turn launches a
 * team whose seats are GMIs of the runtime's GMIManager over a view of its tools, and the next model call receives
 * one tool result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  /** One entry per streamed model call: the chunks to stream, or an Error to throw. The default answers "Done.". */
  replies: [] as Array<Array<Record<string, unknown>> | Error>,
  /** Every streamed model call: its messages and the names of the tools it offered. */
  seen: [] as Array<{ messages: Array<{ role: string; content: unknown }>; tools: string[] }>,
  /** Every unstreamed call's messages, as JSON (a judge's, a coordinator's, a metaprompt's). */
  whole: [] as string[],
  /** The API key of every provider instance that initialized. */
  keys: [] as string[],
  /** Called after each streamed call is recorded, before it is answered; a test may hold the answer. */
  beforeAnswer: undefined as undefined | ((messages: Array<{ role: string; content: unknown }>) => Promise<void> | void),
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  /** The creation judge's verdict on a forged tool: approved (EmergentJudge parses it as JSON). */
  const APPROVED = JSON.stringify({
    safety: { passed: true, concerns: [] },
    correctness: { passed: true, failedTests: [] },
    determinism: { likely: true, reasoning: 'Deterministic.' },
    bounded: { likely: true, reasoning: 'Bounded.' },
    confidence: 0.95,
    approved: true,
    reasoning: 'Safe and correct.',
  });
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize(config: { apiKey?: string }) {
      provider.keys.push(String(config?.apiKey));
      this.isInitialized = true;
    }
    async generateCompletion(_modelId: string, messages: Array<{ role: string; content: unknown }>) {
      const prompt = JSON.stringify(messages);
      provider.whole.push(prompt);
      const text = prompt.includes('security auditor reviewing a tool') ? APPROVED : 'ok';
      return {
        choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }],
        responseText: text,
        usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 },
      };
    }
    async *generateCompletionStream(
      _modelId: string,
      messages: Array<{ role: string; content: unknown }>,
      options?: { tools?: Array<{ function: { name: string } }> },
    ) {
      provider.seen.push({ messages: JSON.parse(JSON.stringify(messages)), tools: (options?.tools ?? []).map((tool) => tool.function.name) });
      await provider.beforeAnswer?.(messages);
      const next = provider.replies.shift() ?? [
        { responseTextDelta: 'Done.' },
        { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: 'Done.' }, finishReason: 'stop' }], usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
      ];
      if (next instanceof Error) throw next;
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
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import type { IRetrievalAugmentor } from '../../cognition/rag/IRetrievalAugmentor';
import type { ITool, ToolExecutionContext } from '../../core/tools/ITool';

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
/** A model step that answers `text`, reporting `totalTokens` of usage. */
const textStep = (text: string, totalTokens = 12): Array<Record<string, unknown>> => [
  { responseTextDelta: text },
  { isFinal: true, choices: [{ index: 0, message: { role: 'assistant', content: text }, finishReason: 'stop' }], usage: { promptTokens: totalTokens - 2, completionTokens: 2, totalTokens } },
];
/** The content of the tool messages a model call received. */
const toolMessages = (messages: Array<{ role: string; content: unknown }>): string[] => messages.filter((m) => m.role === 'tool').map((m) => String(m.content));
const systemTextOf = (messages: Array<{ role: string; content: unknown }>): string => messages.filter((m) => m.role === 'system').map((m) => String(m.content)).join('\n\n');

const persona = (id: string, extra: Record<string, unknown> = {}): IPersonaDefinition =>
  ({ id, name: id, description: `The ${id}.`, version: '1.0.0', baseSystemPrompt: `You are the ${id}.`, defaultProviderId: 'openai', defaultModelId: 'stub-model', ...extra }) as unknown as IPersonaDefinition;
const PERSONAS = [
  persona('lead', { allowedCapabilities: ['agency:launch'] }),
  persona('helper'),
  persona('checker', { baseSystemPrompt: 'You check facts.' }),
  persona('reader', { memoryConfig: { enabled: true, ragConfig: { enabled: true, retrievalTriggers: { onUserQuery: true }, ingestionTriggers: { onTurnSummary: true } } } }),
];

/** A tool for the runtime's config tools. */
const hostTool = (name: string, execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<unknown>, hasSideEffects = false): ITool => ({
  id: `${name}-v1`, name, displayName: name, description: `The ${name} tool.`,
  inputSchema: { type: 'object', properties: {} }, hasSideEffects,
  execute: async (args, context) => ({ success: true, output: await execute(args, context) }),
});
const search = () => hostTool('search', async () => 'found');

/** A retrieval augmentor that records the queries it is asked and the documents it is given. */
function recordingAugmentor() {
  const queries: string[] = [];
  const documents: string[] = [];
  const augmentor = {
    retrieveContext: async (query: string) => {
      queries.push(query);
      return { queryText: query, augmentedContext: '', retrievedChunks: [] };
    },
    ingestDocuments: async (docs: unknown) => {
      documents.push(JSON.stringify(docs));
      return { ingestedIds: ['doc'], failedCount: 0, errors: [] };
    },
    checkHealth: async () => ({ isHealthy: true }),
    shutdown: async () => undefined,
  };
  return { augmentor: augmentor as unknown as IRetrievalAugmentor, queries: () => [...queries], filed: () => documents.join('\n') };
}

async function boot(extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: PERSONAS,
    tools: { search: search() },
    agencies: { launch: true },
    ...extra,
  } as any);
}
async function send(os: AgentOS, input: Record<string, unknown>): Promise<void> {
  for await (const _chunk of os.processRequest({ textInput: 'Go.', userId: 'ana', ...input } as any)) {
    /* drain */
  }
}

let booted: AgentOS | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
  provider.replies.length = 0;
  provider.seen.length = 0;
  provider.whole.length = 0;
  provider.keys.length = 0;
  provider.beforeAnswer = undefined;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('launch_agency on the full runtime', () => {
  it('a persona without agency:launch neither lists nor calls the tool, and one with it lists and calls it', async () => {
    booted = await boot();
    provider.replies.push(toolStep(['launch_agency', { goal: 'x', seats: [{ role: 'w', instructions: 'Write.' }] }]));
    await send(booted, { selectedPersonaId: 'helper', sessionId: 's-helper' });
    // The helper's table is offered (the precondition), without launch_agency, and its call is refused.
    expect(provider.seen[0].tools).toContain('search');
    expect(provider.seen[0].tools).not.toContain('launch_agency');
    expect(toolMessages(provider.seen[1].messages)[0]).toContain("Error from tool 'launch_agency'");

    provider.seen.length = 0;
    provider.replies.push(toolStep(['launch_agency', { goal: 'Check the fact.', seats: [{ role: 'checker', personaId: 'checker' }] }]), textStep('Checked.'), textStep('Done.'));
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    expect(provider.seen[0].tools).toContain('launch_agency');
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('"status":"completed"');
  });

  it("a personaId seat is that registered persona, an unknown one is unknown_member, and a seat's retrieval stays off", async () => {
    const rag = recordingAugmentor();
    booted = await boot({ retrievalAugmentor: rag.augmentor });
    // The reader's own turn retrieves with its input and files a turn summary (the precondition).
    await send(booted, { selectedPersonaId: 'reader', sessionId: 's-reader', textInput: 'CANARY-OWN-1 what do we know?' });
    expect(rag.queries()).toContain('CANARY-OWN-1 what do we know?');
    expect(rag.filed()).toContain('CANARY-OWN-1');

    provider.seen.length = 0;
    provider.replies.push(
      toolStep(
        ['launch_agency', { goal: 'CANARY-SEAT-2: read this.', seats: [{ role: 'reader', personaId: 'reader' }, { role: 'checker', personaId: 'checker' }] }],
        ['launch_agency', { goal: 'x', seats: [{ role: 'ghost', personaId: 'ghost' }] }],
      ),
      textStep('Read.'),
      textStep('Checked.'),
      textStep('Done.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // Each seat is its registered persona.
    expect(systemTextOf(provider.seen[1].messages)).toContain('You are the reader.');
    expect(systemTextOf(provider.seen[2].messages)).toContain('You check facts.');
    const [launched, unknown] = toolMessages(provider.seen[3].messages);
    expect(launched).toContain('"status":"completed"');
    expect(unknown).toContain('unknown_member');
    // The reader's seat retrieved nothing and filed nothing: its input reached neither the queries nor the documents.
    expect(rag.queries().some((query) => query.includes('CANARY-SEAT-2'))).toBe(false);
    expect(rag.filed()).not.toContain('CANARY-SEAT-2');
  });

  it("a seat's view lists only its allowlist, and an allowlist naming forge_tool is tool_not_allowed", async () => {
    booted = await boot({ emergent: true, tools: { search: search(), whoami: hostTool('whoami', async () => 'ana') } });
    provider.replies.push(
      toolStep(
        ['launch_agency', { goal: 'Forge.', seats: [{ role: 'smith', instructions: 'Forge a tool.', tools: ['forge_tool'] }] }],
        ['launch_agency', { goal: 'Look.', seats: [{ role: 'looker', instructions: 'Look it up.', tools: ['search'] }] }],
      ),
      textStep('Looked.'),
      textStep('Done.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // The lead's own table is wider than the seat's (the precondition).
    expect(provider.seen[0].tools).toEqual(expect.arrayContaining(['search', 'whoami', 'launch_agency']));
    expect(provider.seen[1].tools).toEqual(['search']);
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('tool_not_allowed');
  });

  it("a seat's tool calls see the parent's user and organization, and the frame", async () => {
    const contexts: Array<Record<string, unknown>> = [];
    const whoami = hostTool('whoami', async (_args, context) => {
      contexts.push({ userId: context.userContext.userId, organizationId: context.sessionData?.organizationId, frame: context.sessionData?.agencyLaunch });
      return 'ana';
    });
    booted = await boot({ tools: { search: search(), whoami } });
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Who is asking?', seats: [{ role: 'checker', personaId: 'checker', tools: ['whoami'] }] }]),
      toolStep(['whoami', {}]),
      textStep('You are ana.'),
      textStep('Done.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead', organizationId: 'org-7' });
    expect(contexts).toEqual([{ userId: 'ana', organizationId: 'org-7', frame: expect.objectContaining({ role: 'checker', depth: 1 }) }]);
  });

  it("a personaId seat names only tools its persona may use: one its capabilities do not allow is unknown_tool, before any seat runs", async () => {
    booted = await boot();
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Launch a team of your own.', seats: [{ role: 'helper', personaId: 'helper', tools: ['launch_agency'] }] }]),
      textStep('Done.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // The lead has launch_agency (the precondition); the helper's persona is not granted agency:launch.
    expect(provider.seen[0].tools).toContain('launch_agency');
    expect(toolMessages(provider.seen[1].messages)[0]).toContain("unknown_tool: seat 'helper': the persona 'helper' has no tool 'launch_agency'");
    // The lead's two calls alone: no seat ran.
    expect(provider.seen).toHaveLength(2);
  });

  it("a personaId member is floored on its own route, not the parent's", async () => {
    // The lead's route counts 500 output tokens a call, big's 2,000 and small's 100: a seat's floor is 2,000 for the
    // prompt plus its own estimate.
    const lead = persona('lead', { allowedCapabilities: ['agency:launch'], defaultModelCompletionOptions: { maxTokens: 500 } });
    const big = persona('big', { defaultModelCompletionOptions: { maxTokens: 2_000 } });
    const small = persona('small', { defaultModelCompletionOptions: { maxTokens: 100 } });
    booted = await boot({ personas: [lead, big, small] });

    // 3,000 covers one call of the lead's route (2,500) and not one of big's (4,000): refused before any seat runs.
    provider.replies.push(toolStep(['launch_agency', { goal: 'Think big.', maxTokens: 3_000, seats: [{ role: 'big', personaId: 'big' }] }]), textStep('Done.'));
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-1' });
    expect(toolMessages(provider.seen[1].messages)[0]).toContain('budget_unavailable');
    expect(provider.seen).toHaveLength(2);

    // 2,200 covers one call of small's route (2,100) and not one of the lead's (2,500): admitted, and the seat runs.
    provider.seen.length = 0;
    provider.replies.push(toolStep(['launch_agency', { goal: 'Think small.', maxTokens: 2_200, seats: [{ role: 'small', personaId: 'small' }] }]), textStep('Small.'), textStep('Done.'));
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-2' });
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('"status":"completed"');
    expect(provider.seen).toHaveLength(3);
  });
});
