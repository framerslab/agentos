/**
 * @fileoverview Tests for the ParallelGuardrailDispatcher two-phase execution model.
 *
 * Covers:
 * - Phase 1 sequential sanitizer chaining and BLOCK short-circuit
 * - Phase 2 parallel execution (verified via concurrency counters)
 * - Phase 2 SANITIZE → FLAG downgrade
 * - Worst-wins aggregation (BLOCK > FLAG > ALLOW)
 * - Timeout and error fail-open behavior
 * - Registration-order preservation in evaluations[]
 * - Streaming TEXT_DELTA: Phase 1 sanitize + Phase 2 parallel
 * - Streaming BLOCK terminates the stream
 * - Rate limiting per streaming guardrail
 * - Final chunk evaluation with two-phase flow
 */
import { describe, it, expect, vi } from 'vitest';
import { ParallelGuardrailDispatcher } from '../../../src/safety/guardrails/ParallelGuardrailDispatcher';
import {
  GuardrailAction,
  type GuardrailEvaluationResult,
  type GuardrailConfig,
  type IGuardrailService,
  type GuardrailInputPayload,
  type GuardrailOutputPayload,
} from '../../../src/safety/guardrails/IGuardrailService.js';
import type { AgentOSInput } from '../../../src/api/types/AgentOSInput';
import {
  type AgentOSResponse,
  AgentOSResponseChunkType,
  type AgentOSTextDeltaChunk,
  type AgentOSFinalResponseChunk,
  type AgentOSErrorChunk,
} from '../../../src/api/types/AgentOSResponse';
import type { GuardrailInputOutcome, GuardrailOutputOptions } from '../../../src/safety/guardrails/guardrailDispatcher';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Options for creating a mock guardrail service. */
interface MockGuardrailOptions {
  /** Unique identifier for the guardrail (used for rate limiting). */
  id?: string;
  /** Whether this guardrail can sanitize (Phase 1 sequential). */
  canSanitize?: boolean;
  /** Whether to evaluate streaming TEXT_DELTA chunks. */
  evaluateStreamingChunks?: boolean;
  /** Max streaming evaluations before rate-limiting kicks in. */
  maxStreamingEvaluations?: number;
  /** Static result returned by evaluateInput. */
  inputResult?: GuardrailEvaluationResult | null;
  /** Static result returned by evaluateOutput. */
  outputResult?: GuardrailEvaluationResult | null;
  /** Dynamic function for evaluateInput (overrides inputResult). */
  inputFn?: (payload: GuardrailInputPayload) => Promise<GuardrailEvaluationResult | null>;
  /** Dynamic function for evaluateOutput (overrides outputResult). */
  outputFn?: (payload: GuardrailOutputPayload) => Promise<GuardrailEvaluationResult | null>;
  /** Artificial delay in ms before returning. */
  delay?: number;
  /** Per-service timeout to set on config.timeoutMs. */
  timeoutMs?: number;
  /** When true, evaluateInput and evaluateOutput throw an error. */
  shouldThrow?: boolean;
}

/**
 * Create a mock IGuardrailService for testing.
 *
 * Supports static results, dynamic functions, artificial delays, timeouts,
 * and deliberate errors — everything needed to exercise the dispatcher.
 */
