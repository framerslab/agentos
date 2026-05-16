/**
 * @module guardrailDispatcher
 *
 * Dispatches guardrail evaluations for input and output processing.
 *
 * This module provides two main functions:
 * - {@link evaluateInputGuardrails} - Evaluate user input before orchestration
 * - {@link wrapOutputGuardrails} - Wrap output stream with guardrail filtering
 *
 * @example
 * ```typescript
 * // Input evaluation
 * const outcome = await evaluateInputGuardrails(
 *   guardrailServices,
 *   userInput,
 *   guardrailContext
 * );
 *
 * if (outcome.evaluation?.action === GuardrailAction.BLOCK) {
 *   return createGuardrailBlockedStream(context, outcome.evaluation);
 * }
 *
 * // Output wrapping
 * const safeStream = wrapOutputGuardrails(
 *   guardrailServices,
 *   guardrailContext,
 *   outputStream,
 *   { streamId, personaId }
 * );
 * ```
 */
import { uuidv4 } from '../../core/utils/uuid.js';
import type { AgentOSInput } from '../../api/types/AgentOSInput';
import {
  AgentOSResponse,
  AgentOSResponseChunkType,
  type AgentOSErrorChunk,
} from '../../api/types/AgentOSResponse';
import {
  GuardrailAction,
  type GuardrailContext,
  type GuardrailEvaluationResult,
  type IGuardrailService,
} from './IGuardrailService';
import { ParallelGuardrailDispatcher } from './ParallelGuardrailDispatcher';

/**
 * Normalize a service input (single, array, or undefined) into a flat array.
 *
 * Filters out falsy entries so callers never need null-checks.
 *
 * @param service - Single guardrail, array of guardrails, or undefined
 * @returns Non-empty array of valid guardrail services
 */
export function normalizeServices(
  service: IGuardrailService | IGuardrailService[] | undefined,
): IGuardrailService[] {
  return Array.isArray(service)
    ? service.filter(Boolean)
    : service
    ? [service]
    : [];
}

/**
 * Type guard to check if a guardrail service implements evaluateOutput.
 *
 * @param svc - The guardrail service to inspect
 * @returns `true` when `svc.evaluateOutput` is a callable function
 */
export function hasEvaluateOutput(
  svc: IGuardrailService,
): svc is IGuardrailService & {
  evaluateOutput: NonNullable<IGuardrailService['evaluateOutput']>;
} {
  return typeof (svc as IGuardrailService).evaluateOutput === 'function';
}

/**
 * Result of running input guardrails.
 *
 * Contains the potentially modified input and all evaluation results.
 * Check `evaluation.action` to determine if processing should continue.
 */
export interface GuardrailInputOutcome {
  /** Input after all sanitization (may be modified from original) */
  sanitizedInput: AgentOSInput;

  /** The last evaluation result. Convenience accessor; prefer `evaluations[]` for the full set. */
  evaluation?: GuardrailEvaluationResult | null;

  /** All evaluation results from all guardrails in execution order. */
  evaluations?: GuardrailEvaluationResult[];
}

/**
 * Options for output guardrail wrapping.
 */
export interface GuardrailOutputOptions {
  /** Stream identifier for error chunks */
  streamId: string;

  /** Persona ID for error chunks */
  personaId?: string;

  /** Input evaluations to attach to first output chunk */
  inputEvaluations?: GuardrailEvaluationResult[] | null;

  /** RAG sources to thread through to output guardrails for grounding verification */
  ragSources?: import('../../cognition/rag').RagRetrievedChunk[];
}

/**
 * Metadata entry attached to response chunks.
 *
 * Compact representation of a {@link GuardrailEvaluationResult} that gets
 * embedded into chunk `metadata.guardrail.input[]` / `metadata.guardrail.output[]`.
 */
