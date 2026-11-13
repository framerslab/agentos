/**
 * @module api/runtime/textGuardrails
 *
 * The `guards` option of generateText() and streamText(). One run per call: the call's own user turn is judged once
 * before the first provider request, every tool call before any hook and on the arguments the model sent, and the
 * whole reply before the caller receives it. Every guard runs closed unless its config says otherwise. The report,
 * the verdicts and the stop error carry codes and ids and none of the text.
 */
import { randomUUID } from 'node:crypto';
import type { AgentOSInput } from '../types/AgentOSInput.js';
import {
  AgentOSResponseChunkType,
  type AgentOSFinalResponseChunk,
  type AgentOSMetadataUpdateChunk,
  type AgentOSResponse,
  type AgentOSTextDeltaChunk,
  type AgentOSToolCallRequestChunk,
} from '../types/AgentOSResponse.js';
import type { VisionInputData } from '../../cognition/substrate/IGMI.js';
import type { CacheDiagnostics } from '../../core/llm/providers/IProvider.js';
import { listedErrorFields } from '../../core/logging/events.js';
import { GuardrailAction, type GuardrailContext, type GuardrailEvaluationResult, type GuardrailHold, type IGuardrailService } from '../../safety/guardrails/IGuardrailService.js';
import { toModerationEvaluation, wrapOutputGuardrails, type GuardrailOutputVerdict, type ModerationEvaluation } from '../../safety/guardrails/guardrailDispatcher.js';
import { ParallelGuardrailDispatcher } from '../../safety/guardrails/ParallelGuardrailDispatcher.js';
import { assertModerationContext } from '../../safety/guardrails/ModerationContext.js';
import { namedGuard, withModerationPosture } from '../../safety/guardrails/requiredGuardrails.js';
import { pickModerationOutcome, writeVerdictLine } from '../../safety/guardrails/contentModeration.js';
import { guardrailLog } from '../../safety/guardrails/log.js';
import { GuardrailStopError } from '../errors.js';
import type { FallbackSignal, GenerateTextOptions, GenerateTextResult, MessageContent, MessageContentPart, TokenUsage, ToolCallRecord } from '../generateText.js';
import type { StreamFinishReason, StreamPart, StreamTextResult } from '../streamText.js';

/** The `guards` option: a host's guards, enforced on one call. */
export interface TextGuardrailOptions {
  /** The guards, in registration order. */
  services: IGuardrailService[];
  /** Who the call is for and where it happens. */
  context: GuardrailContext;
  /**
   * `enforce` (default) applies every verdict. `dryRun` evaluates every guard and reports each verdict with
   * `enforced: false`; the input, the tool calls and the reply pass unchanged.
   */
  mode?: 'enforce' | 'dryRun';
  /** The stages that run. Default: every stage some guard implements. */
  stages?: ReadonlyArray<'input' | 'toolCalls' | 'output'>;
  /**
   * streamText only. `hold` (default): no text part is delivered before the final guards have judged the whole
   * reply. `stream`: text flows as it arrives; only guards with `evaluateStreamingChunks` can stop it mid-stream, and
   * a final block arrives as an error part after the text.
   */
  output?: 'hold' | 'stream';
  /** The deadline for a guard whose config sets none. Default 8000 ms. */
  timeoutMs?: number;
  /** Called with every verdict, enforced or not. A throw is written as an event and ignored. */
  onVerdict?: (verdict: TextGuardrailVerdict) => void | Promise<void>;
}

/** One stage decision, as `onVerdict` receives it. */
export interface TextGuardrailVerdict {
  stage: 'input' | 'toolCall' | 'output';
  action: GuardrailAction;
  hold?: GuardrailHold;
  enforced: boolean;
  /** Nothing but a guard that threw, timed out or answered nonsense decided it. */
  unavailable: boolean;
  guardrailId?: string;
  reasonCode?: string;
  /**
   * The module's own number for the call, `tc_<step>_<index>` (step from 1, index from 0 in the order the model
   * listed the step's calls); never the provider's or the model's call id.
   */
  toolCallId?: string;
  /** The name of the registered tool the call named, as the host registered it; `unregistered` when the model named no tool of the call's list. */
  toolName?: string;
  /** Output stage: the reply as the guards judged it and as the caller receives it. Null on the other stages. */
  originalText: string | null;
  finalText: string | null;
}

/** What each stage's guards answered on one call, as codes and ids. */
export interface TextGuardrailReport {
  mode: 'enforce' | 'dryRun';
  input: ModerationEvaluation[];
  /** `toolCallId` and `toolName` as on `TextGuardrailVerdict`: the module's number and a registered name or `unregistered`. */
  toolCalls: Array<{ toolCallId: string; toolName: string; evaluations: ModerationEvaluation[] }>;
  output: ModerationEvaluation[];
  /**
   * `passed`: nothing changed. `sanitized`: a guard rewrote the input or the reply. `replaced`: a fixed reply took its
   * place. `stopped`: the call ended in a `GuardrailStopError`, whose `report` this is.
   */
  result: 'passed' | 'sanitized' | 'replaced' | 'stopped';
}

