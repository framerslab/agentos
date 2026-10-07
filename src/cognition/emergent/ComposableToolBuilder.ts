/**
 * @fileoverview ComposableToolBuilder — DSL for constructing higher-order tools
 * by chaining existing tool invocations in a sequential pipeline.
 *
 * @module @framers/agentos/emergent/ComposableToolBuilder
 *
 * Overview:
 * - Accepts a {@link ComposableToolSpec} describing a sequence of {@link ComposableStep}s.
 * - At runtime each step's `inputMapping` is resolved against a shared evaluation
 *   context consisting of the original tool input (`$input.*`), the previous step's
 *   output (`$prev.*`), and any named step output (`$steps[N].*`).
 * - Steps execute sequentially; the first failure aborts the pipeline and surfaces
 *   the error immediately.
 * - The composite tool's final output is the last step's raw output value.
 * - Every step runs through a {@link StepGate}; the builder holds no registry.
 */

import type { ComposableToolSpec, ComposableStep } from './types.js';
import {
  COMPOSE_NEEDS_GATE_MESSAGE,
  MAX_COMPOSITION_DEPTH,
  checkChainable,
  type Chainability,
  type StepGate,
} from './StepGate.js';
import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';

// ============================================================================
// INTERNAL TYPES
// ============================================================================

/**
 * The evaluation context threaded through a pipeline execution.
 * Populated incrementally as each step resolves.
 */
interface PipelineContext {
  /** The original input object passed to the composite tool's `execute` call. */
  input: Record<string, unknown>;
  /** The output of the most recently completed step, or `null` before step 1. */
  prev: unknown;
  /**
   * Named step outputs keyed by {@link ComposableStep.name}.
   * Populated after each step completes.
   */
  steps: Record<string, unknown>;
}

// ============================================================================
// COMPOSABLE TOOL BUILDER
// ============================================================================

/**
 * Builds composite `ITool` instances by chaining existing tool invocations.
 *
 * Each invocation is described by a {@link ComposableStep} that maps values from
 * a shared pipeline context into the step tool's arguments via a lightweight
 * reference expression syntax:
 *
 * | Expression | Resolves to |
 * |---|---|
 * | `"$input.foo"` | `args.foo` from the composite tool's own input |
 * | `"$input"` | the whole input object |
 * | `"$prev.bar"` | `bar` from the previous step's output |
 * | `"$prev"` | the previous step's full output |
 * | `"$steps[0].output.data"` | `output.data` from the first step's output |
 * | `"$steps[0]"` | the first step's full output |
 * | anything else | used as a literal value without transformation |
 *
 * Reference expressions nested inside plain objects are resolved recursively, so
 * `{ query: "$input.topic", limit: 10 }` becomes `{ query: "actual-topic", limit: 10 }`.
 *
 * Every step runs through a {@link StepGate}, which is where the host's checks
 * live, and is checked first against the chainability rule: a tool that
 * declares no side effects is chained freely, a tool with side effects only
 * when the host lists it, and a tool that declares nothing by no one.
 *
 * @example
 * ```ts
 * const builder = new ComposableToolBuilder(
 *   createStepGate({ resolve: (name) => registry.get(name) }),
 * );
 * builder.bind({ sideEffectingTools: ['send_email'] });
 *
 * const spec: ComposableToolSpec = {
 *   mode: 'compose',
 *   steps: [
 *     { name: 'search', tool: 'web_search', inputMapping: { query: '$input.topic' } },
 *     { name: 'summarise', tool: 'summarise_text', inputMapping: { text: '$prev.snippet' } },
 *   ],
 * };
 *
 * const tool = builder.build('research', 'Search then summarise a topic', schema, spec);
 * const result = await tool.execute({ topic: 'quantum computing' }, ctx);
 * ```
 */
export class ComposableToolBuilder {
  /**
   * When true, unresolved `$`-prefixed reference expressions throw instead
   * of silently passing through as literal strings. Useful for development
   * and testing to catch typos in inputMapping expressions early.
   */
  readonly strictMode: boolean;

  private gate: StepGate | undefined;
  private sideEffectingTools: readonly string[] = [];

  /**
   * @param gateOrExecute - A {@link StepGate}. A bare `(toolName, args, context)`
   *   callback is still accepted so existing construction keeps working, but
   *   nothing can be composed through one: it cannot say what a step tool is,
   *   so no step can be checked. Bind a gate with {@link bind}.
   * @param options - Optional builder configuration.
   * @param options.strictMode - When true, unresolved reference expressions
   *   throw an error instead of falling through as literal strings.
   */
  constructor(
    gateOrExecute:
      | StepGate
      | ((toolName: string, args: unknown, context: ToolExecutionContext) => Promise<ToolExecutionResult>),
    options?: { strictMode?: boolean },
  ) {
    this.strictMode = options?.strictMode ?? false;
    this.gate = typeof gateOrExecute === 'function' ? undefined : gateOrExecute;
  }

