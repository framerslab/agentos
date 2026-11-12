/**
 * @module ParallelGuardrailDispatcher
 *
 * Two-phase parallel guardrail dispatcher that separates sanitizers
 * (sequential, order-dependent) from classifiers (parallel, independent).
 *
 * **Phase 1 (Sequential):** Guardrails with `config.canSanitize === true`
 * or `config.sequential === true` run one-at-a-time in registration order.
 * Each sanitizer receives the cumulative output of all preceding sanitizers.
 * A BLOCK here short-circuits the entire pipeline, so a screen that asks to
 * run first keeps the text it refuses from every phase 2 guard. A SANITIZE
 * from a phase 1 guard without `canSanitize` is downgraded to FLAG.
 *
 * **Phase 2 (Parallel):** Remaining guardrails run concurrently via
 * `Promise.allSettled`. They receive the fully-sanitized text from Phase 1.
 * If any Phase 2 guardrail returns SANITIZE, it is **downgraded to FLAG**
 * because concurrent sanitization would produce non-deterministic results.
 *
 * The final outcome uses "worst-wins" aggregation:
 * BLOCK (severity 3) > FLAG (severity 2) > ALLOW (severity 0).
 *
 * @example
 * ```typescript
 * import { ParallelGuardrailDispatcher } from '@framers/agentos/safety/guardrails';
 *
 * const outcome = await ParallelGuardrailDispatcher.evaluateInput(
 *   [piiRedactor, toxicityClassifier, policyGuard],
 *   userInput,
 *   guardrailContext,
 * );
 * ```
 */
import type { AgentOSInput } from '../../api/types/AgentOSInput';
import {
  type AgentOSResponse,
  AgentOSResponseChunkType,
  type AgentOSFinalResponseChunk,
  isActionableToolCallRequestChunk,
  isToolCallRequestChunk,
} from '../../api/types/AgentOSResponse';
import {
  GuardrailAction,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type GuardrailOutputPayload,
  type IGuardrailService,
} from './IGuardrailService';
import type { GuardrailInputOutcome, GuardrailOutputOptions, GuardrailOutputVerdict } from './guardrailDispatcher';
import {
  serializeEvaluation,
  withGuardrailMetadata,
  createGuardrailBlockedStream,
  guardrailOutcomeOf,
  hasEvaluateOutput,
  isGuardrailHold,
} from './guardrailDispatcher';
import { renderPlainText } from '../../api/runtime/turnFinalResponse';
import { sanitizedFinalResponse } from './sanitizedFinalResponse';
import { listedErrorFields, safeWord } from '../../core/logging/events.js';
import { carryGuardFailure, markGuardFailure } from './guardFailure';
import { guardrailLog } from './log.js';

// ---------------------------------------------------------------------------
// Severity map used by worstAction — SANITIZE is excluded because it is
// always downgraded to FLAG before reaching the aggregator.
// ---------------------------------------------------------------------------