/** The sentence a refused tool call's result carries. */
export const TOOL_CALL_REFUSED = 'This tool call was refused by a guardrail.';

/** What a tool loop does with a refused call: the error it records and the result it sends the model. */
export interface ToolCallRefusal { error: string; result: { refused: true; error: string; reasonCode?: string } }

/** @internal One guarded call's handle, carried by every leg's options so each tool loop can ask about a call. */
export interface TextGuardRun {
  /** Judges one call before any hook. `step` counts from 0 across the call, `index` is the call's place in its step. Null lets the call run. */
  judgeToolCall(call: { name: string; args: unknown; step: number; index: number; registered: boolean }): Promise<ToolCallRefusal | null>;
  /**
   * Whether the output guards block the model's refusal message, judged once for the call: the wrapper reads the
   * same verdict when it delivers the message. False in a dry run, which blocks nothing.
   */
  judgeRefusal?(message: string): Promise<boolean>;
}

/**
 * @internal How the output guards end a call whose model refused with `refusal`, for the call's root span and usage
 * event, which are written before the wrapper delivers the message: `'blocked'` when they block it, `'aborted'` when
 * the caller's signal fired while they judged it, else undefined (no guards, an empty message, a message they pass).
 */
export async function refusalGuardEnd(
  run: TextGuardRun | undefined,
  refusal: string | undefined,
  signal: AbortSignal | undefined,
): Promise<'blocked' | 'aborted' | undefined> {
  if (!run?.judgeRefusal || !refusal) return undefined;
  let blocked = false;
  try {
    blocked = await run.judgeRefusal(refusal);
  } catch {
    // a guard pipe that failed is the wrapper's to report, as it reports it for the message
  }
  if (signal?.aborted) return 'aborted';
  return blocked ? 'blocked' : undefined;
}

interface Decided { evaluation: GuardrailEvaluationResult; outcome: 'refuse' | 'hold' | 'flag'; unavailable: boolean }
type OutputEnd = { kind: 'passed' | 'sanitized' | 'replaced' } | { kind: 'stopped'; decided: Decided } | { kind: 'failed'; error: Error };
interface UserTurn { text: string; images: VisionInputData[] }

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/** What the input stage did with the turn, by report: an answer that left the text as it was is `passed`. */
const inputDecisions = new WeakMap<TextGuardrailReport, 'passed' | 'sanitized' | 'replaced' | 'stopped'>();
/**
 * @internal What an enforced input stage did with the call's turn: `sanitized` (the text sent is not the caller's),
 * `replaced`, `stopped`, or `passed` (sent as given, a sanitizer that returned the same text included). Undefined for
 * a report this module did not make.
 */
export function inputDecisionOf(report: TextGuardrailReport | undefined): 'passed' | 'sanitized' | 'replaced' | 'stopped' | undefined {
  return report ? inputDecisions.get(report) : undefined;
}

/** What decides a list in the moderation order (a rule's BLOCK, else a hold, else a closed guard's failure, else a FLAG). */
function decide(evaluations: readonly GuardrailEvaluationResult[]): Decided | undefined {
  const pick = pickModerationOutcome(evaluations);
  return pick.evaluation && pick.outcome !== 'allow' ? { evaluation: pick.evaluation, outcome: pick.outcome, unavailable: pick.unavailable } : undefined;
}
/** The BLOCK that decides a list in the moderation order, when one does. */
function blockOf(evaluations: readonly GuardrailEvaluationResult[]): GuardrailEvaluationResult | undefined {
  const decided = decide(evaluations);
  return decided && decided.outcome !== 'flag' ? decided.evaluation : undefined;
}
const idOf = (reported: ModerationEvaluation): string | undefined => (typeof reported.metadata?.guardrailId === 'string' ? reported.metadata.guardrailId : undefined);