  /**
   * Bind the gate and the host's list of side-effecting tools that may be
   * chained. The engine calls this from its configuration; a host that uses
   * the builder on its own may call it too.
   */
  bind(options: { gate?: StepGate; sideEffectingTools?: readonly string[] }): void {
    if (options.gate) {
      this.gate = options.gate;
    }
    if (options.sideEffectingTools) {
      this.sideEffectingTools = options.sideEffectingTools;
    }
  }

  /** Whether steps can be resolved and checked at all. */
  hasGate(): boolean {
    return this.gate !== undefined;
  }

  /** Whether a step naming this tool may be chained right now. */
  check(stepTool: string): Chainability {
    if (!this.gate) {
      return { ok: false, code: 'compose_needs_gate', message: COMPOSE_NEEDS_GATE_MESSAGE };
    }
    return checkChainable(stepTool, this.gate.resolve(stepTool), this.sideEffectingTools);
  }

  /**
   * Whether any step of the spec names a tool that has side effects right now,
   * or a tool that is itself a composition (whose own steps may).
   */
  hasSideEffectingStep(spec: ComposableToolSpec): boolean {
    const gate = this.gate;
    if (!gate) {
      return true;
    }
    return spec.steps.some((step) => {
      const tool = gate.resolve(step.tool);
      return tool?.hasSideEffects !== false || isComposition(tool);
    });
  }

  // --------------------------------------------------------------------------
  // PUBLIC API
  // --------------------------------------------------------------------------

