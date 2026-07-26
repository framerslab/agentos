/**
 * @fileoverview EmergentToolRegistry — tiered lifecycle manager for emergent tools.
 * @module @framers/agentos/emergent/EmergentToolRegistry
 *
 * Manages the lifecycle of emergent tools across three trust tiers:
 *
 * - **Session tier**: In-memory `Map`, auto-cleaned when the session ends.
 *   Tools at this tier live only for the duration of the agent session. When a
 *   storage adapter is available they are also mirrored into SQLite for
 *   inspection/debugging and removed during session cleanup.
 *
 * - **Agent tier**: Persisted in SQLite via the `agentos_emergent_tools` table.
 *   Tools at this tier are scoped to the agent that created them and survive
 *   across sessions.
 *
 * - **Shared tier**: Same SQLite table, discoverable by all agents. Promotion
 *   to shared tier requires explicit human or system approval.
 *
 * All state changes are logged to an in-memory audit trail (and to the
 * `agentos_emergent_audit_log` table when a storage adapter is provided).
 *
 * The registry operates fully in-memory when no storage adapter is supplied,
 * making it suitable for testing and ephemeral agents.
 */

import { randomUUID } from 'node:crypto';
import type {
  EmergentTool,
  SandboxAPI,
  ToolTier,
  ToolUsageStats,
  EmergentConfig,
} from './types.js';
import { DEFAULT_EMERGENT_CONFIG } from './types.js';

// ============================================================================
// STORAGE ADAPTER INTERFACE
// ============================================================================

/**
 * Minimal storage adapter interface for SQLite persistence.
 *
 * The registry uses this abstraction so it can work with any SQLite driver
 * (better-sqlite3, sql.js, Drizzle raw, etc.) without taking a hard dependency.
 * All methods are async to support both sync and async driver wrappers.
 */
export interface IStorageAdapter {
  /**
   * Execute a single SQL statement that does not return rows.
   * Used for INSERT, UPDATE, DELETE, and DDL statements.
   *
   * @param sql - The SQL statement to execute.
   * @param params - Optional positional parameters bound to `?` placeholders.
   */
  run(sql: string, params?: unknown[]): Promise<unknown>;

  /**
   * Execute a single SQL query and return the first matching row.
   *
   * @param sql - The SQL SELECT statement.
   * @param params - Optional positional parameters bound to `?` placeholders.
   * @returns The first row as a plain object, or `undefined` if no rows match.
   */
  get(sql: string, params?: unknown[]): Promise<unknown>;

  /**
   * Execute a single SQL query and return all matching rows.
   *
   * @param sql - The SQL SELECT statement.
   * @param params - Optional positional parameters bound to `?` placeholders.
   * @returns An array of plain objects, one per matching row.
   */
  all(sql: string, params?: unknown[]): Promise<unknown[]>;

  /**
   * Execute a raw SQL string containing one or more statements.
   * Used for schema DDL (CREATE TABLE, CREATE INDEX).
   * Not all adapters support this — the registry falls back to `run()` if absent.
   *
   * @param sql - The raw SQL string to execute.
   */
  exec?(sql: string): Promise<void>;

  /**
   * Run `fn` atomically. The adapter passes a transaction-scoped runner with
   * the same run/get/all shape; a throw inside `fn` rolls the whole unit
   * back. Optional — consumers that require atomicity (e.g.
   * `PersonalityMutationStore.decayForAgent`) must check for it and fail
   * with a descriptive error when absent (spec batch-1 C6).
   */
  transaction?<T>(
    fn: (tx: Pick<IStorageAdapter, 'run' | 'get' | 'all'>) => Promise<T>,
  ): Promise<T>;
}

// ============================================================================
// AUDIT LOG ENTRY
// ============================================================================

/**
 * A single entry in the emergent tool audit trail.
 *
 * Audit entries record every significant state change: registration, promotion,
 * demotion, usage recording, and session cleanup. They are stored both in-memory
 * and (when a storage adapter is provided) in the `agentos_emergent_audit_log`
 * SQLite table.
 */