/** @internal Numeric severity for each guardrail action. Higher = worse. */
const ACTION_SEVERITY: Record<GuardrailAction, number> = {
  [GuardrailAction.ALLOW]: 0,
  [GuardrailAction.SANITIZE]: 1, // only used as tiebreaker — should not appear in Phase 2
  [GuardrailAction.FLAG]: 2,
  [GuardrailAction.BLOCK]: 3,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Synthetic BLOCK returned when a fail-closed guardrail throws or times out. `metadata.cause` says which, and
 * `metadata.guardrailId` names the guard when it has an id.
 */
function guardrailErrorBlock(reason: string, cause: 'error' | 'timeout', svc: IGuardrailService): GuardrailEvaluationResult {
  return markGuardFailure({
    action: GuardrailAction.BLOCK,
    reason,
    reasonCode: 'GUARDRAIL_ERROR',
    metadata: { failClosed: true, cause, ...(svc.id ? { guardrailId: svc.id } : {}) },
  });
}

const GUARDRAIL_TIMEOUT = Symbol('guardrail-timeout');

/** The stage a guard judges at, as the `guardrail.*` events name it. */
type GuardrailEventStage = 'input' | 'output' | 'tool_call';

/** One `guardrail.failed` line. `error` is absent for a timeout. */
function failed(svc: IGuardrailService, stage: GuardrailEventStage, cause: 'error' | 'timeout', error?: unknown): void {
  guardrailLog.warn('guardrail.failed', {
    guardrailId: safeWord(svc.id), stage, posture: svc.config?.failClosed ? 'closed' : 'open', cause,
    ...(cause === 'error' ? listedErrorFields(error) : {}),
  });
}

/**
 * Race a guard's evaluation against its `config.timeoutMs`.
 *
 * Without a timeout (undefined / 0) the evaluation is awaited as it is. On a
 * timeout or a throw the guard's `config.failClosed` decides: a synthetic BLOCK
 * when it is set, else `null` (fail-open). Either way one `guardrail.failed`
 * line names the guard, the stage and the cause, and never the error's message.
 *
 * @param fn    - The async function to execute
 * @param svc   - The guard whose evaluation it is
 * @param stage - The stage the guard judges at
 * @returns The evaluation result, a synthetic BLOCK, or `null`
 */
async function callWithTimeout(
  fn: (deadlineSignal?: AbortSignal) => Promise<GuardrailEvaluationResult | null>,
  svc: IGuardrailService,
  stage: GuardrailEventStage,
): Promise<GuardrailEvaluationResult | null> {
  const timeoutMs = svc.config?.timeoutMs;
  const failClosed = svc.config?.failClosed;
  try {
    if (!timeoutMs || timeoutMs <= 0) {
      return await fn();
    }

    // Race the evaluation against a timeout sentinel — kept distinct from a
    // guard that legitimately resolves `null` (= ALLOW), so a timeout can be
    // handled per the fail-closed policy. The race does not stop the
    // evaluation: at the deadline the signal handed to it is aborted, so a
    // guard that reads it starts nothing more once nobody waits for it.
    const deadline = new AbortController();
    const result = await Promise.race([
      fn(deadline.signal),
      new Promise<typeof GUARDRAIL_TIMEOUT>((resolve) => {
        // the timeout settles first: a guard that answers from an abort listener cannot win the race
        setTimeout(() => { resolve(GUARDRAIL_TIMEOUT); deadline.abort(); }, timeoutMs);
      }),
    ]);

    if (result === GUARDRAIL_TIMEOUT) {
      failed(svc, stage, 'timeout');
      return failClosed ? guardrailErrorBlock('Guardrail evaluation timed out', 'timeout', svc) : null;
    }

    return result;
  } catch (error) {
    failed(svc, stage, 'error', error);
    return failClosed ? guardrailErrorBlock('Guardrail evaluation threw an error', 'error', svc) : null;
  }
}

/**
 * Determine the worst (highest-severity) action from a list of evaluations.
 *
 * Returns `GuardrailAction.ALLOW` when the list is empty.
 *
 * @param evaluations - Non-empty array of evaluation results
 * @returns The action with the highest severity
 */
function worstAction(evaluations: GuardrailEvaluationResult[]): GuardrailAction {
  if (evaluations.length === 0) {
    return GuardrailAction.ALLOW;
  }

  let worst = evaluations[0].action;
  for (let i = 1; i < evaluations.length; i++) {
    const candidate = evaluations[i].action;
    if (ACTION_SEVERITY[candidate] > ACTION_SEVERITY[worst]) {
      worst = candidate;
    }
  }
  return worst;
}

/** Phase 1 holds the guards that can sanitize and the guards that ask to run first. */
function runsInPhaseOne(svc: IGuardrailService): boolean {
  return svc.config?.canSanitize === true || svc.config?.sequential === true;
}

/** Of one phase's settled evaluations: the first BLOCK without a hold, else the first hold, else nothing. */
function decidingBlock(evaluations: readonly GuardrailEvaluationResult[]): GuardrailEvaluationResult | undefined {
  return evaluations.find((e) => e.action === GuardrailAction.BLOCK && !isGuardrailHold(e)) ?? evaluations.find((e) => isGuardrailHold(e));
}

/** The verdict fields a block's notification carries beside its text fields. */
function blockVerdictOf(evaluation: GuardrailEvaluationResult): Pick<GuardrailOutputVerdict, 'action' | 'guardrailId' | 'reasonCode' | 'hold'> {
  return { action: GuardrailAction.BLOCK, guardrailId: guardrailIdOf(evaluation), reasonCode: evaluation.reasonCode, ...(isGuardrailHold(evaluation) ? { hold: evaluation.hold } : {}) };
}

/**
 * If a Phase 2 guardrail, or a phase 1 guardrail without `canSanitize` (one
 * that only asks to run first), returns SANITIZE, downgrade it to FLAG and
 * write one `guardrail.sanitize_downgraded` line. Concurrent sanitization is
 * non-deterministic so we refuse it.
 *
 * @param evaluation - The raw evaluation from Phase 2
 * @param svc        - The guard that answered it
 * @param stage      - The stage the guard judged at
 * @returns The (potentially downgraded) evaluation
 */
function downgradePhase2Sanitize(
  evaluation: GuardrailEvaluationResult,
  svc: IGuardrailService,
  stage: 'input' | 'output',
): GuardrailEvaluationResult {
  if (evaluation.action !== GuardrailAction.SANITIZE) {
    return evaluation;
  }

  guardrailLog.warn('guardrail.sanitize_downgraded', { guardrailId: safeWord(svc.id), stage });

  return {
    ...evaluation,
    action: GuardrailAction.FLAG,
    reason: evaluation.reason
      ? `${evaluation.reason} [downgraded from SANITIZE]`
      : 'SANITIZE downgraded to FLAG in parallel phase',
  };
}

/**
 * A guard cannot rewrite a tool call: a SANITIZE on a TOOL_CALL_REQUEST chunk
 * is applied as a BLOCK that keeps the guard's reason, so the call never goes
 * out in a form no guard approved. A `hold` the SANITIZE carried was ignored,
 * so the BLOCK is a refusal, not a hold. One `guardrail.sanitize_downgraded`
 * line names the guard.
 *
 * @param evaluation - The raw evaluation of a tool-call chunk
 * @param svc        - The guard that answered it
 * @returns The evaluation, with a SANITIZE turned into a BLOCK
 */
function sanitizeOfToolCallAsBlock(
  evaluation: GuardrailEvaluationResult,
  svc: IGuardrailService,
): GuardrailEvaluationResult {
  if (evaluation.action !== GuardrailAction.SANITIZE) {
    return evaluation;
  }

  guardrailLog.warn('guardrail.sanitize_downgraded', { guardrailId: safeWord(svc.id), stage: 'tool_call' });

  const { modifiedText: _modifiedText, hold: _hold, ...rest } = evaluation;
  return {
    ...rest,
    action: GuardrailAction.BLOCK,
    reason: evaluation.reason
      ? `${evaluation.reason} [SANITIZE of a tool call applied as BLOCK]`
      : 'SANITIZE of a tool call applied as BLOCK: a tool call cannot be rewritten',
  };
}

const holdIgnoredFor = new Set<string>();
const holdIgnoredByUnnamed = new WeakSet<IGuardrailService>();
/**
 * Writes `guardrail.hold_ignored` the first time a guard answers a hold on an action other than BLOCK. A guard with an
 * id is remembered by it (at most 256 ids); one without is remembered as the object it is, though its line says `unknown`.
 */
function noteIgnoredHold(evaluation: GuardrailEvaluationResult, svc: IGuardrailService, stage: GuardrailEventStage): void {
  if (evaluation.hold === undefined || evaluation.hold === null || evaluation.action === GuardrailAction.BLOCK) return;
  const guardrailId = safeWord(svc.id);
  if (guardrailId === 'unknown') {
    if (holdIgnoredByUnnamed.has(svc)) return;
    holdIgnoredByUnnamed.add(svc);
  } else {
    if (holdIgnoredFor.has(guardrailId) || holdIgnoredFor.size >= 256) return;
    holdIgnoredFor.add(guardrailId);
  }
  guardrailLog.warn('guardrail.hold_ignored', { guardrailId, stage });
}

/** A guardrail that evaluates tool calls, with its place in the registration order. */
interface ToolCallGuard {
  svc: IGuardrailService;
  registrationIndex: number;
}

/**
 * The verdict of the guardrails that evaluate tool calls on one TOOL_CALL_REQUEST chunk: the blocking evaluation, or
 * every evaluation of a chunk they pass.
 */
export type GuardrailToolCallVerdict =
  | { outcome: 'block'; evaluation: GuardrailEvaluationResult }
  | { outcome: 'pass'; evaluations: GuardrailEvaluationResult[] };

/** The services that evaluate tool calls: they implement `evaluateOutput` and set `config.evaluateToolCalls`. */
function toolCallGuardsOf(services: IGuardrailService[]): ToolCallGuard[] {
  const guards: ToolCallGuard[] = [];
  services.forEach((svc, registrationIndex) => {
    if (hasEvaluateOutput(svc) && svc.config?.evaluateToolCalls === true) {
      guards.push({ svc, registrationIndex });
    }
  });
  return guards;
}

/**
 * The tool-call guards over one TOOL_CALL_REQUEST chunk. The guards with
 * `config.sequential` answer first, one at a time in registration order, and
 * the first BLOCK among them (a SANITIZE counts as one) is the verdict before
 * any other guard is called. The rest run in parallel; once every guard has
 * answered, returns the first BLOCK without a hold by registration order, else
 * the first hold, or every evaluation of a chunk they pass.
 */
async function evaluateToolCallGuards(
  guards: ToolCallGuard[],
  context: GuardrailContext,
  chunk: AgentOSResponse,
  ragSources: GuardrailOutputPayload['ragSources'],
  pickBlock?: GuardrailOutputOptions['pickBlock'],
): Promise<GuardrailToolCallVerdict> {
  const pick = pickBlock ?? decidingBlock;
  const slots: (GuardrailEvaluationResult | null)[] = new Array(guards.length).fill(null);
  const settle = (j: number, result: PromiseSettledResult<GuardrailEvaluationResult | null>): GuardrailEvaluationResult | null => {
    const { svc } = guards[j];
    if (result.status === 'rejected') {
      failed(svc, 'tool_call', 'error', result.reason);
      return null;
    }
    if (!result.value) {
      return null;
    }
    noteIgnoredHold(result.value, svc, 'tool_call');
    const evaluation = stampGuardrailId(sanitizeOfToolCallAsBlock(result.value, svc), svc);
    slots[j] = evaluation;
    return evaluation;
  };
  const call = ({ svc }: ToolCallGuard): Promise<GuardrailEvaluationResult | null> =>
    callWithTimeout(() => svc.evaluateOutput!({ context, chunk, ragSources }), svc, 'tool_call');

  // Screens first: a call one of them refuses reaches no other guard.
  for (let j = 0; j < guards.length; j++) {
    if (guards[j].svc.config?.sequential !== true) continue;
    const [result] = await Promise.allSettled([call(guards[j])]);
    const evaluation = settle(j, result);
    if (evaluation?.action === GuardrailAction.BLOCK) {
      // a caller's picker is shown the screen's BLOCK too; it ends the evaluation whatever the picker answers
      return { outcome: 'block', evaluation: pick([evaluation]) ?? evaluation };
    }
  }

  const rest = guards.map((guard, j) => ({ guard, j })).filter(({ guard }) => guard.svc.config?.sequential !== true);
  const results = await Promise.allSettled(rest.map(({ guard }) => call(guard)));
  results.forEach((result, k) => settle(rest[k].j, result));

  const evaluations = slots.filter(Boolean) as GuardrailEvaluationResult[];
  // Every guard has answered: a refusal outranks a hold wherever it sits in registration order, unless the caller picks.
  const block = pick(evaluations);
  if (block) {
    return { outcome: 'block', evaluation: block };
  }

  return { outcome: 'pass', evaluations };
}

/**
 * The verdict field naming the calls a block withheld from the caller: the
 * calls of an actionable tool-call chunk (`executionMode: 'external'`), which
 * the runtime saved a pause for. Any other chunk names none.
 */
function withheldCallsOf(chunk: AgentOSResponse): Pick<GuardrailOutputVerdict, 'toolCallIds'> {
  return isActionableToolCallRequestChunk(chunk) ? { toolCallIds: chunk.toolCalls.map((call) => call.id) } : {};
}

// ---------------------------------------------------------------------------
// ParallelGuardrailDispatcher
// ---------------------------------------------------------------------------

/**
 * Stateless two-phase parallel guardrail dispatcher.
 *
 * All methods are static — no instantiation needed. The class exists purely
 * as a namespace to keep the two public entry points grouped.
 */
export class ParallelGuardrailDispatcher {
  // -----------------------------------------------------------------------
  // evaluateInput
  // -----------------------------------------------------------------------

  /**
   * Evaluate user input through registered guardrails using two-phase execution.
   *
   * **Phase 1 (Sequential — sanitizers):**
   * Guardrails with `config.canSanitize === true` or `config.sequential === true`
   * run one-at-a-time in registration order. Each sees (and, with `canSanitize`,
   * may modify) the cumulative sanitized input. A BLOCK result short-circuits
   * immediately — Phase 2 never runs.
   *
   * **Phase 2 (Parallel — classifiers):**
   * All remaining guardrails run concurrently via `Promise.allSettled` on
   * the text produced by Phase 1. A Phase 2 SANITIZE is downgraded to FLAG.
   *
   * **Aggregation:** worst-wins (BLOCK > FLAG > ALLOW). The singular
   * `evaluation` field is set to the first BLOCK without a hold, else the
   * first hold, else the worst-severity evaluation, else the last evaluation
   * by registration order. `outcome` says what the evaluations amount to: a
   * refusal outranks a hold, and a hold outranks the rest.
   *
   * @param services  - Array of guardrail services (already normalized)
   * @param input     - User input to evaluate
   * @param context   - Conversational context for policy decisions
   * @returns Outcome with sanitized input and all evaluations in registration order
   */
  static async evaluateInput(
    services: IGuardrailService[],
    input: AgentOSInput,
    context: GuardrailContext,
  ): Promise<GuardrailInputOutcome> {
    if (services.length === 0) {
      return { sanitizedInput: input, evaluations: [], outcome: 'allow' };
    }

    // -- Partition into sanitizers (Phase 1) and parallel classifiers (Phase 2)
    const sanitizers: IGuardrailService[] = [];
    const parallel: { svc: IGuardrailService; registrationIndex: number }[] = [];

    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      if (runsInPhaseOne(svc)) {
        sanitizers.push(svc);
      } else {
        parallel.push({ svc, registrationIndex: i });
      }
    }

    // Pre-allocate evaluation slots so results appear in registration order.
    // null slots are compacted away at the end.
    const evaluationSlots: (GuardrailEvaluationResult | null)[] = new Array(services.length).fill(null);

    let sanitizedInput = input;

    // -----------------------------------------------------------------
    // Phase 1: Sequential sanitizers
    // -----------------------------------------------------------------
    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      // Only Phase 1 services (sanitizers and screens that run first) run sequentially
      if (!runsInPhaseOne(svc)) {
        continue;
      }

      if (!svc.evaluateInput) {
        continue;
      }

      let evaluation = await callWithTimeout(
        (deadlineSignal) => svc.evaluateInput!({ context, input: sanitizedInput, ...(deadlineSignal ? { deadlineSignal } : {}) }),
        svc,
        'input',
      );

      if (!evaluation) {
        continue;
      }

      noteIgnoredHold(evaluation, svc, 'input');
      // a guard that only asks to run first cannot rewrite: its SANITIZE is a FLAG, as a phase 2 guard's is
      if (svc.config?.canSanitize !== true) evaluation = downgradePhase2Sanitize(evaluation, svc, 'input');
      evaluationSlots[i] = evaluation;

      // BLOCK in Phase 1 short-circuits everything — Phase 2 never runs
      if (evaluation.action === GuardrailAction.BLOCK) {
        const evaluations = evaluationSlots.filter(Boolean) as GuardrailEvaluationResult[];
        return { sanitizedInput, evaluation, evaluations, outcome: guardrailOutcomeOf(evaluations) };
      }

      // SANITIZE: update the running sanitized input for the next sanitizer
      if (evaluation.action === GuardrailAction.SANITIZE && evaluation.modifiedText !== undefined) {
        sanitizedInput = {
          ...sanitizedInput,
          textInput: evaluation.modifiedText,
        };
      }
    }

    // -----------------------------------------------------------------
    // Phase 2: Parallel classifiers
    // -----------------------------------------------------------------
    if (parallel.length > 0) {
      const settled = await Promise.allSettled(
        parallel.map(({ svc }) => {
          if (!svc.evaluateInput) {
            return Promise.resolve(null);
          }

          return callWithTimeout(
            (deadlineSignal) => svc.evaluateInput!({ context, input: sanitizedInput, ...(deadlineSignal ? { deadlineSignal } : {}) }),
            svc,
            'input',
          );
        }),
      );

      // Slot results back into registration order
      for (let j = 0; j < parallel.length; j++) {
        const outcome = settled[j];
        if (outcome.status === 'rejected') {
          failed(parallel[j].svc, 'input', 'error', outcome.reason);
          continue;
        }

        let evaluation = outcome.value;
        if (!evaluation) {
          continue;
        }

        noteIgnoredHold(evaluation, parallel[j].svc, 'input');
        // Downgrade SANITIZE → FLAG in Phase 2
        evaluation = downgradePhase2Sanitize(evaluation, parallel[j].svc, 'input');

        evaluationSlots[parallel[j].registrationIndex] = evaluation;
      }
    }

    // -----------------------------------------------------------------
    // Aggregate: compact slots, pick "evaluation" (singular)
    // -----------------------------------------------------------------
    const evaluations = evaluationSlots.filter(Boolean) as GuardrailEvaluationResult[];

    if (evaluations.length === 0) {
      return { sanitizedInput, evaluations: [], outcome: 'allow' };
    }

    // The singular evaluation: the first BLOCK without a hold, else the first hold, else the worst action, else the last.
    const outcome = guardrailOutcomeOf(evaluations);
    const block = decidingBlock(evaluations);
    if (block) {
      return { sanitizedInput, evaluation: block, evaluations, outcome };
    }

    const worst = worstAction(evaluations);
    // Find the first evaluation matching worst severity
    const worstEval = evaluations.find((e) => e.action === worst) ?? evaluations.at(-1)!;

    return {
      sanitizedInput,
      evaluation: worstEval,
      evaluations,
      outcome,
    };
  }

  // -----------------------------------------------------------------------
  // evaluateToolCall
  // -----------------------------------------------------------------------

  /**
   * Evaluate one TOOL_CALL_REQUEST chunk with the guardrails that evaluate
   * tool calls (`config.evaluateToolCalls`), as {@link wrapOutput} evaluates
   * the tool-call chunks of a stream: the guards with `config.sequential`
   * first, one at a time, and a BLOCK among them ends the evaluation; the rest
   * in parallel, a SANITIZE applied as a BLOCK, the first refusal in
   * registration order the verdict, else the first hold. Services without the
   * flag are not called.
   *
   * @param services   - Array of guardrail services (already normalized)
   * @param context    - Conversational context for policy decisions
   * @param chunk      - The tool-call chunk to evaluate
   * @param ragSources - RAG sources to pass to the guardrails, when the caller has them
   * @param pickBlock  - Picks which evaluation blocks the call, as {@link GuardrailOutputOptions.pickBlock} does for
   *                     a reply. Default: the first BLOCK without a hold, else the first hold.
   * @returns The blocking evaluation, or every evaluation of a chunk the guardrails pass
   */
  static async evaluateToolCall(
    services: IGuardrailService[],
    context: GuardrailContext,
    chunk: AgentOSResponse,
    ragSources?: GuardrailOutputPayload['ragSources'],
    pickBlock?: GuardrailOutputOptions['pickBlock'],
  ): Promise<GuardrailToolCallVerdict> {
    return evaluateToolCallGuards(toolCallGuardsOf(services), context, chunk, ragSources, pickBlock);
  }

  // -----------------------------------------------------------------------
  // wrapOutput
  // -----------------------------------------------------------------------

  /**
   * Wrap a response stream with two-phase guardrail filtering.
   *
   * Partitions services into four groups (once, up front). "Phase 1" is a
   * guard with `canSanitize` or `sequential`; a SANITIZE from one without
   * `canSanitize` is downgraded to FLAG.
   * 1. **Streaming sanitizers** (phase 1 and `evaluateStreamingChunks`)
   * 2. **Streaming parallel** classifiers (`evaluateStreamingChunks`, not phase 1)
   * 3. **Final sanitizers** (every phase 1 guard)
   * 4. **Final parallel** classifiers (the rest with `evaluateOutput`)
   *
   * For each TEXT_DELTA chunk: Phase 1 runs streaming sanitizers sequentially
   * (with per-service rate limiting), then Phase 2 runs streaming classifiers
   * in parallel.
   *
   * For each isFinal chunk: Phase 1 runs final sanitizers sequentially, then
   * Phase 2 runs final classifiers in parallel. All services with
   * `evaluateOutput` participate in final evaluation.
   *
   * For each non-final TOOL_CALL_REQUEST chunk: the services whose config sets
   * `evaluateToolCalls` run in parallel on the chunk as the stream carries it.
   * A SANITIZE is applied as a BLOCK, since a tool call cannot be rewritten; a
   * BLOCK ends the stream with the verdict in place of the chunk. Services
   * without the flag never receive a tool-call chunk. A block that withholds
   * an actionable call (`executionMode: 'external'`), on its chunk or, in hold
   * mode, on the text before it, names the call ids in the verdict's
   * `toolCallIds`.
   *
   * A BLOCK in either phase terminates the stream immediately with an error
   * chunk, or with a final response holding the guard's `replacementText`.
   *
   * @param services  - Array of guardrail services (already normalized)
   * @param context   - Conversational context for policy decisions
   * @param stream    - Source response stream to filter
   * @param options   - Stream options and input evaluations to embed
   * @returns Wrapped async generator with guardrail filtering applied
   */
  static async *wrapOutput(
    services: IGuardrailService[],
    context: GuardrailContext,
    stream: AsyncGenerator<AgentOSResponse, void, undefined>,
    options: GuardrailOutputOptions,
  ): AsyncGenerator<AgentOSResponse, void, undefined> {
    if (services.length === 0) {
      yield* stream;
      return;
    }

    // -- Partition into 4 groups once --------------------------------
    /** Streaming sanitizers: Phase 1 for TEXT_DELTA chunks */
    const streamingSanitizers: { svc: IGuardrailService; registrationIndex: number }[] = [];
    /** Streaming classifiers: Phase 2 for TEXT_DELTA chunks */
    const streamingParallel: { svc: IGuardrailService; registrationIndex: number }[] = [];
    /** Final sanitizers: Phase 1 for isFinal chunks */
    const finalSanitizers: IGuardrailService[] = [];
    /** Final classifiers: Phase 2 for isFinal chunks */
    const finalParallel: { svc: IGuardrailService; registrationIndex: number }[] = [];
    /** Tool-call guards: the services that opted in to TOOL_CALL_REQUEST chunks */
    const toolCallGuards = toolCallGuardsOf(services);

    for (let i = 0; i < services.length; i++) {
      const svc = services[i];
      if (!hasEvaluateOutput(svc)) {
        continue;
      }

      const isStreaming = svc.config?.evaluateStreamingChunks === true;
      // phase 1 of output: the guards that can sanitize and the guards that ask to run first
      const isSanitizer = runsInPhaseOne(svc);

      if (isStreaming && isSanitizer) {
        streamingSanitizers.push({ svc, registrationIndex: i });
      } else if (isStreaming && !isSanitizer) {
        streamingParallel.push({ svc, registrationIndex: i });
      }

      // All services with evaluateOutput participate in final evaluation
      if (isSanitizer) {
        finalSanitizers.push(svc);
      } else {
        finalParallel.push({ svc, registrationIndex: i });
      }
    }

    // -- Metadata from input evaluation --------------------------------
    const serializedInputEvaluations = (options.inputEvaluations ?? []).map(serializeEvaluation);
    let inputMetadataApplied = serializedInputEvaluations.length === 0;

    // -- Per-service rate limiting for streaming evaluation -------------
    const streamingEvaluationCounts = new Map<string, number>();

    // -- Live RAG-source state (updated from stream chunks) -----------------
    // The GMI emits retrieved chunks as a METADATA_UPDATE early in the turn
    // (right after retrieval, before the LLM call). The FINAL_RESPONSE chunk
    // also carries the same sources. Track them here so per-chunk
    // evaluateOutput calls see the live state, not just the initial option.
    let currentRagSources = options.ragSources;

    // -- Hold mode: the reply's text deltas wait for the final verdict ----
    // With `holdUntilFinal`, no TEXT_DELTA reaches the caller before the
    // final guards have passed the whole reply: the deltas are buffered and
    // flushed only when the final chunk is allowed (or flagged). A block or a
    // sanitize drops them, since they carry the text the guards refused.
    const hold = options.holdUntilFinal === true;
    let held: AgentOSResponse[] = [];

    // Which evaluation of a phase ends the reply: the caller's picker, else the first refusal, else the first hold.
    const pick = options.pickBlock ?? decidingBlock;

    const notify = async (verdict: GuardrailOutputVerdict): Promise<void> => {
      if (!options.onVerdict) return;
      try {
        await options.onVerdict(verdict);
      } catch (error) {
        guardrailLog.warn('guardrail.verdict_callback_failed', listedErrorFields(error));
      }
    };

    /**
     * The final guards over one final chunk: Phase 1 sanitizers in order,
     * then Phase 2 classifiers in parallel. Returns the first BLOCK, or the
     * chunk as the sanitizers left it with every evaluation attached.
     */
    const evaluateFinal = async (
      chunkIn: AgentOSResponse,
    ): Promise<
      | { outcome: 'block'; evaluation: GuardrailEvaluationResult }
      | { outcome: 'pass'; chunk: AgentOSResponse; sanitized: boolean; worst: GuardrailAction }
    > => {
      const outputEvaluations: GuardrailEvaluationResult[] = [];
      let workingChunk = chunkIn;
      let sanitized = false;

      // Phase 1: sequential final sanitizers
      for (const svc of finalSanitizers) {
        if (!svc.evaluateOutput) {
          continue;
        }

        const raw = await callWithTimeout(
          () => svc.evaluateOutput!({ context, chunk: workingChunk, ragSources: currentRagSources }),
          svc,
          'output',
        );

        if (!raw) {
          continue;
        }

        noteIgnoredHold(raw, svc, 'output');
        let evaluation = stampGuardrailId(raw, svc);
        // a guard that only asks to run first cannot rewrite: its SANITIZE is a FLAG, as a phase 2 guard's is
        if (svc.config?.canSanitize !== true) evaluation = downgradePhase2Sanitize(evaluation, svc, 'output');
        outputEvaluations.push(evaluation);

        // BLOCK terminates the stream; a caller's picker is shown it after what the guards before it answered
        if (evaluation.action === GuardrailAction.BLOCK) {
          return { outcome: 'block', evaluation: pick(outputEvaluations) ?? evaluation };
        }

        // SANITIZE: modify every text field of the final response, or the textDelta
        if (evaluation.action === GuardrailAction.SANITIZE && evaluation.modifiedText !== undefined) {
          sanitized = true;
          if (workingChunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) {
            workingChunk = sanitizedFinalResponse(workingChunk as AgentOSFinalResponseChunk, evaluation.modifiedText);
          } else {
            workingChunk = {
              ...(workingChunk as any),
              textDelta: evaluation.modifiedText,
            };
          }
        }
      }

      // Phase 2: parallel final classifiers
      if (finalParallel.length > 0) {
        const tasks = finalParallel.map(({ svc, registrationIndex }) => {
          if (!svc.evaluateOutput) {
            return Promise.resolve({ evaluation: null, registrationIndex, svc });
          }

          return callWithTimeout(
            () => svc.evaluateOutput!({ context, chunk: workingChunk, ragSources: currentRagSources }),
            svc,
            'output',
          ).then((evaluation) => ({ evaluation, registrationIndex, svc }));
        });

        const results = await Promise.allSettled(tasks);

        for (let k = 0; k < results.length; k++) {
          const result = results[k];
          if (result.status === 'rejected') {
            failed(finalParallel[k].svc, 'output', 'error', result.reason);
            continue;
          }

          const { evaluation: rawEvaluation, svc } = result.value;
          if (!rawEvaluation) {
            continue;
          }

          noteIgnoredHold(rawEvaluation, svc, 'output');
          // Downgrade SANITIZE → FLAG in Phase 2
          const evaluation = stampGuardrailId(downgradePhase2Sanitize(rawEvaluation, svc, 'output'), svc);
          outputEvaluations.push(evaluation);
        }

        // A BLOCK terminates the stream: a refusal outranks a hold wherever it sits in registration order. The picker
        // is shown phase 1's answers too; none of them is a BLOCK, so the default picks from this phase.
        const block = pick(outputEvaluations);
        if (block) {
          return { outcome: 'block', evaluation: block };
        }
      }

      // Attach output evaluation metadata
      if (outputEvaluations.length > 0) {
        workingChunk = withGuardrailMetadata(workingChunk, {
          output: outputEvaluations.map(serializeEvaluation),
        });
      }

      // the reply goes out: a BLOCK the caller's picker declined did not decide it, so the verdict is the worst of the rest
      const delivered = outputEvaluations.filter((evaluation) => evaluation.action !== GuardrailAction.BLOCK);
      return { outcome: 'pass', chunk: workingChunk, sanitized, worst: worstAction(delivered) };
    };

    /**
     * The tool-call guards over one TOOL_CALL_REQUEST chunk, in parallel.
     * Returns the first BLOCK by registration order (a SANITIZE counts as
     * one), or the chunk with every evaluation attached.
     */
    const evaluateToolCall = async (
      chunkIn: AgentOSResponse,
    ): Promise<
      | { outcome: 'block'; evaluation: GuardrailEvaluationResult }
      | { outcome: 'pass'; chunk: AgentOSResponse }
    > => {
      const verdict = await evaluateToolCallGuards(toolCallGuards, context, chunkIn, currentRagSources, options.pickBlock);
      if (verdict.outcome === 'block') {
        return verdict;
      }

      const chunk =
        verdict.evaluations.length > 0
          ? withGuardrailMetadata(chunkIn, { output: verdict.evaluations.map(serializeEvaluation) })
          : chunkIn;
      return { outcome: 'pass', chunk };
    };

    const finalTextOf = (chunk: AgentOSResponse): string | null =>
      chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE ? ((chunk as AgentOSFinalResponseChunk).finalResponseText ?? null) : null;

    // -- Main stream loop ----------------------------------------------
    for await (const chunk of stream) {
      let currentChunk = chunk;

      // Attach input evaluation metadata to the first output chunk
      if (!inputMetadataApplied && serializedInputEvaluations.length > 0) {
        currentChunk = withGuardrailMetadata(currentChunk, { input: serializedInputEvaluations });
        inputMetadataApplied = true;
      }

      // Sniff RAG sources off the stream so subsequent claim grounding runs
      // against the same chunks the LLM saw. METADATA_UPDATE.updates.ragSources
      // arrives before TEXT_DELTA; FINAL_RESPONSE.ragSources arrives at the end
      // and acts as a defensive fallback.
      if (chunk.type === AgentOSResponseChunkType.METADATA_UPDATE) {
        const meta = (chunk as any).updates as { ragSources?: unknown } | undefined;
        if (meta && Array.isArray(meta.ragSources) && meta.ragSources.length > 0) {
          currentRagSources = meta.ragSources as typeof currentRagSources;
        }
      } else if (chunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) {
        const finalRag = (chunk as any).ragSources;
        if (Array.isArray(finalRag) && finalRag.length > 0) {
          currentRagSources = finalRag as typeof currentRagSources;
        }
      }

      // ---------------------------------------------------------------
      // TEXT_DELTA (non-final): streaming guardrails
      // ---------------------------------------------------------------
      if (
        chunk.type === AgentOSResponseChunkType.TEXT_DELTA &&
        !chunk.isFinal &&
        (streamingSanitizers.length > 0 || streamingParallel.length > 0)
      ) {
        const outputEvaluations: GuardrailEvaluationResult[] = [];
        let workingChunk = currentChunk;

        // Phase 1: sequential streaming sanitizers
        for (const { svc, registrationIndex } of streamingSanitizers) {
          // an unnamed guard is counted under its place in the registration order, as in phase 2
          const svcId = svc.id || (svc as any).id || `svc-${registrationIndex}`;
          const currentCount = streamingEvaluationCounts.get(svcId) || 0;
          const maxEvals = svc.config?.maxStreamingEvaluations;

          // Skip if this service has hit its rate limit
          if (maxEvals !== undefined && currentCount >= maxEvals) {
            continue;
          }

          const raw = await callWithTimeout(
            () => svc.evaluateOutput!({ context, chunk: workingChunk, ragSources: currentRagSources }),
            svc,
            'output',
          );

          streamingEvaluationCounts.set(svcId, currentCount + 1);

          if (!raw) {
            continue;
          }

          noteIgnoredHold(raw, svc, 'output');
          let evaluation = stampGuardrailId(raw, svc);
          // a guard that only asks to run first cannot rewrite: its SANITIZE is a FLAG, as a phase 2 guard's is
          if (svc.config?.canSanitize !== true) evaluation = downgradePhase2Sanitize(evaluation, svc, 'output');
          outputEvaluations.push(evaluation);

          // BLOCK terminates the stream immediately; a caller's picker is shown it after what the guards before it answered
          if (evaluation.action === GuardrailAction.BLOCK) {
            const block = pick(outputEvaluations) ?? evaluation;
            held = [];
            await notify({ streamId: options.streamId, ...blockVerdictOf(block), finalText: block.replacementText ?? null, originalText: null });
            yield* blockedOutput(context, block, options);
            return;
          }

          // SANITIZE: modify the textDelta for downstream services
          if (evaluation.action === GuardrailAction.SANITIZE && evaluation.modifiedText !== undefined) {
            workingChunk = {
              ...(workingChunk as any),
              textDelta: evaluation.modifiedText,
            };
          }
        }

        // Phase 2: parallel streaming classifiers
        if (streamingParallel.length > 0) {
          const tasks = streamingParallel.map(({ svc, registrationIndex }) => {
            const svcId = svc.id || (svc as any).id || `svc-${registrationIndex}`;
            const currentCount = streamingEvaluationCounts.get(svcId) || 0;
            const maxEvals = svc.config?.maxStreamingEvaluations;

            // Rate-limited services return null immediately
            if (maxEvals !== undefined && currentCount >= maxEvals) {
              return Promise.resolve({ evaluation: null, registrationIndex, svcId, svc });
            }

            return callWithTimeout(
              () => svc.evaluateOutput!({ context, chunk: workingChunk, ragSources: currentRagSources }),
              svc,
              'output',
            ).then((evaluation) => {
              streamingEvaluationCounts.set(svcId, currentCount + 1);
              return { evaluation, registrationIndex, svcId, svc };
            });
          });

          const results = await Promise.allSettled(tasks);

          for (let k = 0; k < results.length; k++) {
            const result = results[k];
            if (result.status === 'rejected') {
              failed(streamingParallel[k].svc, 'output', 'error', result.reason);
              continue;
            }

            const { evaluation: rawEvaluation, svc } = result.value;
            if (!rawEvaluation) {
              continue;
            }

            noteIgnoredHold(rawEvaluation, svc, 'output');
            // Downgrade SANITIZE → FLAG in Phase 2
            const evaluation = stampGuardrailId(downgradePhase2Sanitize(rawEvaluation, svc, 'output'), svc);
            outputEvaluations.push(evaluation);
          }

          // A BLOCK terminates the stream immediately: a refusal outranks a hold wherever it sits in registration order
          const block = pick(outputEvaluations);
          if (block) {
            held = [];
            await notify({ streamId: options.streamId, ...blockVerdictOf(block), finalText: block.replacementText ?? null, originalText: null });
            yield* blockedOutput(context, block, options);
            return;
          }
        }

        // Attach output evaluation metadata
        if (outputEvaluations.length > 0) {
          workingChunk = withGuardrailMetadata(workingChunk, {
            output: outputEvaluations.map(serializeEvaluation),
          });
        }

        currentChunk = workingChunk;
      }

      // In hold mode a text delta waits for the final verdict.
      if (hold && chunk.type === AgentOSResponseChunkType.TEXT_DELTA && !chunk.isFinal) {
        held.push(currentChunk);
        continue;
      }

      // ---------------------------------------------------------------
      // TOOL_CALL_REQUEST (non-final): the guards that evaluate tool calls
      // ---------------------------------------------------------------
      // A block ends the stream with the verdict in place of the chunk, so the
      // stream never hands a host an actionable call it would execute; in hold
      // mode the text held before the call is dropped with it.
      if (isToolCallRequestChunk(chunk) && !chunk.isFinal && toolCallGuards.length > 0) {
        const verdict = await evaluateToolCall(currentChunk);
        if (verdict.outcome === 'block') {
          held = [];
          await notify({ streamId: options.streamId, ...blockVerdictOf(verdict.evaluation), finalText: verdict.evaluation.replacementText ?? null, originalText: null, ...withheldCallsOf(chunk) });
          yield* blockedOutput(context, verdict.evaluation, options);
          return;
        }
        currentChunk = verdict.chunk;
      }

      // An actionable tool call ends the turn's text for now: in hold mode the
      // text so far is judged as a final reply before the tool call goes out.
      if (hold && isActionableToolCallRequestChunk(chunk) && held.length > 0) {
        const text = held.map((h) => String((h as any).textDelta ?? '')).join('');
        const synthetic: AgentOSFinalResponseChunk = {
          type: AgentOSResponseChunkType.FINAL_RESPONSE,
          streamId: chunk.streamId,
          gmiInstanceId: chunk.gmiInstanceId,
          personaId: chunk.personaId,
          isFinal: true,
          timestamp: chunk.timestamp,
          finalResponseText: text,
          // the plain text a final reply carries, so a guard judges this reply as it judges one
          finalResponseTextPlain: renderPlainText(text),
        };
        const verdict = await evaluateFinal(synthetic);
        if (verdict.outcome === 'block') {
          held = [];
          await notify({ streamId: options.streamId, ...blockVerdictOf(verdict.evaluation), finalText: verdict.evaluation.replacementText ?? null, originalText: text, ...withheldCallsOf(chunk) });
          yield* blockedOutput(context, verdict.evaluation, options);
          return;
        }
        if (verdict.sanitized) {
          held = [{ ...(held[0] as any), textDelta: finalTextOf(verdict.chunk) ?? '' }];
        }
        for (const h of held) yield h;
        held = [];
        yield currentChunk;
        continue;
      }

      // ---------------------------------------------------------------
      // isFinal chunks: all guardrails participate
      // ---------------------------------------------------------------
      if (
        chunk.isFinal &&
        (finalSanitizers.length > 0 || finalParallel.length > 0)
      ) {
        const originalText = finalTextOf(currentChunk);
        const verdict = await evaluateFinal(currentChunk);
        if (verdict.outcome === 'block') {
          held = [];
          await notify({ streamId: options.streamId, ...blockVerdictOf(verdict.evaluation), finalText: verdict.evaluation.replacementText ?? null, originalText });
          yield* blockedOutput(context, verdict.evaluation, options);
          return;
        }
        // the deltas carry the text a sanitizer changed: only the final chunk's text stands
        if (verdict.sanitized) held = [];
        await notify({
          streamId: options.streamId,
          action: verdict.sanitized ? GuardrailAction.SANITIZE : verdict.worst,
          finalText: finalTextOf(verdict.chunk),
          originalText,
        });
        currentChunk = verdict.chunk;
      }

      if (chunk.isFinal && held.length > 0) {
        // held text is sent only beside the final response the guards judged; a turn that ended in an error drops it unjudged
        if (currentChunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) {
          for (const h of held) yield h;
        }
        held = [];
      }

      yield currentChunk;
    }
    // A stream that ended without a final chunk leaves its held text unjudged; it is dropped, never sent.
  }
}

