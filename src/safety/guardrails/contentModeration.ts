/**
 * @module guardrails/contentModeration
 *
 * One call for content people send each other: text and images judged by a host's guards, every guard closed unless
 * its config says otherwise, and a decision that carries codes, ids and scores and none of the content, except the
 * text a sanitizer rewrote (`sanitizedText`) and whatever a host's guard writes into its own `metadata`.
 */
import type { AgentOSInput } from '../../api/types/AgentOSInput';
import type { VisionInputData } from '../../cognition/substrate/IGMI';
import { safeWord, valid } from '../../core/logging/events.js';
import { GuardrailAction, type GuardrailContext, type GuardrailEvaluationResult, type GuardrailHold, type IGuardrailService } from './IGuardrailService';
import { isGuardrailHold, toModerationEvaluation, type ModerationEvaluation } from './guardrailDispatcher';
import { ParallelGuardrailDispatcher } from './ParallelGuardrailDispatcher';
import { assertModerationContext } from './ModerationContext';
import { isMarkedGuardFailure } from './guardFailure';
import { namedGuard, withModerationPosture } from './requiredGuardrails';
import { guardrailLog } from './log.js';

/** The content a person sent: its text, its images, or both. */
export interface ContentUnderReview {
  text?: string | null;
  images?: VisionInputData[];
}

export interface ModerateContentOptions {
  /** The guards, in registration order. Screens that must run first set `config.sequential`. */
  guards: IGuardrailService[];
  /** Who sent it and where. `context.moderation` carries the typed fields: surface, room, rating, message, sender. */
  context: GuardrailContext;
  /** `enforce` (default) or `dryRun`: every guard runs the same way; the decision reports what would have happened. */
  mode?: 'enforce' | 'dryRun';
  /** The deadline for a guard whose config sets none. Default 8000 ms. */
  timeoutMs?: number;
  /**
   * Reason codes and review codes that stop every further vendor request for this content once a guard answers one.
   * Default none.
   */
  stopVendorsOn?: readonly string[];
}

/** What the host does with the content. */
export type ModerationOutcome = 'allow' | 'flag' | 'refuse' | 'hold';

export interface ModerationDecision {
  /** What the host does. In a dry run this is always `allow`. */
  outcome: ModerationOutcome;
  /** In a dry run: the outcome enforcement would have given. */
  wouldBe?: ModerationOutcome;
  enforced: boolean;
  /**
   * Nothing but a guard that threw, timed out or answered nonsense, or an image the image guard could not have checked,
   * kept the content back: no rule refused it and no guard held it.
   */
  unavailable: boolean;
  /** The evaluation that decided: a rule's BLOCK, else a hold, else a closed guard's failure, else a FLAG. */
  deciding?: ModerationEvaluation;
  /** Every evaluation, in registration order. */
  evaluations: ModerationEvaluation[];
  /** Set when the outcome, or `wouldBe`, is `hold`. */
  hold?: GuardrailHold;
  /**
   * In `enforce`: the text as the sanitizers left it, when a guard with `canSanitize` changed it, whatever the outcome;
   * `''` when one removed it (`modifiedText: null`). It is the person's text, so a host keeps it out of its logs. Never
   * set in a dry run.
   */
  sanitizedText?: string;
}

/** The reason codes the dispatcher and the posture wrapper make themselves for a closed guard's failure. */
const MADE_BY_THE_LIBRARY: ReadonlySet<string> = new Set(['GUARDRAIL_ERROR', 'GUARDRAIL_MALFORMED']);

/**
 * Whether an evaluation is a closed guard's failure: a BLOCK the library made for a guard that threw, ran late or
 * answered no recognised action, or the image guard's `IMAGE_CHECK_UNAVAILABLE` for an image no check could judge. A
 * guard that writes `metadata.failClosed` or a library code into its own answer gives a rule's refusal, not a failure:
 * the library marks its own BLOCK outside the answer.
 */
export function isGuardFailure(evaluation: GuardrailEvaluationResult): boolean {
  return evaluation.action === GuardrailAction.BLOCK && isMarkedGuardFailure(evaluation);
}

