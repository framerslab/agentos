import type { AgentOSInput } from '../../api/types/AgentOSInput';
import type { AgentOSResponse } from '../../api/types/AgentOSResponse';

/**
 * High-level outcome emitted by a guardrail evaluation.
 *
 * The action instructs AgentOS how to handle evaluated content:
 * - {@link GuardrailAction.ALLOW} - Pass through unchanged
 * - {@link GuardrailAction.FLAG} - Pass through but record metadata
 * - {@link GuardrailAction.SANITIZE} - Replace content with modified version
 * - {@link GuardrailAction.BLOCK} - Reject/terminate the interaction
 *
 * @example
 * ```typescript
 * // Allow content to pass
 * return { action: GuardrailAction.ALLOW };
 *
 * // Block harmful content
 * return {
 *   action: GuardrailAction.BLOCK,
 *   reason: 'Content violates policy',
 *   reasonCode: 'POLICY_VIOLATION'
 * };
 *
 * // Redact sensitive information
 * return {
 *   action: GuardrailAction.SANITIZE,
 *   modifiedText: text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN REDACTED]')
 * };
 * ```
 */
export enum GuardrailAction {
  /**
   * Allow the content to pass through unchanged.
   * Use when content passes all policy checks.
   */
  ALLOW = 'allow',

  /**
   * Allow the request/response but record metadata for analytics or audit.
   * Content passes through, but the evaluation is logged for review.
   */
  FLAG = 'flag',

  /**
   * Continue processing after replacing content with a sanitized version.
   * Use for PII redaction, profanity filtering, or content modification.
   * Requires {@link GuardrailEvaluationResult.modifiedText} to be set.
   */
  SANITIZE = 'sanitize',

  /**
   * Block the interaction entirely and return an error to the host.
   * Use for policy violations, harmful content, or security threats.
   * Terminates the stream immediately when used in output evaluation.
   */
  BLOCK = 'block',
}

/**
 * Lightweight description of the conversational context for guardrail decisions.
 *
 * Provides identity and session information to help guardrails make
 * context-aware decisions (e.g., different policies per user tier).
 *
 * @example
 * ```typescript
 * const context: GuardrailContext = {
 *   userId: 'user-123',
 *   sessionId: 'session-abc',
 *   personaId: 'support-agent',
 *   metadata: { userTier: 'premium', region: 'EU' }
 * };
 * ```
 */
export interface GuardrailContext {
  /** Unique identifier for the user making the request */
  userId: string;

  /** Current session identifier */
  sessionId: string;

  /** Active persona/agent identity (if applicable) */
  personaId?: string;

  /** Conversation thread identifier */
  conversationId?: string;

  /** Operating mode (e.g., 'debug', 'production') */
  mode?: string;

  /** Additional context for guardrail evaluation */
  metadata?: Record<string, unknown>;
}

/**
 * Result returned by a guardrail evaluation.
 *
 * Contains the action to take and optional context about why.
 * This result is attached to response chunk metadata for observability.
 *
 * @example
 * ```typescript
 * // Block with explanation
 * const result: GuardrailEvaluationResult = {
 *   action: GuardrailAction.BLOCK,
 *   reason: 'Content contains prohibited material',
 *   reasonCode: 'CONTENT_POLICY_001',
 *   metadata: { category: 'violence', confidence: 0.95 }
 * };
 *
 * // Sanitize PII
 * const result: GuardrailEvaluationResult = {
 *   action: GuardrailAction.SANITIZE,
 *   modifiedText: 'Contact me at [EMAIL REDACTED]',
 *   reasonCode: 'PII_REDACTED'
 * };
 * ```
 */
export interface GuardrailEvaluationResult {
  /** The action AgentOS should take based on this evaluation */
  action: GuardrailAction;

  /**
   * Human-readable reason for the action.
   * May be shown to end users or logged for audit.
   */
  reason?: string;

  /**
   * Machine-readable code identifying the policy or rule triggered.
   * Useful for analytics and automated handling.
   */
  reasonCode?: string;