function textOf(content: MessageContent): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content.filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof (p as { text?: unknown }).text === 'string').map((p) => p.text).join('\n');
}
/** The image parts of a turn as guards read them: a data URL as its bytes, any other URL as a URL. */
function imagesOf(content: MessageContent): VisionInputData[] {
  if (!Array.isArray(content)) return [];
  const images: VisionInputData[] = [];
  for (const part of content) {
    const url = part.type === 'image_url' ? (part as { image_url?: { url?: unknown } }).image_url?.url : undefined;
    if (typeof url !== 'string') continue;
    const data = /^data:([^;,]+);base64,(.*)$/s.exec(url);
    images.push(data ? { type: 'base64', data: data[2], mimeType: data[1] } : { type: 'image_url', data: url });
  }
  return images;
}
/** The call's own user turn: `prompt`, else the last message when its role is `user`. A call that ends on another role has none. */
function userTurnOf(opts: GenerateTextOptions): UserTurn | undefined {
  if (typeof opts.prompt === 'string' && opts.prompt.length > 0) return { text: opts.prompt, images: [] };
  const last = opts.messages?.[opts.messages.length - 1];
  if (!last || last.role !== 'user') return undefined;
  return { text: textOf(last.content), images: imagesOf(last.content) };
}
/** The options with the user turn's text replaced. In multi-part content one text part takes the place of the text parts; the other parts stay. */
function withTurnText(opts: GenerateTextOptions, text: string): GenerateTextOptions {
  // an emptied prompt is still the turn: the text functions send it, where a caller's empty prompt adds none
  if (typeof opts.prompt === 'string' && opts.prompt.length > 0) return { ...opts, prompt: text, ...(text.length === 0 ? { __emptyPrompt: true } : {}) };
  const messages = [...(opts.messages ?? [])];
  const last = messages[messages.length - 1];
  if (!last) return opts;
  let content: MessageContent = text;
  if (Array.isArray(last.content)) {
    const first = last.content.findIndex((p) => p.type === 'text');
    const rest: MessageContentPart[] = last.content.filter((p) => p.type !== 'text');
    rest.splice(first === -1 ? rest.length : first, 0, { type: 'text', text });
    content = rest;
  }
  messages[messages.length - 1] = { ...last, content };
  return { ...opts, messages };
}
/**
 * The delta with its last assistant entry holding the delivered text and nothing of the reply a guard took out. When
 * the step limit ended the call on a tool step, the reply is that step's text: its entry keeps its tool calls and
 * their thinking (each tool result after it answers one of those calls) and holds the delivered text in place of its own.
 */