/** What a list of evaluations amounts to for a moderation entry point, and the evaluation that decided. */
export interface ModerationPick { outcome: ModerationOutcome; unavailable: boolean; evaluation?: GuardrailEvaluationResult }

/**
 * What decides, in this order: the first BLOCK a rule gave (no hold, not a closed guard's failure); else the first
 * hold; else the first closed guard's failure; else the first FLAG; else nothing. So among the guards that ran, one
 * guard's outage never hides another guard's refusal or hold. A sequential screen's failure is a BLOCK and ends phase 1
 * as its refusal does, so the phase 2 guards never see the text and cannot hold it.
 *
 * @param evaluations - The evaluations, in registration order.
 * @returns The outcome, whether only an outage decided it, and the evaluation that decided.
 */
export function pickModerationOutcome(evaluations: readonly GuardrailEvaluationResult[]): ModerationPick {
  const rule = evaluations.find((e) => e.action === GuardrailAction.BLOCK && !isGuardrailHold(e) && !isGuardFailure(e));
  if (rule) return { outcome: 'refuse', unavailable: false, evaluation: rule };
  const hold = evaluations.find((e) => isGuardrailHold(e));
  if (hold) return { outcome: 'hold', unavailable: false, evaluation: hold };
  const failure = evaluations.find(isGuardFailure);
  if (failure) return { outcome: 'refuse', unavailable: true, evaluation: failure };
  const flag = evaluations.find((e) => e.action === GuardrailAction.FLAG);
  if (flag) return { outcome: 'flag', unavailable: false, evaluation: flag };
  return { outcome: 'allow', unavailable: false };
}

/**
 * One `guardrail.verdict` line. `code` is the evaluation's reason code, or a hold's review code, and is written only
 * when the guard that answered lists it in `config.reasonCodes`, or the library made the evaluation for a closed guard's
 * failure and the code is the library's own; `unknown` otherwise.
 */
export function writeVerdictLine(verdict: {
  evaluation: GuardrailEvaluationResult;
  action: 'flag' | 'sanitize' | 'hold' | 'block';
  stage: 'input' | 'output' | 'tool_call';
  /** The guards of the call, under the ids their evaluations are stamped with. */
  guards: readonly IGuardrailService[];
  surface: string | undefined;
  mode: 'enforce' | 'dryRun';
  unavailable: boolean;
}): void {
  const stamped = verdict.evaluation.metadata?.guardrailId;
  const guardrailId = typeof stamped === 'string' ? stamped : undefined;
  const guard = guardrailId === undefined ? undefined : verdict.guards.find((svc) => svc.id === guardrailId);
  const given = verdict.action === 'hold' ? verdict.evaluation.hold?.reviewCode : verdict.evaluation.reasonCode;
  const listed = typeof given === 'string' && ((MADE_BY_THE_LIBRARY.has(given) && isGuardFailure(verdict.evaluation)) || guard?.config?.reasonCodes?.includes(given) === true);
  guardrailLog.info('guardrail.verdict', {
    guardrailId: safeWord(guardrailId),
    stage: verdict.stage,
    action: verdict.action,
    code: listed && valid('word', given, 'code') ? (given as string) : 'unknown',
    surface: safeWord(verdict.surface),
    mode: verdict.mode === 'dryRun' ? 'dry_run' : 'enforce',
    unavailable: verdict.unavailable ? 'yes' : 'no',
  });
}

/**
 * Judges content a person sent: every guard runs closed unless its config says `failClosed: false`, guards with
 * `config.sequential` run first, and the decision reports codes and ids, never a guard's `reason` or `details`.
 *
 * A guard's answer is read as it settles: one whose reason code or review code is in `stopVendorsOn` aborts the
 * call's `context.vendorSignal` at once, while the other guards are still running. A request already sent is answered
 * as usual; a guard that reads the signal starts no new one.
 *
 * @param content - The text and the images.
 * @param options - The guards, the context, the mode, the deadline and the codes that stop further vendor requests.
 * @returns What the host does with the content.
 * @throws TypeError when a guard cannot judge input, when `mode` is neither `enforce` nor `dryRun`, or when
 * `context.moderation` holds a field that is not a word or an id.
 */
