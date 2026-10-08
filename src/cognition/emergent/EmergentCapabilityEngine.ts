/**
 * @fileoverview EmergentCapabilityEngine — orchestrates runtime tool creation.
 * @module @framers/agentos/emergent/EmergentCapabilityEngine
 *
 * Provides the top-level pipeline that ties the forge subsystem together:
 *
 *   forge request → build tool → run tests → judge review → register
 *
 * Supports two creation modes:
 * - **Compose**: chains existing tools via {@link ComposableToolBuilder}.
 * - **Sandbox**: runs agent-written code via {@link SandboxedToolForge} (judge-gated).
 *
 * After registration the engine tracks usage and auto-promotes tools that
 * meet the configured `EmergentConfig.promotionThreshold` criteria.
 */

import type {
  EmergentConfig,
  ForgeToolRequest,
  ForgeResult,
  PromotionResult,
  EmergentTool,
  ToolUsageStats,
  PersistedToolRow,
  StoredRequest,
  ToolImplementation,
  ToolState,
  ToolStateRecord,
  ToolTier,
  CallHandle,
  ComposableToolSpec,
  SandboxExecutionResult,
  SandboxedToolSpec,
} from './types.js';
import { GMI_INSTANCE_ID_PREFIX } from './types.js';
import {
  parsePersistedSource,
  parseRowSchemas,
  parseStoredRequest,
  requestFromImplementation,
  sessionFromSource,
  requestFromSource,
  sourceFromImplementation,
  stateSetterFromColumn,
  toolFromRow,
  type PersistedSource,
} from './persisted-source.js';
import { normalizeAllowlist, toSandboxApis } from './capabilities.js';
import { randomUUID } from 'node:crypto';
import { checkRequest, narrowToForge, resolveCeiling, type ResolvedCeiling } from './ceiling.js';
import { CapabilityBroker } from './broker/CapabilityBroker.js';
import type { ToolCandidate } from './EmergentJudge.js';
import type { ITool, ToolEffectRecord, ToolExecutionContext, ToolExecutionResult } from '../../core/tools/ITool.js';
import type { PersonalityMutationStore } from './PersonalityMutationStore.js';
import type { AdaptPersonalityTool } from './AdaptPersonalityTool.js';
import { ComposableToolBuilder } from './ComposableToolBuilder.js';
import type { StepGate } from './StepGate.js';
import { SandboxedToolForge } from './SandboxedToolForge.js';
import { EmergentJudge } from './EmergentJudge.js';
import { EmergentToolRegistry } from './EmergentToolRegistry.js';

// ============================================================================
// SELF-IMPROVEMENT TOOL DEPENDENCIES
// ============================================================================

/**
 * Dependencies required to construct the four self-improvement tools.
 *
 * Callers provide runtime hooks for personality access, skill management,
 * tool execution, and optional memory storage. The engine uses these to
 * wire each tool without hard-coupling to specific service implementations.
 */
export interface SelfImprovementToolDeps {
  /**
   * Returns the calling agent's HEXACO personality trait values as a
   * trait→value map. The context identifies the agent instance and session
   * that made the tool call.
   */
  getPersonality: (context?: ToolExecutionContext) => Record<string, number>;

  /**
   * Sets a single HEXACO personality trait (already clamped) on the calling
   * agent. Returns `false` when the caller cannot be resolved, in which case
   * nothing was changed; returning nothing counts as applied.
   */
  setPersonality: (trait: string, value: number, context?: ToolExecutionContext) => boolean | void;

  /** Durable store for personality mutations (used by AdaptPersonalityTool for persistence). */
  mutationStore?: PersonalityMutationStore;

  /** Returns the agent's currently active skills. */
  getActiveSkills: (
    context?: ToolExecutionContext,
  ) => Array<{ skillId: string; name: string; category: string }>;

  /** Returns skill IDs that may not be disabled (core skills). */
  getLockedSkills: () => string[];

  /** Dynamically loads a skill by ID and returns its metadata. */
  loadSkill: (
    id: string,
    context?: ToolExecutionContext,
  ) => Promise<{ skillId: string; name: string; category: string }>;

  /** Unloads (disables) a previously loaded skill. */
  unloadSkill: (id: string, context?: ToolExecutionContext) => void;

  /** Searches the skill registry by query string, returning matching skill metadata. */
  searchSkills: (
    query: string,
    context?: ToolExecutionContext,
  ) => Array<{ skillId: string; name: string; category: string; description: string }>;

  /** Executes a registered tool by name with the given arguments. */
  executeTool: (
    name: string,
    args: unknown,
    context?: ToolExecutionContext,
    signal?: AbortSignal,
    tool?: ITool,
  ) => Promise<unknown>;

  /** Returns the names of all currently registered tools. */
  listTools: () => string[];

  /**
   * Optional callback for persisting self-improvement trace memories. The
   * context identifies the calling agent and session, so the host can store
   * the trace in that agent's memory under that session's scope.
   */
  storeMemory?: (
    trace: { type: string; scope: string; content: string; tags: string[] },
    context?: ToolExecutionContext,
  ) => Promise<void>;

  /** Optional host-level getter for session-scoped runtime params such as temperature. */
  getSessionParam?: (
    param: string,
    context: ToolExecutionContext,
  ) => unknown;

  /** Optional host-level setter for session-scoped runtime params such as temperature. */
  setSessionParam?: (
    param: string,
    value: unknown,
    context: ToolExecutionContext,
  ) => void;
}

// ============================================================================
// DEPENDENCY BUNDLE
// ============================================================================

// ============================================================================
// STORED TOOLS
// ============================================================================

/** The configuration key behind a reason, named in the start-up line. */
const REASON_CONFIG_KEYS: Readonly<Record<string, string>> = {
  source_not_persisted: 'emergent.persistSandboxSource',
  sandbox_tools_off: 'emergent.allowSandboxTools',
  compose_needs_gate: 'a StepGate (deps.stepGate, or the ComposableToolBuilder)',
  step_not_chainable: 'emergent.compose.sideEffectingTools',
  side_effects_undeclared: "the step tool's hasSideEffects",
  step_cycle: "the composition's steps (a step reaches the composition itself)",
  capability_not_granted: 'emergent.capabilities',
  request_unreadable: "the tool's stored request (a release that reads it)",
};

/**
 * The start-up line of an engine that runs code-forged tools without a
 * ceiling: what runs unscoped, and the ceiling that comes closest.
 */
function legacyLine(options: { fetchDomainAllowlist: string[]; fsReadRoots: string[] }): string {
  const everyHost = options.fetchDomainAllowlist.length === 0;
  const hosts = everyHost ? 'any host' : options.fetchDomainAllowlist.join(', ');
  const domains = everyHost ? "'*'" : JSON.stringify(options.fetchDomainAllowlist);
  return (
    '[agentos:emergent] code-forged tools run without a ceiling: a tool granted fetch sends any method to ' +
    `${hosts} (only the first host is checked; redirects go anywhere), fs.readFile reads under ` +
    `${options.fsReadRoots.join(', ')}, and crypto is unscoped. The closest ceiling: ` +
    `capabilities: { fetch: { domains: ${domains} }, 'fs.read': { roots: ${JSON.stringify(options.fsReadRoots)} }, crypto: {} } ` +
    '(a ceiling sends GET and HEAD only, checks every redirect, and bounds bodies, reads and time).'
  );
}

/**
 * The library's suspensions of a composition that a change in what is
 * registered can lift: the composition is checked again when a tool one of
 * its steps names is registered (`onHostToolRegistered`).
 */
const STEP_SUSPENSION_REASONS: ReadonlySet<string> = new Set([
  'compose_needs_gate',
  'step_missing',
  'step_not_chainable',
  'side_effects_undeclared',
  'step_replaced',
  'step_cycle',
]);

/** Step refusals a composed call can meet at run time, and the suspension each leads to. */
const RUN_REFUSAL_REASONS: Readonly<Record<string, string>> = {
  step_missing: 'step_missing',
  step_not_chainable: 'step_replaced',
  side_effects_undeclared: 'step_replaced',
  compose_needs_gate: 'compose_needs_gate',
  step_cycle: 'step_cycle',
  // The step's tool was replaced between its check and its run: nothing ran,
  // and the composition waits for a re-check.
  step_replaced: 'step_replaced',
};

/** The `ITool` the engine registers for a forged tool. */
export type EmergentExecutableTool = ITool<Record<string, unknown>, unknown> & {
  /**
   * How the tool was forged. A host's orchestrator reads it to ask at each
   * step of a composition instead of at the composed call.
   */
  readonly emergentMode: 'compose' | 'sandbox';
};

/** What happened to one stored tool at load. */
export interface LoadedToolOutcome {
  toolId: string;
  name: string;
  state: ToolState;
  reason: string | null;
}

/** A stored tool whose load threw; the row is as it was. */
export interface FailedToolLoad {
  toolId: string;
  name: string;
  error: string;
}

/** What {@link EmergentCapabilityEngine.loadPersistedTools} loads. */
export interface LoadPersistedToolsOptions {
  tiers: ToolTier[];
  /** The agent whose `agent`-tier rows to load; required when `tiers` names `agent`. */
  agentId?: string;
  /** The session whose `session`-tier rows to load; required when `tiers` names `session`. */
  sessionId?: string;
}

/** The result of {@link EmergentCapabilityEngine.loadPersistedTools}. */
export interface LoadPersistedToolsResult {
  active: number;
  suspended: number;
  demoted: number;
  outcomes: LoadedToolOutcome[];
  /** Rows whose load threw (a storage write that failed, say); none of these tools is registered. */
  failed: FailedToolLoad[];
}

/** One stored tool on its way through the single-row path. */
interface AdmissionCandidate {
  toolId: string;
  name: string;
  source: PersistedSource;
  /** The stored or held state, when one exists. */
  stored: ToolStateRecord | undefined;
  /**
   * Whether the row holds a request, readable by this release or not. A load
   * writes a derived request only where the row holds none.
   */
  requestStored: boolean;
  /** The tool row's `is_active`, or a host-built object's `isActive`. */
  legacyActive: boolean;
  /** The tier the row or the host-built object carries. */
  tier: ToolTier;
  /** The owner the row or the host-built object carries (`created_by_agent`). */
  createdBy: string;
  /** False when the row's last state write did not finish its flag write; undefined for a host-built object. */
  flagSynced?: boolean;
  buildTool: (implementation: ToolImplementation) => EmergentTool;
}

