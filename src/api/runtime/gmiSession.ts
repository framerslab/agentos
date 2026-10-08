/**
 * @file gmiSession.ts
 * One agent session served by one GMI (`agent({ runtime: 'gmi' })`, spec D10).
 *
 * The session store is the source of truth: before every turn the GMI's history
 * is replaced with the store's messages, and as the turn runs each finished
 * model step is written to the store through a turn writer; a turn that fails
 * after some steps keeps them, marked partial. One turn runs at a time per
 * session. Each model call of a turn is metered with the provider and model
 * that served it: a usage ledger row and a usage event for the process-wide
 * observer, as `generateText` and `streamText` meter a call.
 */
import { randomUUID } from 'node:crypto';
import type { ZodType } from 'zod';
import {
  GMIInteractionType,
  GMIOutputChunkType,
  type GMIOutputChunk,
  type GMITurnInput,
  type IGMI,
  type StepFinishedChunkPayload,
  type ToolCallRequest,
  type ToolResultChunkPayload,
} from '../../cognition/substrate/IGMI.js';
import { addModelUsage, extractTextFromContent, type GenerateTextResult, type MessageContent, type TokenUsage } from '../generateText.js';
import { normalizeStreamFinishReason, type StreamTextResult } from '../streamText.js';
import { ObjectGenerationError } from '../generateObject.js';
import { fireLlmUsageObserver, type LlmUsageEvent } from '../observers.js';
import type { SessionHistoryBuffer, SessionTurnWriter } from '../sessionHistory.js';
import type { SessionTranscriptMessage } from '../sessionTranscript.js';
import type { AgentMemoryProvider, AgentOptions } from '../agent.js';
import { DEFAULT_MEMORY_TOKEN_BUDGET, MEMORY_TIMEOUT_MS } from './memoryProviderHooks.js';
import type { AgentOSUsageLedgerOptions } from './usageLedger.js';
import { GmiTurnFolder, streamFromGmiTurn } from './gmiResults.js';
import { stepToTranscript, transcriptToConversation } from './gmiTranscript.js';

/** Serialises turns: `acquire()` resolves with a release function once every earlier holder released. */
export class TurnLock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.tail;
    this.tail = previous.then(() => held);
    return previous.then(() => release);
  }
}

/** What one turn asks for beyond its input. */
export interface GmiTurnOptions {
  /** Completion options for this turn (`metadata.options`): temperature, maxTokens, toolChoice, cacheDiagnostics, … */
  options?: Record<string, unknown>;
  /** Structured output: the gateway lowers it for each hop and suppresses tools. */
  responseSchema?: ZodType;
  schemaName?: string;
  /** Label of the turn's block in the session store. */
  blockLabel?: string;
  /** Stops the turn: the model call in progress is aborted, and the turn ends with the abort error. */
  abortSignal?: AbortSignal;
  /**
   * Checks the reply of a turn that ended without error, before the session
   * keeps it. A throw keeps nothing of the turn (no history, no
   * `memoryProvider.observe`) and is the turn's error: a structured send whose
   * answer does not parse adds nothing, as `agent()`'s send adds nothing.
   */
  acceptReply?: () => void;
}

/** What the GMI's hooks need to know about the turn about to run. */
export interface GmiTurnContext {
  /** The turn's text input, for `onBeforeGeneration`'s `prompt` (undefined for multimodal input). */
  prompt: string | undefined;
  /** The `memoryProvider.getContext` block for this turn, inserted as a system message on every model call. */
  memoryContext: string | undefined;
  /** Called before every model call of the turn with the provider and model its hop was routed to. */
  onModelCall?: (route: { providerId: string; modelId: string }) => void;
}

/** The GMI that serves one turn. */
export interface GmiForTurn {
  gmi: IGMI;
  /** Hands the turn's prompt and memory context to the GMI's hooks; called after the turn holds the lock, before it runs. */
  prepare?(context: GmiTurnContext): void;
  /** Releases a GMI made for this turn alone; called once the turn has ended. */
  release?(): Promise<void>;
}

