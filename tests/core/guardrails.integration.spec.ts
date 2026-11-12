import { describe, it, expect, vi } from 'vitest';
import { AgentOS } from '../../src/api/AgentOS';
import type { AgentOSConfig } from '../../src/api/AgentOS';
import type { AgentOSInput } from '../../src/api/types/AgentOSInput';
import {
  AgentOSResponseChunkType,
  isActionableToolCallRequestChunk,
  type AgentOSResponse,
  type AgentOSFinalResponseChunk,
  type AgentOSErrorChunk,
  type AgentOSToolCallRequestChunk,
} from '../../src/api/types/AgentOSResponse';
import { wrapOutputGuardrails } from '../../src/safety/guardrails/guardrailDispatcher';
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
import { ImageGuardrail, type ImageCheck, type ImageUnderReview } from '../../src/safety/guardrails/builtin/ImageGuardrail';

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

  it('a held input ends the turn as a block does and carries the hold, with no text delivered', async () => {
    const streamId = 'stream-hold';
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [buildFinalChunk(streamId, 'persona-default', 'never sent')]);
    const guardrailService = new TestGuardrailService({
      inputEvaluation: { action: GuardrailAction.BLOCK, reasonCode: 'NEEDS_REVIEW', hold: { reviewCode: 'REVIEW' } },
    });

    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator);
    const responses = await collectResponses(agent, baseInput);

    expect(orchestrator.callCount).toBe(0);
    expect(responses).toHaveLength(1);
    const errorChunk = responses[0] as AgentOSErrorChunk;
    expect(errorChunk.type).toBe(AgentOSResponseChunkType.ERROR);
    expect(errorChunk.details).toMatchObject({ action: GuardrailAction.BLOCK, hold: { reviewCode: 'REVIEW' } });
    expect(JSON.stringify(responses)).not.toContain('never sent');
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

  it('a sanitized final response rewrites the reply inside the serialized conversation it carries', async () => {
    const streamId = 'stream-hold-sanitize-context';
    const streamingManager = new FakeStreamingManager();
    const context = { sessionId: 'session-1', messages: [{ role: 'user', content: 'Will I pass?' }, { role: 'assistant', content: 'you will pass' }], config: {} };
    const chunks = [{ ...buildFinalChunk(streamId, 'persona-default', 'you will pass'), updatedConversationContext: context } as unknown as AgentOSResponse];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const guardrailService = new TestGuardrailService({ canSanitize: true, outputEvaluation: { action: GuardrailAction.SANITIZE, modifiedText: 'No promise is made.', reasonCode: 'outcome_promise' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses = await collectResponses(agent, baseInput);
    const final = responses[0] as AgentOSFinalResponseChunk;
    expect(final.finalResponseText).toBe('No promise is made.');
    const carried = final.updatedConversationContext as unknown as { messages: Array<{ role: string; content: string }> };
    expect(carried.messages).toEqual([{ role: 'user', content: 'Will I pass?' }, { role: 'assistant', content: 'No promise is made.' }]);
    // the chunk the orchestrator sent is not changed under it
    expect(context.messages[1].content).toBe('you will pass');
  });

  it('in hold mode the text before an actionable tool call is judged as a reply: a block replaces it and the tool call stays in', async () => {
    const streamId = 'stream-hold-tool-block';
    const streamingManager = new FakeStreamingManager();
    const toolCall = { type: AgentOSResponseChunkType.TOOL_CALL_REQUEST, streamId, gmiInstanceId: 'gmi-1', personaId: 'persona-default', isFinal: false, timestamp: new Date().toISOString(), toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'book_it', arguments: '{}' } }], executionMode: 'external', requiresExternalToolResult: true } as unknown as AgentOSResponse;
    const chunks = [buildDeltaChunk(streamId, 'persona-default', "I'll book "), buildDeltaChunk(streamId, 'persona-default', 'it for you.'), toolCall];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const guardrailService = new TestGuardrailService({ outputEvaluation: { action: GuardrailAction.BLOCK, reasonCode: 'outward_act', replacementText: 'Your guide books nothing in your name.' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses = await collectResponses(agent, baseInput);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
    expect((responses[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('Your guide books nothing in your name.');
    // the guard read the held text as one reply, before the tool call
    expect(guardrailService.receivedOutputPayloads.map((p) => [p.chunk.type, (p.chunk as AgentOSFinalResponseChunk).finalResponseText])).toEqual([[AgentOSResponseChunkType.FINAL_RESPONSE, "I'll book it for you."]]);
  });

  it('in hold mode an allowed text before an actionable tool call streams in order, then the tool call', async () => {
    const streamId = 'stream-hold-tool-allow';
    const streamingManager = new FakeStreamingManager();
    const toolCall = { type: AgentOSResponseChunkType.TOOL_CALL_REQUEST, streamId, gmiInstanceId: 'gmi-1', personaId: 'persona-default', isFinal: false, timestamp: new Date().toISOString(), toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read_path', arguments: '{}' } }], executionMode: 'external', requiresExternalToolResult: true } as unknown as AgentOSResponse;
    const chunks = [buildDeltaChunk(streamId, 'persona-default', 'Let me '), buildDeltaChunk(streamId, 'persona-default', 'read your path.'), toolCall];
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const guardrailService = new TestGuardrailService({ outputEvaluation: { action: GuardrailAction.ALLOW, reasonCode: 'OK' } });
    const agent = createAgentUnderTest(guardrailService, streamingManager, orchestrator, { guardrailOutputMode: 'hold' });
    const responses = await collectResponses(agent, baseInput);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
    expect(responses.slice(0, 2).map((r) => (r as { textDelta: string }).textDelta).join('')).toBe('Let me read your path.');
    expect(guardrailService.receivedOutputPayloads.map((p) => p.chunk.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
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
    context.addMessage({ role: MessageRole.USER, content: 'How is the week?' });
    const earlier = context.addMessage({ role: MessageRole.ASSISTANT, content: 'Two drills and a rest day.', metadata: { source: 'agentos_output' } });
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
    expect(context.getMessageById(earlier.id)?.content).toBe('Two drills and a rest day.');
    expect(saveConversation).toHaveBeenCalledWith(context);
  });
});


describe('AgentOS.processRequest output guards and tool calls', () => {
  const SHELL_CALL = { id: 'call-1', name: 'shell_execute', arguments: { command: 'rm -rf /' } };

  function buildToolCallChunk(streamId: StreamId, executionMode: 'external' | 'internal' = 'external'): AgentOSResponse {
    return {
      type: AgentOSResponseChunkType.TOOL_CALL_REQUEST,
      streamId,
      gmiInstanceId: 'gmi-1',
      personaId: 'persona-default',
      isFinal: false,
      timestamp: new Date().toISOString(),
      toolCalls: [SHELL_CALL],
      rationale: 'Agent requires tool execution.',
      executionMode,
      requiresExternalToolResult: executionMode === 'external',
    } as AgentOSResponse;
  }

  /** A guard that evaluates tool calls: it records each chunk it is given and answers a tool call with `verdict`. */
  function toolCallGuard(
    verdict: GuardrailEvaluationResult | null,
    config: GuardrailConfig = {},
  ): IGuardrailService & { seen: AgentOSResponse[] } {
    const seen: AgentOSResponse[] = [];
    return {
      id: 'tool-call-guard',
      config: { ...config, evaluateToolCalls: true } as GuardrailConfig,
      seen,
      async evaluateOutput({ chunk }: GuardrailOutputPayload) {
        seen.push(chunk);
        return chunk.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST ? verdict : null;
      },
    };
  }

  /** A guard written for text: it blocks any chunk that is not text, so a tool call that reached it would be refused. */
  function textOnlyGuard(): IGuardrailService & { seen: AgentOSResponse[] } {
    const seen: AgentOSResponse[] = [];
    return {
      id: 'text-guard',
      config: { evaluateStreamingChunks: true },
      seen,
      async evaluateOutput({ chunk }: GuardrailOutputPayload) {
        seen.push(chunk);
        const isText = chunk.type === AgentOSResponseChunkType.TEXT_DELTA || chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE;
        return isText ? null : { action: GuardrailAction.BLOCK, reasonCode: 'NOT_TEXT' };
      },
    };
  }

  /** Reads the stream as a host does: each actionable tool call it receives, it executes. */
  async function runAsHost(agent: AgentOS, execute: (call: unknown) => void): Promise<AgentOSResponse[]> {
    const responses: AgentOSResponse[] = [];
    for await (const chunk of agent.processRequest(baseInput)) {
      responses.push(chunk);
      if (isActionableToolCallRequestChunk(chunk)) {
        for (const call of chunk.toolCalls) execute(call);
      }
    }
    return responses;
  }

  function turnThatCallsATool(streamId: StreamId, guard: IGuardrailService): AgentOS {
    const streamingManager = new FakeStreamingManager();
    const chunks = [buildDeltaChunk(streamId, 'persona-default', 'Clearing the disk now.'), buildToolCallChunk(streamId)];
    return createAgentUnderTest(guard, streamingManager, new StubOrchestrator(streamingManager, streamId, chunks));
  }

  it('a guard that evaluates tool calls receives the tool-call chunk as the stream carries it, and a call it allows reaches the host', async () => {
    const guard = toolCallGuard({ action: GuardrailAction.FLAG, reason: 'a shell command', reasonCode: 'SHELL' });
    const execute = vi.fn();
    const responses = await runAsHost(turnThatCallsATool('stream-tool-flag', guard), execute);
    expect(guard.seen.map((c) => c.type)).toEqual([AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
    expect((guard.seen[0] as AgentOSToolCallRequestChunk).toolCalls).toEqual([SHELL_CALL]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith(SHELL_CALL);
    const sent = responses.find((r) => r.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST);
    expect(sent?.metadata?.guardrail?.output?.[0]).toMatchObject({
      action: GuardrailAction.FLAG,
      reasonCode: 'SHELL',
      metadata: { guardrailId: 'tool-call-guard' },
    });
  });

  it('a block stops the call: the host never receives it, and the stream ends with the guard\'s verdict', async () => {
    const guard = toolCallGuard({ action: GuardrailAction.BLOCK, reason: 'a destructive shell command', reasonCode: 'CODE_SAFETY_CRITICAL' });
    const execute = vi.fn();
    const responses = await runAsHost(turnThatCallsATool('stream-tool-block', guard), execute);
    expect(execute).not.toHaveBeenCalled();
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.ERROR]);
    const error = responses[1] as AgentOSErrorChunk;
    expect(error.code).toBe('CODE_SAFETY_CRITICAL');
    expect(error.message).toBe('a destructive shell command');
    expect(error.details).toMatchObject({ action: GuardrailAction.BLOCK, metadata: { guardrailId: 'tool-call-guard' } });
  });

  it('a block with a replacement reply ends the stream with that reply, as a block on text does', async () => {
    const guard = toolCallGuard({ action: GuardrailAction.BLOCK, reasonCode: 'OUTWARD_ACT', replacementText: 'Your guide runs no commands on your machine.' });
    const execute = vi.fn();
    const responses = await runAsHost(turnThatCallsATool('stream-tool-replace', guard), execute);
    expect(execute).not.toHaveBeenCalled();
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.FINAL_RESPONSE]);
    const final = responses[1] as AgentOSFinalResponseChunk;
    expect(final.finalResponseText).toBe('Your guide runs no commands on your machine.');
    expect(final.metadata?.guardrail?.output?.[0]).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'OUTWARD_ACT' });
  });

  it('a sanitize cannot rewrite a tool call: it is applied as a block that keeps the guard\'s reason', async () => {
    const guard = toolCallGuard(
      { action: GuardrailAction.SANITIZE, modifiedText: '{}', reason: 'the command names the root folder', reasonCode: 'ROOT_PATH' },
      { canSanitize: true },
    );
    const execute = vi.fn();
    const responses = await runAsHost(turnThatCallsATool('stream-tool-sanitize', guard), execute);
    expect(execute).not.toHaveBeenCalled();
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.ERROR]);
    const error = responses[1] as AgentOSErrorChunk;
    expect(error.code).toBe('ROOT_PATH');
    expect(error.message).toContain('the command names the root folder');
    expect(error.details).toMatchObject({ action: GuardrailAction.BLOCK });
  });

  it('a call the runtime runs itself reaches the guard too, and a block ends the stream with the verdict', async () => {
    const streamId = 'stream-tool-internal';
    const streamingManager = new FakeStreamingManager();
    const chunks = [buildToolCallChunk(streamId, 'internal'), buildFinalChunk(streamId, 'persona-default', 'The disk is clear.')];
    const guard = toolCallGuard({ action: GuardrailAction.BLOCK, reasonCode: 'CODE_SAFETY_CRITICAL' });
    const responses = await collectResponses(createAgentUnderTest(guard, streamingManager, new StubOrchestrator(streamingManager, streamId, chunks)), baseInput);
    expect(guard.seen.map((c) => c.type)).toEqual([AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.ERROR]);
    expect((responses[0] as AgentOSErrorChunk).code).toBe('CODE_SAFETY_CRITICAL');
  });

  it('a guard that does not evaluate tool calls never receives one, and the call reaches the host as before', async () => {
    const guard = textOnlyGuard();
    const execute = vi.fn();
    const responses = await runAsHost(turnThatCallsATool('stream-tool-text-guard', guard), execute);
    expect(guard.seen.map((c) => c.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
  });

  it('beside a guard that evaluates tool calls, a text-only guard still sees only text', async () => {
    const streamId = 'stream-tool-two-guards';
    async function* turn(): AsyncGenerator<AgentOSResponse, void, undefined> {
      yield buildDeltaChunk(streamId, 'persona-default', 'Clearing the disk now.');
      yield buildToolCallChunk(streamId);
    }
    const text = textOnlyGuard();
    const tools = toolCallGuard(null);
    const out: AgentOSResponse[] = [];
    const context = { userId: 'user-1', sessionId: 'session-1' };
    for await (const chunk of wrapOutputGuardrails([text, tools], context, turn(), { streamId })) out.push(chunk);
    expect(text.seen.map((c) => c.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA]);
    expect(tools.seen.map((c) => c.type)).toEqual([AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
    expect(out.map((r) => r.type)).toEqual([AgentOSResponseChunkType.TEXT_DELTA, AgentOSResponseChunkType.TOOL_CALL_REQUEST]);
  });
});

describe('AgentOS.processRequest with holds from guards a host registered', () => {
  const HOLD: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: 'NEEDS_REVIEW', hold: { reviewCode: 'REVIEW' } };
  const REFUSE: GuardrailEvaluationResult = { action: GuardrailAction.BLOCK, reasonCode: 'RULE_1' };

  /** A guard that answers `verdict` on input, on a final reply and on a tool call, as `stages` lists. */
  function guard(id: string, verdict: GuardrailEvaluationResult, stages: Array<'input' | 'output' | 'tool_call'>): IGuardrailService {
    return {
      id,
      config: stages.includes('tool_call') ? { evaluateToolCalls: true } : {},
      evaluateInput: async () => (stages.includes('input') ? verdict : null),
      evaluateOutput: async ({ chunk }: GuardrailOutputPayload) => {
        if (chunk.type === AgentOSResponseChunkType.TOOL_CALL_REQUEST) return stages.includes('tool_call') ? verdict : null;
        return chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE && stages.includes('output') ? verdict : null;
      },
    };
  }

  /** The agent with `guards` registered in this order, as extensions a host loaded, and a turn that sends `chunks`. */
  function agentWith(streamId: StreamId, guards: IGuardrailService[], chunks: AgentOSResponse[]): { agent: AgentOS; orchestrator: StubOrchestrator } {
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, chunks);
    const agent = createAgentUnderTest(undefined, streamingManager, orchestrator);
    const descriptors = guards.map((payload) => ({ id: payload.id, payload }));
    (agent as unknown as { extensionManager: unknown }).extensionManager = { getRegistry: () => ({ listActive: () => descriptors }) };
    return { agent, orchestrator };
  }

  const toolCall = (streamId: StreamId): AgentOSResponse => ({
    type: AgentOSResponseChunkType.TOOL_CALL_REQUEST, streamId, gmiInstanceId: 'gmi-1', personaId: 'persona-default', isFinal: false,
    timestamp: new Date().toISOString(), toolCalls: [{ id: 'call-1', name: 'mute', arguments: { userId: 'u2' } }],
    executionMode: 'external', requiresExternalToolResult: true,
  } as AgentOSResponse);

  it('on input, a refusal from a guard registered after a hold outranks it, and the turn never runs', async () => {
    const { agent, orchestrator } = agentWith('stream-hold-then-refuse', [guard('holder-in', HOLD, ['input']), guard('refuser-in', REFUSE, ['input'])], [buildFinalChunk('stream-hold-then-refuse', 'persona-default', 'never sent')]);
    const responses = await collectResponses(agent, baseInput);
    expect(orchestrator.callCount).toBe(0);
    expect(responses).toHaveLength(1);
    const error = responses[0] as AgentOSErrorChunk;
    expect(error.type).toBe(AgentOSResponseChunkType.ERROR);
    expect(error.code).toBe('RULE_1');
    expect((error.details as { hold?: unknown }).hold).toBeUndefined();
    expect(JSON.stringify(responses)).not.toContain('never sent');
  });

  it('on a final reply, a hold ends the turn with the hold in the error chunk and the reply never delivered', async () => {
    const streamId = 'stream-output-hold';
    const { agent } = agentWith(streamId, [guard('holder-out', HOLD, ['output']), guard('passer-out', { action: GuardrailAction.ALLOW }, ['output'])], [buildDeltaChunk(streamId, 'persona-default', 'the '), buildFinalChunk(streamId, 'persona-default', 'the held reply')]);
    const responses = await collectResponses(agent, baseInput);
    const last = responses.at(-1) as AgentOSErrorChunk;
    expect(last.type).toBe(AgentOSResponseChunkType.ERROR);
    expect(last.code).toBe('NEEDS_REVIEW');
    expect(last.details).toMatchObject({ action: GuardrailAction.BLOCK, hold: { reviewCode: 'REVIEW' } });
    expect(responses.some((r) => r.type === AgentOSResponseChunkType.FINAL_RESPONSE)).toBe(false);
    expect(JSON.stringify(responses)).not.toContain('the held reply');
  });

  it('on a final reply, a refusal registered after a hold outranks it', async () => {
    const streamId = 'stream-output-hold-refuse';
    const { agent } = agentWith(streamId, [guard('holder-out-2', HOLD, ['output']), guard('refuser-out', REFUSE, ['output'])], [buildFinalChunk(streamId, 'persona-default', 'the held reply')]);
    const responses = await collectResponses(agent, baseInput);
    expect(responses).toHaveLength(1);
    const error = responses[0] as AgentOSErrorChunk;
    expect(error.code).toBe('RULE_1');
    expect((error.details as { hold?: unknown }).hold).toBeUndefined();
  });

  it('a hold with a fixed reply delivers that reply, and its record carries the hold', async () => {
    const streamId = 'stream-output-hold-replacement';
    const { agent } = agentWith(streamId, [guard('holder-out-3', { ...HOLD, replacementText: 'Your message is waiting for review.' }, ['output'])], [buildFinalChunk(streamId, 'persona-default', 'the held reply')]);
    const responses = await collectResponses(agent, baseInput);
    expect(responses).toHaveLength(1);
    const final = responses[0] as AgentOSFinalResponseChunk;
    expect(final.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
    expect(final.finalResponseText).toBe('Your message is waiting for review.');
    expect(final.metadata?.guardrail?.output?.[0]).toMatchObject({ action: GuardrailAction.BLOCK, hold: { reviewCode: 'REVIEW' } });
    expect(JSON.stringify(responses)).not.toContain('the held reply');
  });

  it('a held tool call never reaches the host, and a refusal registered after the hold outranks it', async () => {
    const execute = vi.fn();
    for (const [name, guards, code, hold] of [
      ['held', [guard('holder-tool', HOLD, ['tool_call'])], 'NEEDS_REVIEW', { reviewCode: 'REVIEW' }],
      ['refused', [guard('holder-tool-2', HOLD, ['tool_call']), guard('refuser-tool', REFUSE, ['tool_call'])], 'RULE_1', undefined],
    ] as const) {
      const streamId = `stream-tool-${name}`;
      const { agent } = agentWith(streamId, [...guards], [toolCall(streamId)]);
      const responses: AgentOSResponse[] = [];
      for await (const chunk of agent.processRequest(baseInput)) {
        responses.push(chunk);
        if (isActionableToolCallRequestChunk(chunk)) for (const call of chunk.toolCalls) execute(call);
      }
      expect(responses.map((r) => r.type), name).toEqual([AgentOSResponseChunkType.ERROR]);
      const error = responses[0] as AgentOSErrorChunk;
      expect(error.code, name).toBe(code);
      expect((error.details as { hold?: unknown }).hold, name).toEqual(hold);
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it('a hold on an action other than BLOCK is ignored: the turn runs and the reply is delivered', async () => {
    const streamId = 'stream-flag-hold';
    const flagged: GuardrailEvaluationResult = { action: GuardrailAction.FLAG, reasonCode: 'NOTE', hold: { reviewCode: 'REVIEW' } };
    const { agent, orchestrator } = agentWith(streamId, [guard('flagger-in-out', flagged, ['input', 'output'])], [buildFinalChunk(streamId, 'persona-default', 'a delivered reply')]);
    const responses = await collectResponses(agent, baseInput);
    expect(orchestrator.callCount).toBe(1);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
    expect((responses[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('a delivered reply');
  });
});

describe('AgentOS.processRequest with the image guard a host registered', () => {
  /** A three-byte image whose bytes are all `byte`. */
  const image = (byte: number) => ({ type: 'base64' as const, data: Buffer.from([byte, byte, byte]).toString('base64'), mimeType: 'image/png' });

  /** The agent with `guard` registered as an extension a host loaded, and a turn that would reply `a reply`. */
  function agentWithImageGuard(streamId: StreamId, guard: IGuardrailService): { agent: AgentOS; orchestrator: StubOrchestrator } {
    const streamingManager = new FakeStreamingManager();
    const orchestrator = new StubOrchestrator(streamingManager, streamId, [buildFinalChunk(streamId, 'persona-default', 'a reply')]);
    const agent = createAgentUnderTest(undefined, streamingManager, orchestrator);
    (agent as unknown as { extensionManager: unknown }).extensionManager = { getRegistry: () => ({ listActive: () => [{ id: guard.id, payload: guard }] }) };
    return { agent, orchestrator };
  }

  it('a quarantine on the second upload ends the turn before any model check or the agent sees the input', async () => {
    const hash = vi.fn<ImageCheck['check']>(async (img) => (img.index === 1 ? { verdict: 'block', reasonCode: 'KNOWN_MATERIAL', quarantine: true } : { verdict: 'pass' }));
    const model = vi.fn<ImageCheck['check']>(async () => ({ verdict: 'pass' }));
    const guard = ImageGuardrail.create({ id: 'images', checks: [{ id: 'hash', kind: 'match', check: hash, reasonCodes: ['KNOWN_MATERIAL'] }, { id: 'model', kind: 'classify', check: model }], requireMatch: true, sequential: true });
    const { agent, orchestrator } = agentWithImageGuard('stream-image-quarantine', guard);
    const responses = await collectResponses(agent, { ...baseInput, visionInputs: [image(1), image(2)] });
    expect(orchestrator.callCount).toBe(0);
    expect(responses).toHaveLength(1);
    const error = responses[0] as AgentOSErrorChunk;
    expect(error.type).toBe(AgentOSResponseChunkType.ERROR);
    expect(error.code).toBe('KNOWN_MATERIAL');
    expect(hash).toHaveBeenCalledTimes(2);
    expect(model).not.toHaveBeenCalled();
    expect(JSON.stringify(responses)).not.toContain('a reply');
  });

  it('an image_url upload with no loadImage ends the turn as unavailable, and the URL reaches no check and no chunk', async () => {
    const model = vi.fn<ImageCheck['check']>(async () => ({ verdict: 'pass' }));
    const guard = ImageGuardrail.create({ id: 'images', checks: [{ id: 'model', kind: 'classify', check: model }] });
    const { agent, orchestrator } = agentWithImageGuard('stream-image-url', guard);
    const responses = await collectResponses(agent, { ...baseInput, visionInputs: [{ type: 'image_url', data: 'https://images.example/upload.jpg' }] });
    expect(orchestrator.callCount).toBe(0);
    expect(responses).toHaveLength(1);
    expect((responses[0] as AgentOSErrorChunk).code).toBe('IMAGE_CHECK_UNAVAILABLE');
    expect(model).not.toHaveBeenCalled();
    expect(JSON.stringify(responses)).not.toContain('images.example');
  });

  it('an upload every check passes reaches the agent unchanged, and the model check judged the captured bytes', async () => {
    const seen: ImageUnderReview[] = [];
    const model = vi.fn<ImageCheck['check']>(async (img) => { seen.push(img); return { verdict: 'pass' }; });
    const guard = ImageGuardrail.create({ id: 'images', checks: [{ id: 'hash', kind: 'match', check: async () => ({ verdict: 'pass' }) }, { id: 'model', kind: 'classify', check: model }], requireMatch: true });
    const { agent, orchestrator } = agentWithImageGuard('stream-image-allowed', guard);
    const upload = image(5);
    const responses = await collectResponses(agent, { ...baseInput, visionInputs: [upload] });
    expect(orchestrator.callCount).toBe(1);
    expect(orchestrator.lastInput?.visionInputs).toEqual([upload]);
    expect(responses.map((r) => r.type)).toEqual([AgentOSResponseChunkType.FINAL_RESPONSE]);
    expect(seen.map((img) => [img.index, img.mimeType, [...img.bytes]])).toEqual([[0, 'image/png', [5, 5, 5]]]);
  });
});