  /**
   * Build an `ITool`-compatible object from a {@link ComposableToolSpec}.
   *
   * The returned tool can be registered directly with any tool orchestrator that
   * accepts `ITool`. Its `execute` method runs the step pipeline sequentially,
   * threading outputs through the reference resolution system.
   *
   * @param name - Machine-readable tool name exposed to the LLM (e.g. `"research_topic"`).
   * @param description - Natural language description of what the composite tool does.
   * @param inputSchema - JSON Schema describing the arguments the composite tool accepts.
   * @param spec - The composable pipeline specification to execute.
   * @returns A fully-formed `ITool` instance whose `execute` method runs the pipeline.
   *
   * @example
   * ```ts
   * const tool = builder.build(
   *   'fetch_and_summarise',
   *   'Fetch a URL then return a one-paragraph summary.',
   *   { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
   *   spec,
   * );
   * ```
   */
  build(
    name: string,
    description: string,
    inputSchema: JSONSchemaObject,
    spec: ComposableToolSpec
  ): ITool {
    return {
      id: `composable:${name}`,
      name,
      displayName: name,
      description,
      inputSchema,
      hasSideEffects: true,
      execute: (args: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> =>
        this.runPipeline(spec, args, context),
    };
  }

  /**
   * Run a pipeline. Every step is re-checked against the chainability rule
   * before it runs, because a tool is replaced by name, and the instance that
   * was checked is the one the gate runs. With `options.dry` (forge-time
   * tests), a step whose tool has side effects, or is itself a composition,
   * is not executed: its output is taken from `stepOutputs`, and the step is
   * listed as an effect that would have run. `options.signal`, when given,
   * reaches every step's run.
   *
   * Compositions nest no deeper than {@link MAX_COMPOSITION_DEPTH}: the depth
   * travels in `context.sessionData.emergentDepth`, and a run at the limit is
   * refused with `step_cycle`.
   *
   * A refusal or a failure ends the run; `details` then names the step, the
   * steps that completed before it, and the effects so far.
   */
  async runPipeline(
    spec: ComposableToolSpec,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    options: { dry?: { stepOutputs: Record<string, unknown> }; signal?: AbortSignal } = {},
  ): Promise<ToolExecutionResult> {
    const gate = this.gate;
    if (!gate) {
      return {
        success: false,
        error: `compose_needs_gate: ${COMPOSE_NEEDS_GATE_MESSAGE}`,
        details: { code: 'compose_needs_gate' },
      };
    }

    const depthValue = context.sessionData?.emergentDepth;
    const depth = typeof depthValue === 'number' && depthValue >= 0 ? depthValue : 0;
    if (depth >= MAX_COMPOSITION_DEPTH) {
      return {
        success: false,
        error:
          `step_cycle: compositions nest more than ${MAX_COMPOSITION_DEPTH} deep; ` +
          'a composition that reaches itself, or a chain that long, does not run',
        details: { code: 'step_cycle', depth },
      };
    }
    const stepContext: ToolExecutionContext = {
      ...context,
      sessionData: { ...(context.sessionData ?? {}), emergentDepth: depth + 1 },
    };

    const pipelineCtx: PipelineContext = { input: args, prev: null, steps: {} };
    const completed: string[] = [];
    const effects: Array<Record<string, unknown>> = [];
    let lastOutput: unknown = null;

    for (const step of spec.steps) {
      const tool = gate.resolve(step.tool);
      const verdict = checkChainable(step.tool, tool, this.sideEffectingTools);
      if (!verdict.ok || !tool) {
        const code = verdict.ok ? 'step_missing' : verdict.code;
        const message = verdict.ok ? `step tool "${step.tool}" is not registered` : verdict.message;
        return {
          success: false,
          error: `Step "${step.name}" (tool: "${step.tool}") refused: ${code}: ${message}`,
          details: { code, step: step.name, tool: step.tool, completed, effects },
        };
      }

      const resolvedArgs = resolveMapping(step.inputMapping, pipelineCtx, this.strictMode);
      const nested = isComposition(tool);

      if (options.dry && (verdict.sideEffects || nested)) {
        if (!(step.name in options.dry.stepOutputs)) {
          return {
            success: false,
            error:
              `dry_run_needs_output: step "${step.name}" (tool: "${step.tool}") ` +
              (nested ? 'is a composition' : 'has side effects') +
              ` and is not executed while forging; give its output in testCases[].stepOutputs["${step.name}"]`,
            details: { code: 'dry_run_needs_output', step: step.name, tool: step.tool, completed, effects },
          };
        }
        lastOutput = options.dry.stepOutputs[step.name];
        effects.push({
          step: step.name,
          tool: step.tool,
          wouldRun: true,
          ...(nested ? { nested: true } : {}),
          args: resolvedArgs,
        });
      } else {
        const result = await gate.run(tool, resolvedArgs, stepContext, options.signal);
        if (!result.success) {
          return {
            success: false,
            error: `Step "${step.name}" (tool: "${step.tool}") failed: ${result.error ?? 'unknown error'}`,
            details: {
              ...(result.details ?? {}),
              step: step.name,
              tool: step.tool,
              completed,
              effects,
              // Whether a refused or failed side-effecting step took effect is not known here.
              ...(verdict.sideEffects ? { unknownEffect: step.name } : {}),
            },
          };
        }
        lastOutput = result.output;
        const inner = (result.details as { effects?: unknown } | undefined)?.effects;
        if (Array.isArray(inner)) {
          effects.push(...(inner as Array<Record<string, unknown>>));
        } else if (verdict.sideEffects) {
          effects.push({ step: step.name, tool: step.tool, ran: true });
        }
      }

      completed.push(step.name);
      pipelineCtx.prev = lastOutput;
      pipelineCtx.steps[step.name] = lastOutput;
    }

    return effects.length > 0
      ? { success: true, output: lastOutput, details: { effects } }
      : { success: true, output: lastOutput };
  }

  /**
   * Validate a {@link ComposableToolSpec} before building.
   *
   * Performs structural checks only — it does not verify that the referenced tool
   * names are actually registered in any registry. Use this method to give early,
   * actionable feedback before attempting to {@link build} a tool.
   *
   * Checks performed:
   * 1. `spec.steps` must be a non-empty array.
   * 2. Every step must have a non-empty `tool` string.
   *
   * @param spec - The spec to validate.
   * @returns `{ valid: true }` when the spec passes all checks, or
   *   `{ valid: false, errors: string[] }` with one message per failing check.
   *
   * @example
   * ```ts
   * const result = builder.validate(spec);
   * if (!result.valid) {
   *   console.error('Invalid spec:', result.errors);
   * }
   * ```
   */
  validate(spec: ComposableToolSpec): { valid: boolean; errors?: string[] } {
    const errors: string[] = [];

    if (!Array.isArray(spec.steps) || spec.steps.length === 0) {
      errors.push('ComposableToolSpec.steps must be a non-empty array.');
    } else {
      for (let i = 0; i < spec.steps.length; i++) {
        const step = spec.steps[i];
        if (typeof step.tool !== 'string' || step.tool.trim() === '') {
          errors.push(`Step at index ${i} has an empty or missing "tool" name.`);
        }
      }
    }

    return errors.length === 0 ? { valid: true } : { valid: false, errors };
  }
}

// ============================================================================
// INTERNAL HELPERS — not exported
// ============================================================================

/** Whether a resolved step tool is itself an emergent composition (the engine marks its executables). */
function isComposition(tool: ITool | undefined): boolean {
  return (tool as { emergentMode?: string } | undefined)?.emergentMode === 'compose';
}

/**
 * Resolve an entire `inputMapping` object against the current pipeline context.
 *
 * Iterates over each key-value pair in `mapping`. String values that match the
 * reference expression grammar are substituted with their runtime value; all other
 * values (numbers, booleans, `null`, nested objects, arrays) are kept as-is, with
 * nested objects resolved recursively.
 *
 * @param mapping - The raw `inputMapping` from a {@link ComposableStep}.
 * @param ctx - The current pipeline evaluation context.
 * @param strict - When true, unresolved `$`-prefixed expressions throw.
 * @returns A new plain object with all reference expressions replaced.
 */
function resolveMapping(
  mapping: Record<string, unknown>,
  ctx: PipelineContext,
  strict: boolean = false
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(mapping)) {
    resolved[key] = resolveValue(value, ctx, strict);
  }
  return resolved;
}

