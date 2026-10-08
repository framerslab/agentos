// File: packages/agentos/src/core/llm/streaming/StreamingBatcher.ts
/**
 * @fileoverview Backpressure batching wrapper for provider streaming chunks (`ModelCompletionResponse`).
 * Combines small, high-frequency deltas into larger aggregated chunks to reduce downstream
 * dispatch overhead (websocket emissions, DOM updates, etc.) while preserving core invariants:
 *   - Text remains append-only (merged into a single `responseTextDelta` per batch), and so does
 *     reasoning-summary text (`reasoningTextDelta`), kept apart from it.
 *   - Tool/function argument deltas merged per (choiceIndex, toolCallId) into single consolidated delta.
 *   - Exactly one terminal chunk with `isFinal: true` (forwarded from original final chunk).
 *   - Usage & error surfaced only when FINAL chunk encountered (or if intermediate provider error semantics change).
 *
 * Flush Triggers (any):
 *   1. Latency: maxLatencyMs elapsed since first unflushed chunk arrival.
 *   2. Size: accumulated text and reasoning delta length >= maxTextDeltaChars.
 *   3. Chunk Count: buffer size >= maxChunksPerBatch.
 *   4. Explicit final provider chunk.
 *   5. Manual tool argument size threshold (maxToolArgumentChars) exceeded.
 *
 * Design Choices:
 *   - Aggregated batch `id` composed from first chunk id + suffix `-batch-{sequence}` for traceability.
 *   - `choices` taken verbatim from first chunk in batch (providers do not mutate choice metadata mid-stream except deltas).
 *   - Non-final batches omit `usage` & `error` to keep semantics consistent. (If provider emits an error chunk mid-stream
 *     with `isFinal: true`, it will be flushed immediately as its own batch.)
 *   - Tool call reconstruction at batch granularity only (full stream reconstruction still delegated to `StreamingReconstructor`).
 *
 * NOTE: This is an optional optimization layer. Consumers requiring raw per-token latency should bypass batching.
 */
import { ModelCompletionResponse } from '../providers/IProvider';

/** Configuration options for StreamingBatcher. */
export interface StreamingBatcherOptions {
  /** Max wall-clock latency before forcing a flush (milliseconds). */
  maxLatencyMs?: number; // default 100ms
  /** Max accumulated text delta characters (answer and reasoning text together) before flush. */
  maxTextDeltaChars?: number; // default 800 chars
  /** Max accumulated tool argument characters (combined per tool call) before flush. */
  maxToolArgumentChars?: number; // default 4000 chars
  /** Max number of provider chunks to accumulate before flush. */
  maxChunksPerBatch?: number; // default 50
  /** If true, include batchSequence on emitted chunk object for diagnostics. */
  annotateBatches?: boolean;
}

const DEFAULT_BATCHER_OPTIONS: Required<StreamingBatcherOptions> = {
  maxLatencyMs: 100,
  maxTextDeltaChars: 800,
  maxToolArgumentChars: 4000,
  maxChunksPerBatch: 50,
  annotateBatches: true,
};

interface AccumulatedToolBuffer {
  raw: string;
  name?: string;
  id?: string;
  /** Gemini thought signature carried on the call's deltas, if any. */
  thoughtSignature?: string;
}

interface AccumulatorState {
  chunks: ModelCompletionResponse[];
  textBuffer: string;
  reasoningBuffer: string;
  toolBuffers: Record<string, AccumulatedToolBuffer>; // key => `${index}|${id??'_'}`
  firstChunkAt: number; // ms timestamp of first buffered chunk
}

/** Internal helper: merge a new chunk into accumulator state. */
function accumulate(state: AccumulatorState, chunk: ModelCompletionResponse) {
  state.chunks.push(chunk);
  if (chunk.responseTextDelta) state.textBuffer += chunk.responseTextDelta;
  if (chunk.reasoningTextDelta) state.reasoningBuffer += chunk.reasoningTextDelta;
  if (chunk.toolCallsDeltas) {
    for (const d of chunk.toolCallsDeltas) {
      const key = `${d.index}|${d.id || '_'}`;
      const buf = state.toolBuffers[key] || { raw: '' };
      if (d.function?.arguments_delta) buf.raw += d.function.arguments_delta;
      if (d.function?.name) buf.name = d.function.name;
      if (d.id) buf.id = d.id;
      if (d.thoughtSignature) buf.thoughtSignature = d.thoughtSignature;
      state.toolBuffers[key] = buf;
    }
  }
}