function deliveredDelta(delta: GenerateTextResult['transcriptDelta'], text: string): GenerateTextResult['transcriptDelta'] {
  if (!delta || delta.length === 0) return delta;
  let at = delta.length - 1;
  while (at >= 0 && (delta[at] as { role?: string }).role !== 'assistant') at -= 1;
  if (at < 0) return delta;
  const entry = at === delta.length - 1 ? { role: 'assistant', content: text } : { ...delta[at], content: text };
  return [...delta.slice(0, at), entry as (typeof delta)[number], ...delta.slice(at + 1)];
}
function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void } {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

class GuardRun implements TextGuardRun {
  readonly mode: 'enforce' | 'dryRun';
  readonly report: TextGuardrailReport;
  private readonly streamId = randomUUID();
  private readonly context: GuardrailContext;
  private readonly named: IGuardrailService[];
  private readonly inputGuards: IGuardrailService[];
  private readonly outputGuards: IGuardrailService[];
  private readonly toolGuards: IGuardrailService[];
  /** The verdict on the model's refusal message, judged once however often it is asked for. */
  private refusalJudged?: { message: string; judged: Promise<{ end: OutputEnd; text: string }> };

  constructor(private readonly options: TextGuardrailOptions) {
    const mode = options.mode ?? 'enforce';
    // any other value would report enforced: false beside verdicts that were enforced
    if (mode !== 'enforce' && mode !== 'dryRun') throw new TypeError("guards: mode must be 'enforce' or 'dryRun'");
    if (!Array.isArray(options.services)) throw new TypeError('guards: services must be an array of guards');
    if (options.context.moderation !== undefined) assertModerationContext(options.context.moderation);
    this.mode = mode;
    this.context = options.context;
    this.report = { mode: this.mode, input: [], toolCalls: [], output: [], result: 'passed' };
    this.named = options.services.map((svc, index) => namedGuard(svc, index));
    const postured = this.named.map((svc) => withModerationPosture(svc, { timeoutMs: options.timeoutMs }));
    const wanted = (stage: 'input' | 'toolCalls' | 'output'): boolean => options.stages === undefined || options.stages.includes(stage);
    const declares = (svc: IGuardrailService, stage: 'input' | 'output'): boolean => svc.stages === undefined || svc.stages.includes(stage);
    this.inputGuards = wanted('input') ? postured.filter((svc) => typeof svc.evaluateInput === 'function' && declares(svc, 'input')) : [];
    this.outputGuards = wanted('output') ? postured.filter((svc) => typeof svc.evaluateOutput === 'function' && declares(svc, 'output')) : [];
    this.toolGuards = wanted('toolCalls') ? postured.filter((svc) => typeof svc.evaluateOutput === 'function' && svc.config?.evaluateToolCalls === true && declares(svc, 'output')) : [];
  }

  /** One verdict: its line, then the host's callback. A callback that throws is written and ignored. */
  private async emit(
    stage: TextGuardrailVerdict['stage'],
    evaluation: GuardrailEvaluationResult,
    action: GuardrailAction,
    unavailable: boolean,
    extra: Partial<Pick<TextGuardrailVerdict, 'toolCallId' | 'toolName' | 'originalText' | 'finalText' | 'enforced'>> = {},
  ): Promise<void> {
    const reported = toModerationEvaluation(evaluation);
    writeVerdictLine({
      evaluation,
      action: action === GuardrailAction.BLOCK ? (reported.hold ? 'hold' : 'block') : action === GuardrailAction.SANITIZE ? 'sanitize' : 'flag',
      stage: stage === 'toolCall' ? 'tool_call' : stage,
      guards: this.named,
      surface: this.context.moderation?.surface,
      mode: this.mode,
      unavailable,
    });
    if (!this.options.onVerdict) return;
    const guardrailId = idOf(reported);
    const verdict: TextGuardrailVerdict = {
      stage,
      action,
      enforced: this.mode === 'enforce',
      unavailable,
      ...(reported.hold ? { hold: reported.hold } : {}),
      ...(guardrailId !== undefined ? { guardrailId } : {}),
      ...(reported.reasonCode !== undefined ? { reasonCode: reported.reasonCode } : {}),
      originalText: null,
      finalText: null,
      ...extra,
    };
    try {
      await this.options.onVerdict(verdict);
    } catch (error) {
      guardrailLog.warn('guardrail.verdict_callback_failed', listedErrorFields(error));
    }
  }

  /** The error a stop rejects with, or a stream yields. */
  stop(stage: 'input' | 'output', decided: Decided, usage?: TokenUsage): GuardrailStopError {
    this.report.result = 'stopped';
    const reported = toModerationEvaluation(decided.evaluation);
    const guardrailId = idOf(reported);
    return new GuardrailStopError({
      code: decided.unavailable ? 'GUARDRAIL_UNAVAILABLE' : reported.hold ? 'GUARDRAIL_HELD' : 'GUARDRAIL_BLOCKED',
      stage,
      report: this.report,
      ...(reported.reasonCode !== undefined ? { reasonCode: reported.reasonCode } : {}),
      ...(guardrailId !== undefined ? { guardrailId } : {}),
      ...(reported.hold ? { hold: reported.hold as GuardrailHold } : {}),
      ...(usage ? { usage } : {}),
    });
  }

  /** The input stage: once per call, before the first provider request. */
  async judgeInput(turn: UserTurn | undefined): Promise<{ kind: 'pass'; text?: string } | { kind: 'replaced'; text: string } | { kind: 'stopped'; error: GuardrailStopError }> {
    if (!turn || this.inputGuards.length === 0) {
      inputDecisions.set(this.report, 'passed');
      return { kind: 'pass' };
    }
    const input = {
      userId: this.context.userId,
      sessionId: this.context.sessionId,
      textInput: turn.text,
      ...(turn.images.length > 0 ? { visionInputs: turn.images } : {}),
    } as AgentOSInput;
    const outcome = await ParallelGuardrailDispatcher.evaluateInput(this.inputGuards, input, this.context);
    const evaluations = outcome.evaluations ?? [];
    this.report.input = evaluations.map(toModerationEvaluation);
    const decided = decide(evaluations);
    if (decided && decided.outcome !== 'flag') {
      await this.emit('input', decided.evaluation, GuardrailAction.BLOCK, decided.unavailable);
      if (this.mode === 'dryRun') return { kind: 'pass' };
      const replacement = decided.evaluation.replacementText;
      if (typeof replacement === 'string' && replacement.length > 0) {
        this.report.result = 'replaced';
        inputDecisions.set(this.report, 'replaced');
        return { kind: 'replaced', text: replacement };
      }
      inputDecisions.set(this.report, 'stopped');
      return { kind: 'stopped', error: this.stop('input', decided) };
    }
    // a sanitizer that removed the whole text (`modifiedText: null`) leaves the turn with no text, never the original
    const after = outcome.sanitizedInput.textInput;
    const rewritten = typeof after === 'string' ? after : '';
    const rewrite = rewritten !== turn.text ? evaluations.find((e) => e.action === GuardrailAction.SANITIZE) : undefined;
    if (rewrite) {
      await this.emit('input', rewrite, GuardrailAction.SANITIZE, false);
      if (this.mode === 'dryRun') return { kind: 'pass' };
      this.report.result = 'sanitized';
      inputDecisions.set(this.report, 'sanitized');
      return { kind: 'pass', text: rewritten };
    }
    if (decided) await this.emit('input', decided.evaluation, GuardrailAction.FLAG, false);
    inputDecisions.set(this.report, 'passed');
    return { kind: 'pass' };
  }

  /** The tool-call stage: one call, before any hook, as a chunk that holds that call alone under the run's own number. */
  async judgeToolCall(call: { name: string; args: unknown; step: number; index: number; registered: boolean }): Promise<ToolCallRefusal | null> {
    if (this.toolGuards.length === 0) return null;
    const toolCallId = `tc_${call.step + 1}_${call.index}`;
    const toolName = call.registered ? call.name : 'unregistered';
    const chunk = {
      type: AgentOSResponseChunkType.TOOL_CALL_REQUEST,
      streamId: this.streamId,
      gmiInstanceId: 'text-guardrails',
      personaId: this.context.personaId ?? 'text-guardrails',
      isFinal: false,
      timestamp: new Date().toISOString(),
      toolCalls: [{ id: toolCallId, name: call.name, arguments: (call.args ?? {}) as Record<string, unknown> }],
      executionMode: 'internal',
      requiresExternalToolResult: false,
    } as AgentOSToolCallRequestChunk;
    // The picker sees every evaluation that can end the call, a screen's BLOCK included, and picks in the moderation order.
    let all: readonly GuardrailEvaluationResult[] = [];
    const verdict = await ParallelGuardrailDispatcher.evaluateToolCall(this.toolGuards, this.context, chunk, undefined, (evaluations) => {
      all = evaluations;
      return blockOf(evaluations);
    });
    if (verdict.outcome === 'pass') all = verdict.evaluations;
    else if (all.length === 0) all = [verdict.evaluation];
    if (all.length === 0) return null;
    this.report.toolCalls.push({ toolCallId, toolName, evaluations: all.map(toModerationEvaluation) });
    const decided = decide(all);
    if (!decided) return null;
    const refused = decided.outcome !== 'flag';
    await this.emit('toolCall', decided.evaluation, refused ? GuardrailAction.BLOCK : GuardrailAction.FLAG, decided.unavailable, { toolCallId, toolName });
    if (!refused || this.mode === 'dryRun') return null;
    const reasonCode = toModerationEvaluation(decided.evaluation).reasonCode;
    return { error: TOOL_CALL_REFUSED, result: { refused: true, error: TOOL_CALL_REFUSED, ...(reasonCode !== undefined ? { reasonCode } : {}) } };
  }

  /**
   * The reply's parts as the caller may receive them. Text parts pass the output guards (held until the final guards
   * have judged the whole reply when `hold`); every other part passes as it came; the source's own error part is not
   * passed on but reported by `end()`. `end()` is read after `parts` has ended.
   */
  guardOutput(source: AsyncIterable<StreamPart>, hold: boolean): { parts: AsyncGenerator<StreamPart, void, undefined>; end(): OutputEnd } {
    let end: OutputEnd = { kind: 'passed' };
    // the nested generator below cannot see `this`
    const { mode, report, context, streamId, outputGuards } = this;
    const emit = this.emit.bind(this);
    const base = { streamId: this.streamId, gmiInstanceId: 'text-guardrails', personaId: this.context.personaId ?? 'text-guardrails' };
    async function* parts(): AsyncGenerator<StreamPart, void, undefined> {
      let original = '';
      let failed: Error | undefined;
      async function* chunks(): AsyncGenerator<AgentOSResponse, void, undefined> {
        for await (const part of source) {
          const timestamp = new Date().toISOString();
          if (part.type === 'text') {
            original += part.text;
            yield { ...base, type: AgentOSResponseChunkType.TEXT_DELTA, isFinal: false, timestamp, textDelta: part.text } as AgentOSResponse;
          } else if (part.type === 'error') {
            failed = part.error;
            return; // no final chunk: text the guards held is dropped unjudged
          } else {
            yield { ...base, type: AgentOSResponseChunkType.METADATA_UPDATE, isFinal: false, timestamp, updates: { streamPart: part } } as AgentOSResponse;
          }
        }
        // an empty reply is not judged
        if (original.length > 0) {
          yield { ...base, type: AgentOSResponseChunkType.FINAL_RESPONSE, isFinal: true, timestamp: new Date().toISOString(), finalResponseText: original } as AgentOSResponse;
        }
      }
      if (outputGuards.length === 0) {
        for await (const chunk of chunks()) {
          if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) yield { type: 'text', text: (chunk as AgentOSTextDeltaChunk).textDelta };
          else if (chunk.type === AgentOSResponseChunkType.METADATA_UPDATE) yield (chunk as AgentOSMetadataUpdateChunk).updates.streamPart as StreamPart;
        }
        if (failed) end = { kind: 'failed', error: failed };
        return;
      }

      let verdict: GuardrailOutputVerdict | undefined;
      let blocked: GuardrailEvaluationResult | undefined;
      const phase: GuardrailEvaluationResult[] = [];
      const attached: GuardrailEvaluationResult[] = [];
      let replacement: string | undefined;
      let rewritten: string | undefined;
      // the text as it went out, which a sanitizer of the streamed deltas may have changed
      let out = '';
      let finished = false;
      // The report and the verdict are settled before the text that follows from them goes out, so a reader that stops
      // after that text still finds them.
      const finish = async (): Promise<void> => {
        if (finished) return;
        finished = true;
        // what every guard answered: the evaluations carried by the chunks that went out, then the phase that decided a block
        report.output.push(...(blocked ? [...attached, ...phase] : attached).map(toModerationEvaluation));
        const judged = verdict?.originalText ?? null;
        if (blocked) {
          const decided = decide(phase) as Decided;
          await emit('output', blocked, GuardrailAction.BLOCK, decided.unavailable, { originalText: judged, finalText: replacement ?? null });
          end = replacement !== undefined ? { kind: 'replaced' } : { kind: 'stopped', decided };
        } else if (verdict?.action === GuardrailAction.SANITIZE) {
          const rewrite = attached.find((e) => e.action === GuardrailAction.SANITIZE);
          if (rewrite) await emit('output', rewrite, GuardrailAction.SANITIZE, false, { originalText: judged, finalText: verdict.finalText, ...(rewritten === undefined ? { enforced: false } : {}) });
          if (rewritten !== undefined) end = { kind: 'sanitized' };
        } else if (!failed && out !== original && attached.some((e) => e.action === GuardrailAction.SANITIZE)) {
          // a sanitizer rewrote the streamed deltas and the final guards passed: the reply is what went out
          const rewrite = attached.find((e) => e.action === GuardrailAction.SANITIZE) as GuardrailEvaluationResult;
          await emit('output', rewrite, GuardrailAction.SANITIZE, false, { originalText: original, finalText: out });
          end = { kind: 'sanitized' };
        } else {
          const flagged = decide(attached);
          if (flagged) await emit('output', flagged.evaluation, GuardrailAction.FLAG, false, { originalText: judged, finalText: judged });
        }
        if (mode === 'enforce' && (end.kind === 'replaced' || end.kind === 'sanitized')) report.result = end.kind;
      };
      const guarded = wrapOutputGuardrails(outputGuards, context, chunks(), {
        streamId,
        holdUntilFinal: hold,
        onVerdict: (v) => { verdict = v; },
        pickBlock: (evaluations) => {
          const block = blockOf(evaluations);
          if (block) { blocked = block; phase.push(...evaluations); }
          return block;
        },
      });
      for await (const chunk of guarded) {
        const entries = (chunk.metadata?.guardrail as { output?: unknown } | undefined)?.output;
        if (Array.isArray(entries) && !blocked) attached.push(...(entries as GuardrailEvaluationResult[]));
        if (chunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
          const delta = (chunk as AgentOSTextDeltaChunk).textDelta;
          out += delta;
          yield { type: 'text', text: delta };
          continue;
        }
        if (chunk.type === AgentOSResponseChunkType.METADATA_UPDATE) {
          const part = (chunk as AgentOSMetadataUpdateChunk).updates?.streamPart as StreamPart | undefined;
          if (part) yield part;
          continue;
        }
        if (chunk.type !== AgentOSResponseChunkType.FINAL_RESPONSE) continue; // the error chunk of a block: the dispatcher ends the stream after it
        const finalText = (chunk as AgentOSFinalResponseChunk).finalResponseText ?? '';
        if (blocked) {
          // a block that carries a fixed reply; in stream mode the text is already out and nothing can take its place
          if (hold) {
            replacement = finalText;
            await finish();
            if (mode === 'enforce') yield { type: 'text', text: finalText };
          }
        } else if (verdict?.action === GuardrailAction.SANITIZE) {
          // the held deltas were dropped; the rewritten reply is one part. In stream mode the original is already out.
          if (hold) {
            rewritten = finalText;
            await finish();
            if (mode === 'enforce') yield { type: 'text', text: finalText };
          }
        }
      }

      await finish();
      if (failed) end = { kind: 'failed', error: failed };
    }
    return { parts: parts(), end: () => end };
  }

  /** The output guards over the model's refusal message, as over a whole reply; one judgement per message. */
  judgeRefusalMessage(message: string): Promise<{ end: OutputEnd; text: string }> {
    if (this.refusalJudged?.message !== message) this.refusalJudged = { message, judged: this.judgeReply(message) };
    return this.refusalJudged.judged;
  }

  async judgeRefusal(message: string): Promise<boolean> {
    if (this.mode === 'dryRun') return false;
    return (await this.judgeRefusalMessage(message)).end.kind === 'stopped';
  }

  /** The output guards over one whole reply: how it ended, and the text the guards deliver. */
  async judgeReply(text: string): Promise<{ end: OutputEnd; text: string }> {
    const one = (async function* (): AsyncGenerator<StreamPart, void, undefined> { yield { type: 'text', text }; })();
    const out = this.guardOutput(one, true);
    let delivered = '';
    for await (const part of out.parts) if (part.type === 'text') delivered += part.text;
    return { end: out.end(), text: delivered };
  }
}