export async function moderateContent(content: ContentUnderReview, options: ModerateContentOptions): Promise<ModerationDecision> {
  const mode = options.mode ?? 'enforce';
  // any other value would give enforced: false beside an enforced outcome, with sanitizedText dropped
  if (mode !== 'enforce' && mode !== 'dryRun') throw new TypeError("moderateContent(): mode must be 'enforce' or 'dryRun'");
  if (options.context.moderation !== undefined) assertModerationContext(options.context.moderation);

  const named = options.guards.map((svc, index) => namedGuard(svc, index));
  for (const svc of named) {
    // under a closed default an output-only guard must not read as an allow
    if (typeof svc.evaluateInput !== 'function' || (svc.stages !== undefined && !svc.stages.includes('input'))) {
      throw new TypeError(`moderateContent(): guard ${svc.id} does not evaluate input`);
    }
  }

  // One signal per call. A guard's answer is read as it settles, while the other phase 2 guards are still running.
  const vendors = new AbortController();
  const stopOn = new Set(options.stopVendorsOn ?? []);
  const context: GuardrailContext = { ...options.context, vendorSignal: vendors.signal };
  const guards = named.map((svc) => {
    const postured = withModerationPosture(svc, { timeoutMs: options.timeoutMs });
    const judge = postured.evaluateInput!;
    postured.evaluateInput = async (payload) => {
      const evaluation = await judge(payload);
      if (evaluation && stopOn.size > 0) {
        const review = isGuardrailHold(evaluation) ? evaluation.hold!.reviewCode : undefined;
        if ((typeof evaluation.reasonCode === 'string' && stopOn.has(evaluation.reasonCode)) || (typeof review === 'string' && stopOn.has(review))) vendors.abort();
      }
      return evaluation;
    };
    return postured;
  });

  const text = typeof content.text === 'string' ? content.text : null;
  const input = {
    userId: context.userId,
    sessionId: context.sessionId,
    textInput: text,
    ...(content.images && content.images.length > 0 ? { visionInputs: content.images } : {}),
  } as AgentOSInput;

  const result = await ParallelGuardrailDispatcher.evaluateInput(guards, input, context);
  const evaluations = result.evaluations ?? [];
  const pick = pickModerationOutcome(evaluations);
  const after = result.sanitizedInput.textInput;
  // a sanitizer that removed the whole text (`modifiedText: null`) gives '', so `sanitizedText ?? text` cannot restore it
  const sanitizedText = typeof after === 'string' ? (after !== text ? after : undefined) : text !== null ? '' : undefined;
  const surface = options.context.moderation?.surface;

  if (pick.evaluation) {
    writeVerdictLine({ evaluation: pick.evaluation, action: pick.outcome === 'refuse' ? 'block' : (pick.outcome as 'hold' | 'flag'), stage: 'input', guards: named, surface, mode, unavailable: pick.unavailable });
  } else if (sanitizedText !== undefined) {
    // a text a sanitizer rewrote and no other guard touched: one line, as `sanitize`
    const rewrite = evaluations.find((e) => e.action === GuardrailAction.SANITIZE);
    if (rewrite) writeVerdictLine({ evaluation: rewrite, action: 'sanitize', stage: 'input', guards: named, surface, mode, unavailable: false });
  }

  const deciding = pick.evaluation ? toModerationEvaluation(pick.evaluation) : undefined;
  return {
    outcome: mode === 'dryRun' ? 'allow' : pick.outcome,
    ...(mode === 'dryRun' ? { wouldBe: pick.outcome } : {}),
    enforced: mode === 'enforce',
    unavailable: pick.unavailable,
    ...(deciding ? { deciding } : {}),
    evaluations: evaluations.map(toModerationEvaluation),
    ...(pick.outcome === 'hold' && deciding?.hold ? { hold: deciding.hold } : {}),
    ...(mode === 'enforce' && sanitizedText !== undefined ? { sanitizedText } : {}),
  };
}