/**
 * Resolve a single value against the pipeline context.
 *
 * - If `value` is a `string` beginning with `$`, attempt reference resolution.
 * - If `value` is a plain object (`Record<string, unknown>`), resolve recursively.
 * - All other values are returned unchanged.
 *
 * @param value - The raw value to resolve.
 * @param ctx - The current pipeline evaluation context.
 * @param strict - When true, unresolved `$`-prefixed expressions throw.
 * @returns The resolved runtime value.
 */
function resolveValue(value: unknown, ctx: PipelineContext, strict: boolean = false): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    return resolveExpression(value, ctx, strict);
  }

  if (isPlainObject(value)) {
    return resolveMapping(value as Record<string, unknown>, ctx, strict);
  }

  return value;
}

/**
 * Resolve a single reference expression string.
 *
 * Supported expression forms:
 * - `"$input"` → the whole input object
 * - `"$input.a.b"` → `ctx.input.a.b` (dotted path)
 * - `"$prev"` → the previous step's output
 * - `"$prev.a.b"` → dotted path into `ctx.prev`
 * - `"$steps[N]"` → the Nth named-step's output (index-based, insertion order)
 * - `"$steps[N].a.b"` → dotted path into that step's output
 *
 * If the expression does not match any of these forms the original string is
 * returned unchanged (non-strict mode), or an error is thrown (strict mode).
 *
 * @param expr - The `$`-prefixed expression string.
 * @param ctx - The current pipeline evaluation context.
 * @param strict - When true, unresolved expressions throw instead of passing through.
 * @returns The resolved runtime value, or the original `expr` string if unmatched.
 */
function resolveExpression(expr: string, ctx: PipelineContext, strict: boolean = false): unknown {
  // --- $input or $input.path ---
  if (expr === '$input') {
    return ctx.input;
  }
  if (expr.startsWith('$input.')) {
    const path = expr.slice('$input.'.length);
    return resolvePath(ctx.input, path);
  }

  // --- $prev or $prev.path ---
  if (expr === '$prev') {
    return ctx.prev;
  }
  if (expr.startsWith('$prev.')) {
    const path = expr.slice('$prev.'.length);
    return resolvePath(ctx.prev, path);
  }

  // --- $steps[N] or $steps[N].path ---
  const stepsMatch = expr.match(/^\$steps\[(\d+)\](.*)$/);
  if (stepsMatch) {
    const index = parseInt(stepsMatch[1], 10);
    const remainder = stepsMatch[2]; // either '' or '.some.path'

    // Step outputs are stored by name in insertion order.
    const stepValues = Object.values(ctx.steps);
    if (index >= stepValues.length) {
      // Out-of-bounds — return undefined to signal the reference doesn't exist yet.
      return undefined;
    }
    const stepOutput = stepValues[index];

    if (remainder === '' || remainder === undefined) {
      return stepOutput;
    }
    if (remainder.startsWith('.')) {
      return resolvePath(stepOutput, remainder.slice(1));
    }
  }

  // Unrecognised expression — strict mode throws so typos in inputMapping
  // are caught during development rather than silently producing wrong data.
  if (strict) {
    throw new Error(
      `Unresolved reference expression: "${expr}". Available: $input, $prev, $steps[N]`
    );
  }
  // Non-strict: return as literal (existing behaviour) but warn so the issue
  // is visible in logs without crashing production pipelines.
  console.warn(`[ComposableToolBuilder] Unresolved reference "${expr}" treated as literal`);
  return expr;
}

/**
 * Walk a dotted path string into an arbitrary value.
 *
 * Given `root = { a: { b: 42 } }` and `path = "a.b"`, returns `42`.
 * Returns `undefined` for any missing segment rather than throwing.
 *
 * @param root - The root value to traverse.
 * @param path - A dot-separated sequence of property names (e.g. `"output.data"`).
 * @returns The value at the resolved path, or `undefined` if any segment is absent.
 */
function resolvePath(root: unknown, path: string): unknown {
  const segments = path.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Returns `true` when `value` is a plain (non-array, non-null) object.
 * Used to distinguish nested mapping objects from other value types.
 *
 * @param value - The value to test.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