/** How one admission runs. */
interface AdmissionOptions {
  /** Re-check a restriction the host set (a host's own reactivation). */
  force?: boolean;
  /** How many times the row was read again after a refused write or adoption. */
  readmitted?: number;
  /** The implementation to run when the row holds a redacted record. */
  sourceFallback?: PersistedSource;
  /** The point the row's read started at (`EmergentToolRegistry.beginRead`). */
  readAt?: number;
}

/**
 * Dependencies injected into the {@link EmergentCapabilityEngine} constructor.
 *
 * All collaborators are provided externally so the engine is trivially testable
 * with mocks — no real LLM calls, no real sandbox execution.
 */
export interface EmergentCapabilityEngineDeps {
  /** Resolved emergent capability configuration. */
  config: EmergentConfig;

  /** Builder for composable (tool-chaining) implementations. */
  composableBuilder: ComposableToolBuilder;

  /**
   * The executor for code-forged tools. Optional: without it the engine
   * builds one from `config.sandboxMemoryMB` and `config.sandboxTimeoutMs`.
   * Under a ceiling (`config.capabilities`) a forge given here must be no
   * wider than the ceiling (construction fails with
   * `forge_wider_than_ceiling` naming the option), narrows it where it is
   * narrower, and serves this engine only.
   */
  sandboxForge?: SandboxedToolForge;

  /** LLM-as-judge evaluator for creation and promotion reviews. */
  judge: EmergentJudge;

  /** Tiered registry for storing and querying emergent tools. */
  registry: EmergentToolRegistry;

  /**
   * The gate composed tools run their steps through. `ToolOrchestrator`
   * passes its own; a host that builds the engine directly passes one from
   * `createStepGate`, or gives the builder one. Without a gate the engine
   * forges code but refuses to compose (`compose_needs_gate`).
   */
  stepGate?: StepGate;

  /** Optional callback used to activate a newly forged tool immediately. */
  onToolForged?: (tool: EmergentTool, executable: ITool) => Promise<void>;

  /** Optional callback used when a tool is promoted to a persisted tier. */
  onToolPromoted?: (tool: EmergentTool) => Promise<void>;

  /** Optional callback used when a tool is removed from the live runtime. */
  onToolRemoved?: (tool: EmergentTool) => Promise<void>;
}

// ============================================================================
// SESSION / AGENT TOOL INDEX
// ============================================================================

/**
 * Internal index mapping session IDs and agent IDs to their associated
 * emergent tool IDs, enabling fast lookup for `getSessionTools()`,
 * `getAgentTools()`, and `cleanupSession()`.
 */
interface ToolIndex {
  /** Session ID → set of tool IDs created in that session. */
  bySession: Map<string, Set<string>>;
  /** Agent ID → set of tool IDs created by that agent. */
  byAgent: Map<string, Set<string>>;
}

// ============================================================================
// ENGINE
// ============================================================================

/**
 * Orchestrates runtime tool creation for agents with emergent capabilities.
 *
 * Pipeline: forge request → build tool → run tests → judge review → register.
 *
 * Supports two creation modes:
 * - **Compose**: chains existing tools via {@link ComposableToolBuilder}.
 * - **Sandbox**: runs agent-written code via {@link SandboxedToolForge} (judge-gated).
 *
 * @example
 * ```ts
 * const engine = new EmergentCapabilityEngine({
 *   config: { ...DEFAULT_EMERGENT_CONFIG, enabled: true },
 *   composableBuilder,
 *   sandboxForge,
 *   judge,
 *   registry,
 * });
 *
 * const result = await engine.forge(request, { agentId: 'gmi-1', sessionId: 'sess-1' });
 * if (result.success) {
 *   console.log('Registered tool:', result.toolId);
 * }
 * ```
 */
