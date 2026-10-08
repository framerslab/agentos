/**
 * @file gmiResults.ts
 * Folds a GMI turn's output chunks into the result shapes of `generateText`
 * (`session.send()`) and `streamText` (`session.stream()`) on the GMI path
 * (`agent({ runtime: 'gmi' })`).
 *
 * The rules are streamText's: the turn's text is the latest step that produced
 * text; usage adds each step's STEP_FINISHED usage once (USAGE_UPDATE carries a
 * request's running total) plus the billed usage of attempts that failed, before
 * any output or after it; a run that called tools and produced no text ends as
 * `'tool-calls'`; an ERROR chunk ends it as `'error'` with the GMI's code.
 */
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import {
  GMIOutputChunkType,
  type GMIOutputChunk,
  type StepFinishedChunkPayload,
  type ToolCallRequest,
  type ToolResultChunkPayload,
} from '../../cognition/substrate/IGMI.js';
import { addModelUsage, type GenerateTextResult, type TokenUsage, type ToolCallRecord } from '../generateText.js';
import { normalizeStreamFinishReason, type StreamPart, type StreamTextResult } from '../streamText.js';
import type { SessionTranscriptMessage } from '../sessionTranscript.js';

/** The error a turn ended with, as the GMI reported it. */
export interface GmiTurnError {
  code?: string;
  message: string;
  details?: unknown;
}

/** An attempt that failed, before any output or after it, and was billed (reported on a USAGE_UPDATE with `metadata.attemptFailed`). */
export interface GmiFailedAttempt {
  providerId?: string;
  modelId?: string;
  usage: TokenUsage;
}

function emptyUsage(): TokenUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
}

/** Adds one TokenUsage to another; an optional counter is added only when present. */
function addTokenUsage(target: TokenUsage, add: TokenUsage): void {
  target.promptTokens += add.promptTokens;
  target.completionTokens += add.completionTokens;
  target.totalTokens += add.totalTokens;
  if (add.costUSD !== undefined) target.costUSD = (target.costUSD ?? 0) + add.costUSD;
  if (add.cacheReadTokens !== undefined) target.cacheReadTokens = (target.cacheReadTokens ?? 0) + add.cacheReadTokens;
  if (add.cacheCreationTokens !== undefined) target.cacheCreationTokens = (target.cacheCreationTokens ?? 0) + add.cacheCreationTokens;
  if (add.inclusiveInputTokens !== undefined) target.inclusiveInputTokens = (target.inclusiveInputTokens ?? 0) + add.inclusiveInputTokens;
}

/** The message a failed tool result carries. */
export function toolErrorMessage(result: ToolResultChunkPayload): string {
  const details = result.errorDetails as { message?: unknown } | undefined;
  return typeof details?.message === 'string' && details.message ? details.message : 'Tool failed.';
}

/**
 * Accumulates one turn's chunks. `push` every chunk in order; read the result
 * once the turn has ended (or at any point for a partial view).
 */
export class GmiTurnFolder {
  /** The STEP_FINISHED payloads, in order. */
  readonly steps: StepFinishedChunkPayload[] = [];
  /** Every requested call in order, with its result once the TOOL_RESULT arrived. */
  private readonly calls: Array<{ call: ToolCallRequest; result?: ToolResultChunkPayload }> = [];
  private readonly overrides = new Map<number, string>();
  private readonly failed: GmiFailedAttempt[] = [];
  private failure: GmiTurnError | undefined;

  push(chunk: GMIOutputChunk): void {
    switch (chunk.type) {
      case GMIOutputChunkType.STEP_FINISHED:
        this.steps.push(chunk.content as StepFinishedChunkPayload);
        break;
      case GMIOutputChunkType.TOOL_CALL_REQUEST:
        for (const call of (chunk.content as ToolCallRequest[]) ?? []) this.calls.push({ call });
        break;
      case GMIOutputChunkType.TOOL_RESULT: {
        const result = chunk.content as ToolResultChunkPayload;
        // The latest unanswered call with this id: providers may reuse ids across steps.
        for (let i = this.calls.length - 1; i >= 0; i--) {
          if (this.calls[i].call.id === result.toolCallId && !this.calls[i].result) {
            this.calls[i].result = result;
            break;
          }
        }
        break;
      }
      case GMIOutputChunkType.USAGE_UPDATE: {
        const meta = chunk.metadata as { attemptFailed?: boolean; providerId?: string; modelId?: string } | undefined;
        if (meta?.attemptFailed) {
          const usage = emptyUsage();
          addModelUsage(usage, chunk.content);
          this.failed.push({ providerId: meta.providerId, modelId: meta.modelId, usage });
        }
        break;
      }
      case GMIOutputChunkType.ERROR: {
        const details = chunk.errorDetails as { code?: unknown; details?: unknown } | undefined;
        this.failure = {
          code: typeof details?.code === 'string' ? details.code : undefined,
          message: String(chunk.content),
          details: details?.details,
        };
        break;
      }
      default:
        break;
    }
  }

