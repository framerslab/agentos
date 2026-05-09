/**
 * @fileoverview CreateWorkflowTool — ITool implementation that enables agents
 * to compose multi-step tool workflows at runtime and execute them as a unit.
 *
 * @module @framers/agentos/emergent/CreateWorkflowTool
 *
 * Agents call `create_workflow` to define, run, and list workflows. A workflow
 * is a named sequence of tool invocations with reference resolution:
 * - `$input`     — the workflow's input argument
 * - `$prev`      — the output of the immediately preceding step
 * - `$steps[N]`  — the output of the Nth step (zero-indexed)
 *
 * Constraints:
 * - Maximum step count is enforced via `config.maxSteps`.
 * - Only tools from `config.allowedTools` may be used in steps.
 * - Recursive workflow creation is blocked (`create_workflow` cannot appear in steps).
 * - Each step execution has a 30-second timeout enforced via `Promise.race`.
 */

import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import { resolveSelfImprovementSessionKey } from './sessionScope.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * A single step in a workflow definition.
 */
export interface WorkflowStep {
  /** The tool name to invoke for this step. */
  tool: string;
  /** Arguments to pass to the tool (may contain $input, $prev, $steps[N] references). */
  args: Record<string, unknown>;
}

/**
 * A stored workflow definition with execution metadata.
 */
export interface Workflow {
  /** Unique workflow ID. */
  id: string;
  /** Human-readable workflow name. */
  name: string;
  /** Natural language description. */
  description: string;
  /** Ordered list of steps to execute. */
  steps: WorkflowStep[];
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** Number of times this workflow has been run. */
  runCount: number;
}

// ============================================================================
// INPUT TYPE
// ============================================================================

/**
 * Input arguments accepted by the `create_workflow` tool.
 * Discriminated on the `action` field.
 */
export interface CreateWorkflowInput extends Record<string, any> {
  /** The action to perform: create, run, or list. */
  action: 'create' | 'run' | 'list';
  /** Workflow name (required for create). */
  name?: string;
  /** Workflow description (required for create). */
  description?: string;
  /** Workflow steps (required for create). */
  steps?: WorkflowStep[];
  /** Workflow ID (required for run). */
  workflowId?: string;
  /** Input data passed into the workflow when running. */
  input?: unknown;
}

// ============================================================================
// CONSTRUCTOR DEPS
// ============================================================================

/**
 * Dependencies injected into the {@link CreateWorkflowTool} constructor.
 */
export interface CreateWorkflowDeps {
  /** Configuration controlling step limits and tool allowlists. */
  config: {
    /** Maximum number of steps allowed in a single workflow. */
    maxSteps: number;
    /** List of tool names that are permitted in workflow steps. */
    allowedTools: string[];
  };
  /** Execute a tool by name with the given arguments. */
  executeTool: (
    name: string,
    args: unknown,
    context?: ToolExecutionContext,
  ) => Promise<unknown>;
  /** Return the list of all currently available tool names. */
  listTools: () => string[];
}

// ============================================================================
// TOOL IMPLEMENTATION
// ============================================================================

/** Default per-step execution timeout in milliseconds. */
const STEP_TIMEOUT_MS = 30_000;

function isToolAllowed(toolName: string, allowedTools: string[]): boolean {
  return allowedTools.includes('*') || allowedTools.includes(toolName);
}

/**
 * ITool implementation enabling agents to compose, execute, and list
 * multi-step tool workflows at runtime.
 *
 * @example
 * ```ts
 * const tool = new CreateWorkflowTool({
 *   config: { maxSteps: 10, allowedTools: ['web_search', 'summarize'] },
 *   executeTool: (name, args) => orchestrator.execute(name, args),
 *   listTools: () => orchestrator.listToolNames(),
 * });
 *
 * // Create a workflow
 * const createResult = await tool.execute({
 *   action: 'create',
 *   name: 'search-and-summarize',
 *   description: 'Search the web and summarize results.',
 *   steps: [
 *     { tool: 'web_search', args: { query: '$input' } },
 *     { tool: 'summarize', args: { text: '$prev' } },
 *   ],
 * }, context);
 * ```
 */
export class CreateWorkflowTool implements ITool<CreateWorkflowInput> {
  /** @inheritdoc */
  readonly id = 'com.framers.emergent.create-workflow';

  /** @inheritdoc */
  readonly name = 'create_workflow';

