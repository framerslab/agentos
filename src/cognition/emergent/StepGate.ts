/**
 * @fileoverview The step gate: where a tool run on a caller's behalf (a step
 * of a composed tool, a step of a workflow) meets the checks a direct call
 * meets, and the one rule for which tools may be chained at all.
 * @module @framers/agentos/emergent/StepGate
 */

import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../core/tools/ITool.js';
import type { IToolPermissionManager } from '../../core/tools/permissions/IToolPermissionManager.js';
import type {
  ActionSeverity,
  IHumanInteractionManager,
} from '../../orchestration/hitl/IHumanInteractionManager.js';

/**
 * Runs one step with the host's checks. Built by `ToolOrchestrator`, or by a
 * host with {@link createStepGate}.
 */
export interface StepGate {
  /** The tool a step names, as registered right now, or `undefined`. */
  resolve(name: string): ITool | undefined;
  /**
   * Run one step as the caller in `context`. The step's tool is the instance
   * the pipeline resolved and checked, so a registration that replaces the
   * name between the check and the run is not what runs. A `signal` that is
   * already aborted when the checks are done stops the step before its tool.
   */
  run(
    tool: ITool,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    signal?: AbortSignal,
  ): Promise<ToolExecutionResult>;
}

/**
 * Why a step may not be chained: no gate to resolve it (`compose_needs_gate`),
 * no tool under its name (`step_missing`), a tool with side effects the host
 * has not listed (`step_not_chainable`), a tool that does not declare
 * `hasSideEffects` (`side_effects_undeclared`), or a chain that reaches itself
 * (`step_cycle`).
 */
export type ChainRefusalCode =
  | 'compose_needs_gate'
  | 'step_missing'
  | 'step_not_chainable'
  | 'side_effects_undeclared'
  | 'step_cycle';

/**
 * The rule's verdict for one step tool: chainable (and whether it has side
 * effects, which decides whether a forge test runs it), or refused with a
 * {@link ChainRefusalCode} and a message naming what the host can change.
 */
export type Chainability =
  | { ok: true; sideEffects: boolean }
  | { ok: false; code: ChainRefusalCode; message: string };

/** The message a composition gets when its builder has no gate (`compose_needs_gate`). */
export const COMPOSE_NEEDS_GATE_MESSAGE =
  'this engine composes tools through a bare callback, which cannot say what a step tool is; ' +
  'pass a StepGate (createStepGate({ resolve, ... })) to ComposableToolBuilder or as deps.stepGate';

/**
 * Compositions nest no deeper than this at run time. A deeper chain is
 * refused with `nesting_too_deep`: the call fails and no composition is
 * suspended for it, since a long chain is not a cycle.
 */
export const MAX_COMPOSITION_DEPTH = 8;

/**
 * The one rule for chaining a tool as a step.
 *
 * - `hasSideEffects: false`: chained freely.
 * - `hasSideEffects: true`: only when the host lists the tool's name.
 * - flag unset: by no one, listed or not; the host declares it first.
 * - not registered: nothing to chain.
 */
export function checkChainable(
  stepTool: string,
  tool: ITool | undefined,
  sideEffectingTools: readonly string[],
): Chainability {
  if (!tool) {
    return { ok: false, code: 'step_missing', message: `step tool "${stepTool}" is not registered` };
  }
  if (tool.hasSideEffects === false) {
    return { ok: true, sideEffects: false };
  }
  if (tool.hasSideEffects === undefined) {
    return {
      ok: false,
      code: 'side_effects_undeclared',
      message:
        `step tool "${stepTool}" does not declare hasSideEffects; ` +
        'set it to true or false on the tool before a composition or a workflow can chain it',
    };
  }
  if (sideEffectingTools.includes(stepTool)) {
    return { ok: true, sideEffects: true };
  }
  return {
    ok: false,
    code: 'step_not_chainable',
    message:
      `step tool "${stepTool}" has side effects and is not listed in ` +
      'emergent.compose.sideEffectingTools',
  };
}

