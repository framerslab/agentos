import { describe, it, expect, vi } from 'vitest';
import { AgentOS } from '../../src/api/AgentOS';
import type { AgentOSConfig } from '../../src/api/AgentOS';
import type { AgentOSInput } from '../../src/api/types/AgentOSInput';
import {
  AgentOSResponseChunkType,
  type AgentOSResponse,
  type AgentOSFinalResponseChunk,
  type AgentOSErrorChunk,
} from '../../src/api/types/AgentOSResponse';
import type { IStreamClient, StreamClientId } from '../../src/core/streaming/IStreamClient';
import type { StreamId } from '../../src/core/streaming/StreamingManager';
import type { ILogger } from '../../src/logging/ILogger';
import { ConversationContext } from '../../src/core/conversation/ConversationContext';
import { MessageRole } from '../../src/core/conversation/ConversationMessage';
import {
  GuardrailAction,
  type GuardrailConfig,
  type GuardrailEvaluationResult,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from '../../src/safety/guardrails/IGuardrailService.js';

class FakeStreamingManager {
  private readonly prepared = new Map<StreamId, AgentOSResponse[]>();
  private readonly clients = new Map<StreamId, IStreamClient[]>();

  public prepareStream(streamId: StreamId, responses: AgentOSResponse[]): void {
    this.prepared.set(
      streamId,
      responses.map((chunk) => ({
        ...chunk,
        metadata: chunk.metadata ? { ...chunk.metadata } : undefined,
      })),
    );
  }

  public async registerClient(streamId: StreamId, client: IStreamClient): Promise<void> {
    const registered = this.clients.get(streamId) ?? [];
    registered.push(client);
    this.clients.set(streamId, registered);

    const responses = this.prepared.get(streamId);
    if (!responses) {
      return;
    }

    for (const chunk of responses) {
      await client.sendChunk(chunk);
    }
    await client.notifyStreamClosed();
  }

  public async deregisterClient(streamId: StreamId, clientId: StreamClientId): Promise<void> {
    const registered = this.clients.get(streamId) ?? [];
    this.clients.set(
      streamId,
      registered.filter((client) => client.id !== clientId),
    );
  }

  /**
   * Returns the IDs of all streams that have been prepared.
   * Required by AgentOS.processRequest's finally block which checks whether
   * the stream is still active before attempting deregistration.
   *
   * @returns Array of active stream IDs
   */
  public async getActiveStreamIds(): Promise<string[]> {
    return Array.from(this.prepared.keys());
  }
}

class StubOrchestrator {
  public lastInput: AgentOSInput | undefined;
  public callCount = 0;

  constructor(
    private readonly streamingManager: FakeStreamingManager,
    private readonly streamId: StreamId,
    private readonly responses: AgentOSResponse[],
  ) {}

  public async orchestrateTurn(input: AgentOSInput): Promise<StreamId> {
    this.callCount += 1;
    this.lastInput = input;
    this.streamingManager.prepareStream(this.streamId, this.responses);
    return this.streamId;
  }

  /** The continuation after an external tool: the test prepares the stream's chunks itself, as the fake sends them at registration. */
  public async orchestrateToolResults(): Promise<void> {
    this.callCount += 1;
  }

  public getStreamIdentity(): { userId: string; sessionId: string; personaId: string; conversationId: string } {
    return { userId: 'user-1', sessionId: 'session-1', personaId: 'persona-default', conversationId: 'conversation-1' };
  }
}

class TestGuardrailService implements IGuardrailService {
  public readonly receivedInputPayloads: GuardrailInputPayload[] = [];
  public readonly receivedOutputPayloads: GuardrailOutputPayload[] = [];

  /**
   * GuardrailConfig — set canSanitize when the service returns SANITIZE
   * so the ParallelGuardrailDispatcher runs it in Phase 1 (sequential).
   */
  public config?: GuardrailConfig;

  constructor(
    private readonly options: {
      inputEvaluation?: GuardrailEvaluationResult | null;
      outputEvaluation?: GuardrailEvaluationResult | null;
      /** Mark as sanitizer so Phase 1 handles SANITIZE correctly. */
      canSanitize?: boolean;
    },
  ) {
    if (options.canSanitize) {
      this.config = { canSanitize: true };
    }
  }

  public async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
    this.receivedInputPayloads.push(payload);
    return this.options.inputEvaluation ?? null;
  }

  public async evaluateOutput(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
    this.receivedOutputPayloads.push(payload);
    return this.options.outputEvaluation ?? null;
  }
}

