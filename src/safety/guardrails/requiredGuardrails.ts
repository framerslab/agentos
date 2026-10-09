/**
 * @module guardrails/requiredGuardrails
 *
 * Guards a deployment cannot run without. A product names them by id and stage; AgentOS refuses to start when one is
 * missing, refuses a request when one has gone missing since, and runs each one fail-closed with a deadline, so a
 * guard that throws, hangs or answers nonsense blocks instead of letting the reply through.
 */
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { GuardrailAction, type GuardrailEvaluationResult, type IGuardrailService } from './IGuardrailService';

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
      const implemented = stage === 'input' ? typeof found.service.evaluateInput === 'function' : typeof found.service.evaluateOutput === 'function';
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

/** An evaluation whose action is not one of {@link GuardrailAction} is a malformed answer, and a required guard's malformed answer blocks. */
function wellFormed(evaluation: GuardrailEvaluationResult | null): GuardrailEvaluationResult | null {
  if (evaluation === null || evaluation === undefined) return null;
  if (typeof evaluation === 'object' && ACTIONS.has(String((evaluation as GuardrailEvaluationResult).action))) return evaluation;
  return { action: GuardrailAction.BLOCK, reason: 'The guardrail answered with no recognised action.', reasonCode: 'GUARDRAIL_MALFORMED', metadata: { failClosed: true } };
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
    wrapped.evaluateInput = async (payload) => wellFormed(await svc.evaluateInput!(payload));
  }
  if (typeof svc.evaluateOutput === 'function') {
    wrapped.evaluateOutput = async (payload) => wellFormed(await svc.evaluateOutput!(payload));
  }
  return wrapped;
}