  /**
   * Additional metadata for analytics, audit, or debugging.
   * Persisted in response chunk metadata.
   */
  metadata?: Record<string, unknown>;

  /**
   * Detailed information about the evaluation (e.g., moderation scores,
   * stack traces, matched patterns). Not shown to users.
   */
  details?: unknown;

  /**
   * Replacement text when action is {@link GuardrailAction.SANITIZE}.
   * For input evaluation: replaces textInput before orchestration.
   * For output evaluation: replaces textDelta (streaming) or finalResponseText (final).
   */
  modifiedText?: string | null;

  /**
   * With {@link GuardrailAction.BLOCK} on an output's final response: the fixed reply the caller receives in place of
   * the model's, as a FINAL_RESPONSE whose guardrail metadata records the block, instead of an error chunk. A
   * product's safety templates answer this way, so a person reads a fixed text and never a raw failure.
   */
  replacementText?: string;
}

/**
 * Payload for input guardrail evaluation.
 *
 * Provided to {@link IGuardrailService.evaluateInput} before the request
 * enters the orchestration pipeline. Use this to validate, sanitize,
 * or block user input before processing.
 */
export interface GuardrailInputPayload {
  /** Conversational context for policy decisions */
  context: GuardrailContext;

  /** The user's input request to evaluate */
  input: AgentOSInput;
}

/**
 * Payload for output guardrail evaluation.
 *
 * Provided to {@link IGuardrailService.evaluateOutput} before response
 * chunks are emitted to the client. Use this to filter, redact,
 * or block agent output.
 *
 * @remarks
 * Every guardrail is called for each chunk of the turn's output stream that
 * carries `isFinal: true` (the FINAL_RESPONSE, an ERROR the turn yields). With
 * {@link GuardrailConfig.evaluateStreamingChunks} set, it is also called for
 * each TEXT_DELTA chunk (real-time filtering). Other chunks are not evaluated,
 * and neither is the ERROR that `processRequest()` yields from its own
 * `catch` or for an input guardrail's BLOCK.
 */
export interface GuardrailOutputPayload {
  /** Conversational context for policy decisions */
  context: GuardrailContext;

  /** The response chunk to evaluate */
  chunk: AgentOSResponse;

  /**
   * RAG source chunks retrieved for this request.
   * Available to output guardrails for grounding verification.
   * Persists across all chunks in a stream (not just the final chunk).
   * Undefined when no RAG retrieval was performed.
   */
  ragSources?: import('../../cognition/rag').RagRetrievedChunk[];
}

/**
 * Configuration for guardrail evaluation behavior.
 *
 * Controls when and how often guardrails evaluate content.
 * Use these settings to balance safety requirements against
 * performance and cost constraints.
 *
 * @example
 * ```typescript
 * // Real-time PII redaction with rate limiting
 * const config: GuardrailConfig = {
 *   evaluateStreamingChunks: true,
 *   maxStreamingEvaluations: 50
 * };
 *
 * // Cost-efficient final-only evaluation (default)
 * const config: GuardrailConfig = {
 *   evaluateStreamingChunks: false
 * };
 * ```
 */
export interface GuardrailConfig {
  /**
   * Enable real-time evaluation of streaming chunks.
   *
   * When `true`, also evaluates each TEXT_DELTA chunk during streaming.
   * When `false` (default), evaluates only the output stream's chunks that
   * carry `isFinal: true` (the FINAL_RESPONSE, an ERROR the turn yields),
   * which every guardrail evaluates either way.
   *
   * **Performance Impact:**
   * - Streaming: Adds 1-500ms latency per TEXT_DELTA chunk
   * - Final-only: Adds 1-500ms latency once per response
   *
   * **Cost Impact:**
   * - Streaming: May trigger LLM calls per chunk (expensive)
   * - Final-only: Single evaluation per response (cost-efficient)
   *
   * **Use Cases:**
   * - Streaming (`true`): Real-time PII redaction, immediate blocking
   * - Final-only (`false`): Policy checks needing full context, cost-sensitive
   *
   * @default false
   */
  evaluateStreamingChunks?: boolean;