/** What a session hands the turn runner. */
export interface GmiSessionDeps {
  sessionId: string;
  opts: AgentOptions;
  /** The GMI that serves the next turn: the session's own, or one made for the turn when the session keeps no history. */
  gmiFor(): Promise<GmiForTurn>;
  /** The user the GMI runs the turn as: it scopes cognitive memory. */
  userId: string;
  /**
   * The end-user id the turn's model calls send to the provider (OpenAI's `user`
   * / `safety_identifier`): a user id the caller passed, never a session or call
   * id. Unset, they send none, as agent() sends none.
   */
  providerUserId?: string;
  /** False when cognitive memory supplies the memory context: `memoryProvider.getContext` is then skipped. */
  useMemoryProviderContext: boolean;
  /** The session store, or null when the turn keeps no history. */
  history: SessionHistoryBuffer | null;
  /** Usage ledger options for this turn's events (session id and source included). */
  ledger?: AgentOSUsageLedgerOptions;
  /** Receives the turn's usage once it ends, failed or not. */
  onUsage(usage: TokenUsage): void;
  lock: TurnLock;
}

/** `memoryProvider.getContext` for the turn, within its timeout; undefined when there is none or it fails. */
async function memoryProviderContext(opts: AgentOptions, userText: string): Promise<string | undefined> {
  const provider = opts.memoryProvider;
  if (!provider?.getContext) return undefined;
  const timeoutMs = opts.memoryProviderOptions?.timeoutMs ?? MEMORY_TIMEOUT_MS;
  const tokenBudget = opts.memoryProviderOptions?.tokenBudget ?? DEFAULT_MEMORY_TOKEN_BUDGET;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    const result = await Promise.race([
      provider.getContext(userText, { tokenBudget }),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (timedOut) console.warn(`[agentos] memoryProvider.getContext exceeded ${timeoutMs}ms; continuing without memory context.`);
    return result?.contextText || undefined;
  } catch (error) {
    console.warn('[agentos] memoryProvider.getContext failed; continuing without memory context.', error);
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `memoryProvider.observe` for one side of a finished turn. It is called on the
 * provider, as `agent()` calls it, because a provider built from a class reads
 * `this`; and it is never the turn's error: the turn has been answered and
 * stored, and a memory store that fails to record it does not undo that.
 */
function observeTurn(provider: AgentMemoryProvider, role: 'user' | 'assistant', text: string): void {
  try {
    void Promise.resolve(provider.observe?.(role, text)).catch(() => undefined);
  } catch (observeError) {
    console.warn('[agentos] memoryProvider.observe failed:', observeError);
  }
}

/**
 * The usage event surface a turn reports under: `generateText` for a turn
 * folded into a result (`send`, `generate`), `streamText` for a streamed one,
 * the surfaces the same calls report under through `agent()`.
 */
export type GmiTurnSurface = Extract<LlmUsageEvent['surface'], 'generateText' | 'streamText'>;

/** One model call of a turn that was billed or finished. */
interface MeteredCall {
  providerId: string | undefined;
  modelId: string | undefined;
  /** The provider's usage report for the call, if it gave one. */
  usage: unknown;
  /** The gateway hop that served the call; 0 or undefined for the primary. */
  hop: number | undefined;
  finishReason: string;
  /** When the call started, in epoch milliseconds. */
  startedAt: number;
}

/**
 * Meters one model call of a turn where `generateText` and `streamText` meter
 * theirs: a usage event for the process-wide observer (`setGlobalLlmObserver`),
 * fired at once, and a usage ledger row. A turn's calls are metered one by
 * one, each with the provider and model that served it, so a turn that moved
 * to a fallback hop or ran a tool loop reports every request it was billed for.
 *
 * @returns A promise that settles once the ledger row is written, or was not:
 *   a ledger failure is never the caller's error, so it never rejects.
 */
function meterCall(ledger: AgentOSUsageLedgerOptions | undefined, surface: GmiTurnSurface, call: MeteredCall): Promise<void> {
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addModelUsage(usage, call.usage);
  fireLlmUsageObserver({
    provider: call.providerId ?? '',
    model: call.modelId ?? '',
    usage: { ...usage },
    ...(call.hop ? { fallbackDepth: call.hop } : {}),
    finishReason: call.finishReason,
    surface,
    durationMs: Date.now() - call.startedAt,
  });
  // Imported on use, as agent() imports it: the ledger reads and writes files.
  return import('./usageLedger.js')
    .then(({ recordAgentOSUsage }) => recordAgentOSUsage({ providerId: call.providerId, modelId: call.modelId, usage, options: ledger }))
    .then(
      () => undefined,
      () => undefined,
    );
}

/** `onAfterGeneration` for one finished step: a returned text replaces the step's text in the result and in the store. */
async function afterGeneration(opts: AgentOptions, folder: GmiTurnFolder, step: StepFinishedChunkPayload, calls: ToolCallRequest[]): Promise<void> {
  if (!opts.onAfterGeneration) return;
  const usage: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addModelUsage(usage, step.usage);
  try {
    const modified = await opts.onAfterGeneration({
      text: folder.stepText(step),
      toolCalls: calls.map((call) => ({ name: call.name, args: call.arguments })),
      usage,
      step: step.stepIndex,
      ...(step.cacheDiagnostics !== undefined ? { cacheDiagnostics: step.cacheDiagnostics as GenerateTextResult['cacheDiagnostics'] } : {}),
    });
    // A schema answer stays the JSON the schema validated.
    if (modified && typeof modified.text === 'string' && step.structuredOutput === undefined) {
      folder.overrideStepText(step.stepIndex, modified.text);
    }
  } catch (hookError) {
    console.warn('[agentos] onAfterGeneration hook error:', hookError);
  }
}

/**
 * Runs one GMI turn and yields its chunks, pushing each into `folder`, writing
 * each finished step to the session store and metering each model call (a
 * usage ledger row and a usage observer event). The caller folds the chunks
 * (send) or streams them (stream).
 *
 * The turn reads the store's epoch and messages the moment it holds the lock,
 * before it waits for its GMI or its memory context, so a clear or reseed during
 * those waits makes the turn's writes no-ops, as an in-flight legacy send's are.
 *
 * @param surface - The surface the turn's usage events name: `generateText`
 *   for a folded turn (the default), `streamText` for a streamed one.
 * @returns The messages the turn added to the store (or would have, with no history).
 */
export async function* runGmiTurn(
  deps: GmiSessionDeps,
  input: MessageContent,
  turn: GmiTurnOptions,
  folder: GmiTurnFolder,
  surface: GmiTurnSurface = 'generateText',
): AsyncGenerator<GMIOutputChunk, SessionTranscriptMessage[], undefined> {
  const release = await deps.lock.acquire();
  const recorded: SessionTranscriptMessage[] = [];
  let writer: SessionTurnWriter | undefined;
  let ended = false;
  let releaseGmi: (() => Promise<void>) | undefined;
  // The turn's usage ledger writes, awaited before the turn ends.
  const ledgerWrites: Array<Promise<void>> = [];
  const userMessage: SessionTranscriptMessage = { role: 'user', content: input };
  // False until a step is kept with the turn's user message in front of it.
  let userMessageKept = false;
  let pending: { step: StepFinishedChunkPayload; calls: ToolCallRequest[]; results: ToolResultChunkPayload[] } | undefined;
  // Writes the last finished step once its tool results are in. The turn's user
  // message goes with the first step the store keeps: when the store refuses a
  // step (a tool call left unanswered, two calls under one id), the message
  // waits for the next one, so no later step is stored without the message it
  // answers.
  const flush = (): void => {
    if (!pending) return;
    const messages = stepToTranscript({
      step: pending.step,
      calls: pending.calls,
      results: pending.results,
      userMessage: userMessageKept ? undefined : userMessage,
      textOverride: folder.stepText(pending.step),
    });
    if (!writer || writer.appendStep(messages)) {
      recorded.push(...messages);
      userMessageKept = true;
    }
    pending = undefined;
  };

  try {
    // What the turn starts from, read together before any wait.
    const epochAtStart = deps.history?.epoch();
    const priorMessages = deps.history ? deps.history.messages() : [];
    const userText = typeof input === 'string' ? input : extractTextFromContent(input);

    const served = await deps.gmiFor();
    releaseGmi = served.release;
    const gmi = served.gmi;
    gmi.replaceHistory?.(transcriptToConversation(priorMessages));
    const memoryContext = deps.useMemoryProviderContext ? await memoryProviderContext(deps.opts, userText) : undefined;
    served.prepare?.({
      prompt: typeof input === 'string' ? input : undefined,
      memoryContext,
      onModelCall: ({ providerId, modelId }) => folder.route(providerId, modelId),
    });
    writer = deps.history?.beginTurn(turn.blockLabel, epochAtStart);

    const turnInput: GMITurnInput = {
      interactionId: `turn-${randomUUID()}`,
      userId: deps.userId,
      sessionId: deps.sessionId,
      type: typeof input === 'string' ? GMIInteractionType.TEXT : GMIInteractionType.MULTIMODAL_CONTENT,
      content: input as GMITurnInput['content'],
      metadata: {
        providerUserId: deps.providerUserId ?? null,
        options: {
          ...(turn.options ?? {}),
          ...(turn.responseSchema ? { responseSchema: turn.responseSchema, schemaName: turn.schemaName ?? 'response' } : {}),
          ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
        },
      },
    };

    let stepCalls: ToolCallRequest[] = [];
    // When the model call in progress started: the turn's start, the end of the
    // tool round before it, or the failure of the attempt it replaces.
    let callStartedAt = Date.now();
    for await (const chunk of gmi.processTurnStream(turnInput)) {
      folder.push(chunk);
      switch (chunk.type) {
        case GMIOutputChunkType.TOOL_CALL_REQUEST:
          stepCalls.push(...((chunk.content as ToolCallRequest[]) ?? []));
          break;
        case GMIOutputChunkType.STEP_FINISHED: {
          flush();
          const step = chunk.content as StepFinishedChunkPayload;
          await afterGeneration(deps.opts, folder, step, stepCalls);
          pending = { step, calls: stepCalls, results: [] };
          stepCalls = [];
          ledgerWrites.push(
            meterCall(deps.ledger, surface, {
              providerId: step.providerId,
              modelId: step.modelId,
              usage: step.usage,
              hop: step.hop,
              // A schema answer is the step's reply, whatever stop reason carried it.
              finishReason: step.structuredOutput !== undefined ? 'stop' : normalizeStreamFinishReason(step.finishReason),
              startedAt: callStartedAt,
            }),
          );
          callStartedAt = Date.now();
          break;
        }
        case GMIOutputChunkType.TOOL_RESULT:
          pending?.results.push(chunk.content as ToolResultChunkPayload);
          callStartedAt = Date.now();
          break;
        case GMIOutputChunkType.USAGE_UPDATE: {
          // A failed attempt that was billed (before any output, or a step that failed after it): no step carries it.
          const meta = chunk.metadata as { attemptFailed?: boolean; providerId?: string; modelId?: string; hop?: number } | undefined;
          if (meta?.attemptFailed) {
            ledgerWrites.push(
              meterCall(deps.ledger, surface, {
                providerId: meta.providerId,
                modelId: meta.modelId,
                usage: chunk.content,
                hop: meta.hop,
                finishReason: 'error',
                startedAt: callStartedAt,
              }),
            );
            callStartedAt = Date.now();
          }
          break;
        }
        default:
          break;
      }
      yield chunk;
    }
    flush();
    ended = true;
    if (folder.error()) {
      writer?.abort({ partial: true });
    } else {
      try {
        turn.acceptReply?.();
      } catch (refusal) {
        // A refused reply leaves nothing of the turn behind.
        writer?.abort();
        throw refusal;
      }
      writer?.commit();
      const memoryProvider = deps.opts.memoryProvider;
      if (memoryProvider?.observe) {
        observeTurn(memoryProvider, 'user', userText);
        const reply = folder.text();
        if (reply) observeTurn(memoryProvider, 'assistant', reply);
      }
    }
    return recorded;
  } catch (error) {
    folder.fail(error);
    flush();
    ended = true;
    writer?.abort({ partial: true });
    throw error;
  } finally {
    try {
      // A turn its consumer stopped reading keeps the steps that finished, marked partial.
      if (!ended) {
        flush();
        writer?.abort({ partial: true });
      }
      const usage = folder.usage();
      if (usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0) deps.onUsage(usage);
      // The ledger holds the turn before the turn ends, as it holds a call before
      // generateText returns: with the ledger enabled, usage() reads it alone, and
      // a process that exits once the call returns keeps the turn's rows.
      await Promise.all(ledgerWrites);
    } finally {
      // Whatever the lines above threw, the next turn gets the lock.
      if (releaseGmi) void releaseGmi().catch(() => undefined);
      release();
    }
  }
}

/** Parses a structured send's answer: the schema tool's arguments when a step carried them, else the reply text. */
function parseStructured(folder: GmiTurnFolder, schema: ZodType): unknown {
  const structured = folder.structuredOutput();
  let raw: unknown = structured;
  if (structured === undefined || typeof structured === 'string') {
    const source = typeof structured === 'string' ? structured : folder.text();
    try {
      raw = JSON.parse(source);
    } catch (err) {
      throw new ObjectGenerationError(
        `session.send: provider response is not valid JSON despite enforcement (${err instanceof Error ? err.message : String(err)})`,
        source,
      );
    }
  }
  const safe = schema.safeParse(raw);
  if (!safe.success) {
    throw new ObjectGenerationError('session.send: provider-enforced JSON failed Zod validation', folder.text(), safe.error);
  }
  return safe.data;
}

/**
 * `send()`: the whole turn, folded into a `GenerateTextResult` (with `object`
 * when a schema was given). Rejects with the GMI's error, its code kept, when
 * the turn failed; an error thrown before the turn ran (no provider or model
 * resolves, the memory cannot be built) is rethrown as it was thrown. A
 * structured answer is parsed before the session keeps the turn, so one that
 * does not parse or validate rejects with `ObjectGenerationError` and leaves
 * nothing in the history.
 */
export async function sendGmiTurn(
  deps: GmiSessionDeps,
  input: MessageContent,
  turn: GmiTurnOptions,
): Promise<GenerateTextResult & { object?: unknown }> {
  const folder = new GmiTurnFolder({ cacheDiagnostics: Boolean(turn.options?.cacheDiagnostics) });
  const schema = turn.responseSchema;
  let object: unknown;
  const checked: GmiTurnOptions = schema
    ? {
        ...turn,
        acceptReply: () => {
          object = parseStructured(folder, schema);
        },
      }
    : turn;
  const run = runGmiTurn(deps, input, checked, folder);
  let recorded: SessionTranscriptMessage[] = [];
  for (;;) {
    const next = await run.next();
    if (next.done) {
      recorded = next.value;
      break;
    }
  }
  const error = folder.toError();
  if (error) throw error;
  const result = folder.toGenerateTextResult(recorded);
  if (!schema) return result;
  return { ...result, object };
}

/**
 * `stream()`: the turn's chunks as a `StreamTextResult`. The promises settle
 * after the turn is written to the session store, so a caller that awaits
 * `text` and sends again finds the turn in the history. A consumer that stops
 * reading `textStream` or `fullStream` stops the turn, as streamText's
 * consumer stops its generator: the model call in progress is aborted.
 */
export function streamGmiTurn(deps: GmiSessionDeps, input: MessageContent, turn: GmiTurnOptions): StreamTextResult {
  const folder = new GmiTurnFolder({ cacheDiagnostics: Boolean(turn.options?.cacheDiagnostics) });
  // The turn stops when the caller's signal aborts (a session's close()) or when
  // the consumer stops reading. The listener on the caller's signal, which
  // outlives the turn, goes once the turn has ended.
  const stop = new AbortController();
  const forwardAbort = (): void => stop.abort();
  if (turn.abortSignal?.aborted) stop.abort();
  else turn.abortSignal?.addEventListener('abort', forwardAbort, { once: true });
  const run = runGmiTurn(deps, input, { ...turn, abortSignal: stop.signal }, folder, 'streamText');
  const chunks = (async function* () {
    try {
      return yield* run;
    } finally {
      turn.abortSignal?.removeEventListener('abort', forwardAbort);
    }
  })();
  // runGmiTurn pushes every chunk into `folder` (with the onAfterGeneration replacements); the stream reads that folder.
  return streamFromGmiTurn(chunks, { folder, stop: () => stop.abort() });
}