  /** @inheritdoc */
  readonly displayName = 'Create Workflow';

  /** @inheritdoc */
  readonly description =
    'Create, run, or list multi-step tool workflows. Steps execute sequentially ' +
    'with reference resolution ($input, $prev, $steps[N]).';

  /** @inheritdoc */
  readonly category = 'emergent';

  /** @inheritdoc */
  readonly hasSideEffects = true;

  /** @inheritdoc */
  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'run', 'list'],
        description: 'The workflow action to perform.',
      },
      name: {
        type: 'string',
        description: 'Workflow name (required for create).',
      },
      description: {
        type: 'string',
        description: 'Workflow description (required for create).',
      },
      steps: {
        type: 'array',
        description: 'Ordered list of workflow steps (required for create).',
        items: {
          type: 'object',
          properties: {
            tool: { type: 'string' },
            args: { type: 'object' },
          },
          required: ['tool', 'args'],
        },
      },
      workflowId: {
        type: 'string',
        description: 'Workflow ID (required for run).',
      },
      input: {
        description: 'Input data passed to the workflow when running.',
      },
    },
    required: ['action'],
  };

  /** Session-scoped workflow storage. */
  private readonly workflowsBySession: Map<string, Map<string, Workflow>> = new Map();

  /** Monotonic counter for generating workflow IDs. */
  private nextId = 1;

  /** Injected dependencies. */
  private readonly deps: CreateWorkflowDeps;

  /**
   * Create a new CreateWorkflowTool.
   *
   * @param deps - Injected dependencies including config, tool executor,
   *   and tool lister.
   */
  constructor(deps: CreateWorkflowDeps) {
    this.deps = deps;
  }

  // --------------------------------------------------------------------------
  // EXECUTE
  // --------------------------------------------------------------------------

  /**
   * Execute the requested workflow action.
   *
   * @param args - Action type and associated parameters.
   * @param context - Tool execution context.
   * @returns A {@link ToolExecutionResult} wrapping the action outcome.
   */
  async execute(
    args: CreateWorkflowInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    switch (args.action) {
      case 'create':
        return this.handleCreate(args, context);
      case 'run':
        return this.handleRun(args, context);
      case 'list':
        return this.handleList(context);
      default:
        return {
          success: false,
          error: `Unknown action "${args.action}". Must be one of: create, run, list`,
        };
    }
  }

  // --------------------------------------------------------------------------
  // ACTION HANDLERS
  // --------------------------------------------------------------------------

  /**
   * Create and store a new workflow definition.
   *
   * Validates:
   * - Required fields (name, description, steps) are present
   * - Step count does not exceed maxSteps
   * - No step references `create_workflow` (prevent recursion)
   * - All step tools exist in the available tool list
   */
  private async handleCreate(
    args: CreateWorkflowInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { name, description, steps } = args;

    if (!name || typeof name !== 'string') {
      return { success: false, error: 'name is required for the create action' };
    }
    if (!description || typeof description !== 'string') {
      return { success: false, error: 'description is required for the create action' };
    }
    if (!steps || !Array.isArray(steps) || steps.length === 0) {
      return { success: false, error: 'steps is required and must be a non-empty array' };
    }

    // Check maxSteps
    if (steps.length > this.deps.config.maxSteps) {
      return {
        success: false,
        error: `Workflow exceeds maxSteps limit (${steps.length} > ${this.deps.config.maxSteps})`,
      };
    }

    // Block recursive workflow creation
    for (const step of steps) {
      if (step.tool === 'create_workflow') {
        return {
          success: false,
          error: 'Workflows cannot contain create_workflow steps (recursion not allowed)',
        };
      }
    }

    // Validate all tools exist
    const availableTools = this.deps.listTools();
    for (const step of steps) {
      if (!availableTools.includes(step.tool)) {
        return {
          success: false,
          error: `Tool "${step.tool}" referenced in step is not available`,
        };
      }

      if (!isToolAllowed(step.tool, this.deps.config.allowedTools)) {
        return {
          success: false,
          error: `Tool "${step.tool}" is not permitted by the workflow allowedTools configuration`,
        };
      }
    }

    const id = `workflow-${this.nextId++}`;
    const workflow: Workflow = {
      id,
      name,
      description,
      steps,
      createdAt: new Date().toISOString(),
      runCount: 0,
    };

    this.getSessionWorkflows(context).set(id, workflow);

    return {
      success: true,
      output: { workflowId: id, name, stepCount: steps.length },
    };
  }

  /**
   * Run a stored workflow, executing steps sequentially with reference resolution.
   *
   * Reference resolution:
   * - `$input`    — the workflow's input argument
   * - `$prev`     — the output of the immediately preceding step
   * - `$steps[N]` — the output of the Nth step (zero-indexed)
   *
   * Each step has a 30-second timeout enforced via Promise.race.
   */
  private async handleRun(
    args: CreateWorkflowInput,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const { workflowId, input } = args;

    if (!workflowId) {
      return { success: false, error: 'workflowId is required for the run action' };
    }

    const workflow = this.getSessionWorkflows(context, false).get(workflowId);
    if (!workflow) {
      return { success: false, error: `Workflow "${workflowId}" not found` };
    }

    const stepResults: unknown[] = [];
    let prev: unknown = undefined;

    for (let i = 0; i < workflow.steps.length; i++) {
      const step = workflow.steps[i];

      // Resolve references in step args
      const resolvedArgs = this.resolveReferences(step.args, input, prev, stepResults);

      try {
        const result = await this.executeStepWithTimeout(
          step.tool,
          resolvedArgs,
          i,
          context,
        );

        stepResults.push(result);
        prev = result;
      } catch (err: any) {
        return {
          success: false,
          error: `Workflow failed at step ${i} ("${step.tool}"): ${err.message ?? String(err)}`,
          output: { completedSteps: i, stepResults },
        };
      }
    }

    workflow.runCount++;

    return {
      success: true,
      output: {
        workflowId: workflow.id,
        runCount: workflow.runCount,
        stepResults,
        finalOutput: prev,
      },
    };
  }

  /**
   * List all stored workflows.
   */
  private async handleList(
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const workflows = Array.from(this.getSessionWorkflows(context, false).values()).map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      stepCount: w.steps.length,
      runCount: w.runCount,
      createdAt: w.createdAt,
    }));

    return { success: true, output: { workflows } };
  }

  private getSessionWorkflows(
    context: ToolExecutionContext,
    createIfMissing = true,
  ): Map<string, Workflow> {
    const sessionKey = resolveSelfImprovementSessionKey(context);
    const existing = this.workflowsBySession.get(sessionKey);
    if (existing) {
      return existing;
    }

    if (!createIfMissing) {
      return new Map<string, Workflow>();
    }

    const created = new Map<string, Workflow>();
    this.workflowsBySession.set(sessionKey, created);
    return created;
  }

  // --------------------------------------------------------------------------
  // REFERENCE RESOLUTION
  // --------------------------------------------------------------------------

  /**
   * Resolve `$input`, `$prev`, and `$steps[N]` references in step arguments.
   *
   * Uses JSON.stringify → string replacement → JSON.parse cycle for simple
   * reference resolution. References appearing as standalone string values
   * are replaced with the actual object; references embedded in larger strings
   * are serialized inline.
   *
   * @param args - The step arguments potentially containing references.
   * @param input - The workflow input value.
   * @param prev - The output of the previous step.
   * @param stepResults - Array of all completed step outputs.
   * @returns Resolved arguments with references replaced by actual values.
   */
  private resolveReferences(
    args: Record<string, unknown>,
    input: unknown,
    prev: unknown,
    stepResults: unknown[],
  ): Record<string, unknown> {
    const serialized = JSON.stringify(args);

    // Replace $steps[N] references first (more specific pattern)
    let resolved = serialized.replace(/"\$steps\[(\d+)\]"/g, (_match, idx) => {
      const index = parseInt(idx, 10);
      return JSON.stringify(stepResults[index] ?? null);
    });

    // Replace $input references
    resolved = resolved.replace(/"\$input"/g, JSON.stringify(input ?? null));

    // Replace $prev references
    resolved = resolved.replace(/"\$prev"/g, JSON.stringify(prev ?? null));

    try {
      return JSON.parse(resolved);
    } catch {
      // If parsing fails (unlikely), return original args
      return args;
    }
  }

  private async executeStepWithTimeout(
    toolName: string,
    args: Record<string, unknown>,
    stepIndex: number,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        this.deps.executeTool(toolName, args, context),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `Step ${stepIndex} ("${toolName}") timed out after ${STEP_TIMEOUT_MS}ms`,
              ),
            );
          }, STEP_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }
}