/** The id of the guard that produced an evaluation, when it had one. */
function guardrailIdOf(evaluation: GuardrailEvaluationResult): string | undefined {
  const id = evaluation.metadata?.guardrailId;
  return typeof id === 'string' ? id : undefined;
}

/** The evaluation with its guard's id in `metadata.guardrailId`, when the guard has an id. */
function stampGuardrailId(evaluation: GuardrailEvaluationResult, svc: IGuardrailService): GuardrailEvaluationResult {
  if (!svc.id) return evaluation;
  return carryGuardFailure(evaluation, { ...evaluation, metadata: { ...(evaluation.metadata ?? {}), guardrailId: svc.id } });
}

/**
 * What the caller receives in place of a blocked reply: the guard's fixed reply as a final response that records the
 * block, when the guard gave one; otherwise the error chunk.
 */
async function* blockedOutput(
  context: GuardrailContext,
  evaluation: GuardrailEvaluationResult,
  options: GuardrailOutputOptions,
): AsyncGenerator<AgentOSResponse, void, undefined> {
  if (typeof evaluation.replacementText === 'string' && evaluation.replacementText.length > 0) {
    const replacement: AgentOSFinalResponseChunk = {
      type: AgentOSResponseChunkType.FINAL_RESPONSE,
      streamId: options.streamId,
      gmiInstanceId: 'guardrail',
      personaId: options.personaId ?? context.personaId ?? 'unknown_persona',
      isFinal: true,
      timestamp: new Date().toISOString(),
      finalResponseText: evaluation.replacementText,
      finalResponseTextPlain: renderPlainText(evaluation.replacementText),
      metadata: { guardrail: { output: [serializeEvaluation(evaluation)] } },
    };
    yield replacement;
    return;
  }
  yield* createGuardrailBlockedStream(context, evaluation, options);
}