export interface AuditEntry {
  /** Unique identifier for this audit entry. */
  id: string;
  /** The tool ID this event pertains to. */
  toolId: string;
  /** Machine-readable event type (e.g., `'register'`, `'promote'`, `'demote'`). */
  eventType: string;
  /** Optional structured data associated with the event. */
  data?: unknown;
  /** Unix epoch millisecond timestamp of when the event occurred. */
  timestamp: number;
}

type PersistedSandboxMetadata = {
  redacted: true;
  reason: 'sandbox-source-not-persisted';
  allowlist: SandboxAPI[];
  codeBytes: number;
};

// ============================================================================
// TIER ORDER
// ============================================================================

/**
 * Tier ordering used for promotion validation.
 * Higher index = broader scope = higher trust.
 */
const TIER_ORDER: readonly ToolTier[] = ['session', 'agent', 'shared'];

// ============================================================================
// EMERGENT TOOL REGISTRY
// ============================================================================

/**
 * Manages the lifecycle of emergent tools across three trust tiers.
 *
 * The registry stores session-tier tools in an in-memory Map (keyed by tool ID)
 * and mirrors them to SQLite when available for audit/inspection. Agent/shared
 * tier tools live in the persisted map and are written to SQLite (when a
 * storage adapter is provided) or kept in-memory as fallback.
 *
 * Key responsibilities:
 * - **Registration**: Accept new tools at a given tier, enforcing config limits.
 * - **Lookup**: Retrieve tools by ID or filter by tier with optional scope.
 * - **Usage tracking**: Record invocations and update rolling statistics.
 * - **Promotion / demotion**: Move tools between tiers with audit logging.
 * - **Session cleanup**: Bulk-remove all session-scoped tools for a given session.
 * - **Audit trail**: Log every state change for observability and debugging.
 *
 * @example
 * ```ts
 * const registry = new EmergentToolRegistry({ ...DEFAULT_EMERGENT_CONFIG, enabled: true });
 * registry.register(tool, 'session');
 * registry.recordUse(tool.id, { x: 1 }, { y: 2 }, true, 42);
 * const stats = registry.getUsageStats(tool.id);
 * ```
 */
export class EmergentToolRegistry {
  /** In-memory store for session-tier tools, keyed by tool ID. */
  private readonly sessionTools = new Map<string, EmergentTool>();

  /** In-memory store for agent/shared-tier tools when no DB is available. */
  private readonly persistedTools = new Map<string, EmergentTool>();

  /** In-memory audit log. Always populated regardless of DB availability. */
  private readonly auditLog: AuditEntry[] = [];

  /** Resolved configuration, merged with defaults. */
  private readonly config: EmergentConfig;

  /** Optional SQLite storage adapter for agent/shared tier persistence. */
  private readonly db?: IStorageAdapter;

  /** Whether `ensureSchema()` has been called and completed. */
  private schemaReady = false;

  /**
   * Cached promise from the first `ensureSchemaReady()` call.
   * Guards against the race condition where multiple callers invoke
   * `ensureSchema()` concurrently — without this, the second caller could
   * start DB operations before the first's DDL statements finish.
   */
  private schemaReadyPromise: Promise<void> | null = null;

  /**
   * Create a new EmergentToolRegistry.
   *
   * @param config - Emergent capability configuration. Missing fields are
   *   filled from {@link DEFAULT_EMERGENT_CONFIG}.
   * @param db - Optional SQLite storage adapter. When provided, agent and
   *   shared tier tools are persisted to the `agentos_emergent_tools` table.
   *   When omitted, all tiers use in-memory storage only.
   */
  constructor(config: Partial<EmergentConfig> = {}, db?: IStorageAdapter) {
    this.config = { ...DEFAULT_EMERGENT_CONFIG, ...config };
    this.db = db;
  }

  // --------------------------------------------------------------------------
  // SCHEMA
  // --------------------------------------------------------------------------