/** generateText() with `guards`: the input stage, the call itself with the run handle in place of the option, the output stage. */
export async function guardedGenerateText(opts: GenerateTextOptions, inner: (opts: GenerateTextOptions) => Promise<GenerateTextResult>): Promise<GenerateTextResult> {
  const run = new GuardRun(opts.guards as TextGuardrailOptions);
  const input = await run.judgeInput(userTurnOf(opts));
  // a caller's abort while the guards judged the prompt ends the call, before a replacement or any request
  opts.abortSignal?.throwIfAborted();
  if (input.kind === 'stopped') throw input.error;
  if (input.kind === 'replaced') {
    // no request was made: nothing was spent and nothing of the refused turn goes into a history
    return { transcriptDelta: [], provider: opts.provider ?? '', model: opts.model ?? '', text: input.text, usage: { ...NO_USAGE }, toolCalls: [], finishReason: 'stop', guardReport: run.report };
  }
  const result = await inner({ ...(input.text !== undefined ? withTurnText(opts, input.text) : opts), guards: undefined, __guardRun: run });
  const judged = await run.judgeReply(result.text);
  // a caller's abort while the guards judged the reply ends the call, as it does while they judge a tool call
  opts.abortSignal?.throwIfAborted();
  // the model's refusal message is text the model wrote: the output guards judge it as they judge the reply
  const refusal = result.refusal ? await run.judgeRefusalMessage(result.refusal) : undefined;
  if (refusal) opts.abortSignal?.throwIfAborted();
  if (run.mode === 'dryRun') return { ...result, guardReport: run.report };
  if (judged.end.kind === 'stopped') throw run.stop('output', judged.end.decided, result.usage);
  if (refusal && refusal.end.kind === 'stopped') throw run.stop('output', refusal.end.decided, result.usage);
  const delivered: GenerateTextResult = { ...result, guardReport: run.report };
  const replyEnd = judged.end.kind;
  if (replyEnd === 'replaced' || replyEnd === 'sanitized') {
    run.report.result = replyEnd;
    delivered.text = judged.text;
    delivered.transcriptDelta = deliveredDelta(result.transcriptDelta, judged.text);
  }
  const refusalEnd = refusal ? refusal.end.kind : undefined;
  if (refusal && (refusalEnd === 'replaced' || refusalEnd === 'sanitized')) {
    run.report.result = refusalEnd;
    // a rewrite that leaves nothing of the message leaves an empty one: the field is what says the model refused
    delivered.refusal = refusal.text;
  }
  return delivered;
}

