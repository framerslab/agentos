/**
 * @fileoverview ForgeToolMetaTool — ITool implementation that agents call to
 * create new tools at runtime via the Emergent Capability Engine.
 *
 * @module @framers/agentos/emergent/ForgeToolMetaTool
 *
 * This is the meta-tool that bridges the LLM tool-call interface with the
 * {@link EmergentCapabilityEngine}. When an agent determines that no existing
 * capability matches its need, it calls `forge_tool` with a name, description,
 * schemas, implementation (compose or sandbox), and test cases.
 *
 * Only registered when the agent is configured with `emergent: true`.
 * Adds ~120 tokens to the tool list.
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import type { ForgeToolRequest, ForgeResult } from './types.js';
import type { EmergentCapabilityEngine } from './EmergentCapabilityEngine.js';

// ============================================================================
// INPUT TYPE
// ============================================================================

/**
 * Input arguments accepted by the `forge_tool` meta-tool.
 *
 * Mirrors {@link ForgeToolRequest} but typed as a `Record<string, any>` to
 * satisfy the `ITool` generic constraint while retaining semantic clarity.
 */
export interface ForgeToolInput extends Record<string, any> {
  /** Machine-readable name for the new tool. */
  name: string;

  /** Natural language description of the tool's purpose. */
  description: string;

  /** JSON Schema for the tool's input arguments. */
  inputSchema: JSONSchemaObject;

  /** JSON Schema for the tool's expected output (optional). */
  outputSchema?: JSONSchemaObject;

  /**
   * Implementation specification — either compose (chain existing tools) or
   * sandbox (arbitrary code). Discriminated on the `mode` field.
   */
  implementation:
    | {
        mode: 'compose';
        steps: Array<{ name: string; tool: string; inputMapping: Record<string, unknown> }>;
      }
    | { mode: 'sandbox'; code: string; allowlist: string[] };

  /**
   * One or more test cases for the judge to evaluate.
   * Each has an `input` object and optional `expectedOutput`.
   */
  testCases: Array<{
    input: Record<string, unknown>;
    expectedOutput?: unknown;
    stepOutputs?: Record<string, unknown>;
  }>;
}

// ============================================================================
// META-TOOL
// ============================================================================

/**
 * Meta-tool enabling agents to create new tools at runtime.
 *
 * Only registered when the agent is configured with `emergent: true`.
 * Adds ~120 tokens to the tool list. Agents provide: name, description,
 * schemas, implementation (compose existing tools or write sandboxed code),
 * and test cases.
 *
 * @example
 * ```ts
 * const metaTool = new ForgeToolMetaTool(engine);
 * // Register with ToolOrchestrator:
 * orchestrator.registerTool(metaTool);
 *
 * // Agent calls via tool-call interface:
 * const result = await metaTool.execute({
 *   name: 'add_numbers',
 *   description: 'Add two numbers together.',
 *   inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
 *   outputSchema: { type: 'object', properties: { sum: { type: 'number' } } },
 *   implementation: {
 *     mode: 'sandbox',
 *     code: 'function execute(input) { return { sum: input.a + input.b }; }',
 *     allowlist: [],
 *   },
 *   testCases: [{ input: { a: 2, b: 3 }, expectedOutput: { sum: 5 } }],
 * }, context);
 * ```
 */
export class ForgeToolMetaTool implements ITool<ForgeToolInput, ForgeResult> {
  /** @inheritdoc */
  readonly id = 'com.framers.emergent.forge-tool';

  /** @inheritdoc */
  readonly name = 'forge_tool';

  /** @inheritdoc */
  readonly displayName = 'Forge Tool';

  /** @inheritdoc */
  readonly description =
    'Create a new tool when no existing capability matches your need. ' +
    'Provide a name, description, implementation (compose existing tools or ' +
    'write sandboxed code), and test cases.';

  /** @inheritdoc */
  readonly category = 'emergent';

  /** @inheritdoc */
  readonly hasSideEffects = true;

