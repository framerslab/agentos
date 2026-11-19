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
import {
  FORGE_TRACE_DELIVER,
  buildForgeTrace,
  forgeCallScope,
  forgeContextRecords,
  newForgeCallRecord,
  settleForgeTrace,
  thrownReason,
} from './ForgeTrace.js';
import type { ForgeCallAuthor, ForgeCallRecord, ForgeTrace, KnownForgeTraceStage } from './ForgeTrace.js';

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

  /**
   * Optional: the forging agent's own statement of the gap the tool fills, a
   * string when the agent follows the schema's description. Any JSON value is
   * accepted. The forge's trace records it: a string as given, cut to its cap;
   * any other value as its JSON-safe text; a cut one with its path in the
   * trace's `sizes.cut`. The judge does not read it.
   */
  justification?: unknown;
}

/** The ids a forge's trace names, read from forge_tool's call context. */
interface ForgeCallIds {
  agentId: string | null;
  sessionId: string | null;
  correlationId: string | null;
}

/**
 * The ids forge_tool hands the engine (the persona and the correlation id, or
 * `'unknown'`), and the call's session id when it is a string, so a forge's ids
 * read the same whichever layer ends it. A field that cannot be read is null.
 */
function forgeCallIds(context: ToolExecutionContext | undefined): ForgeCallIds {
  const read = (pick: () => unknown): unknown => {
    try {
      return pick();
    } catch {
      return null;
    }
  };
  const agentId = read(() => context?.personaId ?? 'unknown');
  const correlationId = read(() => context?.correlationId ?? 'unknown');
  const sessionId = read(() => context?.sessionData?.sessionId);
  return {
    agentId: typeof agentId === 'string' ? agentId : null,
    sessionId: typeof sessionId === 'string' ? sessionId : null,
    correlationId: typeof correlationId === 'string' ? correlationId : null,
  };
}

/**
 * Who wrote a forge_tool call's request: a model called forge_tool, so the
 * request is model-written. The call's model on its context wins (`answered`,
 * or `requested` when its `modelSource` says the step's answer named no
 * model); else the author an outer layer set on the record; else a model
 * whose provider and model are unknown.
 */
