/**
 * @file gmiSession.ts
 * One agent session served by one GMI (`agent({ runtime: 'gmi' })`, spec D10).
 *
 * The session store is the source of truth: before every turn the GMI's history
 * is replaced with the store's messages, and as the turn runs each finished
 * model step is written to the store through a turn writer; a turn that fails
 * after some steps keeps them, marked partial. One turn runs at a time per
 * session. Each step's usage goes to the usage ledger with the provider and
 * model that served it.
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
import type { StreamTextResult } from '../streamText.js';
import { ObjectGenerationError } from '../generateObject.js';
import type { SessionHistoryBuffer, SessionTurnWriter } from '../sessionHistory.js';
import type { SessionTranscriptMessage } from '../sessionTranscript.js';
import type { AgentOptions } from '../agent.js';
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
  /** The user the GMI runs the turn as: it scopes cognitive memory, and the GMI passes it to the provider as its user field. */
  userId: string;
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

/** One usage ledger event; a ledger failure is never the caller's error. */
function recordLedgerUsage(ledger: AgentOSUsageLedgerOptions | undefined, providerId: string | undefined, modelId: string | undefined, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const total: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  addModelUsage(total, usage);
  // Imported on use, as agent() imports it: the ledger reads and writes files.
  void import('./usageLedger.js')
    .then(({ recordAgentOSUsage }) => recordAgentOSUsage({ providerId, modelId, usage: total, options: ledger }))
    .catch(() => undefined);
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
 * each finished step to the session store and each step's usage to the ledger.
 * The caller folds the chunks (send) or streams them (stream).
 *
 * The turn reads the store's epoch and messages the moment it holds the lock,
 * before it waits for its GMI or its memory context, so a clear or reseed during
 * those waits makes the turn's writes no-ops, as an in-flight legacy send's are.
 *
 * @returns The messages the turn added to the store (or would have, with no history).
 */
export async function* runGmiTurn(
  deps: GmiSessionDeps,
  input: MessageContent,
  turn: GmiTurnOptions,
  folder: GmiTurnFolder,
): AsyncGenerator<GMIOutputChunk, SessionTranscriptMessage[], undefined> {
  const release = await deps.lock.acquire();
  const recorded: SessionTranscriptMessage[] = [];
  let writer: SessionTurnWriter | undefined;
  let ended = false;
  let releaseGmi: (() => Promise<void>) | undefined;
  const userMessage: SessionTranscriptMessage = { role: 'user', content: input };
  let pending: { step: StepFinishedChunkPayload; calls: ToolCallRequest[]; results: ToolResultChunkPayload[]; first: boolean } | undefined;
  // Writes the last finished step once its tool results are in.
  const flush = (): void => {
    if (!pending) return;
    const messages = stepToTranscript({
      step: pending.step,
      calls: pending.calls,
      results: pending.results,
      userMessage: pending.first ? userMessage : undefined,
      textOverride: folder.stepText(pending.step),
    });
    if (!writer || writer.appendStep(messages)) recorded.push(...messages);
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
        options: {
          ...(turn.options ?? {}),
          ...(turn.responseSchema ? { responseSchema: turn.responseSchema, schemaName: turn.schemaName ?? 'response' } : {}),
          ...(turn.abortSignal ? { abortSignal: turn.abortSignal } : {}),
        },
      },
    };

    let stepCalls: ToolCallRequest[] = [];
    let firstStep = true;
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
          pending = { step, calls: stepCalls, results: [], first: firstStep };
          stepCalls = [];
          firstStep = false;
          recordLedgerUsage(deps.ledger, step.providerId, step.modelId, step.usage);
          break;
        }
        case GMIOutputChunkType.TOOL_RESULT:
          pending?.results.push(chunk.content as ToolResultChunkPayload);
          break;
        case GMIOutputChunkType.USAGE_UPDATE: {
          // A failed attempt that was billed (before any output, or a step that failed after it): no step carries it.
          const meta = chunk.metadata as { attemptFailed?: boolean; providerId?: string; modelId?: string } | undefined;
          if (meta?.attemptFailed) recordLedgerUsage(deps.ledger, meta.providerId, meta.modelId, chunk.content);
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
      writer?.commit();
      const observe = deps.opts.memoryProvider?.observe;
      if (observe) {
        void observe('user', userText).catch(() => undefined);
        const reply = folder.text();
        if (reply) void observe('assistant', reply).catch(() => undefined);
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
    // A turn its consumer stopped reading keeps the steps that finished, marked partial.
    if (!ended) {
      flush();
      writer?.abort({ partial: true });
    }
    const usage = folder.usage();
    if (usage.totalTokens > 0 || usage.promptTokens > 0 || usage.completionTokens > 0) deps.onUsage(usage);
    if (releaseGmi) void releaseGmi().catch(() => undefined);
    release();
  }
}

/** Parses a structured send's answer: the schema tool's arguments when a step carried them, else the reply text. */
function parseStructured(folder: GmiTurnFolder, result: GenerateTextResult, schema: ZodType): unknown {
  const structured = folder.structuredOutput();
  let raw: unknown = structured;
  if (structured === undefined || typeof structured === 'string') {
    const source = typeof structured === 'string' ? structured : result.text;
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
    throw new ObjectGenerationError('session.send: provider-enforced JSON failed Zod validation', result.text, safe.error);
  }
  return safe.data;
}

/**
 * `send()`: the whole turn, folded into a `GenerateTextResult` (with `object`
 * when a schema was given). Rejects with the GMI's error, its code kept, when
 * the turn failed; an error thrown before the turn ran (no provider or model
 * resolves, the memory cannot be built) is rethrown as it was thrown.
 */
export async function sendGmiTurn(
  deps: GmiSessionDeps,
  input: MessageContent,
  turn: GmiTurnOptions,
): Promise<GenerateTextResult & { object?: unknown }> {
  const folder = new GmiTurnFolder({ cacheDiagnostics: Boolean(turn.options?.cacheDiagnostics) });
  const run = runGmiTurn(deps, input, turn, folder);
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
  if (!turn.responseSchema) return result;
  return { ...result, object: parseStructured(folder, result, turn.responseSchema) };
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
  const stop = new AbortController();
  turn.abortSignal?.addEventListener('abort', () => stop.abort(), { once: true });
  const run = runGmiTurn(deps, input, { ...turn, abortSignal: stop.signal }, folder);
  // runGmiTurn pushes every chunk into `folder` (with the onAfterGeneration replacements); the stream reads that folder.
  return streamFromGmiTurn({ [Symbol.asyncIterator]: () => run }, { folder, stop: () => stop.abort() });
}
