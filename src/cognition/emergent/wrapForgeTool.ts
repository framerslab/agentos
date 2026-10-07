/**
 * @fileoverview Wrapper around ForgeToolMetaTool that normalizes LLM
 * output, runs a pre-judge shape check, captures every attempt, and
 * surfaces outcomes as structured log events.
 * @module @framers/agentos/emergent/wrapForgeTool
 *
 * LLMs emit wide variety in forge_tool args (stringified JSON, wrong
 * mode spellings, missing allowlists, no code body). This wrapper fixes
 * them up so the engine never crashes deep in sandbox validation, and
 * every attempt gets recorded to the caller's capture sink regardless
 * of outcome. That gives consumers an attempt-level ground truth that
 * does not depend on the LLM self-reporting its forge calls.
 *
 * Pure wrapper over ForgeToolMetaTool + ForgeShapeValidator +
 * ForgeSchemaInference. No stdout dependency — log events route
 * through the optional `log` callback.
 */

import type { ITool, ToolExecutionContext } from '../../core/tools/ITool.js';
import { ForgeToolMetaTool, type ForgeToolInput } from './ForgeToolMetaTool.js';
import { validateForgeShape } from './ForgeShapeValidator.js';
import { inferSchemaFromTestCases } from './ForgeSchemaInference.js';

/**
 * Captured forge event — ground-truth record of an actual forge call,
 * independent of whether the LLM self-reported it.
 */
export interface CapturedForge {
  /** Tool name (`fixed.name || 'unnamed'`). */
  name: string;
  /** Tool description (`fixed.description || name`). */
  description: string;
  /** `'sandbox'` or `'compose'` after normalization. */
  mode: string;
  /** Forge request's declared input schema post-normalization. */
  inputSchema: unknown;
  /** Forge request's declared output schema post-normalization. */
  outputSchema: unknown;
  /** Did the judge approve? */
  approved: boolean;
  /** Judge confidence for approved tools; 0 on rejection. */
  confidence: number;
  /** Judge verdict payload or shape-check context. */
  output: unknown;
  /** Populated on rejection or error. Truncated to 240 chars. */
  errorReason?: string;
  /**
   * Optional free-form scope label (e.g. a department name, a chat
   * agent id, or any grouping the caller wants propagated onto every
   * capture record). Left undefined when the caller does not group.
   */
  scope?: string;
  /** Wall-clock ms so captures can be attributed to surrounding events. */
  timestamp: number;
}

/**
 * Structured log event emitted at each forge lifecycle step. Consumers
 * who care about stdout visibility can pass a `log` callback that
 * renders this into console.log / pm2 / whatever. AgentOS emits
 * nothing by default so the wrapper is safe to use in quiet contexts.
 */
export type ForgeLogEvent =
  | { kind: 'start'; scope?: string; toolName: string; mode: string }
  | { kind: 'approved'; scope?: string; toolName: string; confidence: number }
  | { kind: 'rejected'; scope?: string; toolName: string; reason: string }
  | { kind: 'error'; scope?: string; toolName: string; error: string };

/** Options for {@link wrapForgeTool}. */
export interface WrapForgeToolOptions {
  /** The raw ForgeToolMetaTool instance from EmergentCapabilityEngine. */
  raw: ForgeToolMetaTool;
  /** GMI / agent id patched onto the tool execution context. */
  agentId: string;
  /** Session id patched onto the tool execution context under sessionData. */
  sessionId: string;
  /** Required capture sink. Every attempt (valid or not) is recorded. */
  capture: (record: CapturedForge) => void;
  /**
   * Optional scope label propagated onto every CapturedForge. Use for
   * semantic grouping when multiple callers share a wrapper (dept
   * name, channel id, agent role, etc.).
   */
  scope?: string;
  /**
   * Optional log callback for lifecycle visibility. When undefined,
   * no log events are emitted (quiet mode).
   */
  log?: (event: ForgeLogEvent) => void;
}

