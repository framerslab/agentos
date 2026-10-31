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
import type { AgencySession } from '../../agents/agency/AgencyTypes';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import type { IRetrievalAugmentor } from '../../cognition/rag/IRetrievalAugmentor';
import type { ITool, ToolExecutionContext } from '../../core/tools/ITool';
import type { ILogger } from '../../core/logging/ILogger';

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

async function boot(extra: Record<string, unknown> = {}, logger?: ILogger): Promise<AgentOS> {
  return AgentOS.create(
    {
      modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
      turnPlanning: { enabled: false },
      personas: PERSONAS,
      tools: { search: search() },
      agencies: { launch: true },
      ...extra,
    } as any,
    logger,
  );
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
  it('with launch off the runtime registers no launch_agency, and a bound outside its range fails initialization, launch on or off', async () => {
    booted = await boot({ agencies: { maxDepth: 3 } });
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-off' });
    // The lead's table is offered (the precondition), without launch_agency though the lead is granted agency:launch.
    expect(provider.seen[0].tools).toContain('search');
    expect(provider.seen[0].tools).not.toContain('launch_agency');

    await expect(boot({ agencies: { maxDepth: 9 } })).rejects.toThrow('agencies.maxDepth must be an integer from 1 to 4, not 9');
    await expect(boot({ agencies: { launch: true, maxSeats: 0 } })).rejects.toThrow('agencies.maxSeats must be an integer from 1 to 12, not 0');
  });

  it('with launch on, a config tool of the host named launch_agency fails initialization; with launch off the runtime keeps it', async () => {
    const own = () => hostTool('launch_agency', async () => 'the host ran its own');
    await expect(boot({ tools: { search: search(), launch_agency: own() } })).rejects.toThrow(
      "agencies.launch registers 'launch_agency', and the runtime's tools already hold a tool of that name.",
    );
    booted = await boot({ tools: { search: search(), launch_agency: own() }, agencies: { maxDepth: 3 } });
    provider.replies.push(toolStep(['launch_agency', {}]), textStep('Done.'));
    await send(booted, { selectedPersonaId: 'helper', sessionId: 's-own' });
    // The helper, granted nothing, lists the host's own tool and runs it.
    expect(provider.seen[0].tools).toContain('launch_agency');
    expect(toolMessages(provider.seen[1].messages)[0]).toContain('the host ran its own');
  });

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

  it("a failed seat's message reaches neither the result nor the parent's next request; the runtime's logger gets it under the seat's name, and a logger that throws fails no launch", async () => {
    const canary = 'sk-CANARY-7272';
    // The logger AgentOS.create takes: it records every warning, and throws on the launch's own, as a host's may.
    const warnings: Array<{ message: string; meta?: Record<string, unknown> }> = [];
    const logger: ILogger = {
      info: () => undefined,
      error: () => undefined,
      debug: () => undefined,
      warn: (message: string, meta?: Record<string, unknown>) => {
        warnings.push({ message, meta });
        if (message.startsWith('[AgentOS] launch_agency')) throw new Error('the logger broke');
      },
    };
    booted = await boot({}, logger);
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Check the claim.', seats: [{ role: 'checker', personaId: 'checker' }] }]),
      // The checker's request fails with a message that holds a credential, and with it the sequential team.
      Object.assign(new Error(`upstream refused key ${canary}`), { name: 'ProviderError', code: 'E_UPSTREAM' }),
      textStep('The team failed.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // The lead, the checker's failed request, the lead: the seat ran as its persona (the precondition).
    expect(provider.seen).toHaveLength(3);
    expect(systemTextOf(provider.seen[1].messages)).toContain('You check facts.');
    // The launch failed, by the seat's error's name and code, and its result reached the lead as the tool's result.
    const [launched] = toolMessages(provider.seen[2].messages);
    expect(launched).toContain('"status":"failed"');
    expect(launched).toContain(`"reason":"seat 'checker' failed: GMIError (GMI_PROCESSING_ERROR)"`);
    expect(launched).toContain('"error":{"name":"GMIError","code":"GMI_PROCESSING_ERROR"}');
    // No model call, the lead's next one included, carries the message.
    expect(JSON.stringify(provider.seen)).not.toContain(canary);
    expect(provider.whole.join('\n')).not.toContain(canary);
    // The logger received the seat's original error under the seat's name, then the run's, by name and code; it threw
    // on both, and the launch went on.
    const launchWarnings = warnings.filter(({ message }) => message.startsWith('[AgentOS] launch_agency'));
    expect(launchWarnings.map(({ message }) => message)).toEqual(['[AgentOS] launch_agency seat checker failed', '[AgentOS] launch_agency run failed']);
    expect(launchWarnings[0].meta).toEqual({ error: expect.objectContaining({ name: 'GMIError', message: expect.stringContaining(canary) }) });
    expect(launchWarnings[1].meta).toEqual({ error: expect.objectContaining({ name: 'GMIError', message: 'GMIError (GMI_PROCESSING_ERROR)' }) });
  });

  it('a persona with agency:launch launches a team; listAgencies shows it only while it runs', async () => {
    let running: AgencySession[] = [];
    const peek = hostTool('peek', async () => {
      running = booted!.listAgencies();
      return running.length;
    });
    booted = await boot({ tools: { search: search(), peek } });
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Peek.', seats: [{ role: 'second', instructions: 'Answer.' }, { role: 'peeker', personaId: 'checker', tools: ['peek'] }] }]),
      textStep('Answered.'),
      toolStep(['peek', {}]),
      textStep('Peeked.'),
      textStep('Done.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // Read from a seat's tool while the team ran: one launched entry, its two seats, the first seat's call in its history.
    const launched = running.filter((session) => session.metadata?.kind === 'launched');
    expect(launched).toHaveLength(1);
    expect(Object.keys(launched[0].seats).sort()).toEqual(['peeker', 'second']);
    expect(launched[0]).toMatchObject({
      workflowId: `launch:${launched[0].agencyId}`,
      conversationId: expect.any(String),
      metadata: expect.objectContaining({ kind: 'launched', parentPersonaId: 'lead', depth: 1, strategy: 'sequential', status: 'running', goalPreview: 'Peek.' }),
    });
    expect(launched[0].seats.second.history).toEqual([expect.objectContaining({ status: 'completed', outputPreview: 'Answered.' })]);
    // Afterwards the list is empty, and no seat's GMI is active.
    expect(booted.listAgencies()).toEqual([]);
    expect([...booted.getGMIManager().gmiSessionMap.keys()].filter((id) => id.startsWith('seat:'))).toEqual([]);
  });

  it("a launch that returns while a seat's tool still runs stays listed, closing, until the seat is released", async () => {
    let release!: () => void;
    const hanging = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hang = hostTool('hang', async () => {
      await hanging;
      return 'done';
    });
    booted = await boot({ tools: { search: search(), hang } });
    provider.replies.push(
      toolStep(['launch_agency', { goal: 'Wait.', deadlineMs: 1_000, seats: [{ role: 'waiter', instructions: 'Call hang.', tools: ['hang'] }] }]),
      // The waiter's tool runs past the deadline and the grace.
      toolStep(['hang', {}]),
      textStep('Waited.'),
    );
    await send(booted, { selectedPersonaId: 'lead', sessionId: 's-lead' });
    // The launch returned timed_out while the waiter's tool still runs, and its seat's GMI is still active (the precondition).
    expect(toolMessages(provider.seen[2].messages)[0]).toContain('"status":"timed_out"');
    const listed = booted.listAgencies();
    expect(listed).toHaveLength(1);
    expect(booted.getGMIManager().gmiSessionMap.has(`seat:${listed[0].agencyId}:waiter`)).toBe(true);
    // The team stays listed while its seat holds a GMI, marked closing.
    expect(listed[0].metadata).toMatchObject({ kind: 'launched', status: 'closing' });
    expect(Object.keys(listed[0].seats)).toEqual(['waiter']);
    // Once the tool returns and the seat is released, the team leaves the list.
    release();
    await vi.waitFor(() => expect(booted!.listAgencies()).toEqual([]), { timeout: 10_000 });
    expect([...booted.getGMIManager().gmiSessionMap.keys()].filter((id) => id.startsWith('seat:'))).toEqual([]);
  }, 40_000);
});
