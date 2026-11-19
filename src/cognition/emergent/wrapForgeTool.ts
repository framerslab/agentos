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
import {
  FORGE_TRACE_DELIVER,
  buildForgeTrace,
  forgeCallScope,
  newForgeCallRecord,
  settleForgeTrace,
  thrownReason,
} from './ForgeTrace.js';
import type { ForgeCallAuthor, ForgeCallRecord, ForgeTrace, KnownForgeTraceStage } from './ForgeTrace.js';

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
  /**
   * The forge_tool result's `output`: after a judged forge, the whole `ForgeResult` without its trace; null when the
   * call ended before the engine returned.
   *
   * @deprecated Read `trace`.
   */
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
  /**
   * This forge's trace: the same object the engine's `onForgeTrace` hook receives. Absent only when a call succeeded
   * with no trace on its record: behind a host subclass that runs `super.execute` outside the call's async chain
   * (forge_tool then records the forge under a record of its own), or around a wrapped tool that never calls
   * forge_tool's `execute`.
   */
  trace?: ForgeTrace;
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
  /**
   * The identity recorded as the owner of every tool forged through this
   * wrapper (its `personaId` and `gmiId` on the forge call), whoever calls.
   */
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
  /**
   * Optional: the model the forging agent runs on, as the host asked for it. A forge's trace names it as the
   * request's author with `modelSource: 'requested'`. The model that answered the call, when the call's context
   * carries it (`ToolExecutionContext.callerModel`), wins over it.
   */
  author?: { provider?: string; model?: string };
}

/**
 * Who wrote a wrapped forge's request: a model called forge_tool, so the request is model-written. The answering
 * model on the call's context wins; else the model the host named in `author`, as asked for; else a model whose
 * provider and model are unknown.
 */
function wrapperAuthor(ctx: unknown, author: WrapForgeToolOptions['author']): ForgeCallAuthor {
  try {
    const answered: unknown = (ctx as { callerModel?: unknown } | null | undefined)?.callerModel;
    if (answered !== null && typeof answered === 'object') {
      const { providerId, modelId } = answered as { providerId?: unknown; modelId?: unknown };
      return {
        kind: 'model',
        role: 'forging_agent',
        provider: typeof providerId === 'string' ? providerId : null,
        model: typeof modelId === 'string' ? modelId : null,
        modelSource: 'answered',
      };
    }
  } catch {
    // A getter that throws: the answering model cannot be read.
  }
  try {
    if (author !== null && typeof author === 'object') {
      const provider = typeof author.provider === 'string' ? author.provider : null;
      const model = typeof author.model === 'string' ? author.model : null;
      return {
        kind: 'model',
        role: 'forging_agent',
        provider,
        model,
        modelSource: provider || model ? 'requested' : null,
      };
    }
  } catch {
    // A getter that throws: the host's statement cannot be read.
  }
  return { kind: 'model', role: 'forging_agent', provider: null, model: null, modelSource: null };
}