/**
 * Wrap the raw ForgeToolMetaTool so each forge attempt gets normalized,
 * pre-validated, captured, and logged.
 *
 * Normalization fixes: stringified-JSON fields, mode synonyms (`code`,
 * `javascript`, `js` → `sandbox`; `composed`, `composition`, `chain`,
 * `pipeline` → `compose`), missing allowlist / code body / steps /
 * schemas / testCases. After normalization, the shape validator runs;
 * on failure the judge is skipped and a rejection record is captured
 * immediately. On success, the raw meta-tool executes and the result's
 * verdict is folded into a capture record.
 */
export function wrapForgeTool(options: WrapForgeToolOptions): ITool {
  const { raw, agentId, sessionId, capture, scope, log } = options;
  return {
    ...(raw as unknown as ITool),
    async execute(args: Record<string, unknown>, ctx: unknown) {
      const fixed = { ...args } as Record<string, unknown>;
      for (const k of ['implementation', 'inputSchema', 'outputSchema', 'testCases']) {
        if (typeof fixed[k] === 'string') {
          try {
            fixed[k] = JSON.parse(fixed[k] as string);
          } catch {
            // Leave as-is; downstream normalization backstops most failures.
          }
        }
      }
      // Normalize implementation. Strict `mode === 'compose'` check in
      // the engine means anything else falls into the sandbox branch.
      // Unfamiliar mode strings + missing fields can crash deep in
      // SandboxedToolForge.validateCode. Normalize to exactly
      // 'sandbox' or 'compose', infer from field shape when the mode
      // string is unfamiliar, backstop every required field.
      if (fixed.implementation && typeof fixed.implementation === 'object') {
        const impl = fixed.implementation as Record<string, unknown>;
        if (impl.mode === 'code' || impl.mode === 'javascript' || impl.mode === 'js') {
          impl.mode = 'sandbox';
        }
        if (
          impl.mode === 'composed' ||
          impl.mode === 'composition' ||
          impl.mode === 'composable' ||
          impl.mode === 'chain' ||
          impl.mode === 'pipeline'
        ) {
          impl.mode = 'compose';
        }
        if (impl.mode !== 'sandbox' && impl.mode !== 'compose') {
          if (Array.isArray(impl.steps)) impl.mode = 'compose';
          else if (typeof impl.code === 'string') impl.mode = 'sandbox';
          else impl.mode = 'sandbox';
        }
        if (impl.mode === 'sandbox') {
          if (!Array.isArray(impl.allowlist)) impl.allowlist = [];
          if (impl.code != null && typeof impl.code !== 'string') impl.code = String(impl.code);
          if (!impl.code || typeof impl.code !== 'string') {
            impl.code = 'function execute(input) { return { error: "No code provided in forge request" }; }';
          }
          if (!(impl.code as string).includes('function execute')) {
            impl.code = `function execute(input) {\n${impl.code as string}\n}`;
          }
        } else if (impl.mode === 'compose') {
          if (!Array.isArray(impl.steps)) impl.steps = [];
          for (const step of impl.steps as Array<Record<string, unknown>>) {
            if (step && typeof step === 'object') {
              if (typeof step.tool !== 'string') step.tool = '';
              if (typeof step.name !== 'string') step.name = (step.tool as string) || 'step';
              if (!step.inputMapping || typeof step.inputMapping !== 'object') {
                step.inputMapping = {};
              }
            }
          }
        }
      }
      if (!fixed.inputSchema || typeof fixed.inputSchema !== 'object') {
        fixed.inputSchema = { type: 'object', additionalProperties: true };
      }
      if (!fixed.outputSchema || typeof fixed.outputSchema !== 'object') {
        fixed.outputSchema = { type: 'object', additionalProperties: true };
      }
      if (!Array.isArray(fixed.testCases) || (fixed.testCases as unknown[]).length === 0) {
        fixed.testCases = [{ input: {}, expectedOutput: {} }];
      }
      for (const tc of fixed.testCases as Array<Record<string, unknown>>) {
        if (!tc.input || typeof tc.input !== 'object') tc.input = {};
        if (tc.expectedOutput === undefined) tc.expectedOutput = {};
      }

      // Rescue concrete-testCases-without-formal-schema forges. Still
      // strict: tool code must handle the inferred inputs, but the
      // shape check passes deterministically on intent-clear input.
      inferSchemaFromTestCases(fixed);

      const mode = String((fixed.implementation as { mode?: unknown } | undefined)?.mode ?? '?');
      const toolName = String((fixed as { name?: unknown }).name ?? 'unnamed');
      const toolDescription = String((fixed as { description?: unknown }).description ?? toolName);

      // Pre-judge shape check. On failure, capture + emit a rejection
      // event and short-circuit without invoking the judge LLM.
      const shapeErrors = validateForgeShape(
        fixed as {
          inputSchema?: unknown;
          outputSchema?: unknown;
          testCases?: unknown;
        },
      );
      if (shapeErrors.length > 0) {
        const reason = `Shape check failed: ${shapeErrors.join('; ')}`;
        log?.({ kind: 'rejected', scope, toolName, reason });
        capture({
          name: toolName,
          description: toolDescription,
          mode,
          inputSchema: fixed.inputSchema,
          outputSchema: fixed.outputSchema,
          approved: false,
          confidence: 0,
          output: null,
          errorReason: reason.slice(0, 240),
          scope,
          timestamp: Date.now(),
        });
        return {
          success: false,
          error: reason,
          output: { success: false, verdict: { approved: false, confidence: 0, reasoning: reason } },
        } as unknown;
      }

      log?.({ kind: 'start', scope, toolName, mode });
      const patched = {
        ...(ctx as Record<string, unknown>),
        // The identity the wrapper is given is the forging agent's: the
        // forge records the persona as a tool's owner, so both are set.
        gmiId: agentId,
        personaId: agentId,
        sessionData: {
          ...((ctx as { sessionData?: Record<string, unknown> })?.sessionData ?? {}),
          sessionId,
        },
      };
      try {
        // Cast is intentional: the wrapper's job is to normalize
        // arbitrary LLM output into something the engine can handle.
        // By this point `fixed` is shape-validated enough to run; TS
        // cannot statically prove it matches every ForgeToolInput
        // field because the source is untyped LLM output.
        const r = await raw.execute(
          fixed as unknown as ForgeToolInput,
          patched as unknown as ToolExecutionContext,
        );
        const out = r.output as { verdict?: { approved?: boolean; confidence?: number; reasoning?: string }; testResults?: unknown; result?: unknown; error?: unknown } | undefined;
        const verdict = out?.verdict ?? {};
        // Judge confidence is the judge's score for whether the tool is
        // safe + correct. When rejected, the judge's confidence is in
        // REJECTING the tool; surfacing that as the tool's own quality
        // score would be misleading. So: approved → judge confidence (or
        // 0.85 fallback); rejected → 0.
        const judgeConfidence = typeof verdict.confidence === 'number' ? verdict.confidence : null;
        const confidence = r.success ? (judgeConfidence ?? 0.85) : 0;
        const errorReason = !r.success
          ? String(r.error ?? verdict.reasoning ?? out?.error ?? '').slice(0, 240)
          : undefined;
        if (r.success) {
          log?.({ kind: 'approved', scope, toolName, confidence });
        } else {
          log?.({ kind: 'rejected', scope, toolName, reason: errorReason ?? '' });
        }
        capture({
          name: toolName,
          description: toolDescription,
          mode,
          inputSchema: fixed.inputSchema,
          outputSchema: fixed.outputSchema,
          approved: !!r.success,
          confidence,
          output: out?.testResults ?? out?.result ?? out ?? null,
          errorReason,
          scope,
          timestamp: Date.now(),
        });
        return r;
      } catch (err) {
        const message = String(err).slice(0, 240);
        log?.({ kind: 'error', scope, toolName, error: message });
        capture({
          name: toolName,
          description: toolDescription,
          mode,
          inputSchema: fixed.inputSchema,
          outputSchema: fixed.outputSchema,
          approved: false,
          confidence: 0,
          output: null,
          errorReason: message,
          scope,
          timestamp: Date.now(),
        });
        return { success: false, error: String(err) };
      }
    },
  } as ITool;
}