function createMockGuardrail(opts: MockGuardrailOptions): IGuardrailService & { id: string } {
  const config: GuardrailConfig = {
    canSanitize: opts.canSanitize,
    evaluateStreamingChunks: opts.evaluateStreamingChunks,
    maxStreamingEvaluations: opts.maxStreamingEvaluations,
    timeoutMs: opts.timeoutMs,
  };

  const id = opts.id ?? `mock-${Math.random().toString(36).slice(2, 8)}`;

  /** Internal delay helper — resolves after `opts.delay` ms. */
  const maybeDelay = () =>
    opts.delay ? new Promise<void>((r) => setTimeout(r, opts.delay)) : Promise.resolve();

  return {
    id,
    config,

    async evaluateInput(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null> {
      if (opts.shouldThrow) {
        throw new Error(`Mock guardrail ${id} threw on evaluateInput`);
      }
      await maybeDelay();
      if (opts.inputFn) {
        return opts.inputFn(payload);
      }
      return opts.inputResult ?? null;
    },

    async evaluateOutput(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null> {
      if (opts.shouldThrow) {
        throw new Error(`Mock guardrail ${id} threw on evaluateOutput`);
      }
      await maybeDelay();
      if (opts.outputFn) {
        return opts.outputFn(payload);
      }
      return opts.outputResult ?? null;
    },
  };
}

/** Minimal AgentOSInput fixture. */
const baseInput: AgentOSInput = {
  userId: 'user-1',
  sessionId: 'session-1',
  textInput: 'original text',
  conversationId: 'conv-1',
  selectedPersonaId: undefined,
  visionInputs: [],
  audioInput: undefined,
  userApiKeys: {},
  userFeedback: undefined,
  options: { customFlags: { source: 'test' } },
};

/** Minimal guardrail context fixture. */
const baseContext = {
  userId: 'user-1',
  sessionId: 'session-1',
};

/** Create a TEXT_DELTA chunk for streaming tests. */
function makeTextDelta(text: string, isFinal = false): AgentOSTextDeltaChunk {
  return {
    type: AgentOSResponseChunkType.TEXT_DELTA,
    streamId: 'stream-1',
    gmiInstanceId: 'gmi-1',
    personaId: 'persona-1',
    isFinal,
    timestamp: new Date().toISOString(),
    textDelta: text,
  };
}

/** Create a FINAL_RESPONSE chunk. */
function makeFinalChunk(text: string): AgentOSFinalResponseChunk {
  return {
    type: AgentOSResponseChunkType.FINAL_RESPONSE,
    streamId: 'stream-1',
    gmiInstanceId: 'gmi-1',
    personaId: 'persona-1',
    isFinal: true,
    timestamp: new Date().toISOString(),
    finalResponseText: text,
  };
}

/** Default output options for stream wrapping. */
const baseOutputOptions: GuardrailOutputOptions = {
  streamId: 'stream-1',
  personaId: 'persona-1',
};

/** Convert an async generator into an array. */
async function collectStream(gen: AsyncGenerator<AgentOSResponse>): Promise<AgentOSResponse[]> {
  const chunks: AgentOSResponse[] = [];
  for await (const chunk of gen) {
    chunks.push(chunk);
  }
  return chunks;
}

/** Create an async generator from an array of chunks. */
async function* arrayToStream(chunks: AgentOSResponse[]): AsyncGenerator<AgentOSResponse, void, undefined> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ParallelGuardrailDispatcher', () => {
  // =========================================================================
  // evaluateInput
  // =========================================================================

  describe('evaluateInput', () => {
    it('returns unchanged input when no services are provided', async () => {
      const outcome = await ParallelGuardrailDispatcher.evaluateInput([], baseInput, baseContext);

      expect(outcome.sanitizedInput).toBe(baseInput);
      expect(outcome.evaluations).toEqual([]);
    });

    it('chains Phase 1 sanitizers sequentially — B sees A\'s modified text', async () => {
      /** Sanitizer A: uppercases the input text */
      const sanitizerA = createMockGuardrail({
        id: 'sanitizer-A',
        canSanitize: true,
        inputFn: async (payload) => ({
          action: GuardrailAction.SANITIZE,
          modifiedText: payload.input.textInput?.toUpperCase() ?? '',
          reasonCode: 'UPPER',
        }),
      });

      /** Sanitizer B: appends " [sanitized]" — should see uppercased text */
      const sanitizerB = createMockGuardrail({
        id: 'sanitizer-B',
        canSanitize: true,
        inputFn: async (payload) => ({
          action: GuardrailAction.SANITIZE,
          modifiedText: `${payload.input.textInput} [sanitized]`,
          reasonCode: 'APPEND',
        }),
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [sanitizerA, sanitizerB],
        baseInput,
        baseContext,
      );

      // B should have seen uppercased text from A
      expect(outcome.sanitizedInput.textInput).toBe('ORIGINAL TEXT [sanitized]');
      expect(outcome.evaluations).toHaveLength(2);
    });

    it('Phase 1 BLOCK short-circuits Phase 2', async () => {
      const blocker = createMockGuardrail({
        id: 'blocker',
        canSanitize: true,
        inputResult: {
          action: GuardrailAction.BLOCK,
          reason: 'blocked by sanitizer',
          reasonCode: 'SANITIZER_BLOCK',
        },
      });

      /** Phase 2 guardrail that should never be called */
      const classifier = createMockGuardrail({
        id: 'classifier',
        inputFn: async () => {
          throw new Error('Should not be called — Phase 1 blocked');
        },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [blocker, classifier],
        baseInput,
        baseContext,
      );

      expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
      expect(outcome.evaluation?.reasonCode).toBe('SANITIZER_BLOCK');
      // Only one evaluation (the blocker), classifier never ran
      expect(outcome.evaluations).toHaveLength(1);
    });

    it('Phase 2 services run in parallel (concurrent counter)', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      /**
       * Factory for a parallel classifier that tracks concurrency.
       * Each service bumps the counter, waits, then decrements.
       */
      const makeParallelClassifier = (id: string) =>
        createMockGuardrail({
          id,
          canSanitize: false,
          inputFn: async () => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            // Small delay to let the other promise start
            await new Promise((r) => setTimeout(r, 20));
            currentConcurrent--;
            return { action: GuardrailAction.ALLOW };
          },
        });

      const services = [
        makeParallelClassifier('p1'),
        makeParallelClassifier('p2'),
        makeParallelClassifier('p3'),
      ];

      await ParallelGuardrailDispatcher.evaluateInput(services, baseInput, baseContext);

      // All three should have been running concurrently
      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    });

    it('Phase 2 worst-wins: FLAG + BLOCK → BLOCK', async () => {
      const flagger = createMockGuardrail({
        id: 'flagger',
        inputResult: { action: GuardrailAction.FLAG, reason: 'suspicious', reasonCode: 'FLAG_1' },
      });

      const blocker = createMockGuardrail({
        id: 'blocker',
        inputResult: { action: GuardrailAction.BLOCK, reason: 'policy violation', reasonCode: 'BLOCK_1' },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [flagger, blocker],
        baseInput,
        baseContext,
      );

      // Worst-wins → BLOCK
      expect(outcome.evaluation?.action).toBe(GuardrailAction.BLOCK);
    });

    it('Phase 2 SANITIZE is downgraded to FLAG', async () => {
      const sneakySanitizer = createMockGuardrail({
        id: 'sneaky',
        canSanitize: false, // Phase 2
        inputResult: {
          action: GuardrailAction.SANITIZE,
          modifiedText: 'should not apply',
          reasonCode: 'SNEAKY',
        },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [sneakySanitizer],
        baseInput,
        baseContext,
      );

      // SANITIZE was downgraded to FLAG
      expect(outcome.evaluation?.action).toBe(GuardrailAction.FLAG);
      // Original text is unchanged — Phase 2 cannot sanitize
      expect(outcome.sanitizedInput.textInput).toBe('original text');
      expect(outcome.evaluation?.reason).toContain('SANITIZE');
    });

    it('timeout: slow guardrail with timeoutMs is skipped (fail-open)', async () => {
      const slowGuardrail = createMockGuardrail({
        id: 'slow',
        delay: 500,
        timeoutMs: 10, // 10ms timeout with 500ms delay → will timeout
        inputResult: { action: GuardrailAction.BLOCK, reasonCode: 'SLOW_BLOCK' },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [slowGuardrail],
        baseInput,
        baseContext,
      );

      // Slow guardrail timed out — no evaluations, input passes through
      expect(outcome.evaluations).toHaveLength(0);
      expect(outcome.sanitizedInput).toBe(baseInput);
    });

    it('timeout: a closed guard that answers from its deadline signal still times out, and the signal aborts at the deadline', async () => {
      const signals: (AbortSignal | undefined)[] = [];
      const answersOnAbort: IGuardrailService = {
        id: 'answers-on-abort',
        config: { failClosed: true, timeoutMs: 10 },
        evaluateInput: ({ deadlineSignal }: GuardrailInputPayload) =>
          new Promise((resolve) => {
            signals.push(deadlineSignal);
            deadlineSignal?.addEventListener('abort', () => resolve(null), { once: true });
          }),
      };

      const outcome = await ParallelGuardrailDispatcher.evaluateInput([answersOnAbort], baseInput, baseContext);

      expect(outcome.evaluation).toMatchObject({ action: GuardrailAction.BLOCK, reasonCode: 'GUARDRAIL_ERROR', metadata: { cause: 'timeout' } });
      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
    });

    it('error: throwing guardrail is skipped (fail-open)', async () => {
      const brokenGuardrail = createMockGuardrail({
        id: 'broken',
        shouldThrow: true,
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [brokenGuardrail],
        baseInput,
        baseContext,
      );

      // Error was caught — no evaluations
      expect(outcome.evaluations).toHaveLength(0);
      expect(outcome.sanitizedInput).toBe(baseInput);
    });

    it('evaluations[] preserves registration order', async () => {
      /** Phase 1 sanitizer (index 0). */
      const sanitizer = createMockGuardrail({
        id: 'sanitizer',
        canSanitize: true,
        inputResult: {
          action: GuardrailAction.SANITIZE,
          modifiedText: 'sanitized',
          reasonCode: 'SANITIZE_1',
        },
      });

      /** Phase 2 classifier (index 1) — ALLOW. */
      const classifierA = createMockGuardrail({
        id: 'classifier-a',
        inputResult: { action: GuardrailAction.ALLOW, reasonCode: 'ALLOW_A' },
      });

      /** Phase 2 classifier (index 2) — FLAG. */
      const classifierB = createMockGuardrail({
        id: 'classifier-b',
        inputResult: { action: GuardrailAction.FLAG, reasonCode: 'FLAG_B' },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [sanitizer, classifierA, classifierB],
        baseInput,
        baseContext,
      );

      // All three should be present in registration order
      expect(outcome.evaluations).toHaveLength(3);
      expect(outcome.evaluations![0].reasonCode).toBe('SANITIZE_1');
      expect(outcome.evaluations![1].reasonCode).toBe('ALLOW_A');
      expect(outcome.evaluations![2].reasonCode).toBe('FLAG_B');
    });

    it('services without evaluateInput are skipped gracefully', async () => {
      // A service that only implements evaluateOutput
      const outputOnly: IGuardrailService = {
        config: {},
        async evaluateOutput() {
          return { action: GuardrailAction.BLOCK, reasonCode: 'OUTPUT_ONLY' };
        },
      };

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [outputOnly],
        baseInput,
        baseContext,
      );

      expect(outcome.evaluations).toHaveLength(0);
      expect(outcome.sanitizedInput).toBe(baseInput);
    });

    it('mixed Phase 1 + Phase 2 with ALLOW everywhere returns last evaluation', async () => {
      const sanitizer = createMockGuardrail({
        id: 'clean-sanitizer',
        canSanitize: true,
        inputResult: { action: GuardrailAction.ALLOW, reasonCode: 'CLEAN_1' },
      });

      const classifier = createMockGuardrail({
        id: 'clean-classifier',
        inputResult: { action: GuardrailAction.ALLOW, reasonCode: 'CLEAN_2' },
      });

      const outcome = await ParallelGuardrailDispatcher.evaluateInput(
        [sanitizer, classifier],
        baseInput,
        baseContext,
      );

      expect(outcome.evaluations).toHaveLength(2);
      // When all ALLOW, picks the first match for worst (ALLOW) → which is the first one
      expect(outcome.evaluation?.action).toBe(GuardrailAction.ALLOW);
    });
  });

  // =========================================================================
  // wrapOutput
  // =========================================================================

  describe('wrapOutput', () => {
    it('passes through when no services are provided', async () => {
      const chunks = [makeTextDelta('hello'), makeFinalChunk('hello')];
      const stream = arrayToStream(chunks);

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([], baseContext, stream, baseOutputOptions),
      );

      expect(result).toHaveLength(2);
      expect((result[0] as AgentOSTextDeltaChunk).textDelta).toBe('hello');
    });

    it('streaming TEXT_DELTA: Phase 1 sanitizer modifies textDelta', async () => {
      const sanitizer = createMockGuardrail({
        id: 'stream-sanitizer',
        canSanitize: true,
        evaluateStreamingChunks: true,
        outputFn: async (payload) => {
          // Only process TEXT_DELTA chunks that have textDelta
          const chunk = payload.chunk;
          if (chunk.type !== AgentOSResponseChunkType.TEXT_DELTA) {
            return null;
          }
          const textChunk = chunk as AgentOSTextDeltaChunk;
          if (textChunk.textDelta.includes('secret')) {
            return {
              action: GuardrailAction.SANITIZE,
              modifiedText: textChunk.textDelta.replace('secret', '[REDACTED]'),
              reasonCode: 'PII',
            };
          }
          return null;
        },
      });

      const chunks = [makeTextDelta('my secret info'), makeFinalChunk('done')];
      const stream = arrayToStream(chunks);

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([sanitizer], baseContext, stream, baseOutputOptions),
      );

      // First chunk should have redacted text
      expect((result[0] as AgentOSTextDeltaChunk).textDelta).toBe('my [REDACTED] info');
      // Metadata should be attached
      expect(result[0].metadata?.guardrail?.output?.[0]?.reasonCode).toBe('PII');
    });

    it('streaming BLOCK terminates the stream with error chunk', async () => {
      const blocker = createMockGuardrail({
        id: 'stream-blocker',
        canSanitize: false,
        evaluateStreamingChunks: true,
        outputResult: {
          action: GuardrailAction.BLOCK,
          reason: 'toxic content',
          reasonCode: 'STREAM_BLOCK',
        },
      });

      const chunks = [
        makeTextDelta('chunk 1'),
        makeTextDelta('chunk 2'),
        makeFinalChunk('done'),
      ];
      const stream = arrayToStream(chunks);

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([blocker], baseContext, stream, baseOutputOptions),
      );

      // Only one chunk — the error chunk. Stream was terminated.
      expect(result).toHaveLength(1);
      expect(result[0].type).toBe(AgentOSResponseChunkType.ERROR);
      expect((result[0] as AgentOSErrorChunk).code).toBe('STREAM_BLOCK');
    });

    it('streaming Phase 2 parallel classifiers run concurrently', async () => {
      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const makeClassifier = (id: string) =>
        createMockGuardrail({
          id,
          canSanitize: false,
          evaluateStreamingChunks: true,
          outputFn: async () => {
            currentConcurrent++;
            maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
            await new Promise((r) => setTimeout(r, 20));
            currentConcurrent--;
            return { action: GuardrailAction.ALLOW };
          },
        });

      const services = [makeClassifier('c1'), makeClassifier('c2'), makeClassifier('c3')];
      const chunks = [makeTextDelta('test'), makeFinalChunk('done')];
      const stream = arrayToStream(chunks);

      await collectStream(
        ParallelGuardrailDispatcher.wrapOutput(services, baseContext, stream, baseOutputOptions),
      );

      // At least 2 should have been running concurrently for the TEXT_DELTA
      expect(maxConcurrent).toBeGreaterThanOrEqual(2);
    });

    it('rate limiting: streaming guardrail respects maxStreamingEvaluations', async () => {
      let evalCount = 0;

      const rateLimited = createMockGuardrail({
        id: 'rate-limited',
        canSanitize: true,
        evaluateStreamingChunks: true,
        maxStreamingEvaluations: 2, // Only evaluate first 2 chunks
        outputFn: async () => {
          evalCount++;
          return { action: GuardrailAction.ALLOW };
        },
      });

      // Send 5 TEXT_DELTA chunks
      const chunks = [
        makeTextDelta('a'),
        makeTextDelta('b'),
        makeTextDelta('c'),
        makeTextDelta('d'),
        makeTextDelta('e'),
        makeFinalChunk('done'),
      ];
      const stream = arrayToStream(chunks);

      await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([rateLimited], baseContext, stream, baseOutputOptions),
      );

      // Only 2 streaming evaluations + 1 final evaluation
      // (final sanitizers always run regardless of streaming rate limit)
      expect(evalCount).toBeLessThanOrEqual(3);
    });

    it('final chunk: Phase 1 sanitizer modifies finalResponseText', async () => {
      const finalSanitizer = createMockGuardrail({
        id: 'final-sanitizer',
        canSanitize: true,
        evaluateStreamingChunks: false, // final-only
        outputResult: {
          action: GuardrailAction.SANITIZE,
          modifiedText: 'clean output',
          reasonCode: 'FINAL_CLEAN',
        },
      });

      const chunks = [makeFinalChunk('raw output')];
      const stream = arrayToStream(chunks);

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([finalSanitizer], baseContext, stream, baseOutputOptions),
      );

      expect(result).toHaveLength(1);
      expect((result[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('clean output');
    });

    it('final chunk: Phase 2 SANITIZE downgraded to FLAG', async () => {
      const sneaky = createMockGuardrail({
        id: 'sneaky-final',
        canSanitize: false, // Phase 2
        evaluateStreamingChunks: false,
        outputResult: {
          action: GuardrailAction.SANITIZE,
          modifiedText: 'should not apply',
          reasonCode: 'SNEAKY_FINAL',
        },
      });

      const chunks = [makeFinalChunk('raw output')];
      const stream = arrayToStream(chunks);

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([sneaky], baseContext, stream, baseOutputOptions),
      );

      // Text should remain unchanged — SANITIZE was downgraded
      expect((result[0] as AgentOSFinalResponseChunk).finalResponseText).toBe('raw output');
      // Metadata shows FLAG (downgraded)
      expect(result[0].metadata?.guardrail?.output?.[0]?.action).toBe(GuardrailAction.FLAG);
    });

    it('attaches input evaluations metadata to first chunk', async () => {
      // Need at least one service so wrapOutput doesn't fast-path yield*
      const noopService = createMockGuardrail({
        id: 'noop',
        outputResult: null,
      });

      const chunks = [makeTextDelta('hello'), makeFinalChunk('done')];
      const stream = arrayToStream(chunks);

      const optionsWithInput: GuardrailOutputOptions = {
        ...baseOutputOptions,
        inputEvaluations: [
          { action: GuardrailAction.SANITIZE, reasonCode: 'INPUT_CLEAN' },
        ],
      };

      const result = await collectStream(
        ParallelGuardrailDispatcher.wrapOutput([noopService], baseContext, stream, optionsWithInput),
      );

      // Input metadata attached to first chunk
      expect(result[0].metadata?.guardrail?.input?.[0]?.reasonCode).toBe('INPUT_CLEAN');
      // Not duplicated on second chunk
      expect(result[1].metadata?.guardrail?.input).toBeUndefined();
    });
  });
});