const baseInput: AgentOSInput = {
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'hello world',
  conversationId: 'conversation-1',
  selectedPersonaId: undefined,
  visionInputs: [],
  audioInput: undefined,
  userApiKeys: {},
  userFeedback: undefined,
  options: { customFlags: { source: 'test' } },
};

function buildDeltaChunk(streamId: StreamId, personaId: string, text: string): AgentOSResponse {
  return {
    type: AgentOSResponseChunkType.TEXT_DELTA,
    streamId,
    gmiInstanceId: 'gmi-1',
    personaId,
    isFinal: false,
    timestamp: new Date().toISOString(),
    textDelta: text,
  } as AgentOSResponse;
}

function buildFinalChunk(streamId: StreamId, personaId: string, text: string): AgentOSFinalResponseChunk {
  return {
    type: AgentOSResponseChunkType.FINAL_RESPONSE,
    streamId,
    gmiInstanceId: 'gmi-1',
    personaId,
    isFinal: true,
    timestamp: new Date().toISOString(),
    finalResponseText: text,
  };
}

function createAgentUnderTest(
  guardrailService: IGuardrailService | undefined,
  streamingManager: FakeStreamingManager,
  orchestrator: StubOrchestrator,
  configExtras: Partial<AgentOSConfig> = {},
): AgentOS {
  const logger: ILogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  const agent = new AgentOS(logger) as unknown as {
    initialized: boolean;
    config: AgentOSConfig;
    guardrailService?: IGuardrailService;
    agentOSOrchestrator: StubOrchestrator;
    streamingManager: FakeStreamingManager;
    selfImprovementManager: {
      applySessionOverrides: (input: AgentOSInput) => AgentOSInput;
      buildSkillPromptContext: (sessionId: string) => string | undefined;
      listDisabledSkillIds: (sessionKey: string) => string[];
      buildSessionRuntimeKey: (sessionId: string) => string;
    };
  };

  agent.initialized = true;
  agent.config = {
    defaultPersonaId: 'persona-default',
    ...configExtras,
  } as AgentOSConfig;
  agent.guardrailService = guardrailService;
  agent.agentOSOrchestrator = orchestrator;
  agent.streamingManager = streamingManager;
  agent.selfImprovementManager = {
    applySessionOverrides: (input: AgentOSInput) => input,
    buildSkillPromptContext: () => undefined,
    listDisabledSkillIds: () => [],
    buildSessionRuntimeKey: (sessionId: string) => `session:${sessionId}`,
  };

  return agent as unknown as AgentOS;
}

async function collectResponses(agent: AgentOS, input: AgentOSInput): Promise<AgentOSResponse[]> {
  const outputs: AgentOSResponse[] = [];
  for await (const chunk of agent.processRequest(input)) {
    outputs.push(chunk);
  }
  return outputs;
}

