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
  ToolImplementation,
  ToolState,
  ToolStateRecord,
  ToolTier,
} from './types.js';
import {
  parsePersistedSource,
  parseRowSchemas,
  parseStoredRequest,
  requestFromImplementation,
  requestFromSource,
  sourceFromImplementation,
  stateSetterFromColumn,
  toolFromRow,
  type PersistedSource,
} from './persisted-source.js';
import { normalizeAllowlist, toSandboxApis } from './capabilities.js';
import type { ToolCandidate } from './EmergentJudge.js';
import type { ITool, ToolExecutionContext, ToolExecutionResult } from '../../core/tools/ITool.js';
import type { PersonalityMutationStore } from './PersonalityMutationStore.js';
import type { AdaptPersonalityTool } from './AdaptPersonalityTool.js';
import { ComposableToolBuilder } from './ComposableToolBuilder.js';
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
  buildTool: (implementation: ToolImplementation) => EmergentTool;
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

  /** Sandboxed code executor for arbitrary-code implementations. */
  sandboxForge: SandboxedToolForge;

  /** LLM-as-judge evaluator for creation and promotion reviews. */
  judge: EmergentJudge;

  /** Tiered registry for storing and querying emergent tools. */
  registry: EmergentToolRegistry;

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

  /** Internal index for fast session/agent → tool lookups. */
  private readonly index: ToolIndex = {
    bySession: new Map(),
    byAgent: new Map(),
  };

  /**
   * Create a new EmergentCapabilityEngine.
   *
   * @param deps - All collaborator dependencies. See {@link EmergentCapabilityEngineDeps}.
   */
  constructor(deps: EmergentCapabilityEngineDeps) {
    this.config = deps.config;
    this.composableBuilder = deps.composableBuilder;
    this.sandboxForge = deps.sandboxForge;
    this.judge = deps.judge;
    this.registry = deps.registry;
    this.onToolForged = deps.onToolForged;
    this.onToolPromoted = deps.onToolPromoted;
    this.onToolRemoved = deps.onToolRemoved;
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
   * @param context - Caller context containing the agent and session IDs.
   * @returns A {@link ForgeResult} indicating success or failure.
   */
  async forge(
    request: ForgeToolRequest,
    context: { agentId: string; sessionId: string }
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

      // Build the composable tool so we can execute test cases against it.
      const composedTool = this.composableBuilder.build(
        request.name,
        request.description,
        request.inputSchema,
        request.implementation
      );

      // Run every declared test case.
      const mockContext: ToolExecutionContext = {
        gmiId: context.agentId,
        personaId: 'emergent-forge',
        userContext: { userId: 'system' } as any,
        correlationId: context.sessionId,
      };

      for (const tc of request.testCases) {
        try {
          const result = await composedTool.execute(
            tc.input as Record<string, unknown>,
            mockContext
          );
          testResults.push({
            input: tc.input,
            output: result.output,
            success: result.success,
            error: result.error,
          });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          testResults.push({
            input: tc.input,
            output: undefined,
            success: false,
            error: message,
          });
        }
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

      // Step 2b: Static code validation before any execution.
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

      // Step 3: Execute test cases in the sandbox.
      for (const tc of request.testCases) {
        const sandboxResult = await this.sandboxForge.execute({
          code: request.implementation.code,
          input: tc.input,
          allowlist: request.implementation.allowlist,
          memoryMB: this.config.sandboxMemoryMB,
          timeoutMs: this.config.sandboxTimeoutMs,
        });

        testResults.push({
          input: tc.input,
          output: sandboxResult.output,
          success: sandboxResult.success,
          error: sandboxResult.error,
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
      try {
        await this.registry.setState(toolId, 'active', null, {
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
      this.indexTool(toolId, context.agentId, context.sessionId);

      if (this.onToolForged) {
        try {
          await this.onToolForged(tool, this.createExecutableTool(tool));
        } catch (error: unknown) {
          this.registry.remove(toolId);
          this.removeIndexedTool(toolId, context.agentId, context.sessionId);
          return {
            success: false,
            error: error instanceof Error ? error.message : 'Failed to activate forged tool.',
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

    // Only session-tier tools are eligible for auto-promotion.
    if (tool.tier !== 'session') {
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
   * method and clears the local session index.
   *
   * @param sessionId - The session identifier to clean up.
   */
  cleanupSession(sessionId: string): EmergentTool[] {
    const removedTools = this.getSessionTools(sessionId);
    this.registry.cleanupSession(sessionId);
    this.index.bySession.delete(sessionId);
    return removedTools;
  }

  /**
   * Hydrate one stored tool and make it executable.
   *
   * @deprecated Use {@link loadPersistedTools}, which reads the rows itself.
   * This applies the same checks to the one tool: a suspended or demoted tool
   * is not registered, and a tool whose source cannot be rebuilt is suspended.
   * When the tool has a stored row, that row is what is read, not the object
   * passed in (a host-built object can carry a list the host made up). The row
   * is never rewritten.
   *
   * @returns what happened, so a host can tell a registered tool from a refused one.
   */
  async syncPersistedTool(tool: EmergentTool): Promise<LoadedToolOutcome> {
    const row = await this.registry.loadRow(tool.id);
    if (row) {
      return this.admitRow(row);
    }
    const stored = await this.registry.readState(tool.id);
    return this.admit({
      toolId: tool.id,
      name: tool.name,
      source: sourceFromImplementation(tool.implementation),
      stored,
      requestStored: stored?.request != null,
      legacyActive: (tool as EmergentTool & { isActive?: boolean }).isActive ?? true,
      buildTool: () => tool,
    });
  }

  /**
   * Remove a previously synced tool from the live runtime and registry.
   */
  async removeTool(toolId: string): Promise<EmergentTool | undefined> {
    const tool = this.registry.get(toolId);
    if (!tool) {
      return undefined;
    }

    this.registry.remove(toolId);
    this.removeIndexedToolEverywhere(toolId);
    if (this.onToolRemoved) {
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
   * other agent (see {@link createExecutableTool}).
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
    const rows = await this.registry.loadRows(tiers, { agentId, sessionId });
    const outcomes: LoadedToolOutcome[] = [];
    const failed: FailedToolLoad[] = [];
    for (const row of rows) {
      try {
        outcomes.push(await this.admitRow(row));
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ toolId: row.id, name: row.name, error: message });
        console.warn(`[agentos:emergent] stored tool "${row.name}" (${row.id}) did not load: ${message}`);
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
    const row = await this.registry.loadRow(toolId);
    if (row) {
      return this.admitRow(row, { force: true });
    }
    const tool = this.registry.get(toolId);
    if (!tool) {
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
        buildTool: () => tool,
      },
      { force: true },
    );
  }

  private admitRow(
    row: PersistedToolRow,
    options: { force?: boolean; readmitted?: boolean } = {},
  ): Promise<LoadedToolOutcome> {
    const stored: ToolStateRecord | undefined = row.state
      ? {
          toolId: row.id,
          state: row.state,
          reason: row.state_reason ?? null,
          setBy: stateSetterFromColumn(row.set_by),
          at: Number(row.state_at ?? 0),
          request: parseStoredRequest(row.request_json),
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
    return this.admit(
      {
        toolId: row.id,
        name: row.name,
        source,
        stored,
        requestStored: row.request_json != null,
        legacyActive: !(row.is_active === 0 || row.is_active === false),
        buildTool: (implementation) => toolFromRow(row, implementation),
      },
      options,
    );
  }

  /**
   * The single-row path. Every stored tool goes through it, whether the
   * library read its row or a host built the tool from its own.
   */
  private async admit(
    candidate: AdmissionCandidate,
    options: { force?: boolean; readmitted?: boolean } = {},
  ): Promise<LoadedToolOutcome> {
    const { toolId, name, source, stored, legacyActive, requestStored } = candidate;
    // The request this process works with: the stored one when it can be read,
    // else one derived from the source. It is written to the row only when the
    // row holds none; a stored request this release cannot read stays as it is.
    const request = stored?.request ?? requestFromSource(source);
    const requestToWrite = requestStored ? undefined : request;

    // 1. A tool a host turned off stays off. A row with is_active = 0 and no
    //    suspension on record was turned off by a host (its own SQL, or
    //    demote()); loading never undoes that, so it is recorded as the host's.
    const hostTurnedOff = !legacyActive && stored?.state !== 'suspended';
    if ((stored?.state === 'demoted' || hostTurnedOff) && !options.force) {
      const reason = stored?.state === 'demoted' ? stored.reason : 'legacy_inactive';
      if (stored?.state === 'demoted') {
        this.holdStored(toolId, stored);
      } else {
        await this.registry.setState(toolId, 'demoted', 'legacy_inactive', {
          request: requestToWrite,
          setBy: 'host',
        });
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
      source.format === 'raw-code' &&
      request?.kind === 'sandbox'
    ) {
      // The request is what the tool was granted. For a raw-code row the
      // code's text was read only to derive a request where none was stored;
      // a stored request says what the code may reach whatever its text shows.
      implementation = { ...implementation, allowlist: toSandboxApis(request.capabilities) };
    }
    if (implementation && !refusal) {
      refusal = this.refusalFor(implementation);
    }

    if (refusal || !implementation) {
      const reason = refusal ?? 'source_unreadable';
      // Written as the library's even when a host's suspension already carries
      // the same words, so a later load re-checks it (the words decide nothing).
      if (stored?.state !== 'suspended' || stored.reason !== reason || stored.setBy !== 'library') {
        await this.registry.setState(toolId, 'suspended', reason, {
          request: requestToWrite,
          setBy: 'library',
        });
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
      if (now && (now.state !== stored.state || now.setBy !== stored.setBy || now.at !== stored.at)) {
        written = now;
      }
    }
    // A suspension or demotion that arrived while the row was being written,
    // in this process or in another, is the newer word: the tool is not
    // registered. A restriction this process holds from an earlier read is
    // older than the row and gives way to it.
    const held = written && written.state !== 'active' ? written : this.newerRestrictionHeld(toolId, stored);
    if (held && held.state !== 'active') {
      this.holdStored(toolId, held);
      await this.unregisterIfLive(toolId);
      return { toolId, name, state: held.state, reason: held.reason };
    }
    // A first write refused by another process's active row: that row's
    // request is the grant, not the one derived here, so the tool is admitted
    // again from the row as it stands (once).
    if (
      written &&
      requestToWrite !== undefined &&
      !options.readmitted &&
      !sameGrant(written.request, requestToWrite)
    ) {
      const fresh = await this.registry.loadRow(toolId);
      if (fresh) {
        return this.admitRow(fresh, { ...options, readmitted: true });
      }
    }
    this.registry.adopt(tool, {
      toolId,
      state: 'active',
      reason: null,
      setBy: 'library',
      at: Date.now(),
      request,
    });
    this.indexTool(
      tool.id,
      tool.createdBy,
      this.extractSessionId(tool.source) ?? `persisted:${tool.id}`,
    );
    if (this.onToolForged) {
      await this.onToolForged(tool, this.createExecutableTool(tool));
    }
    return { toolId, name, state: 'active', reason: null };
  }

  /**
   * The library's reason for not running an implementation under the
   * configuration in force, or `null`. Later steps add their checks here, so
   * forging, loading and promotion all ask the same question.
   */
  private refusalFor(implementation: ToolImplementation): string | null {
    if (implementation.mode === 'sandbox' && implementation.code.trim() === '') {
      return 'source_not_persisted';
    }
    return null;
  }

  private async unregisterIfLive(toolId: string): Promise<void> {
    const live = this.registry.get(toolId);
    if (live && this.onToolRemoved) {
      await this.onToolRemoved(live);
    }
  }

  /**
   * A restriction this process holds that is newer than the row it just read:
   * its write is in flight, so the row does not yet show it.
   */
  private newerRestrictionHeld(toolId: string, stored: ToolStateRecord | undefined): ToolStateRecord | undefined {
    const memory = this.registry.getState(toolId);
    if (!memory || memory.state === 'active') {
      return undefined;
    }
    // At the row's own time the restriction is the later of the two: two
    // writes in one millisecond are told apart by nothing else.
    return !stored || memory.at >= stored.at ? memory : undefined;
  }

  /** A stored restriction, held in this process too when the tool is live here. */
  private holdStored(toolId: string, record: ToolStateRecord): void {
    const live = this.registry.get(toolId);
    if (live) {
      this.registry.adopt(live, record);
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
  createExecutableTool(tool: EmergentTool): ITool<Record<string, unknown>, unknown> {
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
      hasSideEffects: tool.implementation.mode === 'sandbox',
      execute: async (
        args: Record<string, unknown>,
        context: ToolExecutionContext
      ): Promise<ToolExecutionResult> => {
        if (!this.registry.isActive(tool.id)) {
          const held = this.registry.getState(tool.id);
          return {
            success: false,
            error:
              `Emergent tool "${tool.name}" is ${held?.state ?? 'inactive'}: ` +
              `${held?.reason ?? 'no reason recorded'}.`,
          };
        }
        const current = this.registry.get(tool.id) ?? tool;
        if (current.tier === 'agent' && context.gmiId !== current.createdBy) {
          return {
            success: false,
            error:
              `Emergent tool "${tool.name}" belongs to agent ${current.createdBy}; ` +
              `it is not callable by agent ${context.gmiId}.`,
          };
        }
        const startTime = performance.now();
        const result = await baseTool.execute(args, context);
        const executionTimeMs = Math.round(performance.now() - startTime);

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
    const match = /session\s+([A-Za-z0-9._:-]+)/i.exec(source);
    return match?.[1] ?? null;
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
      execute: async (args: Record<string, unknown>): Promise<ToolExecutionResult> => {
        if (tool.implementation.mode !== 'sandbox') {
          return {
            success: false,
            error: 'Sandbox executor received a non-sandbox emergent tool.',
          };
        }

        const sandboxResult = await this.sandboxForge.execute({
          code: tool.implementation.code,
          input: args,
          allowlist: tool.implementation.allowlist,
          memoryMB: this.config.sandboxMemoryMB,
          timeoutMs: this.config.sandboxTimeoutMs,
        });

        return sandboxResult.success
          ? { success: true, output: sandboxResult.output }
          : { success: false, error: sandboxResult.error };
      },
    };
  }
}