export interface GuardrailMetadataEntry {
  action: GuardrailAction;
  reason?: string;
  reasonCode?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Evaluate user input through all registered guardrails.
 *
 * Runs guardrails in sequence, allowing each to modify or block the input.
 * If any guardrail returns {@link GuardrailAction.BLOCK}, evaluation stops
 * immediately and the blocked result is returned.
 *
 * @param service - Single guardrail or array of guardrails to evaluate
 * @param input - User input to evaluate
 * @param context - Conversation context for policy decisions
 * @returns Outcome containing sanitized input and all evaluations
 *
 * @example
 * ```typescript
 * const outcome = await evaluateInputGuardrails(
 *   [contentFilter, piiRedactor],
 *   userInput,
 *   { userId: 'user-123', sessionId: 'session-abc' }
 * );
 *
 * if (outcome.evaluation?.action === GuardrailAction.BLOCK) {
 *   // Input was blocked - return error stream
 *   yield* createGuardrailBlockedStream(context, outcome.evaluation);
 *   return;
 * }
 *
 * // Use sanitized input for orchestration
 * const cleanInput = outcome.sanitizedInput;
 * ```
 */
export async function evaluateInputGuardrails(
  service: IGuardrailService | IGuardrailService[] | undefined,
  input: AgentOSInput,
  context: GuardrailContext,
): Promise<GuardrailInputOutcome> {
  // Delegate to the two-phase parallel dispatcher.
  // normalizeServices handles single / array / undefined normalization.
  return ParallelGuardrailDispatcher.evaluateInput(normalizeServices(service), input, context);
}

/**
 * Create a stream that emits a single error chunk for blocked content.
 *
 * Use this when input evaluation returns {@link GuardrailAction.BLOCK}
 * to generate an appropriate error response without invoking orchestration.
 *
 * @param context - Guardrail context for the error details
 * @param evaluation - The blocking evaluation result
 * @param options - Stream options (streamId, personaId)
 * @returns Async generator yielding a single ERROR chunk
 *
 * @example
 * ```typescript
 * if (outcome.evaluation?.action === GuardrailAction.BLOCK) {
 *   yield* createGuardrailBlockedStream(
 *     guardrailContext,
 *     outcome.evaluation,
 *     { streamId: 'stream-123', personaId: 'support-agent' }
 *   );
 *   return;
 * }
 * ```
 */
export async function* createGuardrailBlockedStream(
  context: GuardrailContext,
  evaluation: GuardrailEvaluationResult,
  options?: GuardrailOutputOptions,
): AsyncGenerator<AgentOSResponse, void, undefined> {
  const streamId = options?.streamId ?? uuidv4();
  const errorChunk: AgentOSErrorChunk = {
    type: AgentOSResponseChunkType.ERROR,
    streamId,
    gmiInstanceId: 'guardrail',
    personaId: options?.personaId ?? context.personaId ?? 'unknown_persona',
    isFinal: true,
    timestamp: new Date().toISOString(),
    code: evaluation.reasonCode ?? 'GUARDRAIL_BLOCKED',
    message: evaluation.reason ?? 'Request blocked by guardrail policy.',
    details: {
      action: evaluation.action,
      metadata: evaluation.metadata,
      context,
    },
  };
  yield errorChunk;
}

/**
 * Wrap a response stream with guardrail filtering.
 *
 * Creates an async generator that evaluates each chunk through registered
 * guardrails before yielding to the client. Supports both real-time streaming
 * evaluation and final-only evaluation based on guardrail configuration.
 *
 * **Evaluation Strategy:**
 * - Guardrails with `config.evaluateStreamingChunks === true` evaluate TEXT_DELTA chunks
 * - All guardrails evaluate FINAL_RESPONSE chunks (final safety check)
 * - Rate limiting via `config.maxStreamingEvaluations` per guardrail
 *
 * **Actions:**
 * - {@link GuardrailAction.BLOCK} - Terminates stream immediately with error chunk
 * - {@link GuardrailAction.SANITIZE} - Replaces chunk content with `modifiedText`
 * - {@link GuardrailAction.FLAG} / {@link GuardrailAction.ALLOW} - Passes through
 *
 * @param service - Single guardrail or array of guardrails
 * @param context - Conversation context for policy decisions
 * @param stream - Source response stream to wrap
 * @param options - Stream options and input evaluations to attach
 * @returns Wrapped stream with guardrail filtering applied
 *
 * @example
 * ```typescript
 * // Wrap output stream with PII redaction
 * const safeStream = wrapOutputGuardrails(
 *   [piiRedactor, contentFilter],
 *   guardrailContext,
 *   orchestratorStream,
 *   { streamId: 'stream-123', inputEvaluations }
 * );
 *
 * for await (const chunk of safeStream) {
 *   // Chunks are filtered/sanitized before reaching here
 *   yield chunk;
 * }
 * ```
 */
export async function* wrapOutputGuardrails(
  service: IGuardrailService | IGuardrailService[] | undefined,
  context: GuardrailContext,
  stream: AsyncGenerator<AgentOSResponse, void, undefined>,
  options: GuardrailOutputOptions,
): AsyncGenerator<AgentOSResponse, void, undefined> {
  // Delegate to the two-phase parallel dispatcher.
  // normalizeServices handles single / array / undefined normalization.
  yield* ParallelGuardrailDispatcher.wrapOutput(normalizeServices(service), context, stream, options);
}

/**
 * Convert a full {@link GuardrailEvaluationResult} into the compact
 * {@link GuardrailMetadataEntry} shape that gets embedded in chunk metadata.
 *
 * Strips heavy fields (`details`, `modifiedText`) that are not needed
 * for downstream telemetry / observability.
 *
 * @param evaluation - The evaluation to serialize
 * @returns A lightweight metadata entry suitable for chunk embedding
 */
export function serializeEvaluation(evaluation: GuardrailEvaluationResult): GuardrailMetadataEntry {
  return {
    action: evaluation.action,
    reason: evaluation.reason,
    reasonCode: evaluation.reasonCode,
    metadata: evaluation.metadata,
  };
}

/**
 * Attach guardrail evaluation metadata to a response chunk.
 *
 * Merges new input/output evaluation entries into any existing
 * `metadata.guardrail` structure on the chunk. The result is a
 * shallow-cloned chunk — the original is never mutated.
 *
 * @param chunk   - The response chunk to annotate
 * @param entry   - Input and/or output metadata entries to merge
 * @returns A new chunk with guardrail metadata merged in
 */
export function withGuardrailMetadata(
  chunk: AgentOSResponse,
  entry: {
    input?: GuardrailMetadataEntry | GuardrailMetadataEntry[];
    output?: GuardrailMetadataEntry | GuardrailMetadataEntry[];
  },
): AgentOSResponse {
  const existingMetadata = chunk.metadata ?? {};
  const existingGuardrail = (existingMetadata.guardrail as Record<string, unknown>) ?? {};

  const existingInput = Array.isArray(existingGuardrail.input)
    ? (existingGuardrail.input as GuardrailMetadataEntry[])
    : existingGuardrail.input
    ? [existingGuardrail.input as GuardrailMetadataEntry]
    : [];
  const existingOutput = Array.isArray(existingGuardrail.output)
    ? (existingGuardrail.output as GuardrailMetadataEntry[])
    : existingGuardrail.output
    ? [existingGuardrail.output as GuardrailMetadataEntry]
    : [];

  const incomingInput = normalizeMetadata(entry.input);
  const incomingOutput = normalizeMetadata(entry.output);

  const mergedInput = existingInput.concat(incomingInput);
  const mergedOutput = existingOutput.concat(incomingOutput);

  const guardrail: Record<string, unknown> = {
    ...existingGuardrail,
    ...(mergedInput.length ? { input: mergedInput } : {}),
    ...(mergedOutput.length ? { output: mergedOutput } : {}),
  };

  return {
    ...chunk,
    metadata: {
      ...existingMetadata,
      guardrail,
    },
  };
}

function normalizeMetadata(
  entry?: GuardrailMetadataEntry | GuardrailMetadataEntry[],
): GuardrailMetadataEntry[] {
  if (!entry) {
    return [];
  }
  return Array.isArray(entry) ? entry : [entry];
}