  /**
   * Maximum streaming evaluations per request.
   *
   * Rate-limits streaming evaluations to control cost and performance.
   * Only applies when {@link evaluateStreamingChunks} is `true`.
   * After reaching the limit, remaining chunks pass through unevaluated.
   *
   * The output dispatcher counts evaluations per stream by the guardrail
   * object's `id` property. Streaming sanitizers (`canSanitize: true`) that
   * have no `id` share one count; give each of them an `id`.
   *
   * @default undefined (no limit)
   */
  maxStreamingEvaluations?: number;

  /**
   * Whether this guardrail may return SANITIZE actions that modify content.
   *
   * When true, this guardrail runs in Phase 1 (sequential) of the parallel
   * dispatcher — it sees and can modify text produced by prior sanitizers.
   * Each sanitizer receives the cumulative sanitized text from all preceding
   * sanitizers in registration order.
   *
   * When false or omitted, this guardrail runs in Phase 2 (parallel) on
   * the already-sanitized text from Phase 1. It may return BLOCK, FLAG, or
   * ALLOW. If a Phase 2 guardrail returns SANITIZE, the action is
   * **downgraded to FLAG** with a warning logged, because concurrent
   * sanitization would produce non-deterministic results.
   *
   * @default false
   */
  canSanitize?: boolean;

  /**
   * Maximum time in milliseconds to wait for this guardrail's evaluation.
   *
   * If exceeded, the evaluation is abandoned (fail-open), a warning is
   * logged, and the guardrail contributes nothing to the result. Prevents
   * a slow guardrail (e.g., LLM-based) from blocking the entire pipeline.
   *
   * **Safety note:** Do NOT set timeoutMs on safety-critical guardrails
   * (e.g., CSAM detection, compliance-mandatory filters) because fail-open
   * on timeout means content passes unchecked. Only use on guardrails
   * where a missed evaluation is acceptable.
   *
   * @default undefined (no timeout — wait indefinitely)
   */
  timeoutMs?: number;

  /**
   * Error/timeout posture for this guardrail.
   *
   * When `false` (default), a guardrail that throws or times out is skipped
   * (fail-open) and contributes nothing to the result — so unsafe content can
   * pass if the guard errors. When `true`, a throw or timeout instead yields a
   * synthetic BLOCK (fail-closed) so an erroring safety-critical guardrail
   * never silently lets content through.
   *
   * @default false (fail-open — preserves prior behavior)
   */
  failClosed?: boolean;

  /**
   * Streaming evaluation mode, a declaration for the guardrail's own use.
   *
   * The output dispatcher does not read this field: when
   * {@link evaluateStreamingChunks} is `true` it passes each TEXT_DELTA to the
   * guardrail on its own, whatever the value.
   *
   * - `'per-chunk'` — the guardrail evaluates each TEXT_DELTA as it arrives.
   * - `'sentence-buffered'` — the guardrail buffers the deltas itself and
   *   evaluates whole sentences, for example with `SentenceBoundaryBuffer`,
   *   which also returns the previous sentence as overlap context.
   *
   * @default 'per-chunk'
   */
  streamingMode?: 'per-chunk' | 'sentence-buffered';
}