/** Whether two stored requests grant the same thing. */
function sameGrant(a: StoredRequest | null | undefined, b: StoredRequest | null | undefined): boolean {
  if (!a || !b) {
    return !a && !b;
  }
  if (a.kind !== b.kind) {
    return false;
  }
  if (a.kind === 'sandbox' && b.kind === 'sandbox') {
    return a.capabilities.join(',') === b.capabilities.join(',');
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A restriction only the host clears: its own suspension, or a demotion. */
function isHostRestriction(record: ToolStateRecord): boolean {
  return record.state === 'demoted' || (record.state === 'suspended' && record.setBy === 'host');
}

/**
 * The ids of the emergent compositions running further up a call, outermost
 * first. Each composition's executable adds its own before its steps run;
 * the list travels in `sessionData.emergentChain`, through every step's
 * call, as the depth does.
 */
function compositionChain(context: ToolExecutionContext): string[] {
  const chain = context.sessionData?.emergentChain;
  return Array.isArray(chain) ? chain.filter((id): id is string => typeof id === 'string') : [];
}

export class EmergentCapabilityEngine {
  /** Injected dependencies. */
  private readonly config: EmergentConfig;
  private readonly composableBuilder: ComposableToolBuilder;
  private readonly sandboxForge: SandboxedToolForge;
  private readonly judge: EmergentJudge;
  private readonly registry: EmergentToolRegistry;
  private readonly onToolForged?: (tool: EmergentTool, executable: ITool) => Promise<void>;
  private readonly onToolPromoted?: (tool: EmergentTool) => Promise<void>;
  private readonly onToolRemoved?: (tool: EmergentTool) => Promise<void>;

  /** The host's ceiling for code-forged tools, resolved; absent on the legacy path. */
  private readonly ceiling?: ResolvedCeiling;

  /** The broker the forge's injected functions come from under a ceiling. */
  private readonly broker?: CapabilityBroker;

  /** Internal index for fast session/agent → tool lookups. */
  private readonly index: ToolIndex = {
    bySession: new Map(),
    byAgent: new Map(),
  };

  /**
   * Admissions of one tool run one after another: a load, a re-check after a
   * registration and a host's sync of the same tool otherwise read and write
   * its row at the same time, and the loser could be held off as contended.
   */
  private readonly admissionChains = new Map<string, Promise<unknown>>();

  /**
   * Create a new EmergentCapabilityEngine.
   *
   * @param deps - All collaborator dependencies. See {@link EmergentCapabilityEngineDeps}.
   */
  constructor(deps: EmergentCapabilityEngineDeps) {
    this.config = deps.config;
    this.composableBuilder = deps.composableBuilder;
    this.judge = deps.judge;
    this.registry = deps.registry;
    this.onToolForged = deps.onToolForged;
    this.onToolPromoted = deps.onToolPromoted;
    this.onToolRemoved = deps.onToolRemoved;
    if (deps.stepGate) {
      this.composableBuilder.bind({ gate: deps.stepGate });
    }
    this.composableBuilder.bind({
      sideEffectingTools: this.config.compose?.sideEffectingTools ?? [],
    });

    const forge =
      deps.sandboxForge ??
      new SandboxedToolForge({ memoryMB: this.config.sandboxMemoryMB, timeoutMs: this.config.sandboxTimeoutMs });
    if (this.config.capabilities) {
      // Throws a CeilingError naming the key of the first failure.
      const resolved = resolveCeiling(this.config.capabilities, this.config.audit, {
        hasStorage: this.registry.hasStorage(),
      });
      this.ceiling = deps.sandboxForge ? narrowToForge(resolved, deps.sandboxForge.effectiveOptions()) : resolved;
      const store =
        this.ceiling.audit.store === 'storage'
          ? this.registry.effectsStore({
              content: this.ceiling.audit.content,
              ...(this.ceiling.audit.retainDays !== undefined ? { retainDays: this.ceiling.audit.retainDays } : {}),
            })
          : undefined;
      this.broker = new CapabilityBroker(this.ceiling, store);
      forge.attachBroker(this.broker);
    } else if (this.config.allowSandboxTools) {
      // A direct host never calls the loader, so the line comes from here.
      console.warn(legacyLine(forge.effectiveOptions()));
    }
    this.sandboxForge = forge;
  }

  // --------------------------------------------------------------------------
  // PUBLIC: forge
  // --------------------------------------------------------------------------

  /**
   * Forge a new tool from a request.
   *
   * Runs test cases, submits the candidate to the LLM judge, and registers the
   * tool at the `'session'` tier if approved. Returns a {@link ForgeResult} with
   * the tool ID on success, or an error / rejection verdict on failure.
   *
   * Pipeline:
   * 1. Generate unique tool ID.
   * 2. Build or validate implementation (compose vs. sandbox).
   * 3. Execute all declared test cases and collect results.
   * 4. Submit candidate to the judge for creation review.
   * 5. If approved: create {@link EmergentTool}, register at session tier, index.
   * 6. If rejected: return failure with the judge's reasoning.
   *
   * @param request - The forge request describing the desired tool.
   * @param context - The agent and session ids. `caller` is the forging
   *   call's own context: a composition's test steps run as that caller, so
   *   they meet the checks the caller's direct calls meet.
   * @returns A {@link ForgeResult} indicating success or failure.
   */
  async forge(
    request: ForgeToolRequest,
    context: { agentId: string; sessionId: string; caller?: ToolExecutionContext }
  ): Promise<ForgeResult> {
    // Guard: engine must be enabled.
    if (!this.config.enabled) {
      return { success: false, error: 'Emergent capabilities are disabled.' };
    }

    // Step 1: Generate a unique tool ID.
    const toolId = `emergent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Step 2 & 3: Build implementation and run test cases.
    const testResults: ToolCandidate['testResults'] = [];
    let source: string;

    if (request.implementation.mode === 'compose') {
      // ---- COMPOSE MODE ----
      source = JSON.stringify(request.implementation);

      // Every step must be chainable before any test case runs, and the
      // composition must not reach itself, through any nesting.
      const refused = this.composeRefusal(request.name, request.implementation);
      if (refused) {
        return { success: false, error: refused };
      }

      // The test steps run as the forging caller, so they meet the checks the
      // caller's direct calls meet; a host that builds the engine itself and
      // passes no caller gets a context of its own.
      const testContext: ToolExecutionContext = context.caller ?? {
        gmiId: context.agentId,
        personaId: 'emergent-forge',
        userContext: { userId: 'system' } as ToolExecutionContext['userContext'],
        correlationId: context.sessionId,
      };

      for (const tc of request.testCases) {
        let result: ToolExecutionResult;
        try {
          result = await this.composableBuilder.runPipeline(
            request.implementation,
            tc.input as Record<string, unknown>,
            testContext,
            { dry: { stepOutputs: tc.stepOutputs ?? {} } },
          );
        } catch (err: unknown) {
          testResults.push({
            input: tc.input,
            output: undefined,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          continue;
        }
        const details = result.details as { code?: string; missingCapabilities?: unknown } | undefined;
        if (details?.code === 'dry_run_needs_output') {
          return { success: false, error: result.error };
        }
        // Refused a capability by the permission manager (permission_denied),
        // or by the executor's own check, which names what is missing and
        // carries no code (a manager that does not check capabilities lets
        // the call through to it).
        const missing = details?.missingCapabilities;
        const capabilityRefused =
          details?.code === 'permission_denied' || (Array.isArray(missing) && missing.length > 0);
        if (capabilityRefused && !context.caller) {
          // A step needs a capability the stand-in context does not carry:
          // the test says nothing about the tool, so the forge asks for the
          // caller instead of recording a failed test.
          return {
            success: false,
            error:
              'caller_context_required: a step of this composition needs a capability; ' +
              "pass the forging caller's context (forge(request, { ..., caller }))",
          };
        }
        testResults.push({
          input: tc.input,
          output: result.output,
          success: result.success,
          error: result.error,
          ...(result.effects && result.effects.length > 0 ? { effects: result.effects } : {}),
        });
      }
    } else {
      // ---- SANDBOX MODE ----
      if (!this.config.allowSandboxTools) {
        return {
          success: false,
          error:
            'Sandboxed emergent tools are disabled. Enable allowSandboxTools to permit code-forged tools.',
        };
      }

      source = request.implementation.code;

      // Step 2a: the list must name catalogue capabilities (or the alias), so
      // the request stored for the tool is the list the judge reviews, never a
      // narrowed reading of it.
      const list = normalizeAllowlist(request.implementation.allowlist);
      if (list.unknown.length > 0) {
        return {
          success: false,
          error: `allowlist names capabilities outside the catalogue: ${list.unknown.join(', ')}`,
        };
      }

      // Step 2b: under a ceiling the list is a request, and a name the ceiling
      // does not grant refuses the forge before any test case runs.
      if (this.ceiling) {
        const fit = checkRequest(list.capabilities, this.ceiling);
        if (!fit.ok) {
          return {
            success: false,
            error:
              `capability_not_granted: ${fit.refused.join(', ')}; this host grants ` +
              (fit.allowed.length > 0 ? fit.allowed.join(', ') : 'no capability') +
              ' to code-forged tools',
          };
        }
      }

      // Step 2c: Static code validation before any execution.
      const validation = this.sandboxForge.validateCode(
        request.implementation.code,
        request.implementation.allowlist
      );

      if (!validation.valid) {
        return {
          success: false,
          error: `Code validation failed: ${validation.violations.join('; ')}`,
        };
      }

      // Step 3: Execute test cases in the sandbox, each as a run of its own.
      for (const tc of request.testCases) {
        const sandboxResult = await this.runSandboxed(request.implementation, tc.input, {
          toolId,
          agentId: context.agentId,
        });

        testResults.push({
          input: tc.input,
          output: sandboxResult.output,
          success: sandboxResult.success,
          error: sandboxResult.error,
          ...(sandboxResult.effects ? { effects: sandboxResult.effects } : {}),
        });
      }
    }

    // Step 4: Build candidate and submit to judge.
    const candidate: ToolCandidate = {
      name: request.name,
      description: request.description,
      inputSchema: request.inputSchema,
      outputSchema: request.outputSchema,
      source,
      implementationMode: request.implementation.mode,
      allowlist:
        request.implementation.mode === 'sandbox' ? request.implementation.allowlist : undefined,
      testResults,
    };

    const verdict = await this.judge.reviewCreation(candidate);

    // Step 5: Register if approved.
    if (verdict.approved) {
      if (request.implementation.mode === 'compose') {
        // The tests and the judge took time, and what the steps name may have
        // changed meanwhile (another forge registered a composition that
        // closes a cycle with this one, say): checked again before anything
        // is registered.
        const refused = this.composeRefusal(request.name, request.implementation);
        if (refused) {
          return { success: false, verdict, error: refused };
        }
      }

      const now = new Date().toISOString();

      const usageStats: ToolUsageStats = {
        totalUses: 0,
        successCount: 0,
        failureCount: 0,
        avgExecutionTimeMs: 0,
        lastUsedAt: null,
        confidenceScore: verdict.confidence,
      };

      const tool: EmergentTool = {
        id: toolId,
        name: request.name,
        description: request.description,
        inputSchema: request.inputSchema,
        outputSchema: request.outputSchema,
        implementation: request.implementation,
        tier: 'session',
        createdBy: context.agentId,
        createdAt: now,
        judgeVerdicts: [verdict],
        usageStats,
        source: `forged by agent ${context.agentId} during session ${context.sessionId}`,
      };

      this.registry.register(tool, 'session');
      let written: ToolStateRecord | undefined;
      try {
        written = await this.registry.setState(toolId, 'active', null, {
          request: requestFromImplementation(request.implementation),
          setBy: 'library',
        });
      } catch (error: unknown) {
        // The tool runs in this process either way; without the row its request
        // is re-derived from its source at the next load.
        console.warn(
          `[agentos:emergent] could not store the request of "${request.name}" (${toolId}):`,
          error instanceof Error ? error.message : error,
        );
      }
      if (!this.registry.get(toolId)) {
        // Removed while it was being forged: nothing is registered. (Another
        // change while the state was written, such as a load of the session
        // that adopted the tool from its row, leaves it registered: the forge
        // goes on with the object the registry holds.)
        return { success: false, error: 'the tool was removed while it was being forged' };
      }
      if (written && written.state === 'demoted' && written.reason === 'removed') {
        // The row did not take the state (its tool row never landed): the tool
        // still runs in this process, held active here, and the next load
        // re-derives its request from its source.
        console.warn(
          `[agentos:emergent] the state of "${request.name}" (${toolId}) was not stored; ` +
            'the tool runs in this process only',
        );
        this.registry.adopt(tool, {
          toolId,
          state: 'active',
          reason: null,
          setBy: 'library',
          at: Date.now(),
          request: requestFromImplementation(request.implementation),
        });
      } else if (written && written.state !== 'active') {
        // Another word arrived first (a host's suspension): it holds, and the
        // executable refuses calls until the host lifts it.
        console.warn(
          `[agentos:emergent] "${request.name}" (${toolId}) was ${written.state} before its forge finished ` +
            `(${written.reason ?? 'no reason recorded'})`,
        );
      }
      this.indexTool(toolId, context.agentId, context.sessionId);

      if (this.onToolForged) {
        // The object the registry holds (a registration stores a stamped copy;
        // an adoption above stores the object itself), so the settlement
        // below compares like with like.
        const live = this.registry.get(toolId) ?? tool;
        try {
          await this.onToolForged(live, this.createExecutableTool(live));
        } catch (error: unknown) {
          this.registry.remove(toolId);
          this.removeIndexedTool(toolId, context.agentId, context.sessionId);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to activate forged tool.',
          };
        }
        let settled: LoadedToolOutcome | undefined;
        try {
          settled = await this.settleRegistration(live);
        } catch (error: unknown) {
          return {
            success: false,
            error: error instanceof Error ? error.message : 'the forged tool could not be registered',
          };
        }
        if (settled && settled.reason === 'removed') {
          // Removed while the host was registering it: nothing is registered.
          return { success: false, error: 'the tool was removed while it was being forged' };
        }
      }

      if (request.implementation.mode === 'compose') {
        // A composition registered between the check above and this one's own
        // registration can close a cycle with it, and neither check saw the
        // other: checked once more now that this one resolves by its name, and
        // taken out again when it reaches itself.
        const cycle = this.compositionCycle(request.name, request.implementation.steps);
        if (cycle) {
          const held = this.registry.get(toolId);
          if (held) {
            await this.dropExecutable(held);
          }
          this.registry.remove(toolId);
          this.removeIndexedToolEverywhere(toolId);
          return {
            success: false,
            verdict,
            error: `step_cycle: "${request.name}" reaches itself through ${cycle.join(' -> ')}`,
          };
        }
      }

      return {
        success: true,
        toolId,
        tool,
        verdict,
      };
    }

    // Step 6: Rejected.
    return {
      success: false,
      verdict,
      error: verdict.reasoning,
    };
  }

  // --------------------------------------------------------------------------
  // PUBLIC: checkPromotion
  // --------------------------------------------------------------------------

  /**
   * Check if a tool is eligible for promotion and auto-promote if the threshold
   * is met.
   *
   * A tool qualifies for promotion when:
   * 1. It is at the `'session'` tier.
   * 2. Its usage stats meet `EmergentConfig.promotionThreshold`:
   *    - `totalUses >= threshold.uses`
   *    - `confidenceScore >= threshold.confidence`
   *
   * When eligible, the engine submits the tool to the judge's promotion panel.
   * If both reviewers approve, the tool is promoted to `'agent'` tier.
   *
   * @param toolId - The ID of the tool to check.
   * @returns A {@link PromotionResult} if promotion was attempted, or `null` if
   *   the tool is not eligible or does not exist.
   */
  async checkPromotion(toolId: string): Promise<PromotionResult | null> {
    const tool = this.registry.get(toolId);

    if (!tool) {
      return null;
    }

    // A suspended or demoted tool is neither promoted nor suspended again
    // here: the restriction in force stays, whoever set it.
    if (!this.registry.isActive(toolId)) {
      return null;
    }

    // A tool that no longer fits what is in force is suspended, not promoted.
    const refusal = this.refusalFor(tool.implementation, tool.name);
    if (refusal) {
      await this.suspendAsLibrary(toolId, refusal);
      return { success: false, error: `${refusal}: the tool no longer fits and was suspended.` };
    }

    // Only session-tier tools are eligible for auto-promotion.
    if (tool.tier !== 'session') {
      return null;
    }

    // An owner with the reserved instance-id prefix is never promoted: an
    // agent-tier row with that owner reads as one an earlier release wrote.
    if (tool.createdBy.startsWith(GMI_INSTANCE_ID_PREFIX)) {
      return null;
    }

    // Check thresholds.
    const { uses, confidence } = this.config.promotionThreshold;

    if (tool.usageStats.totalUses < uses || tool.usageStats.confidenceScore < confidence) {
      return null;
    }

    // Submit to the promotion panel.
    const promotionVerdict = await this.judge.reviewPromotion(tool);
    tool.judgeVerdicts.push(promotionVerdict);

    // Suspended, demoted or removed while the panel reviewed it: not promoted.
    if (this.registry.get(toolId) !== tool || !this.registry.isActive(toolId)) {
      return {
        success: false,
        verdict: promotionVerdict,
        error: 'The tool was suspended, demoted or removed during its review and was not promoted.',
      };
    }

    if (promotionVerdict.approved) {
      await this.registry.promote(toolId, 'agent');
      const promotedTool = this.registry.get(toolId);
      if (promotedTool && this.onToolPromoted) {
        await this.onToolPromoted(promotedTool);
      }

      return {
        success: true,
        verdict: promotionVerdict,
      };
    }

    return {
      success: false,
      verdict: promotionVerdict,
      error: 'Promotion panel rejected the tool.',
    };
  }

  // --------------------------------------------------------------------------
  // PUBLIC: getSessionTools
  // --------------------------------------------------------------------------

  /**
   * Get all session-scoped tools for a given session ID.
   *
   * @param sessionId - The session identifier.
   * @returns An array of {@link EmergentTool} objects belonging to the session.
   */
  getSessionTools(sessionId: string): EmergentTool[] {
    const toolIds = this.index.bySession.get(sessionId);
    if (!toolIds) {
      return [];
    }

    const tools: EmergentTool[] = [];
    for (const id of toolIds) {
      const tool = this.registry.get(id);
      if (tool) {
        tools.push(tool);
      }
    }
    return tools;
  }

  // --------------------------------------------------------------------------
  // PUBLIC: getAgentTools
  // --------------------------------------------------------------------------

  /**
   * Get all agent-tier tools for a given agent ID.
   *
   * @param agentId - The agent identifier.
   * @returns An array of {@link EmergentTool} objects created by the agent.
   */
  getAgentTools(agentId: string): EmergentTool[] {
    return this.registry.getByTier('agent', { agentId });
  }

  // --------------------------------------------------------------------------
  // PUBLIC: cleanupSession
  // --------------------------------------------------------------------------

  /**
   * Clean up all session tools for a given session.
   *
   * Delegates to the registry's `EmergentToolRegistry.cleanupSession()`
   * method and clears the local session index. A tool forged in the session
   * and promoted out of it since (now at the agent tier) is not the
   * session's any more: it stays held, registered and indexed under its
   * agent.
   *
   * @param sessionId - The session identifier to clean up.
   * @returns the tools the cleanup removed.
   */
  cleanupSession(sessionId: string): EmergentTool[] {
    const indexed = this.getSessionTools(sessionId);
    this.registry.cleanupSession(sessionId);
    this.index.bySession.delete(sessionId);
    // Only the tools the registry removed go; a promoted tool is still held.
    const removedTools = indexed.filter((tool) => !this.registry.get(tool.id));
    for (const tool of removedTools) {
      // The agent index too, so a lookup by agent never names a tool that is gone.
      this.removeIndexedToolEverywhere(tool.id);
    }
    if (this.onToolRemoved) {
      // The executables go with the tools, as removeTool does. A host that
      // cleans up through the orchestrator unregisters the same names; a
      // second unregistration of a name finds nothing to do.
      const unregister = this.onToolRemoved;
      void Promise.allSettled(removedTools.map((tool) => unregister(tool)));
    }
    return removedTools;
  }

  /**
   * Hydrate one stored tool and make it executable.
   *
   * @deprecated Use {@link loadPersistedTools}, which reads the rows itself.
   * This applies the same checks to the one tool: a suspended or demoted tool
   * is not registered, and a tool whose source cannot be rebuilt is suspended.
   * When the tool has a stored row, that row is what is read, not the object
   * passed in (a host-built object can carry a list the host made up), and a
   * load never rewrites it. A tool with no row gets its row written first, as
   * before, so its uses are recorded and the next load finds it.
   *
   * @returns what happened, so a host can tell a registered tool from a refused one.
   */
  async syncPersistedTool(tool: EmergentTool): Promise<LoadedToolOutcome> {
    return this.serializeAdmission(tool.id, () => this.syncOne(tool));
  }

  private async syncOne(tool: EmergentTool): Promise<LoadedToolOutcome> {
    const existing = await this.registry.loadRow(tool.id);
    if (!existing && this.registry.hasStorage()) {
      // No stored row yet: the host hydrates from its own store. The row is
      // written as it was before loading went through the stored row, so the
      // tool's uses are recorded and the next load finds it.
      await this.registry.writeToolRow(tool);
    }
    // The row is read for the admission after any write above, so the write
    // is not a change the admission's read missed.
    return this.withRead(async (readAt) => {
      const row = await this.registry.loadRow(tool.id);
      if (row) {
        // With source persistence off the row holds a redacted record; the
        // implementation the host supplied is what runs then.
        return this.admitRow(row, { readAt, sourceFallback: sourceFromImplementation(tool.implementation) });
      }
      const stored = await this.registry.readState(tool.id);
      return this.admit(
        {
          toolId: tool.id,
          name: tool.name,
          source: sourceFromImplementation(tool.implementation),
          stored,
          requestStored: stored?.request != null,
          legacyActive: (tool as EmergentTool & { isActive?: boolean }).isActive ?? true,
          tier: tool.tier,
          createdBy: tool.createdBy,
          buildTool: () => tool,
        },
        { readAt },
      );
    });
  }

  /**
   * Remove a previously synced tool from the live runtime and registry.
   */
  async removeTool(toolId: string): Promise<EmergentTool | undefined> {
    const tool = this.registry.get(toolId);
    // The rows go whether or not the tool is loaded here, after the tool's
    // queued state writes; a sync of the same id after this returns finds no
    // row, as a removal promises.
    this.registry.remove(toolId);
    await this.registry.settled(toolId);
    this.removeIndexedToolEverywhere(toolId);
    if (tool && this.onToolRemoved) {
      await this.onToolRemoved(tool);
    }
    return tool;
  }

  // --------------------------------------------------------------------------
  // PUBLIC: stored tools
  // --------------------------------------------------------------------------

  /**
   * Load the stored tools of the given tiers into the running process.
   *
   * Call it at start, after the host's own tools are registered. For each row
   * it reads the source (raw code, code with its list, a redacted record, or a
   * composition), keeps a demoted row off, suspends a row that cannot be
   * rebuilt, and registers the rest. A row is never rewritten by being loaded,
   * and a stored request is never replaced by a derived one. One line is logged
   * per tool that did not load. A row whose load throws is reported in
   * `failed` and does not stop the others.
   *
   * `shared` rows load for every caller. `agent` rows are those of
   * `options.agentId` and `session` rows those of `options.sessionId`, and
   * naming either tier without its selector throws (`selector_required`), so
   * a shared store never puts one agent's private tools in another's
   * executor. A loaded or forged `agent` tool also refuses a call from any
   * other agent (see {@link createExecutableTool}). The agent identity is the
   * persona id: `forge_tool` records the forging caller's `personaId` as
   * `created_by_agent`, and `agentId` here is that id. Rows written by
   * releases before this one hold the forging GMI instance's id instead.
   */
  async loadPersistedTools(options: LoadPersistedToolsOptions): Promise<LoadPersistedToolsResult> {
    const { tiers, agentId, sessionId } = options;
    if (tiers.includes('agent') && agentId === undefined) {
      throw new Error(
        "selector_required: loadPersistedTools({ tiers: ['agent'] }) needs the agentId whose tools to load; " +
          "an agent's tools are private to it.",
      );
    }
    if (tiers.includes('session') && sessionId === undefined) {
      throw new Error(
        "selector_required: loadPersistedTools({ tiers: ['session'] }) needs the sessionId whose tools to load; " +
          "a session's tools are private to it.",
      );
    }
    const outcomes: LoadedToolOutcome[] = [];
    const failed: FailedToolLoad[] = [];
    // One read for the rows and their admissions: a tool that changes in this
    // process after the rows were read (a removal, a registration) is read
    // again before it is adopted.
    await this.withRead(async (readAt) => {
      // Code tools first: a stored composition may chain a stored code tool.
      const rows = (await this.registry.loadRows(tiers, { agentId, sessionId })).sort(
        (a, b) => Number(a.implementation_mode === 'compose') - Number(b.implementation_mode === 'compose'),
      );
      for (const row of rows) {
        try {
          outcomes.push(await this.serializeAdmission(row.id, () => this.admitRow(row, { readAt })));
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push({ toolId: row.id, name: row.name, error: message });
          console.warn(`[agentos:emergent] stored tool "${row.name}" (${row.id}) did not load: ${message}`);
        }
      }
    });
    // A composition can chain another composition loaded after it, at any
    // depth: those suspended because a step was missing are admitted again,
    // pass after pass, until a pass activates none.
    for (let pass = 0; pass < outcomes.length; pass += 1) {
      let activated = 0;
      for (let i = 0; i < outcomes.length; i += 1) {
        const outcome = outcomes[i];
        if (outcome.state !== 'suspended' || outcome.reason !== 'step_missing') {
          continue;
        }
        try {
          const again = await this.serializeAdmission(outcome.toolId, () =>
            this.withRead(async (readAt) => {
              const row = await this.registry.loadRow(outcome.toolId);
              return row ? this.admitRow(row, { readAt }) : undefined;
            }),
          );
          if (again) {
            outcomes[i] = again;
            if (again.state === 'active') {
              activated += 1;
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          outcomes.splice(i, 1);
          i -= 1;
          failed.push({ toolId: outcome.toolId, name: outcome.name, error: message });
          console.warn(`[agentos:emergent] stored tool "${outcome.name}" (${outcome.toolId}) did not load: ${message}`);
        }
      }
      if (activated === 0) {
        break;
      }
    }

    for (const outcome of outcomes) {
      if (outcome.state === 'active') continue;
      const key = outcome.reason ? REASON_CONFIG_KEYS[outcome.reason] : undefined;
      console.warn(
        `[agentos:emergent] stored tool "${outcome.name}" (${outcome.toolId}) is ${outcome.state}: ` +
          `${outcome.reason ?? 'no reason recorded'}${key ? ` (see ${key})` : ''}`,
      );
    }

    const count = (state: ToolState) => outcomes.filter((o) => o.state === state).length;
    return {
      active: count('active'),
      suspended: count('suspended'),
      demoted: count('demoted'),
      outcomes,
      failed,
    };
  }

  /**
   * Suspend a tool and take it out of the executor. The state write is
   * awaited, so the suspension survives a restart, and no later use, rewrite
   * or load turns the tool back on. The suspension is recorded as the host's,
   * so it stays, whatever its reason says, until {@link reactivateTool} is
   * called.
   *
   * @returns `false` when the tool is unknown.
   */
  async suspendTool(toolId: string, reason: string): Promise<boolean> {
    const tool = this.registry.get(toolId);
    if (!tool) {
      // Not loaded in this process: the stored row is still suspended, so the
      // next load keeps it off. The stored request is left as it is.
      const row = await this.registry.loadRow(toolId);
      if (!row) {
        return false;
      }
      await this.registry.setState(toolId, 'suspended', reason, { setBy: 'host' });
      return true;
    }
    await this.registry.suspend(toolId, reason);
    if (this.onToolRemoved) {
      await this.onToolRemoved(tool);
    }
    return true;
  }

  /**
   * Demote a tool: its confidence is reset, it is taken out of the executor,
   * and no later load brings it back. Only {@link reactivateTool} does.
   *
   * @returns `false` when the tool is unknown.
   */
  async demoteTool(toolId: string, reason: string): Promise<boolean> {
    const tool = this.registry.get(toolId);
    if (!tool) {
      const row = await this.registry.loadRow(toolId);
      if (!row) {
        return false;
      }
      await this.registry.setState(toolId, 'demoted', reason, { setBy: 'host' });
      return true;
    }
    await this.registry.demote(toolId, reason);
    if (this.onToolRemoved) {
      await this.onToolRemoved(tool);
    }
    return true;
  }

  /**
   * Re-check one suspended or demoted tool against the configuration in force
   * and, when it fits, register it again. This is how a host clears a
   * suspension or a demotion it set; the library never does so on its own.
   *
   * @returns the outcome, or `undefined` when the tool is unknown.
   */
  async reactivateTool(toolId: string): Promise<LoadedToolOutcome | undefined> {
    return this.recheck(toolId, true);
  }

  /**
   * Called by the host when any tool is registered. A composition the library
   * suspended because a step was missing, refused, replaced or circular is
   * checked again when a tool one of its steps names arrives, and registered
   * when it fits. A host's own suspension is left to the host.
   */
  async onHostToolRegistered(toolName: string): Promise<void> {
    for (const record of this.registry.listStates()) {
      if (
        record.state !== 'suspended' ||
        record.setBy !== 'library' ||
        !STEP_SUSPENSION_REASONS.has(record.reason ?? '')
      ) {
        continue;
      }
      if (record.request?.kind !== 'compose' || !record.request.steps.some((step) => step.tool === toolName)) {
        continue;
      }
      try {
        await this.recheck(record.toolId, false);
      } catch (error: unknown) {
        console.warn(
          `[agentos:emergent] could not re-check "${record.toolId}" after "${toolName}" was registered:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  private async recheck(toolId: string, force: boolean): Promise<LoadedToolOutcome | undefined> {
    return this.serializeAdmission(toolId, () => this.recheckNow(toolId, force));
  }

  private async recheckNow(toolId: string, force: boolean): Promise<LoadedToolOutcome | undefined> {
    return this.withRead(async (readAt) => {
      const row = await this.registry.loadRow(toolId);
      if (row) {
        return this.admitRow(row, { force, readAt });
      }
      const tool = this.registry.get(toolId);
      if (!tool) {
        // Neither a row nor a tool: a state held for it here (a stored
        // suspension another process has since removed) is let go, so no
        // later registration re-checks it.
        if (this.registry.getState(toolId)) {
          this.registry.forget(toolId);
        }
        return undefined;
      }
      const held = this.registry.getState(toolId);
      return this.admit(
        {
          toolId,
          name: tool.name,
          source: sourceFromImplementation(tool.implementation),
          stored: held,
          requestStored: held?.request != null,
          legacyActive: true,
          tier: tool.tier,
          createdBy: tool.createdBy,
          buildTool: () => tool,
        },
        { force, readAt },
      );
    });
  }

  /**
   * Run a read of stored rows and the admissions that use it. `readAt` is the
   * point the read started at; an admission adopts only what has not changed
   * since (see `EmergentToolRegistry.adopt`).
   */
  private async withRead<T>(read: (readAt: number) => Promise<T>): Promise<T> {
    const readAt = this.registry.beginRead();
    try {
      return await read(readAt);
    } finally {
      this.registry.endRead();
    }
  }

  /** Run an admission of `toolId` after any admission of it already under way. */
  private serializeAdmission<T>(toolId: string, run: () => Promise<T>): Promise<T> {
    const prior = this.admissionChains.get(toolId) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(run);
    this.admissionChains.set(toolId, next);
    next
      .finally(() => {
        if (this.admissionChains.get(toolId) === next) {
          this.admissionChains.delete(toolId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  private admitRow(
    row: PersistedToolRow,
    options: AdmissionOptions = {},
  ): Promise<LoadedToolOutcome> {
    const stored: ToolStateRecord | undefined = row.state
      ? {
          toolId: row.id,
          state: row.state,
          reason: row.state_reason ?? null,
          setBy: stateSetterFromColumn(row.set_by),
          at: Number(row.state_at ?? 0),
          request: parseStoredRequest(row.request_json),
          ...(row.write_id ? { writeId: row.write_id } : {}),
        }
      : undefined;
    // A row whose schema columns do not read cannot be built: it is unreadable
    // before its source is looked at, so a damaged input_schema never widens
    // to a schema that accepts any input.
    const schemas = parseRowSchemas(row);
    const source: PersistedSource =
      'error' in schemas
        ? { format: 'unreadable', error: schemas.error }
        : parsePersistedSource(row.implementation_mode, row.implementation_source);
    // A redacted record cannot be rebuilt from the row; a host that supplies
    // the implementation (syncPersistedTool) runs from what it supplied, as it
    // did before loading went through the row. State, request and the flag
    // still come from the row.
    const sourceInUse =
      source.format === 'redacted' && options.sourceFallback && options.sourceFallback.format !== 'unreadable'
        ? options.sourceFallback
        : source;
    return this.admit(
      {
        toolId: row.id,
        name: row.name,
        source: sourceInUse,
        stored,
        requestStored: row.request_json != null,
        legacyActive: !(row.is_active === 0 || row.is_active === false),
        flagSynced: row.flag_synced == null ? undefined : !(row.flag_synced === 0 || row.flag_synced === false),
        tier: row.tier,
        createdBy: row.created_by_agent,
        buildTool: (implementation) => toolFromRow(row, implementation),
      },
      options,
    );
  }

  /**
   * The single-row path. Every stored tool goes through it, whether the
   * library read its row or a host built the tool from its own.
   */
  /**
   * The row changed under an admission (another process wrote, or the host
   * acted): admit the tool again from the row as it stands, up to twice. A
   * row that is gone reads as removed; a row still changing after two
   * re-admissions is left for the next load.
   */
  private async readmit(candidate: AdmissionCandidate, options: AdmissionOptions): Promise<LoadedToolOutcome> {
    const { toolId, name } = candidate;
    const depth = options.readmitted ?? 0;
    if (depth < 2) {
      // The tool's queued writes and deletes land first, so the row read next
      // is the one they leave.
      await this.registry.settled(toolId);
      return this.withRead(async (readAt): Promise<LoadedToolOutcome> => {
        const fresh = await this.registry.loadRow(toolId);
        if (fresh) {
          return this.admitRow(fresh, { ...options, readmitted: depth + 1, readAt });
        }
        await this.unregisterIfLive(toolId);
        return { toolId, name, state: 'demoted', reason: 'removed' };
      });
    }
    // Nothing is written; the tool is held off here until the next load.
    this.holdStored(toolId, {
      toolId,
      state: 'suspended',
      reason: 'contended',
      setBy: 'library',
      at: Date.now(),
      request: null,
    });
    await this.unregisterIfLive(toolId);
    return { toolId, name, state: 'suspended', reason: 'contended' };
  }

  private async admit(candidate: AdmissionCandidate, options: AdmissionOptions = {}): Promise<LoadedToolOutcome> {
    const { toolId, name, source, stored, requestStored } = candidate;
    // The point after which a change makes what this admission holds stale:
    // where its row was read, or, for a caller that did not say, now.
    const readAt = options.readAt ?? this.registry.generation(toolId);
    let legacyActive = candidate.legacyActive;
    // A row whose last state write did not finish its flag write: finish it
    // first, so the flag reads what the state row says before anything is
    // decided. A crash or a failed write between a state row and its flag
    // never leaves the two apart beyond the next load.
    if (stored && candidate.flagSynced === false) {
      await this.registry.syncLegacyFlag(toolId, stored);
      legacyActive = stored.state === 'active';
    }
    // The request this process works with: the stored one when it can be read,
    // else one derived from the source. It is written to the row only when the
    // row holds none; a stored request this release cannot read stays as it is.
    const request = stored?.request ?? requestFromSource(source);
    const requestToWrite = requestStored ? undefined : request;

    // 1. A tool a host turned off stays off. A row with is_active = 0 and no
    //    suspension on record was turned off by a host (its own SQL, or
    //    demote()); loading never undoes that, so it is recorded as the host's.
    //    (A flag write the library had not finished was finished above, so a
    //    lowered flag here is the host's own.)
    const hostTurnedOff = !legacyActive && stored?.state !== 'suspended';
    if ((stored?.state === 'demoted' || hostTurnedOff) && !options.force) {
      const reason = stored?.state === 'demoted' ? stored.reason : 'legacy_inactive';
      if (stored?.state === 'demoted') {
        this.holdStored(toolId, stored);
      } else {
        // Written only while the row is as it was read: a host that
        // reactivated the tool meanwhile is not written over.
        const written = await this.registry.setState(toolId, 'demoted', 'legacy_inactive', {
          request: requestToWrite,
          setBy: 'host',
          ifRow: stored ? { at: stored.at, state: stored.state, setBy: stored.setBy } : ('absent' as const),
        });
        if (written.state !== 'demoted' || written.reason !== 'legacy_inactive') {
          return this.readmit(candidate, options);
        }
      }
      await this.unregisterIfLive(toolId);
      return { toolId, name, state: 'demoted', reason };
    }

    // 2. A suspension the host set is cleared only by the host, whatever its
    //    reason says. One the library set is re-checked below.
    if (stored?.state === 'suspended' && !options.force && stored.setBy === 'host') {
      // Another process may have set it: this one takes it in and lets go of
      // the executable, so the suspension holds wherever the tool is loaded.
      this.holdStored(toolId, stored);
      await this.unregisterIfLive(toolId);
      return { toolId, name, state: 'suspended', reason: stored.reason };
    }

    // 3. Can the source be rebuilt, and may it run under the configuration in force?
    let implementation: ToolImplementation | undefined;
    let refusal: string | null = null;
    if (source.format === 'unreadable') {
      refusal = 'source_unreadable';
    } else if (source.format === 'redacted') {
      // The row cannot rebuild the tool, but this process may still hold it:
      // with source persistence off, a tool forged here runs from memory until
      // the process ends, and a load must not take it away.
      const held = this.registry.get(toolId)?.implementation;
      if (held && held.mode === 'sandbox' && held.code.trim() !== '') {
        implementation = held;
      } else {
        refusal = 'source_not_persisted';
      }
    } else {
      implementation = source.implementation;
    }
    if (
      implementation &&
      implementation.mode === 'sandbox' &&
      request?.kind === 'sandbox'
    ) {
      // The request is what the tool was granted, whatever its text, its
      // stored list or the list held in memory shows: for a raw-code row the
      // text was read only to derive a request where none was stored, and a
      // stored request narrower than a stored list is the grant. Never wider
      // than a stored list: a request widened by hand grants nothing the list
      // did not. The two are compared in catalogue names, since a list a host
      // built, or one held in memory, may name `fs.read` or `fs.readFile`.
      const listed = normalizeAllowlist(implementation.allowlist).capabilities;
      const names =
        source.format === 'code-with-list'
          ? request.capabilities.filter((name) => listed.includes(name))
          : request.capabilities;
      implementation = { ...implementation, allowlist: toSandboxApis(names) };
    }
    // 3a. An agent-tier row from an earlier release is owned by the forging
    //     GMI instance's id, which no persona can match, so no caller could
    //     ever pass the owner check: it loads suspended rather than running
    //     for everyone. Forging the tool again under the persona is the way
    //     back; `reactivateTool` goes through this same path.
    if (!refusal && candidate.tier === 'agent' && candidate.createdBy.startsWith(GMI_INSTANCE_ID_PREFIX)) {
      refusal = 'legacy_owner';
    }
    // 3b. Under a ceiling, a stored request this release cannot read is not
    //     replaced by one derived from the source, which could narrow the
    //     tool silently: it waits, suspended, for a release that reads it.
    if (!refusal && this.ceiling && implementation?.mode === 'sandbox' && requestStored && !stored?.request) {
      refusal = 'request_unreadable';
    }
    if (implementation && !refusal) {
      refusal = this.refusalFor(implementation, name);
    }

    if (refusal || !implementation) {
      const reason = refusal ?? 'source_unreadable';
      // Written as the library's even when a host's suspension already carries
      // the same words, so a later load re-checks it (the words decide nothing).
      if (stored?.state !== 'suspended' || stored.reason !== reason || stored.setBy !== 'library') {
        // A load writes only while the row is as it was read (a host's
        // reactivation is unconditional); a refused write re-admits from the
        // row as it stands.
        const written = await this.registry.setState(toolId, 'suspended', reason, {
          request: requestToWrite,
          setBy: 'library',
          ...(options.force
            ? {}
            : { ifRow: stored ? { at: stored.at, state: stored.state, setBy: stored.setBy } : ('absent' as const) }),
        });
        if (written.state !== 'suspended' || written.reason !== reason) {
          return this.readmit(candidate, options);
        }
      } else {
        // The row already says so; this process holds it too. A row that
        // holds no request it can read is held with the one derived from its
        // source, so a registration of a step tool it names finds it.
        this.holdStored(toolId, stored.request ? stored : { ...stored, request });
      }
      await this.unregisterIfLive(toolId);
      return { toolId, name, state: 'suspended', reason };
    }

    // 4. Active: the state row first, so a write that fails leaves the tool
    //    off; then into memory without rewriting the row; then into the executor.
    const tool = candidate.buildTool(implementation);
    // A reactivation always writes: the row may already read active while this
    // process holds a restriction whose own write failed. A load writes only
    // while the row is still as it read it, so a restriction another process
    // stored in between is never written over.
    let written: ToolStateRecord | undefined;
    if (options.force || stored?.state !== 'active' || !requestStored) {
      written = await this.registry.setState(toolId, 'active', null, {
        request: requestToWrite,
        setBy: 'library',
        ...(options.force
          ? {}
          : { ifRow: stored ? { at: stored.at, state: stored.state, setBy: stored.setBy } : ('absent' as const) }),
      });
    } else {
      // Nothing to write: the row read active with its request. It is read
      // again here, because the write that would have caught a restriction
      // another process stored since the first read is not made.
      const now = await this.registry.readStoredState(toolId);
      if (!now) {
        // The row this load read is gone: another process removed the tool.
        written = { toolId, state: 'demoted', reason: 'removed', setBy: 'host', at: Date.now(), request: null };
      } else if (
        now.state !== stored.state ||
        now.setBy !== stored.setBy ||
        now.at !== stored.at ||
        (now.writeId !== undefined && now.writeId !== stored.writeId)
      ) {
        written = now;
      }
    }
    // A suspension or demotion that arrived while the row was being written,
    // in this process or in another, is the newer word: the tool is not
    // registered. A restriction this process holds from an earlier read, or
    // whose write has settled (or failed) before this read, is older than the
    // row and gives way to it.
    const held = written && written.state !== 'active' ? written : this.newerRestrictionHeld(toolId, readAt);
    if (held && held.state !== 'active') {
      this.holdStored(toolId, held);
      await this.unregisterIfLive(toolId);
      return { toolId, name, state: held.state, reason: held.reason };
    }
    // A first write refused by another process's active row: that row's
    // request is the grant, not the one derived here, so the tool is admitted
    // again from the row as it stands (once).
    // The grant the row holds after the write is what the tool may reach: a
    // request another process stored meanwhile, narrower or wider than the
    // one this admission built with, admits the tool again from the row. A
    // row whose request this release cannot read (or holds none) gives
    // nothing to compare, and the derived grant stands as before.
    if (written && written.request !== null && !sameGrant(written.request, request)) {
      return this.readmit(candidate, options);
    }
    // A live tool under this id with another name (the host renamed the row):
    // its executable goes first, so the old name stops running the old code.
    const live = this.registry.get(toolId);
    if (live && live.name !== tool.name) {
      await this.unregisterIfLive(toolId);
    }
    const adopted = this.registry.adopt(
      tool,
      {
        toolId,
        state: 'active',
        reason: null,
        setBy: 'library',
        at: Date.now(),
        request,
      },
      readAt,
    );
    if (!adopted) {
      // The tool changed in this process after its row was read (removed,
      // replaced under its id, written again), or a removal of it is still
      // deleting its rows: what this admission holds may be stale. With
      // storage the row is read again once the tool's queued writes have run;
      // without, the registry's own record is the answer.
      if (this.registry.hasStorage()) {
        return this.readmit(candidate, options);
      }
      const current = this.registry.get(toolId);
      if (!current) {
        return { toolId, name, state: 'demoted', reason: 'removed' };
      }
      const held = this.registry.getState(toolId);
      return { toolId, name: current.name, state: held?.state ?? 'active', reason: held?.reason ?? null };
    }
    this.indexTool(
      tool.id,
      tool.createdBy,
      this.extractSessionId(tool.source) ?? `persisted:${tool.id}`,
    );
    if (this.onToolForged) {
      try {
        await this.onToolForged(tool, this.createExecutableTool(tool));
      } catch (error: unknown) {
        // The host did not register the executable: nothing here claims the
        // tool, its row stays for the next load, and the failure is the
        // load's report for this row.
        this.registry.forget(toolId);
        this.removeIndexedToolEverywhere(toolId);
        throw error;
      }
      const settled = await this.settleRegistration(tool);
      if (settled) {
        return settled;
      }
    }
    return { toolId, name, state: 'active', reason: null };
  }

  /**
   * After the host registered a tool's executable, the registry must still
   * hold that very object. When it does not (the tool was removed, or
   * replaced under its id, while the registration ran), the executor is
   * brought back in line with the registry: the current tool's executable is
   * registered (the old name's taken out first when the name changed), or
   * the stale executable is taken out when the registry holds none. The
   * registry is read again after every registration, so a change during the
   * settlement is settled too, up to three rounds. A registration that fails,
   * or a tool still changing after three rounds, leaves no executable under
   * the name and throws: a tool that cannot be called is reported, never a
   * stale executable left running. Returns the outcome to report, or
   * undefined when the first registration stands.
   */
  private async settleRegistration(tool: EmergentTool): Promise<LoadedToolOutcome | undefined> {
    let registered: EmergentTool | undefined = tool;
    for (let round = 0; round < 3; round += 1) {
      const current = this.registry.get(tool.id);
      if (current === registered) {
        if (round === 0) {
          return undefined;
        }
        if (!current) {
          this.removeIndexedToolEverywhere(tool.id);
          return { toolId: tool.id, name: tool.name, state: 'demoted', reason: 'removed' };
        }
        const held = this.registry.getState(tool.id);
        return { toolId: tool.id, name: current.name, state: held?.state ?? 'active', reason: held?.reason ?? null };
      }
      try {
        if (registered && (!current || current.name !== registered.name) && this.onToolRemoved) {
          await this.onToolRemoved(registered);
        }
        if (current && this.onToolForged) {
          await this.onToolForged(current, this.createExecutableTool(current));
        }
        registered = current;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        await this.dropExecutable(registered ?? current ?? tool);
        if (!this.registry.get(tool.id)) {
          this.removeIndexedToolEverywhere(tool.id);
        }
        throw new Error(
          `the executable of "${tool.name}" (${tool.id}) could not be brought in line with the registry: ${message}`,
        );
      }
    }
    await this.dropExecutable(registered ?? tool);
    throw new Error(
      `the executable of "${tool.name}" (${tool.id}) could not be settled: the tool kept changing while it was registered`,
    );
  }

  /** Take a tool's executable out of the host, best-effort. */
  private async dropExecutable(tool: EmergentTool): Promise<void> {
    if (!this.onToolRemoved) {
      return;
    }
    try {
      await this.onToolRemoved(tool);
    } catch (error: unknown) {
      console.warn(
        `[agentos:emergent] could not take out the executable of "${tool.name}" (${tool.id}):`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  /**
   * The forge's refusal of a composition under what is registered now: a step
   * that may not be chained, or a chain that reaches the composition itself,
   * with the step or the path named; `null` when it may be forged.
   */
  private composeRefusal(name: string, implementation: ComposableToolSpec): string | null {
    for (const step of implementation.steps) {
      const verdict = this.composableBuilder.check(step.tool);
      if (!verdict.ok) {
        return `${verdict.code}: step "${step.name}" (tool "${step.tool}"): ${verdict.message}`;
      }
    }
    const cycle = this.compositionCycle(name, implementation.steps);
    return cycle ? `step_cycle: "${name}" reaches itself through ${cycle.join(' -> ')}` : null;
  }

  /**
   * The library's reason for not running an implementation under the
   * configuration in force, or `null`. Later steps add their checks here, so
   * forging, loading and promotion all ask the same question.
   */
  private refusalFor(implementation: ToolImplementation, name?: string): string | null {
    if (implementation.mode === 'sandbox') {
      if (!this.config.allowSandboxTools) {
        return 'sandbox_tools_off';
      }
      if (implementation.code.trim() === '') {
        return 'source_not_persisted';
      }
      if (this.ceiling) {
        // The grant must fit the ceiling in force: a lowered ceiling
        // suspends the tool, and the next load under a ceiling that covers
        // it again lifts the suspension (the library's, so it is re-checked).
        const list = normalizeAllowlist(implementation.allowlist);
        if (list.unknown.length > 0 || !checkRequest(list.capabilities, this.ceiling).ok) {
          return 'capability_not_granted';
        }
      }
      return null;
    }
    for (const step of implementation.steps) {
      const verdict = this.composableBuilder.check(step.tool);
      if (!verdict.ok) {
        return verdict.code;
      }
    }
    if (name !== undefined && this.compositionCycle(name, implementation.steps)) {
      return 'step_cycle';
    }
    return null;
  }

  /**
   * The path of step tool names through which a composition named `name`
   * reaches itself, or a nested composition reaches one already on the path;
   * null when there is none. Nested compositions are followed through the
   * tools the gate resolves now.
   */
  private compositionCycle(
    name: string,
    steps: readonly { tool: string }[],
    path: readonly string[] = [],
  ): string[] | null {
    for (const step of steps) {
      if (step.tool === name || path.includes(step.tool)) {
        return [...path, step.tool];
      }
      const nested = this.nestedSteps(step.tool);
      if (nested) {
        const found = this.compositionCycle(name, nested, [...path, step.tool]);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }

  /** The steps of the emergent composition registered as `toolName`, or undefined. */
  private nestedSteps(toolName: string): readonly { tool: string }[] | undefined {
    const resolved = this.composableBuilder.resolve(toolName) as (ITool & { emergentMode?: string }) | undefined;
    if (resolved?.emergentMode !== 'compose' || !resolved.id.startsWith('emergent-tool:')) {
      return undefined;
    }
    const implementation = this.registry.get(resolved.id.slice('emergent-tool:'.length))?.implementation;
    return implementation?.mode === 'compose' ? implementation.steps : undefined;
  }

  /**
   * A suspension the library sets from a run or a promotion check: written as
   * the library's (so a later load, or a registration of the missing step
   * tool, re-checks it), held here, and the executable taken out. It gives
   * way to the host's word: when this process holds a host's suspension or a
   * demotion nothing is written, and a row another process restricted that
   * way is left as it is and held here (`yieldToHost`), so the library never
   * turns a host's restriction into one of its own that a re-check lifts.
   *
   * It takes its turn with the tool's admissions (`serializeAdmission`): a
   * re-check that a registration starts while the suspension is written runs
   * after it, reads the row it leaves and lifts it when the step fits again,
   * instead of reading the row from before it and holding the suspension
   * whose write was still under way.
   *
   * @returns whether the library's suspension is what holds now.
   */
  private suspendAsLibrary(toolId: string, reason: string): Promise<boolean> {
    return this.serializeAdmission(toolId, () => this.suspendAsLibraryNow(toolId, reason));
  }

  private async suspendAsLibraryNow(toolId: string, reason: string): Promise<boolean> {
    const held = this.registry.getState(toolId);
    let suspended = false;
    if (!held || !isHostRestriction(held)) {
      try {
        const inForce = await this.registry.setState(toolId, 'suspended', reason, {
          setBy: 'library',
          yieldToHost: true,
        });
        suspended = inForce.state === 'suspended' && inForce.setBy === 'library';
      } catch (error: unknown) {
        // Held here even though the row did not take it.
        suspended = true;
        console.warn(
          `[agentos:emergent] could not store the suspension of "${toolId}" (${reason}):`,
          error instanceof Error ? error.message : error,
        );
      }
    }
    await this.unregisterIfLive(toolId);
    return suspended;
  }

  private async unregisterIfLive(toolId: string): Promise<void> {
    const live = this.registry.get(toolId);
    if (live && this.onToolRemoved) {
      await this.onToolRemoved(live);
    }
  }

  /**
   * A restriction this process holds that the row read from `readAt` on may
   * not show: one requested here whose write is still queued or running, or
   * settled after the read began, or a host's whose write failed (it stays
   * in force here until the host reactivates the tool). Decided by the
   * registry's record of its own writes, not by timestamps, so a contended
   * hold, a library suspension whose write failed and a record taken from an
   * earlier row read give way to the row, and so does a restriction another
   * process lifted after it, whatever the processes' clocks say.
   */
  private newerRestrictionHeld(toolId: string, readAt: number): ToolStateRecord | undefined {
    const memory = this.registry.getState(toolId);
    if (!memory || memory.state === 'active') {
      return undefined;
    }
    return this.registry.restrictionUnread(toolId, readAt) ? memory : undefined;
  }

  /** A stored restriction, held in this process too when the tool is live here. */
  private holdStored(toolId: string, record: ToolStateRecord): void {
    const live = this.registry.get(toolId);
    if (live) {
      this.registry.adopt(live, record);
    } else if (record.state !== 'active') {
      // Held without a tool: a stored step suspension must reach
      // onHostToolRegistered, which walks the held states, on every start
      // and in every process that reads it, not only where it was written.
      this.registry.holdState(record);
    }
  }

  // --------------------------------------------------------------------------
  // PUBLIC: createSelfImprovementTools
  // --------------------------------------------------------------------------

  /**
   * Factory method that creates the four self-improvement tools when
   * `config.selfImprovement?.enabled` is `true`.
   *
   * Returns an array containing:
   * 1. **AdaptPersonalityTool** — bounded HEXACO trait mutation.
   * 2. **ManageSkillsTool** — runtime skill enable/disable/search.
   * 3. **CreateWorkflowTool** — multi-step tool composition.
   * 4. **SelfEvaluateTool** — self-scoring with parameter adjustment.
   *
   * Returns an empty array when self-improvement is disabled or the
   * config is absent. Uses dynamic imports to avoid hard compile-time
   * coupling to tool modules that may not yet exist.
   *
   * @param deps - Runtime hooks for personality, skills, tools, and memory.
   * @returns Array of 0 or 4 {@link ITool} instances.
   */
  async createSelfImprovementTools(deps: SelfImprovementToolDeps): Promise<ITool[]> {
    const selfConfig = this.config.selfImprovement;
    if (!selfConfig?.enabled) {
      return [];
    }

    const tools: ITool[] = [];
    let adaptPersonalityTool: AdaptPersonalityTool | undefined;

    try {
      // Dynamic import to avoid hard coupling — these modules may be created
      // by other agents or added later. Each import is individually try-caught
      // so a missing module doesn't prevent the others from loading.

      try {
        const { AdaptPersonalityTool } = await import('./AdaptPersonalityTool.js');
        adaptPersonalityTool = new AdaptPersonalityTool({
          config: {
            maxDeltaPerSession: selfConfig.personality.maxDeltaPerSession,
            // Decay wiring (spec batch-1 C6): both values forwarded so
            // decay-on-adapt can run — construction previously dropped them.
            persistWithDecay: selfConfig.personality.persistWithDecay,
            decayRate: selfConfig.personality.decayRate,
          },
          getPersonality: deps.getPersonality,
          setPersonality: deps.setPersonality,
          mutationStore: selfConfig.personality.persistWithDecay ? deps.mutationStore : undefined,
        });
        tools.push(adaptPersonalityTool);
      } catch {
        // AdaptPersonalityTool module not available — skip.
      }

      try {
        const { ManageSkillsTool } = await import('./ManageSkillsTool.js');
        tools.push(
          new ManageSkillsTool({
            config: {
              allowlist: selfConfig.skills.allowlist,
              requireApprovalForNewCategories:
                selfConfig.skills.requireApprovalForNewCategories,
            },
            getActiveSkills: deps.getActiveSkills,
            getLockedSkills: deps.getLockedSkills,
            loadSkill: deps.loadSkill,
            unloadSkill: deps.unloadSkill,
            searchSkills: deps.searchSkills,
          }),
        );
      } catch {
        // ManageSkillsTool module not available — skip.
      }

      try {
        const { CreateWorkflowTool } = await import('./CreateWorkflowTool.js');
        tools.push(
          new CreateWorkflowTool({
            config: {
              maxSteps: selfConfig.workflows.maxSteps,
              allowedTools: selfConfig.workflows.allowedTools,
            },
            executeTool: deps.executeTool,
            listTools: deps.listTools,
            checkStep: (name: string) => {
              const verdict = this.composableBuilder.check(name);
              // The instance checked is the one the step runs (resolved again
              // with nothing awaited in between).
              return verdict.ok ? { ...verdict, tool: this.composableBuilder.resolve(name) } : verdict;
            },
          }),
        );
      } catch {
        // CreateWorkflowTool module not available — skip.
      }

      try {
        const { SelfEvaluateTool } = await import('./SelfEvaluateTool.js');
        tools.push(
          new SelfEvaluateTool({
            config: {
              autoAdjust: selfConfig.selfEval.autoAdjust,
              adjustableParams: selfConfig.selfEval.adjustableParams,
              maxEvaluationsPerSession: selfConfig.selfEval.maxEvaluationsPerSession,
              evaluationModel: selfConfig.selfEval.evaluationModel,
            },
            adaptPersonality: adaptPersonalityTool,
            storeMemory: deps.storeMemory,
            getSessionParam: deps.getSessionParam,
            setSessionParam: deps.setSessionParam,
          }),
        );
      } catch {
        // SelfEvaluateTool module not available — skip.
      }
    } catch {
      // Outer catch for any unexpected dynamic import infrastructure failures.
    }

    return tools;
  }

  /**
   * Create an executable ITool wrapper for a forged emergent tool.
   *
   * The wrapper refuses a call to a tool that is not active and, for an
   * `agent`-tier tool, a call from any agent but its own, before anything
   * runs or a use is recorded; it then performs runtime output validation,
   * usage tracking, and promotion checks after each successful execution.
   */
  createExecutableTool(tool: EmergentTool): EmergentExecutableTool {
    const baseTool =
      tool.implementation.mode === 'compose'
        ? this.composableBuilder.build(
            tool.name,
            tool.description,
            tool.inputSchema,
            tool.implementation
          )
        : this.buildSandboxExecutable(tool);

    return {
      id: `emergent-tool:${tool.id}`,
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      category: 'emergent',
      emergentMode: tool.implementation.mode,
      // A composition has side effects when one of its steps does (or is a
      // composition itself); each such step is then asked at the step (see
      // ToolOrchestrator), not at the composed call.
      hasSideEffects:
        tool.implementation.mode === 'sandbox' ||
        this.composableBuilder.hasSideEffectingStep(tool.implementation),
      execute: async (
        args: Record<string, unknown>,
        context: ToolExecutionContext
      ): Promise<ToolExecutionResult> => {
        // The registry no longer holds the tool (removed, or its session
        // cleaned up) while the executable is still registered: refuse, do
        // not run the captured code. This comes before the state check, which
        // reads "no state" as active.
        const current = this.registry.get(tool.id);
        if (!current) {
          return { success: false, error: `Emergent tool "${tool.name}" is no longer registered.` };
        }
        if (!this.registry.isActive(tool.id)) {
          const held = this.registry.getState(tool.id);
          return {
            success: false,
            error:
              `Emergent tool "${tool.name}" is ${held?.state ?? 'inactive'}: ` +
              `${held?.reason ?? 'no reason recorded'}.`,
          };
        }
        // The owner is the persona that forged the tool, compared as it was
        // stored ('unknown' for a caller without one). A row from an earlier
        // release holds the forging GMI instance's id instead, which no
        // persona can match; the loader suspends such a row (`legacy_owner`),
        // and a call to one held in memory is refused here like any other
        // owner mismatch.
        const owner = current.createdBy;
        const caller = context.personaId ?? 'unknown';
        if (current.tier === 'agent' && caller !== owner) {
          return {
            success: false,
            error: `Emergent tool "${tool.name}" belongs to agent ${owner}; it is not callable as ${caller}.`,
          };
        }
        // A composition already running further up this call reaches itself:
        // the call is refused before any step runs, and this composition is
        // suspended for the cycle. A long chain without a cycle is refused at
        // the depth limit (nesting_too_deep) and suspends nothing.
        let runContext = context;
        if (tool.implementation.mode === 'compose') {
          const chain = compositionChain(context);
          if (chain.includes(tool.id)) {
            await this.suspendAsLibrary(tool.id, 'step_cycle');
            return {
              success: false,
              error: `step_cycle: "${tool.name}" reaches itself at run time; it was suspended`,
              details: { code: 'step_cycle' },
            };
          }
          runContext = {
            ...context,
            sessionData: { ...(context.sessionData ?? {}), emergentChain: [...chain, tool.id] },
          };
        }
        const startTime = performance.now();
        const result = await baseTool.execute(args, runContext);
        const executionTimeMs = Math.round(performance.now() - startTime);

        // A step that can no longer be chained (its tool was removed or
        // replaced, or the chain reaches itself) suspends the composition
        // until a fitting tool is registered.
        const refused = (result.details as { code?: string } | undefined)?.code;
        const suspendFor = !result.success && refused ? RUN_REFUSAL_REASONS[refused] : undefined;
        if (suspendFor) {
          const suspended = await this.suspendAsLibrary(tool.id, suspendFor);
          const implementation = this.registry.get(tool.id)?.implementation ?? tool.implementation;
          if (suspended && (refused === 'step_replaced' || this.refusalFor(implementation, tool.name) === null)) {
            // The step's tool changed hands between its check and its run (the
            // gate's refusal; nothing ran), or a fitting tool was registered
            // before this suspension was held (it may have waited for an
            // admission of this tool). The registration ran before the
            // suspension existed, so it did not re-check this composition:
            // check it now against the tools registered now.
            try {
              await this.recheck(tool.id, false);
            } catch (recheckError: unknown) {
              console.warn(
                `[agentos:emergent] could not re-check "${tool.name}" (${tool.id}) after its step was refused:`,
                recheckError instanceof Error ? recheckError.message : recheckError,
              );
            }
          }
          return {
            success: false,
            output: result.output,
            error: result.error ?? 'A step of this composition can no longer be chained.',
            details: result.details,
            ...(result.effects ? { effects: result.effects } : {}),
          };
        }

        let success = result.success;
        let error = result.error;
        // Track whether the output passed schema validation separately from
        // execution success. A tool that executes but returns invalid output
        // should NOT be promoted — its confidence is unreliable.
        let validationPassed = true;

        if (success) {
          const reuseVerdict = this.judge.validateReuse(tool.id, result.output, tool.outputSchema);
          if (!reuseVerdict.valid) {
            success = false;
            validationPassed = false;
            error = `Output schema validation failed: ${reuseVerdict.schemaErrors.join('; ')}`;
          }
        }

        this.registry.recordUse(tool.id, args, result.output, success, executionTimeMs);

        // Only check promotion when execution succeeded AND output passed
        // validation. Promoting after validation failure would reward tools
        // that produce structurally invalid output.
        if (success && validationPassed) {
          await this.checkPromotion(tool.id);
        }

        return success
          ? result
          : {
              success: false,
              output: result.output,
              error: error ?? 'Emergent tool execution failed.',
              ...(result.details ? { details: result.details } : {}),
              ...(result.effects ? { effects: result.effects } : {}),
            };
      },
    };
  }

  // --------------------------------------------------------------------------
  // PRIVATE: indexTool
  // --------------------------------------------------------------------------

  /**
   * Add a tool ID to the session and agent indexes for fast future lookup.
   *
   * @param toolId - The tool ID to index.
   * @param agentId - The agent that created the tool.
   * @param sessionId - The session in which the tool was created.
   */
  private indexTool(toolId: string, agentId: string, sessionId: string): void {
    // Session index.
    if (!this.index.bySession.has(sessionId)) {
      this.index.bySession.set(sessionId, new Set());
    }
    this.index.bySession.get(sessionId)!.add(toolId);

    // Agent index.
    if (!this.index.byAgent.has(agentId)) {
      this.index.byAgent.set(agentId, new Set());
    }
    this.index.byAgent.get(agentId)!.add(toolId);
  }

  private removeIndexedTool(toolId: string, agentId: string, sessionId: string): void {
    this.index.bySession.get(sessionId)?.delete(toolId);
    this.index.byAgent.get(agentId)?.delete(toolId);
  }

  private removeIndexedToolEverywhere(toolId: string): void {
    for (const toolIds of this.index.bySession.values()) {
      toolIds.delete(toolId);
    }
    for (const toolIds of this.index.byAgent.values()) {
      toolIds.delete(toolId);
    }
  }

  private extractSessionId(source: string): string | null {
    return sessionFromSource(source);
  }

  private buildSandboxExecutable(tool: EmergentTool): ITool<Record<string, unknown>, unknown> {
    return {
      id: `sandboxed:${tool.id}`,
      name: tool.name,
      displayName: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      category: 'emergent',
      hasSideEffects: true,
      execute: async (
        args: Record<string, unknown>,
        context?: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        if (tool.implementation.mode !== 'sandbox') {
          return {
            success: false,
            error: 'Sandbox executor received a non-sandbox emergent tool.',
          };
        }

        const sandboxResult = await this.runSandboxed(tool.implementation, args, {
          toolId: tool.id,
          agentId: context?.personaId ?? 'unknown',
        });

        const effects = sandboxResult.effects ? { effects: sandboxResult.effects } : {};
        return sandboxResult.success
          ? { success: true, output: sandboxResult.output, ...effects }
          : { success: false, error: sandboxResult.error, ...effects };
      },
    };
  }

  /**
   * One run of forged code, as a forge test or a call. Under a ceiling the
   * run has its own call handle, which ends when the run does, however it
   * ends (it returns, throws or times out): the broker refuses capability
   * calls from then on, aborts the ones in flight, waits up to a second for
   * them, and hands back the run's effects. The handle is per run, so ending
   * one never touches a concurrent run of the same tool.
   */
  private async runSandboxed(
    implementation: SandboxedToolSpec,
    input: unknown,
    who: { toolId: string; agentId: string },
  ): Promise<SandboxExecutionResult & { effects?: ToolEffectRecord[] }> {
    const request = {
      code: implementation.code,
      input,
      allowlist: implementation.allowlist,
      memoryMB: this.config.sandboxMemoryMB,
      timeoutMs: this.config.sandboxTimeoutMs,
    };
    if (!this.broker) {
      return this.sandboxForge.execute(request);
    }
    const controller = new AbortController();
    const call: CallHandle = {
      id: randomUUID(),
      toolId: who.toolId,
      agentId: who.agentId,
      signal: controller.signal,
    };
    let result: SandboxExecutionResult;
    try {
      result = await this.sandboxForge.execute({ ...request, call });
    } catch (error: unknown) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        executionTimeMs: 0,
        memoryUsedBytes: 0,
      };
    }
    controller.abort();
    const effects = await this.broker.endCall(call.id);
    return effects.length > 0 ? { ...result, effects } : result;
  }
}
