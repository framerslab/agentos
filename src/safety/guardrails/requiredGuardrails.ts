/**
 * @module guardrails/requiredGuardrails
 *
 * Guards a deployment cannot run without. A product names them by id and stage; AgentOS refuses to start when one is
 * missing, refuses a request when one has gone missing since, and runs each one fail-closed with a deadline, so a
 * guard that throws, hangs or answers nonsense blocks instead of letting the reply through.
 *
 * Also the posture a moderation entry point runs every guard under ({@link withModerationPosture}): closed unless the
 * guard's config says `failClosed: false`, with a deadline.
 */
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { safeWord } from '../../core/logging/events.js';
import { GuardrailAction, type GuardrailEvaluationResult, type IGuardrailService } from './IGuardrailService';
import { guardrailLog } from './log.js';
import { carryGuardFailure, markGuardFailure } from './guardFailure';

export type GuardrailStage = 'input' | 'output';

export interface RequiredGuardrailSpec {
  /** The guard's id: its `IGuardrailService.id`, else the id of the descriptor it was registered under. */
  id: string;
  /** The stages it must evaluate: a guard required on `output` must implement `evaluateOutput`. */
  stages: GuardrailStage[];
  /** Its deadline per evaluation; past it the guard blocks. */
  timeoutMs: number;
}

export interface ActiveGuardrail {
  id: string;
  service: IGuardrailService;
}

export interface RequiredGuardrailReport {
  ok: boolean;
  /** Required ids with no active guard. */
  missing: string[];
  /** Required stages an active guard does not implement. */
  missingStage: Array<{ id: string; stage: GuardrailStage }>;
}

/** Compares the active guards with the required ones. */
export function checkRequiredGuardrails(active: readonly ActiveGuardrail[], required: readonly RequiredGuardrailSpec[]): RequiredGuardrailReport {
  const missing: string[] = [];
  const missingStage: Array<{ id: string; stage: GuardrailStage }> = [];
  for (const spec of required) {
    const found = active.find((a) => a.id === spec.id);
    if (!found) {
      missing.push(spec.id);
      continue;
    }
    for (const stage of spec.stages) {
      const method = stage === 'input' ? found.service.evaluateInput : found.service.evaluateOutput;
      // a guard that declares its stages is held to them: a method that exists but is configured off is no coverage
      const implemented = typeof method === 'function' && (found.service.stages === undefined || found.service.stages.includes(stage));
      if (!implemented) missingStage.push({ id: spec.id, stage });
    }
  }
  return { ok: missing.length === 0 && missingStage.length === 0, missing, missingStage };
}

/** Throws a configuration error naming every missing guard and stage. */
export function assertRequiredGuardrails(active: readonly ActiveGuardrail[], required: readonly RequiredGuardrailSpec[]): void {
  const report = checkRequiredGuardrails(active, required);
  if (report.ok) return;
  const parts = [
    ...report.missing.map((id) => `${id} is not active`),
    ...report.missingStage.map(({ id, stage }) => `${id} does not evaluate ${stage}`),
  ];
  throw new GMIError(`Required guardrails are missing: ${parts.join('; ')}.`, GMIErrorCode.CONFIGURATION_ERROR, {
    missing: report.missing,
    missingStage: report.missingStage,
  });
}

const ACTIONS = new Set<string>(Object.values(GuardrailAction));

/**
 * A well-formed answer as it came. `null` is an allow. An answer whose action is not one of {@link GuardrailAction}
 * as a string, `undefined` included (a guard that returned nothing), is written once as `guardrail.failed` with cause
 * `malformed`, then turned into a BLOCK that names the guard in `metadata.guardrailId` when the guard runs closed, or
 * dropped when it runs open.
 */
function settled(evaluation: GuardrailEvaluationResult | null, guardrailId: string | undefined, stage: GuardrailStage, closed: boolean): GuardrailEvaluationResult | null {
  if (evaluation === null) return null;
  // the action must be the string itself: a String object prints as one but fails the dispatcher's strict comparison
  const action: unknown = typeof evaluation === 'object' ? (evaluation as GuardrailEvaluationResult).action : undefined;
  if (typeof action === 'string' && ACTIONS.has(action)) return evaluation;
  guardrailLog.warn('guardrail.failed', { guardrailId: safeWord(guardrailId), stage, posture: closed ? 'closed' : 'open', cause: 'malformed' });
  if (!closed) return null;
  return markGuardFailure({ action: GuardrailAction.BLOCK, reason: 'The guardrail answered with no recognised action.', reasonCode: 'GUARDRAIL_MALFORMED', metadata: { failClosed: true, cause: 'malformed', ...(guardrailId ? { guardrailId } : {}) } });
}

