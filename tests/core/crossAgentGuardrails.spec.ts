import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { resetLoggerFactory, setLogger } from '../../src/core/logging/loggerFactory.js';
import {
  GuardrailAction,
  type GuardrailContext,
  type GuardrailEvaluationResult,
} from '../../src/safety/guardrails/IGuardrailService.js';
import {
  type ICrossAgentGuardrailService,
  type CrossAgentOutputPayload,
  isCrossAgentGuardrail,
  shouldObserveAgent,
} from '../../src/safety/guardrails/ICrossAgentGuardrailService';
import {
  evaluateCrossAgentGuardrails,
  wrapWithCrossAgentGuardrails,
  filterCrossAgentGuardrails,
  type CrossAgentGuardrailContext,
} from '../../src/safety/guardrails/crossAgentGuardrailDispatcher';
import {
  AgentOSResponseChunkType,
  type AgentOSTextDeltaChunk,
  type AgentOSFinalResponseChunk,
  type AgentOSResponse,
} from '../../src/api/types/AgentOSResponse';

// Test fixtures
const createTextDeltaChunk = (text: string, isFinal = false): AgentOSTextDeltaChunk => ({
  type: AgentOSResponseChunkType.TEXT_DELTA,
  streamId: 'test-stream',
  gmiInstanceId: 'test-gmi',
  personaId: 'test-persona',
  isFinal,
  timestamp: new Date().toISOString(),
  textDelta: text,
});

const createFinalResponseChunk = (text: string): AgentOSFinalResponseChunk => ({
  type: AgentOSResponseChunkType.FINAL_RESPONSE,
  streamId: 'test-stream',
  gmiInstanceId: 'test-gmi',
  personaId: 'test-persona',
  isFinal: true,
  timestamp: new Date().toISOString(),
  finalResponseText: text,
});

const baseContext: GuardrailContext = {
  userId: 'user-1',
  sessionId: 'session-1',
};

const crossAgentContext: CrossAgentGuardrailContext = {
  sourceAgentId: 'worker-1',
  observerAgentId: 'supervisor',
  agencyId: 'agency-1',
};

// Test guardrail implementations
class AllowingCrossAgentGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = ['worker-1', 'worker-2'];
  canInterruptOthers = true;

  async evaluateCrossAgentOutput(): Promise<GuardrailEvaluationResult | null> {
    return null;
  }
}

class BlockingCrossAgentGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = ['worker-1'];
  canInterruptOthers = true;
  config = { evaluateStreamingChunks: true };

  async evaluateCrossAgentOutput({
    chunk,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (
      chunk.type === AgentOSResponseChunkType.TEXT_DELTA &&
      (chunk as AgentOSTextDeltaChunk).textDelta?.includes('BLOCKED')
    ) {
      return {
        action: GuardrailAction.BLOCK,
        reason: 'Content blocked by supervisor',
        reasonCode: 'SUPERVISOR_BLOCK',
      };
    }
    return null;
  }
}

class SanitizingCrossAgentGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = [];
  canInterruptOthers = true;
  config = { evaluateStreamingChunks: true };

  async evaluateCrossAgentOutput({
    chunk,
  }: CrossAgentOutputPayload): Promise<GuardrailEvaluationResult | null> {
    if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
      const textDelta = (chunk as AgentOSTextDeltaChunk).textDelta;
      if (textDelta?.includes('SECRET')) {
        return {
          action: GuardrailAction.SANITIZE,
          modifiedText: textDelta.replace(/SECRET/g, '[REDACTED]'),
          reasonCode: 'SANITIZED',
        };
      }
    }
    return null;
  }
}

class NonInterruptingCrossAgentGuardrail implements ICrossAgentGuardrailService {
  observeAgentIds = ['worker-1'];
  canInterruptOthers = false; // Cannot interrupt
  config = { evaluateStreamingChunks: true };

  async evaluateCrossAgentOutput(): Promise<GuardrailEvaluationResult | null> {
    return {
      action: GuardrailAction.BLOCK,
      reason: 'Would block but cannot interrupt',
      reasonCode: 'DOWNGRADED',
    };
  }
}