export interface StepGateOptions {
  /** The step's tool as registered right now. */
  resolve: (name: string) => ITool | undefined;
  /** Tools the host has switched off; a step naming one is refused. */
  isDisabled?: (tool: ITool) => boolean;
  /** When given, every step is checked with the caller's capabilities. */
  permissionManager?: Pick<IToolPermissionManager, 'isExecutionAllowed'>;
  /** When given with `hitl.enabled`, a side-effecting step asks approval. */
  hitlManager?: Pick<IHumanInteractionManager, 'requestApproval'>;
  /** Same meaning as `ToolOrchestratorConfig.hitl`. */
  hitl?: {
    enabled?: boolean;
    requireApprovalForSideEffects?: boolean;
    autoApproveWhenNoManager?: boolean;
    defaultSideEffectsSeverity?: ActionSeverity;
    approvalTimeoutMs?: number;
  };
}

/**
 * A gate for a host that builds the engine itself. `ToolOrchestrator` does
 * not use this: its gate runs each step through `processToolCall`.
 *
 * Built with `resolve` alone, the gate runs a step by calling the tool: no
 * permission check and no approval, as a direct call has in a host with
 * neither manager. The chainability rule is applied by the builder either way.
 */
export function createStepGate(options: StepGateOptions): StepGate {
  return {
    resolve: options.resolve,
    async run(tool, args, context, signal) {
      const step = tool.name;
      if (options.isDisabled?.(tool)) {
        return { success: false, error: `step tool "${step}" is disabled`, details: { code: 'step_disabled' } };
      }
      if (options.permissionManager) {
        const verdict = await options.permissionManager.isExecutionAllowed({
          tool,
          personaId: context.personaId,
          personaCapabilities: context.personaCapabilities ?? [],
          userContext: context.userContext,
          gmiId: context.gmiId,
        });
        if (!verdict.isAllowed) {
          return {
            success: false,
            error: verdict.reason ?? `permission denied for step tool "${step}"`,
            details: { ...(verdict.details ?? {}), code: 'permission_denied' },
          };
        }
      }
      const hitl = options.hitl;
      if (hitl?.enabled && (hitl.requireApprovalForSideEffects ?? true) && tool.hasSideEffects === true) {
        if (!options.hitlManager) {
          if (!hitl.autoApproveWhenNoManager) {
            return {
              success: false,
              error: `step tool "${step}" has side effects and requires approval, but no approval manager is configured`,
              details: { code: 'approval_unavailable' },
            };
          }
        } else {
          // The approval is for this registration of the tool: its id is in the action id.
          const decision = await options.hitlManager.requestApproval({
            actionId: `step:${context.gmiId}:${context.personaId}:${step}:${tool.id}:${context.correlationId ?? 'no-correlation'}`,
            description: `Execute tool '${step}' as a step (side effects)`,
            severity: hitl.defaultSideEffectsSeverity ?? 'high',
            agentId: context.personaId,
            context: {
              toolName: tool.name,
              toolId: tool.id,
              gmiId: context.gmiId,
              personaId: context.personaId,
            },
            reversible: false,
            requestedAt: new Date(),
            timeoutMs: hitl.approvalTimeoutMs,
          });
          if (!decision.approved) {
            return {
              success: false,
              error: decision.rejectionReason || `step tool "${step}" was rejected`,
              details: { code: 'approval_rejected' },
            };
          }
        }
      }
      if (signal?.aborted) {
        return {
          success: false,
          error: 'step_aborted: the step expired before its tool ran',
          details: { code: 'step_aborted' },
        };
      }
      return withInnerCode(await tool.execute(args, context));
    },
  };
}

/**
 * A step's own failed result as the enclosing composition reads it: a `code`
 * the step tool put in its details (a nested composition's refusal of one of
 * its own steps) moves to `innerCode`, so it never reads as a refusal of the
 * enclosing composition's step, and only the nested composition is suspended.
 */
export function withInnerCode(result: ToolExecutionResult): ToolExecutionResult {
  const details = result.details as Record<string, unknown> | undefined;
  if (result.success || !details || details.code === undefined) {
    return result;
  }
  const { code: innerCode, ...rest } = details;
  return { ...result, details: { ...rest, innerCode } };
}