  /** Marks the turn failed by a thrown error (the turn's generator itself threw). An ERROR chunk already seen wins. */
  fail(error: unknown): void {
    this.failure ??= {
      code: error instanceof GMIError ? String(error.code) : undefined,
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof GMIError ? error.details : undefined,
    };
  }

  /** Replaces a step's text (`onAfterGeneration`), in the result and in what the session stores. */
  overrideStepText(stepIndex: number, text: string): void {
    this.overrides.set(stepIndex, text);
  }

  /** A step's text as the result reports it: a schema answer as its JSON string, else the hook's replacement, else the step's own text. */
  stepText(step: StepFinishedChunkPayload): string {
    if (step.structuredOutput !== undefined) return JSON.stringify(step.structuredOutput);
    return this.overrides.get(step.stepIndex) ?? step.text;
  }

  /** The latest step that produced text, streamText's rule. */
  text(): string {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const t = this.stepText(this.steps[i]);
      if (t) return t;
    }
    return '';
  }

  /** Each step's usage once, plus every billed failed attempt. */
  usage(): TokenUsage {
    const total = emptyUsage();
    for (const step of this.steps) addModelUsage(total, step.usage);
    for (const attempt of this.failed) addTokenUsage(total, attempt.usage);
    return total;
  }

  /** The billed attempts that failed, in order. */
  failedAttempts(): GmiFailedAttempt[] {
    return this.failed.map((a) => ({ ...a, usage: { ...a.usage } }));
  }

  /** Every call the model requested, with its result or error. */
  toolCalls(): ToolCallRecord[] {
    return this.calls.map(({ call, result }) => {
      const record: ToolCallRecord = { name: call.name, args: call.arguments };
      if (result?.isError) record.error = toolErrorMessage(result);
      else if (result) record.result = result.result;
      return record;
    });
  }

  /** The latest schema answer a step carried, if any. */
  structuredOutput(): unknown {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].structuredOutput !== undefined) return this.steps[i].structuredOutput;
    }
    return undefined;
  }

  error(): GmiTurnError | undefined {
    return this.failure;
  }

  finishReason(): GenerateTextResult['finishReason'] {
    if (this.failure) return 'error';
    const last = this.steps.at(-1);
    // The schema answer is the turn's reply, whatever stop reason carried it.
    if (last?.structuredOutput !== undefined) return 'stop';
    return this.calls.length > 0 && !this.text() ? 'tool-calls' : normalizeStreamFinishReason(last?.finishReason ?? null);
  }

  /** The error the turn ended with, as a GMIError keeping the GMI's code. */
  toError(): GMIError | undefined {
    if (!this.failure) return undefined;
    return new GMIError(this.failure.message, this.failure.code ?? GMIErrorCode.GMI_PROCESSING_ERROR, this.failure.details);
  }

  /**
   * The turn as `generateText` reports a run: provider, model and response
   * metadata from the last step, the text, the usage, the tool calls and the
   * finish reason.
   *
   * @param transcriptDelta - The messages the turn added to the session store.
   */
  toGenerateTextResult(transcriptDelta?: SessionTranscriptMessage[]): GenerateTextResult {
    const last = this.steps.at(-1);
    return {
      provider: last?.providerId ?? '',
      model: last?.modelId ?? '',
      ...(last?.responseModel ? { responseModel: last.responseModel } : {}),
      ...(last?.serviceTier ? { serviceTier: last.serviceTier } : {}),
      ...(last?.providerMessageId ? { providerMessageId: last.providerMessageId } : {}),
      ...(last?.cacheDiagnostics !== undefined ? { cacheDiagnostics: last.cacheDiagnostics as GenerateTextResult['cacheDiagnostics'] } : {}),
      text: this.text(),
      usage: this.usage(),
      toolCalls: this.toolCalls(),
      finishReason: this.finishReason(),
      ...(transcriptDelta ? { transcriptDelta } : {}),
    };
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Options for {@link streamFromGmiTurn}. */
export interface GmiStreamOptions {
  /**
   * A folder the turn already pushes every chunk into (the session's, which
   * carries the `onAfterGeneration` replacements). Without one, the stream
   * folds the chunks itself.
   */
  folder?: GmiTurnFolder;
}

/**
 * A `StreamTextResult` over a GMI turn. The turn is drained eagerly, so every
 * promise settles whether the caller iterates, stops iterating early, or never
 * iterates; `textStream` and `fullStream` replay what arrived and wait for more.
 *
 * `textStream` yields every TEXT_DELTA as it arrives. `fullStream` maps
 * TEXT_DELTA to `text`, TOOL_CALL_REQUEST to `tool-call`, TOOL_RESULT to
 * `tool-result` and ERROR (or a thrown error) to a final `error` part. `text`
 * is the latest step's text; after an error it is the text the failed step
 * delivered, as streamText resolves it.
 *
 * @param turn - The turn's chunks.
 * @param options - A caller-owned folder; see {@link GmiStreamOptions}.
 */
export function streamFromGmiTurn(turn: AsyncIterable<GMIOutputChunk>, options: GmiStreamOptions = {}): StreamTextResult {
  const folder = options.folder ?? new GmiTurnFolder();
  const foldHere = !options.folder;
  const texts: string[] = [];
  const parts: StreamPart[] = [];
  let done = false;
  let waiters: Array<() => void> = [];
  const wake = (): void => {
    const pending = waiters;
    waiters = [];
    pending.forEach((w) => w());
  };
  const p = {
    text: deferred<string>(),
    usage: deferred<TokenUsage>(),
    toolCalls: deferred<ToolCallRecord[]>(),
    provider: deferred<string>(),
    model: deferred<string>(),
    finishReason: deferred<GenerateTextResult['finishReason']>(),
    responseModel: deferred<string | undefined>(),
    serviceTier: deferred<string | undefined>(),
    cacheDiagnostics: deferred<Awaited<StreamTextResult['cacheDiagnostics']>>(),
    providerMessageId: deferred<string | null>(),
  };

  void (async () => {
    // The text the step in progress has delivered; reset at each step boundary.
    let stepDelivered = '';
    try {
      for await (const chunk of turn) {
        if (foldHere) folder.push(chunk);
        switch (chunk.type) {
          case GMIOutputChunkType.TEXT_DELTA: {
            const text = String(chunk.content ?? '');
            stepDelivered += text;
            texts.push(text);
            parts.push({ type: 'text', text });
            break;
          }
          case GMIOutputChunkType.STEP_FINISHED:
            stepDelivered = '';
            break;
          case GMIOutputChunkType.TOOL_CALL_REQUEST:
            for (const call of (chunk.content as ToolCallRequest[]) ?? []) parts.push({ type: 'tool-call', toolName: call.name, args: call.arguments });
            break;
          case GMIOutputChunkType.TOOL_RESULT: {
            const r = chunk.content as ToolResultChunkPayload;
            parts.push({ type: 'tool-result', toolName: r.name, result: r.isError ? { error: toolErrorMessage(r) } : r.result });
            break;
          }
          case GMIOutputChunkType.ERROR:
            parts.push({ type: 'error', error: folder.toError() ?? new Error(String(chunk.content)) });
            break;
          default:
            break;
        }
        wake();
      }
    } catch (error) {
      folder.fail(error);
      parts.push({ type: 'error', error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      const last = folder.steps.at(-1);
      p.text.resolve(folder.error() && stepDelivered ? stepDelivered : folder.text());
      p.usage.resolve(folder.usage());
      p.toolCalls.resolve(folder.toolCalls());
      p.provider.resolve(last?.providerId ?? '');
      p.model.resolve(last?.modelId ?? '');
      p.finishReason.resolve(folder.finishReason());
      p.responseModel.resolve(last?.responseModel);
      p.serviceTier.resolve(last?.serviceTier);
      p.cacheDiagnostics.resolve((last?.cacheDiagnostics as Awaited<StreamTextResult['cacheDiagnostics']> | undefined) ?? null);
      p.providerMessageId.resolve(last?.providerMessageId ?? null);
      done = true;
      wake();
    }
  })();

  function replay<T>(buffer: T[]): AsyncIterable<T> {
    return {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          async next(): Promise<IteratorResult<T>> {
            for (;;) {
              if (i < buffer.length) return { value: buffer[i++], done: false };
              if (done) return { value: undefined as never, done: true };
              await new Promise<void>((resolve) => waiters.push(resolve));
            }
          },
          async return(): Promise<IteratorResult<T>> {
            i = Number.MAX_SAFE_INTEGER;
            return { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  return {
    textStream: replay(texts),
    fullStream: replay(parts),
    text: p.text.promise,
    usage: p.usage.promise,
    toolCalls: p.toolCalls.promise,
    provider: p.provider.promise,
    model: p.model.promise,
    finishReason: p.finishReason.promise,
    responseModel: p.responseModel.promise,
    serviceTier: p.serviceTier.promise,
    cacheDiagnostics: p.cacheDiagnostics.promise,
    providerMessageId: p.providerMessageId.promise,
  };
}
