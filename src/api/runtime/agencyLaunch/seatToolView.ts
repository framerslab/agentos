/**
 * @file seatToolView.ts
 * A runtime seat's tools: a view of the runtime's shared tool orchestrator that lists and runs the seat's names alone.
 * A call to any other name is answered `{ skipped: true, reason: 'not available in this seat' }` (code
 * `TOOL_NOT_IN_SEAT`), as a gmi() seat's is, and its tool never runs. Every call the view passes on carries
 * `callerTurn` with the seat's names and the view's own `processToolCall` as `dispatch`. Every other member runs on the
 * shared orchestrator, whose own checks (the persona's capabilities, the approval of a tool with side effects) still
 * apply to each call.
 * @internal
 */
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator.js';
import { withMembers } from '../withMembers.js';
import type { CallerTurnContext } from './types.js';

/** Why a call outside the seat's names was not run, as the model reads it. */
const NOT_IN_SEAT = 'not available in this seat';

/**
 * @param base - The runtime's shared tool orchestrator.
 * @param names - The seat's tool names.
 * @returns The seat's orchestrator.
 */
export function seatToolView(base: IToolOrchestrator, names: ReadonlySet<string>): IToolOrchestrator {
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
    const callerTurn: CallerTurnContext = { ...(details.callerTurn ?? {}), toolNames: names, dispatch: processToolCall };
    return base.processToolCall({ ...details, callerTurn });
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