describe('ICrossAgentGuardrailService', () => {
  describe('isCrossAgentGuardrail', () => {
    it('returns true for services with observeAgentIds', () => {
      const service = { observeAgentIds: ['agent-1'] };
      expect(isCrossAgentGuardrail(service as ICrossAgentGuardrailService)).toBe(true);
    });

    it('returns true for services with canInterruptOthers', () => {
      const service = { canInterruptOthers: true };
      expect(isCrossAgentGuardrail(service as ICrossAgentGuardrailService)).toBe(true);
    });

    it('returns true for services with evaluateCrossAgentOutput', () => {
      const service = { evaluateCrossAgentOutput: vi.fn() };
      expect(isCrossAgentGuardrail(service as ICrossAgentGuardrailService)).toBe(true);
    });

    it('returns false for regular guardrail services', () => {
      const service = { evaluateInput: vi.fn(), evaluateOutput: vi.fn() };
      expect(isCrossAgentGuardrail(service as ICrossAgentGuardrailService)).toBe(false);
    });
  });

  describe('shouldObserveAgent', () => {
    it('returns true when observeAgentIds is empty (observe all)', () => {
      const guardrail: ICrossAgentGuardrailService = { observeAgentIds: [] };
      expect(shouldObserveAgent(guardrail, 'any-agent')).toBe(true);
    });

    it('returns true when observeAgentIds is undefined (observe all)', () => {
      const guardrail: ICrossAgentGuardrailService = {};
      expect(shouldObserveAgent(guardrail, 'any-agent')).toBe(true);
    });

    it('returns true when agent is in observeAgentIds', () => {
      const guardrail: ICrossAgentGuardrailService = {
        observeAgentIds: ['agent-1', 'agent-2'],
      };
      expect(shouldObserveAgent(guardrail, 'agent-1')).toBe(true);
    });

    it('returns false when agent is not in observeAgentIds', () => {
      const guardrail: ICrossAgentGuardrailService = {
        observeAgentIds: ['agent-1', 'agent-2'],
      };
      expect(shouldObserveAgent(guardrail, 'agent-3')).toBe(false);
    });
  });
});

describe('evaluateCrossAgentGuardrails', () => {
  it('allows chunks when guardrail returns null', async () => {
    const guardrails = [new AllowingCrossAgentGuardrail()];
    const chunk = createTextDeltaChunk('Hello world');

    const result = await evaluateCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      chunk,
    );

    expect(result.blocked).toBe(false);
    expect(result.modifiedChunk).toBeUndefined();
    expect(result.evaluations).toHaveLength(0);
  });

  it('blocks chunks when guardrail returns BLOCK', async () => {
    const guardrails = [new BlockingCrossAgentGuardrail()];
    const chunk = createTextDeltaChunk('This is BLOCKED content');

    const result = await evaluateCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      chunk,
    );

    expect(result.blocked).toBe(true);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].action).toBe(GuardrailAction.BLOCK);
    expect(result.evaluations[0].reasonCode).toBe('SUPERVISOR_BLOCK');
  });

  it('sanitizes chunks when guardrail returns SANITIZE', async () => {
    const guardrails = [new SanitizingCrossAgentGuardrail()];
    const chunk = createTextDeltaChunk('The SECRET code is 123');

    const result = await evaluateCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      chunk,
    );

    expect(result.blocked).toBe(false);
    expect(result.modifiedChunk).toBeDefined();
    expect((result.modifiedChunk as AgentOSTextDeltaChunk).textDelta).toBe(
      'The [REDACTED] code is 123',
    );
  });

  it('respects observeAgentIds filter', async () => {
    const guardrails = [new BlockingCrossAgentGuardrail()];
    const chunk = createTextDeltaChunk('This is BLOCKED content');

    // worker-2 is not in observeAgentIds
    const result = await evaluateCrossAgentGuardrails(
      guardrails,
      { ...crossAgentContext, sourceAgentId: 'worker-2' },
      baseContext,
      chunk,
    );

    expect(result.blocked).toBe(false);
  });

  it('downgrades BLOCK to FLAG when canInterruptOthers is false', async () => {
    const guardrails = [new NonInterruptingCrossAgentGuardrail()];
    const chunk = createTextDeltaChunk('Hello');

    const result = await evaluateCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      chunk,
    );

    expect(result.blocked).toBe(false);
    expect(result.evaluations).toHaveLength(1);
    expect(result.evaluations[0].action).toBe(GuardrailAction.FLAG);
    expect(result.evaluations[0].metadata?.originalAction).toBe(GuardrailAction.BLOCK);
    expect(result.evaluations[0].metadata?.downgraded).toBe(true);
  });

  it('handles guardrail errors gracefully', async () => {
    const errorGuardrail: ICrossAgentGuardrailService = {
      observeAgentIds: [],
      canInterruptOthers: true,
      config: { evaluateStreamingChunks: true },
      evaluateCrossAgentOutput: vi.fn().mockRejectedValue(new Error('Test error')),
    };
    const chunk = createTextDeltaChunk('Hello');

    const lines: Array<Record<string, unknown>> = [];
    setLogger(pino({ level: 'debug', base: undefined }, { write(line: string) { lines.push(JSON.parse(line)); } }));
    try {
      const result = await evaluateCrossAgentGuardrails(
        [errorGuardrail],
        crossAgentContext,
        baseContext,
        chunk,
      );

      expect(result.blocked).toBe(false);
      expect(lines.filter((line) => line.event === 'guardrail.failed')).toEqual([
        expect.objectContaining({ stage: 'output', posture: 'open', cause: 'error', type: 'Error', code: 'unknown' }),
      ]);
      expect(JSON.stringify(lines)).not.toContain('Test error');
    } finally {
      resetLoggerFactory();
    }
  });
});