  /**
   * Idempotent schema readiness guard.
   *
   * Ensures `ensureSchema()` is called exactly once and all subsequent callers
   * await the same in-flight promise. This prevents the race condition where
   * concurrent DB operations start before DDL statements finish.
   *
   * @returns A promise that resolves when the schema is ready.
   */
  async ensureSchemaReady(): Promise<void> {
    if (!this.schemaReadyPromise) {
      this.schemaReadyPromise = this.ensureSchema();
    }
    return this.schemaReadyPromise;
  }

  /**
   * Initialize the database schema for emergent tool persistence.
   *
   * Creates the `agentos_emergent_tools` and `agentos_emergent_audit_log`
   * tables along with their indexes. Safe to call multiple times — all
   * statements use `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS`.
   *
   * This method is a no-op when no storage adapter was provided.
   *
   * @throws If the storage adapter's `exec` or `run` method rejects.
   */
  async ensureSchema(): Promise<void> {
    if (!this.db || this.schemaReady) {
      return;
    }

    const toolsTable = `
CREATE TABLE IF NOT EXISTS agentos_emergent_tools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  input_schema TEXT NOT NULL,
  output_schema TEXT,
  implementation_mode TEXT NOT NULL,
  implementation_source TEXT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'session',
  created_by_agent TEXT NOT NULL,
  created_by_session TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  promoted_at BIGINT,
  promoted_by TEXT,
  judge_verdicts TEXT,
  confidence_score REAL DEFAULT 0,
  total_uses INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  avg_execution_ms REAL DEFAULT 0,
  last_used_at BIGINT,
  is_active INTEGER DEFAULT 1
);`;

    const toolsTierIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_tools_tier ON agentos_emergent_tools(tier, is_active);`;
    const toolsAgentIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_tools_agent ON agentos_emergent_tools(created_by_agent, tier);`;

    const auditTable = `
CREATE TABLE IF NOT EXISTS agentos_emergent_audit_log (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_data TEXT,
  timestamp BIGINT NOT NULL
);`;

    const auditIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_audit_tool ON agentos_emergent_audit_log(tool_id, timestamp);`;

    // Prefer `exec` for multi-statement DDL; fall back to individual `run` calls.
    if (this.db.exec) {
      await this.db.exec(
        [toolsTable, toolsTierIndex, toolsAgentIndex, auditTable, auditIndex].join('\n'),
      );
    } else {
      await this.db.run(toolsTable);
      await this.db.run(toolsTierIndex);
      await this.db.run(toolsAgentIndex);
      await this.db.run(auditTable);
      await this.db.run(auditIndex);
    }

    this.schemaReady = true;
  }

  // --------------------------------------------------------------------------
  // REGISTER
  // --------------------------------------------------------------------------

  /**
   * Register a new emergent tool at the given tier.
   *
   * Session-tier tools are stored in the in-memory session map and mirrored to
   * SQLite when available. Agent and shared tier tools are stored in the
   * persisted map (and written to SQLite when a storage adapter is available).
   *
   * @param tool - The emergent tool to register. Must have a unique `id`.
   * @param tier - The tier to register the tool at. The tool's `tier` property
   *   is updated to match.
   *
   * @throws {Error} If the maximum tool count for the target tier is exceeded
   *   (checked against `maxSessionTools` or `maxAgentTools` from config).
   * @throws {Error} If a tool with the same ID is already registered.
   */
  register(tool: EmergentTool, tier: ToolTier): void {
    // Check for duplicates across all stores.
    if (this.sessionTools.has(tool.id) || this.persistedTools.has(tool.id)) {
      throw new Error(`Tool "${tool.id}" is already registered.`);
    }

    // Enforce tier-specific limits.
    if (tier === 'session') {
      const sessionCount = this.sessionTools.size;
      if (sessionCount >= this.config.maxSessionTools) {
        throw new Error(
          `Session tool limit reached (${this.config.maxSessionTools}). ` +
          `Remove or promote existing tools before registering new ones.`,
        );
      }
    } else if (tier === 'agent') {
      const agentCount = this.getByTier('agent').length;
      if (agentCount >= this.config.maxAgentTools) {
        throw new Error(
          `Agent tool limit reached (${this.config.maxAgentTools}). ` +
          `Remove or promote existing tools before registering new ones.`,
        );
      }
    }

    // Stamp the tier on the tool object.
    const registered: EmergentTool = { ...tool, tier };

    if (tier === 'session') {
      this.sessionTools.set(registered.id, registered);
    } else {
      this.persistedTools.set(registered.id, registered);
    }

    if (this.db && this.schemaReady) {
      this.persistToolToDb(registered).catch(() => {
        // Best-effort persistence mirror. In-memory state remains authoritative.
      });
    }

    this.logAudit(registered.id, 'register', { tier });
  }

  // --------------------------------------------------------------------------
  // GET
  // --------------------------------------------------------------------------

  /**
   * Retrieve a tool by its unique identifier.
   *
   * Searches all tiers (session first, then persisted agent/shared).
   *
   * @param toolId - The tool ID to look up.
   * @returns The tool if found, or `undefined` if no tool with that ID exists.
   */
  get(toolId: string): EmergentTool | undefined {
    return this.sessionTools.get(toolId) ?? this.persistedTools.get(toolId);
  }

  /**
   * Upsert a tool into the registry, replacing any prior in-memory copy.
   *
   * Used to hydrate persisted/shared tools back into a live runtime so they can
   * become executable again after process restart or admin promotion.
   */
  upsert(tool: EmergentTool): void {
    this.sessionTools.delete(tool.id);
    this.persistedTools.delete(tool.id);

    const normalized: EmergentTool = { ...tool };
    if (normalized.tier === 'session') {
      this.sessionTools.set(normalized.id, normalized);
    } else {
      this.persistedTools.set(normalized.id, normalized);
    }

    if (this.db && this.schemaReady) {
      this.persistToolToDb(normalized).catch(() => {
        // Best-effort persistence mirror only.
      });
    }

    this.logAudit(normalized.id, 'sync', { tier: normalized.tier });
  }

  /**
   * Remove a tool from the registry entirely.
   *
   * Used to roll back newly forged tools when downstream activation fails.
   */
  remove(toolId: string): boolean {
    const removed =
      this.sessionTools.delete(toolId) || this.persistedTools.delete(toolId);

    if (removed) {
      if (this.db && this.schemaReady) {
        this.db
          .run(`DELETE FROM agentos_emergent_tools WHERE id = ?`, [toolId])
          .catch(() => {
            // Best-effort cleanup only.
          });
      }
      this.logAudit(toolId, 'remove');
    }

    return removed;
  }

  // --------------------------------------------------------------------------
  // GET BY TIER
  // --------------------------------------------------------------------------

  /**
   * Get all tools registered at a specific tier, optionally filtered by scope.
   *
   * @param tier - The tier to query (`'session'`, `'agent'`, or `'shared'`).
   * @param scope - Optional scope filter. When provided, results are narrowed:
   *   - `sessionId`: Match tools whose `source` string contains the session ID.
   *   - `agentId`: Match tools whose `createdBy` equals the agent ID.
   * @returns An array of matching tools (may be empty).
   */
  getByTier(
    tier: ToolTier,
    scope?: { sessionId?: string; agentId?: string },
  ): EmergentTool[] {
    let tools: EmergentTool[];

    if (tier === 'session') {
      tools = Array.from(this.sessionTools.values());
    } else {
      tools = Array.from(this.persistedTools.values()).filter(
        (t) => t.tier === tier,
      );
    }

    // Apply optional scope filters.
    if (scope?.sessionId) {
      const sid = scope.sessionId;
      tools = tools.filter((t) => t.source.includes(sid));
    }
    if (scope?.agentId) {
      const aid = scope.agentId;
      tools = tools.filter((t) => t.createdBy === aid);
    }

    return tools;
  }

  // --------------------------------------------------------------------------
  // RECORD USE
  // --------------------------------------------------------------------------

  /**
   * Record a tool invocation, updating rolling usage statistics.
   *
   * Updates the tool's {@link ToolUsageStats} in place:
   * - Increments `totalUses`.
   * - Increments `successCount` or `failureCount` based on the `success` flag.
   * - Recalculates `avgExecutionTimeMs` as a running average.
   * - Recalculates `confidenceScore` as `successCount / totalUses`.
   * - Sets `lastUsedAt` to the current ISO-8601 timestamp.
   *
   * @param toolId - The ID of the tool that was invoked.
   * @param _input - The input arguments passed to the tool (logged for audit).
   * @param _output - The output returned by the tool (logged for audit).
   * @param success - Whether the invocation completed successfully.
   * @param executionTimeMs - Wall-clock execution time in milliseconds.
   *
   * @throws {Error} If no tool with the given ID is registered.
   */
  recordUse(
    toolId: string,
    _input: unknown,
    _output: unknown,
    success: boolean,
    executionTimeMs: number,
  ): void {
    const tool = this.get(toolId);
    if (!tool) {
      throw new Error(`Cannot record use: tool "${toolId}" not found.`);
    }

    const stats = tool.usageStats;
    const prevTotal = stats.totalUses;

    stats.totalUses += 1;

    if (success) {
      stats.successCount += 1;
    } else {
      stats.failureCount += 1;
    }

    // Running average: newAvg = (oldAvg * prevTotal + newValue) / newTotal
    stats.avgExecutionTimeMs =
      (stats.avgExecutionTimeMs * prevTotal + executionTimeMs) / stats.totalUses;

    // Confidence is success rate.
    stats.confidenceScore = stats.successCount / stats.totalUses;

    stats.lastUsedAt = new Date().toISOString();

    if (this.db && this.schemaReady) {
      this.persistToolToDb(tool).catch(() => {
        // Best-effort persistence mirror. Usage stats still live in memory.
      });
    }

    this.logAudit(toolId, 'use', { success, executionTimeMs });
  }

  // --------------------------------------------------------------------------
  // GET USAGE STATS
  // --------------------------------------------------------------------------

  /**
   * Retrieve usage statistics for a registered tool.
   *
   * @param toolId - The tool ID to look up.
   * @returns The tool's {@link ToolUsageStats}, or `undefined` if the tool
   *   is not registered.
   */
  getUsageStats(toolId: string): ToolUsageStats | undefined {
    return this.get(toolId)?.usageStats;
  }

  // --------------------------------------------------------------------------
  // PROMOTE
  // --------------------------------------------------------------------------

  /**
   * Promote a tool to a higher lifecycle tier.
   *
   * Moves the tool from its current tier to `targetTier`. If the tool was at
   * session tier, it is removed from the session map and added to the persisted
   * map. If a storage adapter is available and the target tier is agent or
   * shared, the tool is persisted to the database.
   *
   * @param toolId - The ID of the tool to promote.
   * @param targetTier - The target tier to promote to. Must be strictly higher
   *   than the tool's current tier.
   * @param approvedBy - Optional identifier of the human or system entity that
   *   approved the promotion.
   *
   * @throws {Error} If the tool is not found.
   * @throws {Error} If `targetTier` is not higher than the tool's current tier.
   */
  async promote(
    toolId: string,
    targetTier: ToolTier,
    approvedBy?: string,
  ): Promise<void> {
    const tool = this.get(toolId);
    if (!tool) {
      throw new Error(`Cannot promote: tool "${toolId}" not found.`);
    }

    const currentIndex = TIER_ORDER.indexOf(tool.tier);
    const targetIndex = TIER_ORDER.indexOf(targetTier);

    if (targetIndex <= currentIndex) {
      throw new Error(
        `Cannot promote tool from "${tool.tier}" to "${targetTier}": ` +
        `target tier must be strictly higher than current tier.`,
      );
    }

    const previousTier = tool.tier;

    // If moving from session to a persisted tier, migrate between maps.
    if (previousTier === 'session') {
      this.sessionTools.delete(toolId);
      tool.tier = targetTier;
      this.persistedTools.set(toolId, tool);
    } else {
      tool.tier = targetTier;
    }

    // Persist to DB if adapter is available and target is a persisted tier.
    if (this.db && this.schemaReady) {
      await this.persistToolToDb(tool, approvedBy);
    }

    this.logAudit(toolId, 'promote', {
      from: previousTier,
      to: targetTier,
      approvedBy: approvedBy ?? null,
    });
  }

  // --------------------------------------------------------------------------
  // DEMOTE
  // --------------------------------------------------------------------------

  /**
   * Demote or deactivate a tool.
   *
   * Marks the tool as inactive by setting a sentinel on its usage stats
   * (`confidenceScore` set to 0) and logs the demotion event with a reason.
   *
   * Inactive tools are still retrievable via `get()` but should be filtered
   * out by callers when building tool lists for the LLM.
   *
   * @param toolId - The ID of the tool to demote.
   * @param reason - Human-readable explanation for why the tool is being demoted.
   *
   * @throws {Error} If the tool is not found.
   */
  demote(toolId: string, reason: string): void {
    const tool = this.get(toolId);
    if (!tool) {
      throw new Error(`Cannot demote: tool "${toolId}" not found.`);
    }

    tool.usageStats.confidenceScore = 0;
    // Mark as inactive via a convention property.
    (tool as EmergentTool & { isActive?: boolean }).isActive = false;

    if (this.db && this.schemaReady) {
      this.db
        .run(`UPDATE agentos_emergent_tools SET is_active = 0 WHERE id = ?`, [toolId])
        .catch(() => {
          // Best-effort persistence only.
        });
    }

    this.logAudit(toolId, 'demote', { reason });
  }

  // --------------------------------------------------------------------------
  // CLEANUP SESSION
  // --------------------------------------------------------------------------

  /**
   * Remove all session-tier tools associated with a specific session.
   *
   * Iterates the session map and deletes every tool whose `source` string
   * contains the given session ID. Logs a cleanup audit event for each
   * removed tool.
   *
   * @param sessionId - The session identifier to match against tool `source`
   *   strings.
   * @returns The number of tools removed.
   */
  cleanupSession(sessionId: string): number {
    let removedCount = 0;

    for (const [id, tool] of this.sessionTools) {
      if (tool.source.includes(sessionId)) {
        this.sessionTools.delete(id);
        if (this.db && this.schemaReady) {
          this.db
            .run(`DELETE FROM agentos_emergent_tools WHERE id = ?`, [id])
            .catch(() => {
              // Best-effort cleanup only.
            });
        }
        this.logAudit(id, 'cleanup', { sessionId });
        removedCount += 1;
      }
    }

    return removedCount;
  }

  // --------------------------------------------------------------------------
  // AUDIT LOG ACCESSORS
  // --------------------------------------------------------------------------

  /**
   * Retrieve audit log entries, optionally filtered by tool ID.
   *
   * @param toolId - When provided, only entries for this tool are returned.
   * @returns An array of {@link AuditEntry} objects in chronological order.
   */
  getAuditLog(toolId?: string): AuditEntry[] {
    if (toolId) {
      return this.auditLog.filter((e) => e.toolId === toolId);
    }
    return [...this.auditLog];
  }

  // --------------------------------------------------------------------------
  // PRIVATE: logAudit
  // --------------------------------------------------------------------------

  /**
   * Log an audit event to both the in-memory trail and (optionally) the database.
   *
   * @param toolId - The tool this event pertains to.
   * @param eventType - Machine-readable event type string.
   * @param data - Optional structured data to attach to the event.
   */
  private logAudit(toolId: string, eventType: string, data?: unknown): void {
    const entry: AuditEntry = {
      id: randomUUID(),
      toolId,
      eventType,
      data,
      timestamp: Date.now(),
    };

    this.auditLog.push(entry);

    // Best-effort DB write — do not await or throw if it fails.
    if (this.db && this.schemaReady) {
      this.db
        .run(
          `INSERT INTO agentos_emergent_audit_log (id, tool_id, event_type, event_data, timestamp)
           VALUES (?, ?, ?, ?, ?)`,
          [
            entry.id,
            entry.toolId,
            entry.eventType,
            data != null ? JSON.stringify(data) : null,
            entry.timestamp,
          ],
        )
        .catch(() => {
          // Swallow DB write errors for audit logs — the in-memory log is
          // the authoritative source and we should not disrupt the caller.
        });
    }
  }

  // --------------------------------------------------------------------------
  // PRIVATE: persistToolToDb
  // --------------------------------------------------------------------------

  /**
   * Upsert a tool record into the `agentos_emergent_tools` SQLite table.
   *
   * Uses INSERT OR REPLACE to handle both initial persistence and updates
   * after promotion.
   *
   * @param tool - The emergent tool to persist.
   * @param approvedBy - Optional identifier of the promotion approver.
   */
  private async persistToolToDb(
    tool: EmergentTool,
    approvedBy?: string,
  ): Promise<void> {
    if (!this.db) {
      return;
    }

    // Guard: ensure the schema DDL has completed before any DML.
    // Without this, a race between the fire-and-forget mirror write in
    // register() and a slow ensureSchema() could produce "table not found".
    await this.ensureSchemaReady();

    // Extract the session ID from the source string if present.
    const sessionMatch = tool.source.match(/session\s+([\w-]+)/);
    const sessionId = sessionMatch?.[1] ?? 'unknown';

    let promotedAt: number | null = null;
    let promotedBy: string | null = approvedBy ?? null;

    if (tool.tier !== 'session') {
      const existing =
        ((await this.db.get(
          `SELECT promoted_at, promoted_by
             FROM agentos_emergent_tools
            WHERE id = ?
            LIMIT 1`,
          [tool.id],
        )) as
          | {
              promoted_at?: number | null;
              promoted_by?: string | null;
            }
          | undefined) ?? { promoted_at: null, promoted_by: null };

      promotedAt =
        approvedBy != null
          ? Date.now()
          : typeof existing.promoted_at === 'number'
            ? existing.promoted_at
            : Date.now();
      promotedBy =
        approvedBy ??
        (existing.promoted_by != null ? String(existing.promoted_by) : null);
    }

    const implementationSource =
      tool.implementation.mode === 'sandbox'
        ? this.serializeSandboxImplementation(tool)
        : JSON.stringify(tool.implementation);

    await this.db.run(
      `INSERT OR REPLACE INTO agentos_emergent_tools
       (id, name, description, input_schema, output_schema, implementation_mode,
        implementation_source, tier, created_by_agent, created_by_session,
        created_at, promoted_at, promoted_by, judge_verdicts, confidence_score,
        total_uses, success_count, failure_count, avg_execution_ms, last_used_at,
        is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tool.id,
        tool.name,
        tool.description,
        JSON.stringify(tool.inputSchema),
        JSON.stringify(tool.outputSchema),
        tool.implementation.mode,
        implementationSource,
        tool.tier,
        tool.createdBy,
        sessionId,
        new Date(tool.createdAt).getTime(),
        promotedAt,
        promotedBy,
        JSON.stringify(tool.judgeVerdicts),
        tool.usageStats.confidenceScore,
        tool.usageStats.totalUses,
        tool.usageStats.successCount,
        tool.usageStats.failureCount,
        tool.usageStats.avgExecutionTimeMs,
        tool.usageStats.lastUsedAt
          ? new Date(tool.usageStats.lastUsedAt).getTime()
          : null,
        1,
      ],
    );
  }

  private serializeSandboxImplementation(tool: EmergentTool): string {
    if (tool.implementation.mode !== 'sandbox') {
      return JSON.stringify(tool.implementation);
    }

    if (this.config.persistSandboxSource) {
      return tool.implementation.code;
    }

    const metadata: PersistedSandboxMetadata = {
      redacted: true,
      reason: 'sandbox-source-not-persisted',
      allowlist: [...tool.implementation.allowlist],
      codeBytes: Buffer.byteLength(tool.implementation.code, 'utf8'),
    };

    return JSON.stringify(metadata);
  }
}