  /** @inheritdoc */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Machine-readable name for the new tool.',
      },
      description: {
        type: 'string',
        description: 'Natural language description of what the tool does.',
      },
      inputSchema: {
        type: 'object',
        description: 'JSON Schema for the tool input arguments.',
      },
      outputSchema: {
        type: 'object',
        description: 'JSON Schema for the tool output (optional).',
      },
      implementation: {
        description: 'Implementation: compose existing tools or write sandboxed code.',
        oneOf: [
          {
            type: 'object',
            properties: {
              mode: { type: 'string', const: 'compose' },
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    tool: { type: 'string' },
                    inputMapping: { type: 'object' },
                  },
                  required: ['name', 'tool', 'inputMapping'],
                },
                minItems: 1,
              },
            },
            required: ['mode', 'steps'],
          },
          {
            type: 'object',
            properties: {
              mode: { type: 'string', const: 'sandbox' },
              code: {
                type: 'string',
                description:
                  'Pure JavaScript (ES2020). MUST define `function execute(input) { ... }` ' +
                  '(or an async equivalent) at the top level. RULES that block the judge from ' +
                  'approving otherwise-correct tools: ' +
                  '(1) NO TypeScript: no `: type` annotations, no `interface`, no `type` aliases, no `<T>` generics, no `enum`. ' +
                  '(2) Every `if`/`for`/`while`/`else` body uses BLOCK BRACES `{ ... }` — ' +
                  'single-line bodies with declarations are forbidden. ' +
                  '(3) Arrow functions that declare variables must use `(...) => { const x = ...; return x; }` — ' +
                  'never `(...) => const x = ...` (a SyntaxError). ' +
                  '(4) Output MUST conform exactly to `outputSchema` — no extra fields. ' +
                  'If the schema has `additionalProperties: false`, return ONLY the declared keys.',
              },
              allowlist: {
                type: 'array',
                items: { type: 'string', enum: ['fetch', 'fs.readFile', 'crypto'] },
              },
            },
            required: ['mode', 'code', 'allowlist'],
          },
        ],
      },
      testCases: {
        type: 'array',
        description: 'One or more test cases for the judge to evaluate.',
        items: {
          type: 'object',
          properties: {
            input: { type: 'object' },
            expectedOutput: {},
            stepOutputs: {
              type: 'object',
              description:
                'For a composition: the output of each step whose tool has side effects, keyed by step name. ' +
                'Those steps are not executed while the tool is forged.',
            },
          },
          required: ['input'],
        },
        minItems: 1,
      },
    },
    required: ['name', 'description', 'inputSchema', 'implementation', 'testCases'],
  };

  /** Reference to the engine that orchestrates the forge pipeline. */
  private readonly engine: EmergentCapabilityEngine;

  /**
   * Create a new ForgeToolMetaTool.
   *
   * @param engine - The {@link EmergentCapabilityEngine} that will handle the
   *   actual forge pipeline (build → test → judge → register).
   */
  constructor(engine: EmergentCapabilityEngine) {
    this.engine = engine;
  }

  // --------------------------------------------------------------------------
  // EXECUTE
  // --------------------------------------------------------------------------

  /**
   * Execute the forge pipeline via the engine.
   *
   * Extracts the agent ID and session/correlation ID from the execution context
   * and delegates to {@link EmergentCapabilityEngine.forge}.
   *
   * @param args - The forge tool input arguments (name, description, schemas,
   *   implementation, test cases).
   * @param context - The tool execution context providing agent and session IDs.
   * @returns A {@link ToolExecutionResult} wrapping the {@link ForgeResult}.
   */
  async execute(
    args: ForgeToolInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ForgeResult>> {
    // Validate required fields before delegating to the engine.
    // The LLM may omit or mistype fields; catching this early produces
    // a clear error instead of a cryptic downstream failure.
    if (!args.name || typeof args.name !== 'string') {
      return { success: false, error: 'name is required and must be a string' };
    }
    if (!args.description || typeof args.description !== 'string') {
      return { success: false, error: 'description is required and must be a string' };
    }

    const result = await this.engine.forge(args as unknown as ForgeToolRequest, {
      // The agent identity of a forged tool is the persona that forged it: a
      // GMI instance id is minted per session, so a tool owned by one would
      // be callable in no later session. Nullish coalescing (??), not ||, so
      // an empty string is kept as given.
      agentId: context.personaId ?? 'unknown',
      sessionId: context.correlationId ?? 'unknown',
      // A composition's test steps run as this caller.
      caller: context,
    });

    return {
      success: result.success,
      output: result,
      error: result.error,
    };
  }
}