/**
 * The guard as a required one runs: under its id, fail-closed, with the spec's deadline, and with a malformed answer
 * turned into a block. The original service is not changed.
 */
export function withRequiredPosture(id: string, svc: IGuardrailService, spec: RequiredGuardrailSpec): IGuardrailService {
  const wrapped: IGuardrailService = {
    id,
    config: { ...svc.config, failClosed: true, timeoutMs: spec.timeoutMs },
  };
  if (typeof svc.evaluateInput === 'function') {
    wrapped.evaluateInput = async (payload) => settled(await svc.evaluateInput!(payload), id, 'input', true);
  }
  if (typeof svc.evaluateOutput === 'function') {
    wrapped.evaluateOutput = async (payload) => settled(await svc.evaluateOutput!(payload), id, 'output', true);
  }
  return wrapped;
}

export interface ModerationPostureOptions {
  /** The deadline for a guard whose config sets none. Default 8000 ms, the phrase-list guard's own. */
  timeoutMs?: number;
}

const MODERATION_TIMEOUT_MS = 8_000;
const positive = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined);

/**
 * The guard as a moderation entry point runs it: `failClosed` true unless its config says false; a deadline; an
 * answer with no recognised action turned into a BLOCK (when closed) or dropped (when open); its id stamped into
 * `metadata.guardrailId`. The original service is not changed.
 *
 * The wrapper races no deadline and catches nothing itself: the dispatcher reads the wrapped config, so one place
 * applies the deadline, builds the synthetic BLOCK of a guard that throws or runs late, and writes `guardrail.failed`.
 *
 * @param svc - The guard.
 * @param options - The deadline for a guard whose config names none.
 * @returns A new service over the same guard.
 */
export function withModerationPosture(svc: IGuardrailService, options: ModerationPostureOptions = {}): IGuardrailService {
  const closed = svc.config?.failClosed !== false;
  const timeoutMs = positive(svc.config?.timeoutMs) ?? positive(options.timeoutMs) ?? MODERATION_TIMEOUT_MS;
  const wrapped: IGuardrailService = {
    ...(svc.id !== undefined ? { id: svc.id } : {}),
    ...(svc.stages !== undefined ? { stages: svc.stages } : {}),
    config: { ...svc.config, failClosed: closed, timeoutMs },
  };
  const finish = (evaluation: GuardrailEvaluationResult | null, stage: GuardrailStage): GuardrailEvaluationResult | null => {
    const answer = settled(evaluation, svc.id, stage, closed);
    if (answer === null || svc.id === undefined) return answer;
    return carryGuardFailure(answer, { ...answer, metadata: { ...(answer.metadata ?? {}), guardrailId: svc.id } });
  };
  if (typeof svc.evaluateInput === 'function') wrapped.evaluateInput = async (payload) => finish(await svc.evaluateInput!(payload), 'input');
  if (typeof svc.evaluateOutput === 'function') wrapped.evaluateOutput = async (payload) => finish(await svc.evaluateOutput!(payload), 'output');
  return wrapped;
}

/** The guard under an id: its own, or `guard_<index>` when it has none. A guard with an id is returned as it is. */
export function namedGuard(svc: IGuardrailService, index: number): IGuardrailService {
  if (typeof svc.id === 'string' && svc.id.length > 0) return svc;
  const named: IGuardrailService = {
    id: `guard_${index}`,
    ...(svc.stages !== undefined ? { stages: svc.stages } : {}),
    ...(svc.config !== undefined ? { config: svc.config } : {}),
  };
  if (typeof svc.evaluateInput === 'function') named.evaluateInput = (payload) => svc.evaluateInput!(payload);
  if (typeof svc.evaluateOutput === 'function') named.evaluateOutput = (payload) => svc.evaluateOutput!(payload);
  return named;
}