/**
 * Contract for implementing custom guardrail logic.
 *
 * Guardrails intercept content at two points:
 * 1. **Input** - Before user messages enter the orchestration pipeline
 * 2. **Output** - Before agent responses are streamed to the client
 *
 * Both methods are optional—implement only what you need.
 *
 * @example Basic content filter
 * ```typescript
 * class ContentFilterGuardrail implements IGuardrailService {
 *   async evaluateInput({ input }: GuardrailInputPayload) {
 *     if (input.textInput?.includes('prohibited')) {
 *       return {
 *         action: GuardrailAction.BLOCK,
 *         reason: 'Input contains prohibited content',
 *         reasonCode: 'CONTENT_BLOCKED'
 *       };
 *     }
 *     return null; // Allow
 *   }
 * }
 * ```
 *
 * @example Mid-stream "changing mind" (cost ceiling)
 * ```typescript
 * class CostCeilingGuardrail implements IGuardrailService {
 *   config = { evaluateStreamingChunks: true };
 *   private tokenCount = 0;
 *
 *   async evaluateOutput({ chunk }: GuardrailOutputPayload) {
 *     if (chunk.type === 'TEXT_DELTA') {
 *       this.tokenCount += chunk.textDelta?.length ?? 0;
 *       if (this.tokenCount > 5000) {
 *         // "Change mind" - stop mid-stream
 *         return {
 *           action: GuardrailAction.BLOCK,
 *           reason: 'Response exceeded cost ceiling'
 *         };
 *       }
 *     }
 *     return null;
 *   }
 * }
 * ```
 *
 * @example PII redaction mid-stream
 * ```typescript
 * class PIIRedactionGuardrail implements IGuardrailService {
 *   config = { evaluateStreamingChunks: true, maxStreamingEvaluations: 100 };
 *
 *   async evaluateOutput({ chunk }: GuardrailOutputPayload) {
 *     if (chunk.type === 'TEXT_DELTA' && chunk.textDelta) {
 *       const redacted = chunk.textDelta.replace(
 *         /\b\d{3}-\d{2}-\d{4}\b/g,
 *         '[SSN REDACTED]'
 *       );
 *       if (redacted !== chunk.textDelta) {
 *         return {
 *           action: GuardrailAction.SANITIZE,
 *           modifiedText: redacted,
 *           reasonCode: 'PII_REDACTED'
 *         };
 *       }
 *     }
 *     return null;
 *   }
 * }
 * ```
 */
export interface IGuardrailService {
  /**
   * A stable id for this guard. A required guard is named by it (`AgentOSConfig.requiredGuardrails`), and it travels
   * with every verdict as `metadata.guardrailId`. Without one, a registered guard is known by its descriptor's id.
   */
  id?: string;

  /**
   * Configuration for evaluation behavior.
   * Controls streaming vs final-only evaluation and rate limiting.
   */
  config?: GuardrailConfig;

  /**
   * Evaluate user input before orchestration.
   *
   * Called once per request before the orchestration pipeline starts.
   * Use this to validate, sanitize, or block user messages.
   *
   * @param payload - Input and context to evaluate
   * @returns Evaluation result, or `null` to allow without action
   *
   * @remarks
   * - Return `BLOCK` to prevent the request from being processed
   * - Return `SANITIZE` with `modifiedText` to clean the input
   * - Return `null` or `ALLOW` to let the request through
   */
  evaluateInput?(payload: GuardrailInputPayload): Promise<GuardrailEvaluationResult | null>;

  /**
   * Evaluate agent output before streaming to client.
   *
   * Called for each chunk of a guarded output stream (the turn's, and the
   * continuation after an external tool result) that carries
   * `isFinal: true` (the FINAL_RESPONSE, an ERROR the turn yields) and, when
   * {@link GuardrailConfig.evaluateStreamingChunks} is set, for each
   * TEXT_DELTA chunk (real-time filtering). Other chunks, such as
   * TOOL_CALL_REQUEST, are not passed to it, nor is the ERROR that
   * `processRequest()` yields from its own `catch`.
   *
   * @param payload - Response chunk and context to evaluate
   * @returns Evaluation result, or `null` to allow without action
   *
   * @remarks
   * - Return `BLOCK` to immediately terminate the stream with an error chunk, or
   *   with a FINAL_RESPONSE holding `replacementText` when the result carries it
   * - Return `SANITIZE` with `modifiedText` to redact/modify content
   * - Streaming evaluation adds latency; use only when real-time filtering is required
   */
  evaluateOutput?(payload: GuardrailOutputPayload): Promise<GuardrailEvaluationResult | null>;
}