/** Builds a batched chunk from accumulator state and resets state. */
function buildBatch(state: AccumulatorState, batchSequence: number, isFinalOverride = false): ModelCompletionResponse | undefined {
  if (state.chunks.length === 0) return undefined;
  const first = state.chunks[0];
  const finalProviderChunk = state.chunks.find(c => c.isFinal);

  // Consolidate tool call deltas into single entries per key.
  const mergedToolCalls = Object.entries(state.toolBuffers).map(([key, data]) => {
    const [indexStr, idMarker] = key.split('|');
    return {
      index: Number(indexStr),
      id: data.id || (idMarker !== '_' ? idMarker : undefined),
      type: 'function' as const,
      function: {
        name: data.name,
        arguments_delta: data.raw, // merged arguments
      },
      ...(data.thoughtSignature ? { thoughtSignature: data.thoughtSignature } : {}),
    };
  });

  const batched: ModelCompletionResponse = {
    id: `${first.id}-batch-${batchSequence}`,
    object: first.object,
    created: Math.floor(Date.now() / 1000),
    modelId: first.modelId,
    choices: first.choices, // assume stable choice metadata
    responseTextDelta: state.textBuffer.length > 0 ? state.textBuffer : undefined,
    reasoningTextDelta: state.reasoningBuffer.length > 0 ? state.reasoningBuffer : undefined,
    toolCallsDeltas: mergedToolCalls.length > 0 ? mergedToolCalls : undefined,
    // Only propagate usage/error when final provider chunk present.
    usage: finalProviderChunk?.usage,
    error: finalProviderChunk?.error,
    isFinal: isFinalOverride || !!finalProviderChunk?.isFinal,
  };

  // Optional annotation for diagnostics / profiling.
  (batched as any).batchSequence = batchSequence;
  (batched as any).batchedChunkCount = state.chunks.length;
  (batched as any).batchedOriginalIds = state.chunks.map(c => c.id);

  // Reset state for next batch
  state.chunks = [];
  state.textBuffer = '';
  state.reasoningBuffer = '';
  state.toolBuffers = {};
  state.firstChunkAt = 0;
  return batched;
}

/** Determines if flush conditions met (excluding final chunk condition handled upstream). */
function shouldFlush(state: AccumulatorState, opts: Required<StreamingBatcherOptions>): boolean {
  if (state.chunks.length === 0) return false;
  const now = Date.now();
  if (state.firstChunkAt && (now - state.firstChunkAt) >= opts.maxLatencyMs) return true;
  if (state.textBuffer.length + state.reasoningBuffer.length >= opts.maxTextDeltaChars) return true;
  if (state.chunks.length >= opts.maxChunksPerBatch) return true;
  // Tool argument size check
  const toolArgSize = Object.values(state.toolBuffers).reduce((sum, t) => sum + t.raw.length, 0);
  if (toolArgSize >= opts.maxToolArgumentChars) return true;
  return false;
}

/**
 * Batches an async stream of `ModelCompletionResponse` chunks according to `StreamingBatcherOptions`.
 * @param stream Underlying provider async generator.
 * @param options Optional batching thresholds.
 * @returns AsyncGenerator<ModelCompletionResponse>
 */
export async function* batchStream(
  stream: AsyncGenerator<ModelCompletionResponse, void, undefined>,
  options: StreamingBatcherOptions = {}
): AsyncGenerator<ModelCompletionResponse, void, undefined> {
  const opts: Required<StreamingBatcherOptions> = { ...DEFAULT_BATCHER_OPTIONS, ...options };
  let batchSequence = 0;
  const state: AccumulatorState = { chunks: [], textBuffer: '', reasoningBuffer: '', toolBuffers: {}, firstChunkAt: 0 };

  const flush = (isFinal = false): ModelCompletionResponse | undefined => {
    const chunk = buildBatch(state, batchSequence++, isFinal);
    if (chunk && !opts.annotateBatches) {
      delete (chunk as any).batchSequence;
      delete (chunk as any).batchedChunkCount;
      delete (chunk as any).batchedOriginalIds;
    }
    return chunk;
  };

  // Consumption loop with latency race.
  while (true) {
    const providerResult = await stream.next();
    if (providerResult.done) {
      if (state.chunks.length) {
        const residual = flush(false);
        if (residual) {
          yield residual;
        }
      }
      return;
    }

    const chunk = providerResult.value as ModelCompletionResponse;
    if (!chunk) {
      continue;
    }
    // If enough time elapsed since first buffered chunk, flush before adding new chunk
    if (state.chunks.length > 0 && state.firstChunkAt && (Date.now() - state.firstChunkAt) >= opts.maxLatencyMs) {
      const timedOut = flush(false);
      if (timedOut) {
        yield timedOut;
      }
    }

    if (chunk.isFinal) {
      if (state.chunks.length === 0) {
        // No buffered chunks; emit final chunk directly.
        yield chunk;
        return;
      }
      // Flush buffered chunks first, then emit final chunk.
      let preFinal = flush(false);
      if (!preFinal && (state.textBuffer || state.reasoningBuffer)) {
        preFinal = {
          ...state.chunks[0],
          id: `${state.chunks[0]?.id || 'chunk'}-batch-${batchSequence++}`,
          responseTextDelta: state.textBuffer || undefined,
          reasoningTextDelta: state.reasoningBuffer || undefined,
          isFinal: false,
        } as ModelCompletionResponse;
      }
      if (preFinal) {
        yield preFinal;
      }
      yield chunk;
      return;
    }

    if (state.chunks.length === 0) state.firstChunkAt = Date.now();
    accumulate(state, chunk);

    // Non-final flush conditions.
    if (shouldFlush(state, opts)) {
      const chunk = flush(false);
      if (chunk) {
        yield chunk;
      }
    }
  }
}

/** Convenience OO wrapper for imperative control (mirrors functional batchStream). */
export class StreamingBatcher {
  private opts: Required<StreamingBatcherOptions>;
  constructor(options: StreamingBatcherOptions = {}) {
    this.opts = { ...DEFAULT_BATCHER_OPTIONS, ...options };
  }
  batch(stream: AsyncGenerator<ModelCompletionResponse, void, undefined>) {
    return batchStream(stream, this.opts);
  }
}

export default StreamingBatcher;