/** The call's correlation id when its context carries one as a string, else null. */
function callCorrelationId(ctx: unknown): string | null {
  try {
    const id: unknown = (ctx as { correlationId?: unknown } | null | undefined)?.correlationId;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

/**
 * The wrapped tool's delivery to its engine's `onForgeTrace`, when it has one (forge_tool, or a subclass of it).
 * Without it the capture gets its trace all the same; only the hook delivery is skipped.
 */
function deliveryOf(raw: ForgeToolMetaTool): ((trace: ForgeTrace) => Promise<void>) | undefined {
  try {
    if (typeof raw[FORGE_TRACE_DELIVER] === 'function') {
      return (trace) => raw[FORGE_TRACE_DELIVER](trace);
    }
  } catch {
    // A getter or a `Proxy` that throws: no delivery.
  }
  return undefined;
}

/** The capture's `trace` key: the call's trace when a layer recorded one, else no key. */
function traceField(record: ForgeCallRecord): { trace?: ForgeTrace } {
  return record.trace === undefined ? {} : { trace: record.trace };
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
 *
 * Every call has one forge record, made here, so the wrapper mints the
 * forge's id. The raw tool runs inside that record's async scope, where
 * forge_tool and the engine find it, and the capture carries the trace the
 * layer that ended the forge kept on it. The wrapper records the forges it
 * ends itself: a refusal before the approval gate, a failed shape check, a
 * failure the wrapped tool returned before forge_tool's `execute` ran, and a
 * throw no other layer recorded. Each trace reaches the engine's
 * `onForgeTrace` once.
 */
export function wrapForgeTool(options: WrapForgeToolOptions): ITool {
  const { raw, agentId, sessionId, capture, scope, log, author } = options;

  /** Builds the trace of a forge the wrapper ended, keeps it on the call's record and delivers it once. */
  const settle = (
    record: ForgeCallRecord,
    stage: KnownForgeTraceStage,
    reason: unknown,
    traceArgs: unknown,
    ctx: unknown,
  ): Promise<ForgeTrace> =>
    settleForgeTrace(
      record,
      buildForgeTrace({
        record,
        recordedBy: 'wrapper',
        via: 'forge_tool',
        stage,
        reason,
        args: traceArgs,
        agentId,
        sessionId,
        correlationId: callCorrelationId(ctx),
      }),
      deliveryOf(raw),
    );

  return {
    ...(raw as unknown as ITool),
    // A spread copies the tool's fields, not its methods: the forge's refusal before the approval gate is the raw
    // tool's, read with the caller's session data, which the wrapper forwards unchanged. The call then ends without
    // `execute`, so the attempt is recorded here, once.
    refusalBeforeApproval(args: Record<string, any>, ctx: ToolExecutionContext) {
      const record = newForgeCallRecord();
      record.author = wrapperAuthor(ctx, author);
      const refusal = typeof raw.refusalBeforeApproval === 'function' ? raw.refusalBeforeApproval(args, ctx) : undefined;
      if (refusal) {
        // The method is synchronous, so the delivery is not awaited: the settle keeps the trace on the record and
        // marks it delivered before its first await, and the hook receives it after this call returns.
        settle(record, 'refused_before_approval', refusal.error, args, ctx).catch(() => undefined);
        const toolName = String(args?.name ?? 'unnamed');
        const reason = String(refusal.error ?? 'refused').slice(0, 240);
        log?.({ kind: 'rejected', scope, toolName, reason });
        capture({
          name: toolName,
          description: String(args?.description ?? toolName),
          mode: String(args?.implementation?.mode ?? '?'),
          inputSchema: args?.inputSchema,
          outputSchema: args?.outputSchema,
          approved: false,
          confidence: 0,
          output: null,
          errorReason: reason,
          scope,
          timestamp: Date.now(),
          ...traceField(record),
        });
      }
      return refusal;
    },
    async execute(args: Record<string, unknown>, ctx: unknown) {
      // The call's record: the wrapper is the outermost layer that sees the call, so it mints the forge's id.
      const record = newForgeCallRecord();
      record.author = wrapperAuthor(ctx, author);
      try {
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
          // The trace's request is the arguments as the wrapper normalized them.
          await settle(record, 'shape_check', reason, fixed, ctx);
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
            ...traceField(record),
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
          // The raw tool runs inside the call's record, so forge_tool takes it
          // whatever context a host subclass hands `super.execute`.
          const r = await forgeCallScope.run(record, () =>
            raw.execute(fixed as unknown as ForgeToolInput, patched as unknown as ToolExecutionContext),
          );
          // A failure no layer recorded, returned before forge_tool's `execute`
          // ran for this call: a host's own refusal.
          if (record.trace === undefined && !record.seen && !r.success) {
            await settle(record, 'host_refused', r.error, fixed, ctx);
          }
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
            ...traceField(record),
          });
          return r;
        } catch (err) {
          // A throw no layer recorded: from the wrapped tool's own code before
          // forge_tool's `execute`, or from reading what it returned.
          if (record.trace === undefined) {
            await settle(record, 'thrown', thrownReason(err), fixed, ctx);
          }
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
            ...traceField(record),
          });
          return { success: false, error: String(err) };
        }
      } catch (error: unknown) {
        // A throw from the wrapper's own normalization, before the wrapped
        // tool runs: recorded with the arguments as they arrived, then
        // rethrown unchanged, with no capture.
        if (record.trace === undefined) {
          await settle(record, 'thrown', thrownReason(error), args, ctx);
        }
        throw error;
      }
    },
  } as ITool;
}