describe('AgentOS.processRequest guardrail integration', () => {
  it('sanitizes input, forwards metadata, and streams sanitized text to the orchestrator', async () => {
    const streamId = 'stream-allow';
    const streamingManager = new FakeStreamingManager();

    const finalChunk = buildFinalChunk(streamId, 'persona-default', 'raw output');
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [finalChunk]);

    const guardrailService = new TestGuardrailService({
      canSanitize: true,
      inputEvaluation: {
        action: GuardrailAction.SANITIZE,
        modifiedText: 'clean input',
        reason: 'sanitize profanity',
        reasonCode: 'CLEANSED',
      },
    });

    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses = await collectResponses(agent, baseInput);

    expect(orchestrator.callCount).toBe(1);
    expect(orchestrator.lastInput?.textInput).toBe('clean input');

    expect(responses).toHaveLength(1);
    const [chunk] = responses;
    expect(chunk.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect((chunk as AgentOSFinalResponseChunk).finalResponseText).toBe('raw output');
    expect(chunk.metadata?.guardrail?.input?.[0]).toMatchObject({
      action: GuardrailAction.SANITIZE,
      reason: 'sanitize profanity',
      reasonCode: 'CLEANSED',
    });
  });

  it('sanitizes final output chunks when guardrail service requests it', async () => {
    const streamId = 'stream-output-sanitize';
    const streamingManager = new FakeStreamingManager();
    const finalChunk = buildFinalChunk(streamId, 'persona-default', 'raw completion text');
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [finalChunk]);

    const guardrailService = new TestGuardrailService({
      canSanitize: true,
      outputEvaluation: {
        action: GuardrailAction.SANITIZE,
        modifiedText: 'policy compliant text',
        reason: 'mask sensitive info',
        reasonCode: 'OUTPUT_SANITISED',
      },
    });

    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses = await collectResponses(agent, baseInput);

    expect(responses).toHaveLength(1);
    const [chunk] = responses;
    expect(chunk.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect((chunk as AgentOSFinalResponseChunk).finalResponseText).toBe('policy compliant text');
    expect(chunk.metadata?.guardrail?.output?.[0]).toMatchObject({
      action: GuardrailAction.SANITIZE,
      reason: 'mask sensitive info',
      reasonCode: 'OUTPUT_SANITISED',
    });
  });

  it('short-circuits orchestration when guardrails block the input', async () => {
    const streamId = 'stream-block';
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, []);

    const guardrailService = new TestGuardrailService({
      inputEvaluation: {
        action: GuardrailAction.BLOCK,
        reason: 'disallowed content',
        reasonCode: 'BLOCKED_CONTENT',
      },
    });

    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses = await collectResponses(agent, baseInput);

    expect(orchestrator.callCount).toBe(0);
    expect(responses).toHaveLength(1);
    const [chunk] = responses;
    expect(chunk.type).toBe(AgentOSResponseChunkType.ERROR);
    const errorChunk = chunk as AgentOSErrorChunk;
    expect(errorChunk.code).toBe('BLOCKED_CONTENT');
    expect(errorChunk.details).toMatchObject({
      action: GuardrailAction.BLOCK,
    });
  });

  it('converts final output into an error chunk when guardrails block the response', async () => {
    const streamId = 'stream-output-block';
    const streamingManager = new FakeStreamingManager();
    const finalChunk = buildFinalChunk(streamId, 'persona-default', 'unsafe answer');
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [finalChunk]);

    const guardrailService = new TestGuardrailService({
      outputEvaluation: {
        action: GuardrailAction.BLOCK,
        reason: 'response policy violation',
        reasonCode: 'OUTPUT_BLOCKED',
      },
    });

    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses = await collectResponses(agent, baseInput);

    expect(responses).toHaveLength(1);
    const [chunk] = responses;
    expect(chunk.type).toBe(AgentOSResponseChunkType.ERROR);
    const errorChunk = chunk as AgentOSErrorChunk;
    expect(errorChunk.code).toBe('OUTPUT_BLOCKED');
    expect(errorChunk.details).toMatchObject({
      action: GuardrailAction.BLOCK,
    });
  });

  it('holds the deltas until the final verdict and sends them, in order, when the reply is allowed', async () => {
    const streamId = 'stream-hold-allow';
    const streamingManager = new FakeStreamingManager();
    const chunks = [buildDeltaChunk(streamId, 'persona-default', 'safe '), buildDeltaChunk(streamId, 'persona-default', 'answer'), buildFinalChunk(streamId, 'persona-default', 'safe answer')];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const seen: string[] = [];
    const guardrailService = new TestGuardrailService({ outputEvaluation: { action: GuardrailAction.ALLOW, reasonCode: 'OK' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses: AgentOSResponse[] = [];
    for await (const chunk of agent.processRequest(baseInput)) {
      responses.push(chunk);
      seen.push(chunk.type);
    }
    expect(seen).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.FINAL_RESPONSE]);
    // the guard saw the final chunk once, and never a delta
    expect(guardrailService.receivedOutputPayloads.map((p) => p.chunk.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
  });

  it('in hold mode a blocked reply with a replacement reaches the caller as one final response, with no delta before it', async () => {
    const streamId = 'stream-hold-block';
    const streamingManager = new FakeStreamingManager();
    const chunks = [buildDeltaChunk(streamId, 'persona-default', 'you will '), buildDeltaChunk(streamId, 'persona-default', 'pass'), buildFinalChunk(streamId, 'persona-default', 'you will pass')];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const guardrailService = new TestGuardrailService({
      outputEvaluation: { action: GuardrailAction.BLOCK, reason: 'an outcome promise', reasonCode: 'outcome_promise', replacementText: 'Your guide does not promise an outcome or a date.' },
    });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses = await collectResponses(agent, baseInput);
    expect(responses).toHaveLength(1);
    const [chunk] = responses;
    expect(chunk.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    const final = chunk as AgentOSFinalResponseChunk;
    expect(final.finalResponseText).toBe('Your guide does not promise an outcome or a date.');
    expect(final.finalResponseTextPlain).toBe('Your guide does not promise an outcome or a date.');
    expect(final.gmiInstanceId).toBe('guardrail');
    expect(chunk.metadata?.guardrail?.output?.[0]).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'outcome_promise' });
  });

  it('a sanitized final response carries the rewritten text in both text fields, and the held deltas are dropped', async () => {
    const streamId = 'stream-hold-sanitize';
    const streamingManager = new FakeStreamingManager();
    const chunks = [buildDeltaChunk(streamId, 'persona-default', 'raw'), { ...buildFinalChunk(streamId, 'persona-default', 'raw completion text'), finalResponseTextPlain: 'raw completion text' }];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const guardrailService = new TestGuardrailService({ canSanitize: true, outputEvaluation: { action: GuardrailAction.SANITIZE, modifiedText: 'policy compliant text', reasonCode: 'OUTPUT_SANITISED' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses = await collectResponses(agent, baseInput);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
    const final = responses[0] as AgentOSFinalResponseChunk;
    expect(final.finalResponseText).toBe('policy compliant text');
    expect(final.finalResponseTextPlain).toBe('policy compliant text');
  });

  it('a required guard that throws, and one that times out, block the reply, and the verdict names the guard', async () => {
    const cases: Array<{ name: string; service: IGuardrailService }> = [
      { name: 'throws', service: { id: 'safety-gate', config: {}, evaluateOutput: async () => { throw new Error('judge down'); } } },
      { name: 'hangs', service: { id: 'safety-gate', config: {}, evaluateOutput: () => new Promise(() => undefined) } },
      { name: 'answers nonsense', service: { id: 'safety-gate', config: {}, evaluateOutput: async () => ({ action: 'maybe' } as unknown as GuardrailEvaluationResult) } },
    ];
    for (const { name, service } of cases) {
      const streamId = `stream-required-${name.replace(/\s+/g, '-')}`;
      const streamingManager = new FakeStreamingManager();
      const orchestrator = new StubOrchestrator(streamingManager, streamId, [buildFinalChunk(streamId, 'persona-default', 'an answer')]);
      const agent = createAgentUnderTest(service, streamingManager, orchestrator, { requiredGuardrails: [{ id: 'safety-gate', stages: ['output'], timeoutMs: 50 }] });
      const responses = await collectResponses(agent, baseInput);
      expect(responses, name).toHaveLength(1);
      expect(responses[0].type, name).toBe(AgentOSResponseChunkType.ERROR);
      const code = (responses[0] as AgentOSErrorChunk).code;
      expect(['GUARDRAIL_ERROR', 'GUARDRAIL_MALFORMED'], name).toContain(code);
      expect((responses[0] as AgentOSErrorChunk).details?.metadata, name).toMatchObject({ guardrailId: 'safety-gate' });
    }
  });

  it('refuses a request while a required guard is missing, and runs it once the guard is back', async () => {
    const streamId = 'stream-required-missing';
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [buildFinalChunk(streamId, 'persona-default', 'an answer')]);
    const agent = createAgentUnderTest(undefined, streamingManager, orchestrator, { requiredGuardrails: [{ id: 'safety-gate', stages: ['output'], timeoutMs: 1_000 }] });
    const refused = await collectResponses(agent, baseInput);
    expect(orchestrator.callCount).toBe(0);
    expect(refused).toHaveLength(1);
    expect((refused[0] as AgentOSErrorChunk).code).toBe('SYS_GUARDRAIL_REQUIRED_MISSING');
    expect((refused[0] as AgentOSErrorChunk).details).toMatchObject({ missing: ['safety-gate'] });
    (agent as unknown as { guardrailService?: IGuardrailService }).guardrailService = { id: 'safety-gate', evaluateOutput: async () => null };
    const served = await collectResponses(agent, baseInput);
    expect(orchestrator.callCount).toBe(1);
    expect(served.map((r) => r.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
  });

  it('runs the output guards on the continuation after an external tool result', async () => {
    const streamId = 'stream-continuation';
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, []);
    streamingManager.prepareStream(streamId, [buildFinalChunk(streamId, 'persona-default', 'you will pass')]);
    const guardrailService = new TestGuardrailService({ outputEvaluation: { action: GuardrailAction.BLOCK, reasonCode: 'outcome_promise', replacementText: 'No promise is made.' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses: AgentOSResponse[] = [];
    for await (const chunk of agent.handleToolResults(streamId, [{ toolCallId: 'call-1', toolName: 'read_path', toolOutput: { ok: true }, isSuccess: true }])) {
      responses.push(chunk);
    }
    expect(responses).toHaveLength(1);
    expect(responses[0].type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect((responses[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('No promise is made.');
    expect(guardrailService.receivedOutputPayloads).toHaveLength(1);
    expect(guardrailService.receivedOutputPayloads[0].context).toMatchObject({ userId: 'user-1', sessionId: 'session-1', personaId: 'persona-default', conversationId: 'conversation-1' });
  });

  it('rewrites the stored reply when a guard replaced it, so the history holds what the person saw', async () => {
    const streamId = 'stream-persist';
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [buildFinalChunk(streamId, 'persona-default', 'you will pass')]);
    const context = new ConversationContext('conversation-1');
    context.addMessage({ role: MessageRole.USER, content: 'Will I pass?' });
    const stored = context.addMessage({ role: MessageRole.ASSISTANT, content: 'you will pass', metadata: { source: 'agentos_output' } });
    const saveConversation = vi.fn(async () => undefined);
    const getConversation = vi.fn(async (id: string) => (id === 'conversation-1' ? context : null));
    const guardrailService = new TestGuardrailService({ outputEvaluation: { action: GuardrailAction.BLOCK, reasonCode: 'outcome_promise', replacementText: 'No promise is made.' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { orchestratorConfig: { enableConversationalPersistence: true } } as Partial<AgentOSConfig>);
    (agent as unknown as { conversationManager: unknown }).conversationManager = { getConversation, saveConversation };
    const responses = await collectResponses(agent, baseInput);
    expect((responses[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('No promise is made.');
    expect(getConversation).toHaveBeenCalledWith('conversation-1');
    expect(context.getMessageById(stored.id)?.content).toBe('No promise is made.');
    expect(context.getMessageById(stored.id)?.metadata?.modificationInfo).toMatchObject({ strategy: 'filtered', reason: 'guardrail:outcome_promise' });
    expect(saveConversation).toHaveBeenCalledWith(context);
  });
});

