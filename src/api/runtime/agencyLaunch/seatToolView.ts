/**
 * @file seatToolView.ts
 * A runtime seat's tools: a view of the runtime's shared tool orchestrator that lists and runs the seat's names alone.
 * A call to any other name is answered `{ skipped: true, reason: 'not available in this seat' }` (code
 * `TOOL_NOT_IN_SEAT`), as a gmi() seat's is, and its tool never runs. A call to one of the seat's names asks the
 * approval gate of the call the seat serves (the gate the child agency passes with it, which `agencies.hitl` makes at a
 * root launch) about a tool the orchestrator has, as gmi()'s view asks: anything but the exact approval skips the tool,
 * and the model is told why; a call whose stop has come asks no one, and the orchestrator refuses it (`STEP_ABORTED`).
 * An approval is for the registration the gate was asked about: the view hands that instance on as the call's `tool`,
 * so a tool registered under the name while the approval was pending never runs under it (the orchestrator refuses the
 * call, `STEP_REPLACED`). Every call the view passes on carries `callerTurn` with the seat's names, that gate and the
 * view's own `processToolCall` as `dispatch`, through which the shared orchestrator's step gate runs each step of a
 * composition the seat calls: a step meets the seat's names and that gate as the seat's direct calls do, and a step
 * whose tool is outside the names never runs. Every other member runs on the shared orchestrator, whose own checks (the
 * persona's capabilities, the approval of a tool with side effects) still apply to each call.
 * @internal
 */
import type { ITool } from '../../../core/tools/ITool.js';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator.js';
import { APPROVAL_GRANTED, askApprovalGate, type ApprovalGateFn } from '../approval-gate.js';
import { withMembers } from '../withMembers.js';
import type { CallerTurnContext } from './types.js';

/** Why a call outside the seat's names was not run, as the model reads it. */
const NOT_IN_SEAT = 'not available in this seat';

/**
 * @param base - The runtime's shared tool orchestrator.
 * @param names - The seat's tool names.
 * @param gateOf - The approval gate of the call the seat serves, read at each tool call: the one the child agency
 *   passes with that call; undefined between calls and for a team that has none.
 * @returns The seat's orchestrator.
 */
export function seatToolView(
  base: IToolOrchestrator,
  names: ReadonlySet<string>,
  gateOf: () => ApprovalGateFn | undefined = () => undefined,
): IToolOrchestrator {
  const visible = <T extends { name: string }>(tools: T[]): T[] => tools.filter((tool) => names.has(tool.name));
  const processToolCall: IToolOrchestrator['processToolCall'] = async (details) => {
    const req = details.toolCallRequest;
    if (!names.has(req.name)) {
      return {
        toolCallId: req.id,
        toolName: req.name,
        output: { skipped: true, reason: NOT_IN_SEAT },
        isError: true,
        errorDetails: { message: `Skipped: ${NOT_IN_SEAT}`, code: 'TOOL_NOT_IN_SEAT' },
      };
    }
    // The gate of the call the seat serves, after the name filter, about a tool the orchestrator has: anything but the
    // exact approval skips the tool, and the model is told why. A tool the orchestrator does not have is reported by it
    // without asking anyone, and so is a call whose stop has come: the orchestrator refuses it (STEP_ABORTED). The view
    // does not see the step of the GMI's tool loop, so the request names step 0.
    const gate = gateOf();
    const current = gate ? await base.getTool(req.name) : undefined;
    let bound: ITool | undefined;
    if (gate && current && !details.signal?.aborted) {
      const verdict = await askApprovalGate(gate, { name: req.name, args: req.arguments ?? {}, id: req.id, step: 0 });
      if (verdict !== APPROVAL_GRANTED) {
        return {
          toolCallId: req.id,
          toolName: req.name,
          output: { skipped: true, reason: verdict.reason },
          isError: true,
          errorDetails: { message: `Skipped: ${verdict.reason}` },
        };
      }
      // The approval is for the registration the gate was asked about. A composed step arrives with the instance its
      // pipeline checked already.
      if (!details.tool) bound = current;
    }
    const callerTurn: CallerTurnContext = {
      ...(details.callerTurn ?? {}),
      toolNames: names,
      ...(gate ? { approvalGate: gate } : {}),
      dispatch: processToolCall,
    };
    // The orchestrator checks and runs the bound instance alone, and refuses the call (STEP_REPLACED) when another
    // registration took the name while the approval was pending.
    return base.processToolCall({ ...details, ...(bound ? { tool: bound } : {}), callerTurn });
  };
  return withMembers(base, {
    processToolCall,
    listAvailableTools: async (context?: Parameters<IToolOrchestrator['listAvailableTools']>[0]) => visible(await base.listAvailableTools(context)),
    // The base's listDiscoveredTools calls its own listAvailableTools, which this view does not reach.
    ...(typeof base.listDiscoveredTools === 'function'
      ? {
          listDiscoveredTools: async (...args: Parameters<NonNullable<IToolOrchestrator['listDiscoveredTools']>>) =>
            visible(await base.listDiscoveredTools!(...args)),
        }
      : {}),
  });
}
