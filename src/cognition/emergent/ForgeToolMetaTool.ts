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
import type { ForgeToolRequest, ForgeResult, ForgeTestResponse } from './types.js';
import type { EmergentCapabilityEngine } from './EmergentCapabilityEngine.js';
import { InvalidToolNameError, forgedToolNameProblem } from './ToolName.js';
import { refusedSelfChange, selfChangeRefusal } from '../learning/toolContext.js';

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
  /**
   * Machine-readable name for the new tool: an ASCII letter, then ASCII letters, digits, underscores and hyphens,
   * at most 200 characters. Any other name is refused before the forge runs (see `forgedToolNameProblem`).
   */
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
    responses?: ForgeTestResponse[];
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
        description:
          'Machine-readable name for the new tool: an ASCII letter, then ASCII letters, digits, underscores ' +
          'or hyphens, at most 200 characters.',
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
                description:
                  'The capabilities the code uses: fetch, fs.read (in code, the function fs.readFile), ' +
                  'fs.write (fs.writeFile(path, data)), fs.delete (fs.unlink(path)) and crypto; the function names ' +
                  'are accepted too. The host decides what it grants: a name it does not grant refuses the forge, ' +
                  'and the refusal names what it grants.',
                items: {
                  type: 'string',
                  enum: ['fetch', 'fs.read', 'fs.readFile', 'fs.write', 'fs.writeFile', 'fs.delete', 'fs.unlink', 'crypto'],
                },
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
            responses: {
              type: 'array',
              description:
                'For a code tool that sends POST, PUT, PATCH or DELETE requests: the answer each such request ' +
                'gets while the tool is forged, since none is sent then. A request takes the first unused answer ' +
                'with its method and URL; one with no answer gets a 204. Writes and deletes made while forging ' +
                'land in a temporary directory and are read back from it.',
              maxItems: 16,
              items: {
                type: 'object',
                properties: {
                  method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE', 'GET', 'HEAD'] },
                  url: { type: 'string' },
                  status: { type: 'integer', minimum: 200, maximum: 599 },
                  headers: { type: 'object', additionalProperties: { type: 'string' } },
                  body: { type: 'string' },
                },
                required: ['method', 'url', 'status'],
              },
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
  /**
   * The learning layer's refusal of a forge, before the approval gate: forging is a self-change on every call.
   *
   * @param _args - The forge arguments; the refusal does not depend on them.
   * @param context - The call's context.
   */
  refusalBeforeApproval(_args: Record<string, any>, context: ToolExecutionContext): ToolExecutionResult<ForgeResult> | undefined {
    const refusal = selfChangeRefusal(context.sessionData);
    return refusal ? refusedSelfChange(this.name, refusal) : undefined;
  }

  async execute(
    args: ForgeToolInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ForgeResult>> {
    // The freeze, then the turn's mode, then its learner: refused before the engine runs (docs/GMI.md, "Learning").
    const refusal = selfChangeRefusal(context.sessionData);
    if (refusal) return refusedSelfChange(this.name, refusal);

    // Validate required fields before delegating to the engine.
    // The LLM may omit or mistype fields; catching this early produces
    // a clear error instead of a cryptic downstream failure.
    // The name names the tool's folder when the tool is exported as a skill, so a name the forge's rule refuses
    // is refused here with its typed details, before the engine runs. The engine holds a direct forge to the same
    // rule. A missing, empty or non-string name keeps its own message, with the same details as any other refusal.
    const nameProblem = forgedToolNameProblem(args.name);
    if (nameProblem) {
      const refused = new InvalidToolNameError(nameProblem, args.name);
      return {
        success: false,
        error:
          nameProblem === 'type' || nameProblem === 'empty'
            ? 'name is required and must be a string'
            : refused.message,
        details: { code: refused.code, problem: refused.problem },
      };
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
