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
 * - Every tool invocation is delegated to a caller-supplied `executeTool`
 *   callback; the builder holds no registry, and the callback decides which
 *   checks a step meets.
 */

import type { ComposableToolSpec, ComposableStep } from './types.js';
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
 * All tool invocations are delegated to the `executeTool` callback supplied at
 * construction time. The builder never holds a reference to any tool registry,
 * and it applies no permission or approval check of its own.
 *
 * @example
 * ```ts
 * const builder = new ComposableToolBuilder(async (toolName, args, ctx) => {
 *   const tool = registry.get(toolName);
 *   return tool.execute(args, ctx);
 * });
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

  /**
   * @param executeTool - Callback invoked for each pipeline step. Receives the
   *   target tool name, the resolved argument object, and the outer execution
   *   context forwarded from the composite tool's own `execute` call.
   *   Must return a {@link ToolExecutionResult}; a `success: false` result aborts
   *   the remainder of the pipeline.
   * @param options - Optional builder configuration.
   * @param options.strictMode - When true, unresolved reference expressions
   *   throw an error instead of falling through as literal strings.
   */
  constructor(
    private readonly executeTool: (
      toolName: string,
      args: unknown,
      context: ToolExecutionContext
    ) => Promise<ToolExecutionResult>,
    options?: { strictMode?: boolean }
  ) {
    this.strictMode = options?.strictMode ?? false;
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
    // Capture instance fields in local bindings so that the returned object's
    // `execute` closure does not retain a reference to `this` beyond what is needed.
    const executeTool = this.executeTool;
    const strictMode = this.strictMode;

    return {
      // -----------------------------------------------------------------------
      // Identity fields required by ITool
      // -----------------------------------------------------------------------
      id: `composable:${name}`,
      name,
      displayName: name,
      description,
      inputSchema,
      hasSideEffects: true,

      // -----------------------------------------------------------------------
      // Core execution — runs the pipeline defined in spec
      // -----------------------------------------------------------------------
      async execute(
        args: Record<string, unknown>,
        context: ToolExecutionContext
      ): Promise<ToolExecutionResult> {
        /** Shared evaluation context threaded through each step. */
        const pipelineCtx: PipelineContext = {
          input: args,
          prev: null,
          steps: {},
        };

        let lastOutput: unknown = null;

        for (const step of spec.steps) {
          // Resolve the step's inputMapping against the current pipeline context.
          const resolvedArgs = resolveMapping(step.inputMapping, pipelineCtx, strictMode);

          // Invoke the underlying tool via the caller-supplied executor.
          const result = await executeTool(step.tool, resolvedArgs, context);

          if (!result.success) {
            // Abort the pipeline on first failure, surfacing the step's error.
            return {
              success: false,
              error: `Step "${step.name}" (tool: "${step.tool}") failed: ${result.error ?? 'unknown error'}`,
            };
          }

          lastOutput = result.output;

          // Advance the pipeline context so subsequent steps can reference this step.
          pipelineCtx.prev = lastOutput;
          pipelineCtx.steps[step.name] = lastOutput;
        }

        return { success: true, output: lastOutput };
      },
    };
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