describe('wrapWithCrossAgentGuardrails', () => {
  async function* createMockStream(
    chunks: AgentOSResponse[],
  ): AsyncGenerator<AgentOSResponse, void, undefined> {
    for (const chunk of chunks) {
      yield chunk;
    }
  }

  it('passes through chunks when no applicable guardrails', async () => {
    const guardrails: ICrossAgentGuardrailService[] = [];
    const chunks = [createTextDeltaChunk('Hello'), createFinalResponseChunk('Hello world')];

    const stream = wrapWithCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      createMockStream(chunks),
      { streamId: 'test-stream' },
    );

    const results: AgentOSResponse[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(2);
  });

  it('blocks stream when guardrail returns BLOCK', async () => {
    const guardrails = [new BlockingCrossAgentGuardrail()];
    const chunks = [
      createTextDeltaChunk('Normal content'),
      createTextDeltaChunk('BLOCKED content'),
      createTextDeltaChunk('More content'),
    ];

    const stream = wrapWithCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      createMockStream(chunks),
      { streamId: 'test-stream' },
    );

    const results: AgentOSResponse[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    // Should have first chunk + error chunk (stream terminated)
    expect(results).toHaveLength(2);
    expect(results[1].type).toBe(AgentOSResponseChunkType.ERROR);
  });

  it('sanitizes chunks and attaches metadata', async () => {
    const guardrails = [new SanitizingCrossAgentGuardrail()];
    const chunks = [createTextDeltaChunk('The SECRET is here')];

    const stream = wrapWithCrossAgentGuardrails(
      guardrails,
      crossAgentContext,
      baseContext,
      createMockStream(chunks),
      { streamId: 'test-stream' },
    );

    const results: AgentOSResponse[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    expect(results).toHaveLength(1);
    expect((results[0] as AgentOSTextDeltaChunk).textDelta).toBe('The [REDACTED] is here');
    expect(results[0].metadata?.crossAgentGuardrail).toBeDefined();
    expect(results[0].metadata?.crossAgentGuardrail.sourceAgentId).toBe('worker-1');
  });

  it('filters guardrails by observeAgentIds', async () => {
    const guardrails = [new BlockingCrossAgentGuardrail()]; // Only observes worker-1
    const chunks = [createTextDeltaChunk('BLOCKED content')];

    // Source is worker-3, not in observeAgentIds
    const stream = wrapWithCrossAgentGuardrails(
      guardrails,
      { ...crossAgentContext, sourceAgentId: 'worker-3' },
      baseContext,
      createMockStream(chunks),
      { streamId: 'test-stream' },
    );

    const results: AgentOSResponse[] = [];
    for await (const chunk of stream) {
      results.push(chunk);
    }

    // Should pass through since guardrail doesn't observe worker-3
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe(AgentOSResponseChunkType.TEXT_DELTA);
  });
});

describe('filterCrossAgentGuardrails', () => {
  it('filters out non-cross-agent guardrails', () => {
    const services = [
      new AllowingCrossAgentGuardrail(),
      { evaluateInput: vi.fn() }, // Regular guardrail
      new BlockingCrossAgentGuardrail(),
      null,
      undefined,
    ];

    const result = filterCrossAgentGuardrails(services);

    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(AllowingCrossAgentGuardrail);
    expect(result[1]).toBeInstanceOf(BlockingCrossAgentGuardrail);
  });
});