/**
 * streamText() with `guards`: the same three stages over a stream. `text` resolves as the same call without guards
 * resolves it when the guards changed nothing (a dry run, a reply they passed), else with what was delivered and
 * nothing else.
 */
export function guardedStreamText(opts: GenerateTextOptions, inner: (opts: GenerateTextOptions) => StreamTextResult): StreamTextResult {
  const guards = opts.guards as TextGuardrailOptions;
  const hold = guards.output !== 'stream';
  const text = deferred<string>();
  const finishReason = deferred<StreamFinishReason>();
  const refusal = deferred<string | undefined>();
  const guardReport = deferred<TextGuardrailReport | undefined>();
  const usage = deferred<TokenUsage>();
  const toolCalls = deferred<ToolCallRecord[]>();
  const provider = deferred<string>();
  const model = deferred<string>();
  const responseModel = deferred<string | undefined>();
  const serviceTier = deferred<string | undefined>();
  const fallback = deferred<FallbackSignal | undefined>();
  const cacheDiagnostics = deferred<CacheDiagnostics | null>();
  const providerMessageId = deferred<string | null>();

  async function* runGuarded(): AsyncGenerator<StreamPart> {
    let run: GuardRun | undefined;
    let source: StreamTextResult | undefined;
    let delivered = '';
    // the model's refusal message as the output guards deliver it
    let deliveredRefusal: string | undefined;
    let finish: StreamFinishReason | undefined;
    try {
      run = new GuardRun(guards);
      const input = await run.judgeInput(userTurnOf(opts));
      // a caller's abort while the guards judged the prompt ends the stream with the reason, before any text or request
      opts.abortSignal?.throwIfAborted();
      if (input.kind === 'stopped') {
        finish = 'error';
        yield { type: 'error', error: input.error };
        return;
      }
      if (input.kind === 'replaced') {
        finish = 'stop';
        delivered = input.text;
        yield { type: 'text', text: input.text };
        return;
      }
      source = inner({ ...(input.text !== undefined ? withTurnText(opts, input.text) : opts), guards: undefined, __guardRun: run });
      // the call's routing settles as the inner stream routes, so a reader can await it while the reply is still open
      provider.resolve(source.provider);
      model.resolve(source.model);
      responseModel.resolve(source.responseModel);
      serviceTier.resolve(source.serviceTier);
      if (run.mode === 'dryRun') {
        // nothing is held and nothing is changed; the whole reply is judged once it has been delivered
        let whole = '';
        for await (const part of source.fullStream) {
          if (part.type === 'text') {
            whole += part.text;
            delivered += part.text;
          }
          if (part.type === 'error') finish = 'error';
          yield part;
        }
        if (finish !== 'error') {
          await run.judgeReply(whole);
          // the refusal message is judged as the reply is, and delivered as it came
          deliveredRefusal = await source.refusal;
          if (deliveredRefusal) await run.judgeRefusalMessage(deliveredRefusal);
        }
        // the call's own text (the last step's), as the same call without guards resolves it
        delivered = await source.text.catch(() => delivered);
        // a caller's abort while the guards judged the reply ends the stream with the reason, as generateText() rejects
        if (finish !== 'error') opts.abortSignal?.throwIfAborted();
        return;
      }
      const out = run.guardOutput(source.fullStream, hold);
      let inText = false;
      for await (const part of out.parts) {
        // held text goes out only once the guards judged it: a caller's abort while they judged ends the stream before
        // the first piece, and is not checked again while the reader takes the rest
        if (hold && part.type === 'text' && !inText) opts.abortSignal?.throwIfAborted();
        inText = part.type === 'text';
        if (part.type === 'text') delivered += part.text;
        yield part;
      }
      const end = out.end();
      // a caller's abort while the guards judged a reply they refused, or could not judge, ends the stream with the
      // reason, as generateText() rejects with it
      if (end.kind === 'stopped' || end.kind === 'failed') opts.abortSignal?.throwIfAborted();
      if (end.kind === 'stopped') {
        finish = 'error';
        yield { type: 'error', error: run.stop('output', end.decided, await source.usage) };
      } else if (end.kind === 'failed') {
        finish = 'error';
        yield { type: 'error', error: end.error };
      } else if (end.kind !== 'passed') {
        run.report.result = end.kind;
      } else {
        // the guards changed nothing: text is the call's own (the last step's), as the same call without guards resolves it
        delivered = await source.text.catch(() => delivered);
      }
      // The model's refusal message is text the model wrote: the output guards judge it before the caller can read it.
      // The stream was read to its end, so the call's refusal promise has settled.
      const message = finish === undefined ? await source.refusal : undefined;
      // an empty refusal message has nothing to judge, and goes out as it came
      if (message === '') deliveredRefusal = message;
      if (message) {
        const judged = await run.judgeRefusalMessage(message);
        // a caller's abort while the guards judged the message ends the stream with the reason, whatever they
        // decided, as generateText() rejects with it: the message is never delivered after the abort
        opts.abortSignal?.throwIfAborted();
        if (judged.end.kind === 'stopped') {
          finish = 'error';
          yield { type: 'error', error: run.stop('output', judged.end.decided, await source.usage) };
        } else {
          const kind = judged.end.kind;
          if (kind === 'replaced' || kind === 'sanitized') run.report.result = kind;
          // a rewrite that leaves nothing of the message leaves an empty one: the promise is what says the model refused
          deliveredRefusal = judged.text;
        }
      }
    } catch (error) {
      // a configuration error (a mode or a context field the guards cannot take), or a fault of the pipe itself
      finish = 'error';
      yield { type: 'error', error: error instanceof Error ? error : new Error(String(error)) };
    } finally {
      text.resolve(delivered);
      guardReport.resolve(run?.report);
      finishReason.resolve(finish ?? source?.finishReason ?? 'stop');
      // the call's refusal message as the output guards delivered it, when the stream did not end on an error
      refusal.resolve(finish === undefined ? deliveredRefusal : undefined);
      usage.resolve(source ? source.usage : { ...NO_USAGE });
      toolCalls.resolve(source ? source.toolCalls : []);
      provider.resolve(source ? source.provider : '');
      model.resolve(source ? source.model : '');
      responseModel.resolve(source ? source.responseModel : undefined);
      serviceTier.resolve(source ? source.serviceTier : undefined);
      fallback.resolve(source?.fallback ?? undefined);
      cacheDiagnostics.resolve(source ? source.cacheDiagnostics : null);
      providerMessageId.resolve(source ? source.providerMessageId : null);
    }
  }

  const fullStream = runGuarded();
  const textStream: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      const all = fullStream[Symbol.asyncIterator]();
      return {
        async next() {
          for (;;) {
            const { value, done } = await all.next();
            if (done) return { value: undefined, done: true as const };
            if (value.type === 'text') return { value: value.text, done: false as const };
          }
        },
        async return() {
          await all.return?.(undefined);
          return { value: undefined, done: true as const };
        },
      };
    },
  };
  return {
    textStream,
    fullStream,
    text: text.promise,
    usage: usage.promise,
    responseModel: responseModel.promise,
    serviceTier: serviceTier.promise,
    toolCalls: toolCalls.promise,
    provider: provider.promise,
    model: model.promise,
    fallback: fallback.promise,
    finishReason: finishReason.promise,
    refusal: refusal.promise,
    cacheDiagnostics: cacheDiagnostics.promise,
    providerMessageId: providerMessageId.promise,
    guardReport: guardReport.promise,
  };
}