function forgingAgentAuthor(
  context: ToolExecutionContext | undefined,
  set: ForgeCallAuthor | undefined,
): ForgeCallAuthor {
  try {
    const answered: unknown = context?.callerModel;
    if (answered !== null && typeof answered === 'object') {
      const { providerId, modelId, modelSource } = answered as { providerId?: unknown; modelId?: unknown; modelSource?: unknown };
      return {
        kind: 'model',
        role: 'forging_agent',
        provider: typeof providerId === 'string' ? providerId : null,
        model: typeof modelId === 'string' ? modelId : null,
        modelSource: modelSource === 'requested' ? 'requested' : 'answered',
      };
    }
  } catch {
    // A getter that throws: the answering model cannot be read.
  }
  return set ?? { kind: 'model', role: 'forging_agent', provider: null, model: null, modelSource: null };
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
      // No type: any JSON value is accepted, so no forge is refused for it. The trace keeps it; the judge never reads it.
      justification: {
        description: 'Optional: What gap this tool fills that no tool you already have covers, in one to three sentences.',
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
   * The learning layer's refusal of a forge, before the approval gate: forging is a self-change on every call.
   *
   * @param _args - The forge arguments; the refusal does not depend on them.
   * @param context - The call's context.
   */
  refusalBeforeApproval(_args: Record<string, any>, context: ToolExecutionContext): ToolExecutionResult<ForgeResult> | undefined {
    const refusal = selfChangeRefusal(context.sessionData);
    return refusal ? refusedSelfChange(this.name, refusal) : undefined;
  }

  /**
   * Execute the forge pipeline via the engine.
   *
   * Extracts the agent ID and session/correlation ID from the execution context
   * and delegates to {@link EmergentCapabilityEngine.forge}.
   *
   * Every call ends with one trace of the forge. The engine records the forges
   * it runs; forge_tool records the ones it refuses before the engine runs (a
   * self-change refusal, a refused name, a missing description) and the ones
   * its own code throws on, and hands each to the engine's `onForgeTrace`. The
   * result the model reads is the same either way.
   *
   * @param args - The forge tool input arguments (name, description, schemas,
   *   implementation, test cases, and the optional justification).
   * @param context - The tool execution context providing agent and session IDs.
   * @returns A {@link ToolExecutionResult} wrapping the {@link ForgeResult}
   *   without its `trace`, which the model never reads.
   */
  async execute(
    args: ForgeToolInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ForgeResult>> {
    // The call's record: the one an outer layer runs this call under, when no
    // forge_tool has taken it yet; else one of this call's own. Taken and seen
    // in one step.
    const scoped = forgeCallScope.getStore();
    const record = scoped && !scoped.seen ? scoped : newForgeCallRecord();
    record.seen = true;
    record.author = forgingAgentAuthor(context, record.author);

    try {
      // The freeze, then the turn's mode, then its learner: refused before the engine runs (docs/GMI.md, "Learning").
      const refusal = selfChangeRefusal(context.sessionData);
      if (refusal) {
        return await this.refuse(record, 'self_change_refused', args, context, refusedSelfChange(this.name, refusal));
      }

      // Validate required fields before delegating to the engine.
      // The LLM may omit or mistype fields; catching this early produces
      // a clear error instead of a cryptic downstream failure.
      // The name names the tool's folder when the tool is exported as a skill, so a name the forge's rule refuses
      // is refused here with its typed details, before the engine runs. The engine holds a direct forge to the same
      // rule. A missing, empty or non-string name keeps its own message, with the same details as any other refusal.
      const nameProblem = forgedToolNameProblem(args.name);
      if (nameProblem) {
        const refused = new InvalidToolNameError(nameProblem, args.name);
        return await this.refuse(record, 'name_refused', args, context, {
          success: false,
          error:
            nameProblem === 'type' || nameProblem === 'empty'
              ? 'name is required and must be a string'
              : refused.message,
          details: { code: refused.code, problem: refused.problem },
        });
      }
      if (!args.description || typeof args.description !== 'string') {
        return await this.refuse(record, 'description_missing', args, context, {
          success: false,
          error: 'description is required and must be a string',
        });
      }

      const engineContext = {
        // The agent identity of a forged tool is the persona that forged it: a
        // GMI instance id is minted per session, so a tool owned by one would
        // be callable in no later session. Nullish coalescing (??), not ||, so
        // an empty string is kept as given.
        agentId: context.personaId ?? 'unknown',
        sessionId: context.correlationId ?? 'unknown',
        // A composition's test steps run as this caller.
        caller: context,
      };
      // The engine records the forge under this call's record and delivers its
      // trace once.
      forgeContextRecords.set(engineContext, record);
      const result = await this.engine.forge(args as unknown as ForgeToolRequest, engineContext);

      // The trace is for the host, never for the model: the output is the result
      // without it, its other keys in their order.
      const { trace: _trace, ...forgeResult } = result;
      return {
        success: forgeResult.success,
        output: forgeResult,
        error: forgeResult.error,
      };
    } catch (error: unknown) {
      // A throw from forge_tool's own code has no trace yet: this layer records
      // it. One from the engine was recorded there. Either way the caller gets
      // back the value that was thrown.
      if (record.trace === undefined) {
        await this.settleOwnTrace(record, 'thrown', thrownReason(error), args, context);
      }
      throw error;
    }
  }

  /**
   * Hands a forge's trace to the engine's `onForgeTrace` and writes the
   * forge's log line, through the engine's own delivery. Never throws.
   *
   * @param trace - The forge's trace.
   * @internal
   */
  async [FORGE_TRACE_DELIVER](trace: ForgeTrace): Promise<void> {
    return this.engine[FORGE_TRACE_DELIVER](trace);
  }

  /** Records and delivers a refusal of forge_tool's own, and returns the refusal as it is. */
  private async refuse(
    record: ForgeCallRecord,
    stage: KnownForgeTraceStage,
    args: unknown,
    context: ToolExecutionContext,
    refusal: ToolExecutionResult<ForgeResult>,
  ): Promise<ToolExecutionResult<ForgeResult>> {
    await this.settleOwnTrace(record, stage, refusal.error, args, context);
    return refusal;
  }

  /** Builds the trace of a forge forge_tool ended, keeps it on the call's record and delivers it once. */
  private async settleOwnTrace(
    record: ForgeCallRecord,
    stage: KnownForgeTraceStage,
    reason: unknown,
    args: unknown,
    context: ToolExecutionContext | undefined,
  ): Promise<void> {
    const trace = buildForgeTrace({
      record,
      recordedBy: 'forge_tool',
      via: 'forge_tool',
      stage,
      reason,
      args,
      ...forgeCallIds(context),
    });
    await settleForgeTrace(record, trace, (kept) => this[FORGE_TRACE_DELIVER](kept));
  }
}
