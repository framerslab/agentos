/**
 * @module crossAgentGuardrailDispatcher
 *
 * Dispatcher for cross-agent guardrail evaluations.
 *
 * Enables supervisor/observer guardrails to monitor and intervene in
 * other agents' output streams within an agency.
 *
 * @example
 * ```typescript
 * // Wrap an agent's output with cross-agent guardrail supervision
 * const supervisedStream = wrapWithCrossAgentGuardrails(
 *   crossAgentGuardrails,
 *   { sourceAgentId: 'worker-1', observerAgentId: 'supervisor', agencyId: 'agency-1' },
 *   guardrailContext,
 *   workerOutputStream,
 *   { streamId: 'stream-123' }
 * );
 * ```
 */
import { AgentOSResponse, AgentOSResponseChunkType, type AgentOSFinalResponseChunk } from '../../api/types/AgentOSResponse';
import {
  GuardrailAction,
  type GuardrailContext,
  type GuardrailEvaluationResult,
} from './IGuardrailService';
import {
  type CrossAgentOutputPayload,
  type ICrossAgentGuardrailService,
  isCrossAgentGuardrail,
  shouldObserveAgent,
} from './ICrossAgentGuardrailService';
import { createGuardrailBlockedStream, type GuardrailOutputOptions } from './guardrailDispatcher';
import { sanitizedFinalResponse } from './sanitizedFinalResponse';

/**
 * Context for cross-agent guardrail evaluation.
 */
export interface CrossAgentGuardrailContext {
  /** The agent whose output is being observed */
  sourceAgentId: string;

  /** The agent running the cross-agent guardrails */
  observerAgentId: string;

  /** Agency ID if agents are in the same agency */
  agencyId?: string;
}

/**
 * Result of cross-agent guardrail evaluation for a chunk.
 */
export interface CrossAgentEvaluationResult {
  /** Whether the chunk should be blocked */
  blocked: boolean;

  /** Modified chunk (if sanitized) */
  modifiedChunk?: AgentOSResponse;

  /** All evaluation results from cross-agent guardrails */
  evaluations: GuardrailEvaluationResult[];
}

/**
 * Evaluate a chunk through all applicable cross-agent guardrails.
 *
 * Filters guardrails to only those observing the source agent, then
 * evaluates the chunk through each. Respects `canInterruptOthers` flag.
 *
 * @param guardrails - Cross-agent guardrails to evaluate
 * @param crossAgentContext - Source/observer agent context
 * @param guardrailContext - Standard guardrail context
 * @param chunk - The output chunk to evaluate
 * @returns Evaluation result with blocked status and any modifications
 *
 * @example
 * ```typescript
 * const result = await evaluateCrossAgentGuardrails(
 *   crossAgentGuardrails,
 *   { sourceAgentId: 'worker-1', observerAgentId: 'supervisor' },
 *   guardrailContext,
 *   textDeltaChunk
 * );
 *
 * if (result.blocked) {
 *   // Terminate the source agent's stream
 * } else if (result.modifiedChunk) {
 *   // Use the sanitized chunk
 * }
 * ```
 */
export async function evaluateCrossAgentGuardrails(
  guardrails: ICrossAgentGuardrailService[],
  crossAgentContext: CrossAgentGuardrailContext,
  guardrailContext: GuardrailContext,
  chunk: AgentOSResponse,
): Promise<CrossAgentEvaluationResult> {
  const evaluations: GuardrailEvaluationResult[] = [];
  let currentChunk = chunk;
  let blocked = false;

  // Filter to guardrails that should observe this agent
  const applicableGuardrails = guardrails.filter((g) =>
    shouldObserveAgent(g, crossAgentContext.sourceAgentId),
  );

  for (const guardrail of applicableGuardrails) {
    // Skip if no cross-agent evaluation method
    if (typeof guardrail.evaluateCrossAgentOutput !== 'function') {
      continue;
    }

    // Check if this guardrail evaluates streaming chunks
    const isStreamingChunk =
      currentChunk.type === AgentOSResponseChunkType.TEXT_DELTA && !currentChunk.isFinal;
    if (isStreamingChunk && !guardrail.config?.evaluateStreamingChunks) {
      continue;
    }

    // Build payload
    const payload: CrossAgentOutputPayload = {
      sourceAgentId: crossAgentContext.sourceAgentId,
      observerAgentId: crossAgentContext.observerAgentId,
      agencyId: crossAgentContext.agencyId,
      chunk: currentChunk,
      context: guardrailContext,
    };

    let evaluation: GuardrailEvaluationResult | null = null;
    try {
      evaluation = await guardrail.evaluateCrossAgentOutput(payload);
    } catch (error) {
      console.warn('[AgentOS][CrossAgentGuardrails] evaluateCrossAgentOutput failed.', error);
      continue;
    }

    if (!evaluation) {
      continue;
    }

    // Downgrade BLOCK/SANITIZE to FLAG if canInterruptOthers is false
    if (!guardrail.canInterruptOthers) {
      if (
        evaluation.action === GuardrailAction.BLOCK ||
        evaluation.action === GuardrailAction.SANITIZE
      ) {
        evaluation = {
          ...evaluation,
          action: GuardrailAction.FLAG,
          metadata: {
            ...evaluation.metadata,
            originalAction: evaluation.action,
            downgraded: true,
          },
        };
      }
    }

    evaluations.push(evaluation);

    // Handle actions
    if (evaluation.action === GuardrailAction.BLOCK) {
      blocked = true;
      break;
    }

    if (
      evaluation.action === GuardrailAction.SANITIZE &&
      evaluation.modifiedText !== undefined
    ) {
      // Modify the chunk based on type
      if (currentChunk.type === AgentOSResponseChunkType.TEXT_DELTA) {
        currentChunk = {
          ...currentChunk,
          textDelta: evaluation.modifiedText,
        } as AgentOSResponse;
      } else if (currentChunk.type === AgentOSResponseChunkType.FINAL_RESPONSE) {
        // every field that carries the reply reads the rewrite, as an output guardrail's SANITIZE leaves it
        currentChunk = sanitizedFinalResponse(currentChunk as AgentOSFinalResponseChunk, evaluation.modifiedText);
      }
    }
  }

  return {
    blocked,
    modifiedChunk: currentChunk !== chunk ? currentChunk : undefined,
    evaluations,
  };
}

