// File: packages/agentos/src/core/llm/streaming/StreamingReconstructor.ts
/**
 * @fileoverview Utility helpers to reconstruct full model output and tool/function calls
 * from incremental streaming `ModelCompletionResponse` chunks emitted by `IProvider.generateCompletionStream`.
 *
 * Invariants enforced by provider layer (see IProvider.ts):
 *  - `responseTextDelta` values are append-only fragments of assistant text.
 *  - `toolCallsDeltas` supply incremental JSON argument substrings via `arguments_delta` per choice index.
 *  - Exactly one chunk per stream has `isFinal: true` (terminal chunk; may contain error and usage).
 *
 * This module centralizes reconstruction logic so UI code, tests, and higher-level orchestration
 * avoid duplicating fragile merge routines.
 */
import { ModelCompletionResponse } from '../providers/IProvider';

/** Reconstructed tool call structure after merging streamed argument deltas. */
export interface ReconstructedToolCall {
  index: number;
  id?: string;
  name?: string;
  /** Parsed arguments object if JSON parse succeeded, else original concatenated string in rawArguments. */
  arguments?: any;
  rawArguments: string;
  parseError?: string;
  /** Gemini thought signature carried on the call's deltas, if any. */
  thoughtSignature?: string;
}

/** Aggregate reconstruction result for a full streamed completion. */
export interface StreamingReconstructionResult {
  fullText: string;
  toolCalls: ReconstructedToolCall[];
  finalChunk?: ModelCompletionResponse;
  error?: ModelCompletionResponse['error'];
  usage?: ModelCompletionResponse['usage'];
  chunks: number; // total chunks processed
}

/** Internal mutable accumulator state. */
interface ReconstructionAccumulator {
  textBuffer: string;
  toolBuffers: Record<number, { raw: string; id?: string; name?: string; thoughtSignature?: string }>;
  finalChunk?: ModelCompletionResponse;
}

/**
 * Incrementally applies a streaming chunk to the accumulator.
 * @param acc Current accumulator.
 * @param chunk Incoming streaming `ModelCompletionResponse` piece.
 */
function applyChunk(acc: ReconstructionAccumulator, chunk: ModelCompletionResponse): void {
  if (chunk.responseTextDelta) acc.textBuffer += chunk.responseTextDelta;
  if (chunk.toolCallsDeltas) {
    for (const d of chunk.toolCallsDeltas) {
      const buf = acc.toolBuffers[d.index] || { raw: '' };
      if (d.function?.arguments_delta) buf.raw += d.function.arguments_delta;
      if (d.id) buf.id = d.id;
      if (d.function?.name) buf.name = d.function.name;
      if (d.thoughtSignature) buf.thoughtSignature = d.thoughtSignature;
      acc.toolBuffers[d.index] = buf;
    }
  }
  if (chunk.isFinal) acc.finalChunk = chunk;
}

/**
 * Safely parses a JSON string, returning either the parsed object or recording an error.
 */
function safeParseJson(raw: string): { value?: any; error?: string } {
  try {
    return { value: raw.trim() === '' ? {} : JSON.parse(raw) };
  } catch (e: any) {
    return { error: e?.message || 'JSON parse failed' };
  }
}

/**
 * Reconstructs full assistant text and tool calls from an async stream of `ModelCompletionResponse` chunks.
 * The generator is consumed entirely before returning.
 *
 * @param stream Async generator from `generateCompletionStream`.
 * @returns StreamingReconstructionResult summarizing concatenated text, parsed tool calls, final chunk & usage.
 */
export async function reconstructStream(
  stream: AsyncGenerator<ModelCompletionResponse, void, undefined>
): Promise<StreamingReconstructionResult> {
  const acc: ReconstructionAccumulator = { textBuffer: '', toolBuffers: {}, finalChunk: undefined };
  let count = 0;
  for await (const chunk of stream) {
    applyChunk(acc, chunk);
    count++;
  }
  const toolCalls: ReconstructedToolCall[] = Object.entries(acc.toolBuffers).map(([indexStr, data]) => {
    const { value, error } = safeParseJson(data.raw);
    return {
      index: Number(indexStr),
      id: data.id,
      name: data.name,
      rawArguments: data.raw,
      arguments: error ? undefined : value,
      parseError: error,
      ...(data.thoughtSignature ? { thoughtSignature: data.thoughtSignature } : {}),
    };
  });
  return {
    fullText: acc.textBuffer,
    toolCalls,
    finalChunk: acc.finalChunk,
    error: acc.finalChunk?.error,
    usage: acc.finalChunk?.usage,
    chunks: count,
  };
}

/**
 * Incremental (online) reconstruction API: pass each chunk in sequence and query state at any time.
 * Useful for UI rendering that wants interim merged tool arguments without waiting for completion.
 */
export class StreamingReconstructor {
  private acc: ReconstructionAccumulator = { textBuffer: '', toolBuffers: {}, finalChunk: undefined };
  private chunkCount = 0;

  /** Apply next chunk. */
  push(chunk: ModelCompletionResponse): void {
    applyChunk(this.acc, chunk);
    this.chunkCount++;
  }

  /** Current full text (all deltas concatenated). */
  getFullText(): string { return this.acc.textBuffer; }

  /** Returns current reconstructed tool calls (raw + parsed if possible). */
  getToolCalls(): ReconstructedToolCall[] {
    return Object.entries(this.acc.toolBuffers).map(([idx, data]) => {
      const { value, error } = safeParseJson(data.raw);
      return {
        index: Number(idx),
        id: data.id,
        name: data.name,
        rawArguments: data.raw,
        arguments: error ? undefined : value,
        parseError: error,
        ...(data.thoughtSignature ? { thoughtSignature: data.thoughtSignature } : {}),
      };
    });
  }

  /** Final chunk if received. */
  getFinalChunk(): ModelCompletionResponse | undefined { return this.acc.finalChunk; }

  /** Aggregate usage only reliable after final chunk. */
  getUsage() { return this.acc.finalChunk?.usage; }

  /** Error if surfaced on final chunk. */
  getError() { return this.acc.finalChunk?.error; }

  /** Total chunks processed so far. */
  getChunkCount() { return this.chunkCount; }
}

export default StreamingReconstructor;