/**
 * Wrap an agent's output stream with cross-agent guardrail supervision.
 *
 * Creates an async generator that evaluates each chunk through applicable
 * cross-agent guardrails before yielding. If any guardrail returns BLOCK
 * (and has `canInterruptOthers: true`), the stream is terminated.
 *
 * @param guardrails - Cross-agent guardrails to apply
 * @param crossAgentContext - Source/observer agent context
 * @param guardrailContext - Standard guardrail context
 * @param stream - Source agent's output stream
 * @param options - Stream options
 * @returns Supervised stream with cross-agent guardrail filtering
 *
 * @example
 * ```typescript
 * // Supervisor monitors worker agent
 * const supervisedStream = wrapWithCrossAgentGuardrails(
 *   [qualityGate, policyEnforcer],
 *   {
 *     sourceAgentId: 'worker-analyst',
 *     observerAgentId: 'supervisor',
 *     agencyId: 'research-agency'
 *   },
 *   guardrailContext,
 *   workerStream,
 *   { streamId: 'stream-xyz' }
 * );
 *
 * for await (const chunk of supervisedStream) {
 *   // Chunk has been approved/modified by cross-agent guardrails
 *   yield chunk;
 * }
 * ```
 */
export async function* wrapWithCrossAgentGuardrails(
  guardrails: ICrossAgentGuardrailService[],
  crossAgentContext: CrossAgentGuardrailContext,
  guardrailContext: GuardrailContext,
  stream: AsyncGenerator<AgentOSResponse, void, undefined>,
  options: GuardrailOutputOptions,
): AsyncGenerator<AgentOSResponse, void, undefined> {
  // Filter to applicable guardrails once
  const applicableGuardrails = guardrails.filter((g) =>
    shouldObserveAgent(g, crossAgentContext.sourceAgentId),
  );

  // If no applicable guardrails, pass through unchanged
  if (applicableGuardrails.length === 0) {
    yield* stream;
    return;
  }

  for await (const chunk of stream) {
    const result = await evaluateCrossAgentGuardrails(
      applicableGuardrails,
      crossAgentContext,
      guardrailContext,
      chunk,
    );

    if (result.blocked) {
      // Find the blocking evaluation for the error message
      const blockingEval = result.evaluations.find(
        (e) => e.action === GuardrailAction.BLOCK,
      );
      if (blockingEval) {
        yield* createGuardrailBlockedStream(guardrailContext, blockingEval, options);
      }
      return;
    }

    // Yield the (potentially modified) chunk
    const outputChunk = result.modifiedChunk ?? chunk;

    // Attach cross-agent evaluation metadata
    if (result.evaluations.length > 0) {
      const metadata = outputChunk.metadata ?? {};
      yield {
        ...outputChunk,
        metadata: {
          ...metadata,
          crossAgentGuardrail: {
            evaluations: result.evaluations.map((e) => ({
              action: e.action,
              reason: e.reason,
              reasonCode: e.reasonCode,
              metadata: e.metadata,
            })),
            sourceAgentId: crossAgentContext.sourceAgentId,
            observerAgentId: crossAgentContext.observerAgentId,
          },
        },
      };
    } else {
      yield outputChunk;
    }
  }
}

/**
 * Extract cross-agent guardrails from a mixed array of guardrail services.
 *
 * @param services - Array of guardrail services (may include non-cross-agent)
 * @returns Only the cross-agent guardrail services
 */
export function filterCrossAgentGuardrails(
  services: unknown[],
): ICrossAgentGuardrailService[] {
  return services.filter(
    (s): s is ICrossAgentGuardrailService =>
      s != null && typeof s === 'object' && isCrossAgentGuardrail(s as ICrossAgentGuardrailService),
  );
}
