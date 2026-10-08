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
  AllowlistName,
  ToolTier,
  ToolUsageStats,
  EmergentConfig,
  PersistedToolRow,
  StateSetter,
  StoredRequest,
  ToolState,
  ToolStateRecord,
} from './types.js';
import { DEFAULT_EMERGENT_CONFIG, GMI_INSTANCE_ID_PREFIX } from './types.js';
import { EffectsStore } from './EffectsStore.js';
import { parsePersistedSource, parseStoredRequest, sessionFromSource, stateSetterFromColumn } from './persisted-source.js';

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
  allowlist: AllowlistName[];
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
/** A state row as it is read back from storage. */
type StateRowRead = {
  state?: ToolState | null;
  state_reason?: string | null;
  set_by?: string | null;
  state_at?: number | string | null;
  request_json?: string | null;
  write_id?: string | null;
  /** Whether the tool row is still there; a removal deletes it before the state row. */
  tool_exists?: number | boolean | null;
};

const AUDIT_RING_SIZE = 1000;

export class EmergentToolRegistry {
  /** In-memory store for session-tier tools, keyed by tool ID. */
  private readonly sessionTools = new Map<string, EmergentTool>();

  /** In-memory store for agent/shared-tier tools when no DB is available. */
  private readonly persistedTools = new Map<string, EmergentTool>();

  /** In-memory audit log: the newest {@link AUDIT_RING_SIZE} entries, kept with or without storage. A log, never read for state. */
  private readonly auditLog: AuditEntry[] = [];

  /** Held state per tool. A tool with no entry counts as active. */
  private readonly states = new Map<string, ToolStateRecord>();

  /**
   * One chain of state writes per tool. A later `setState` starts its writes
   * after an earlier one's have finished, so storage sees state changes in
   * call order whatever the adapter's connections do.
   */
  private readonly stateWrites = new Map<string, Promise<unknown>>();

  /** Resolved configuration, merged with defaults. */
  private readonly config: EmergentConfig;

  /** Optional SQLite storage adapter for agent/shared tier persistence. */
  private readonly db?: IStorageAdapter;

  /** Whether `ensureSchema()` has been called and completed. */
  private schemaReady = false;
  /**
   * Ids removed in this process whose rows are not yet gone: an admission or
   * a forge that was mid-flight does not put one back. Cleared when the
   * deletes land, or when a new row is written for the id.
   */
  /**
   * Change points. `epoch` advances on every registration, adoption,
   * promotion, row write and removal of any tool in this process, and once
   * more when a removal's row deletes or a rewrite of the tool row from
   * memory (a promotion, an `upsert`) land; `changedAt` holds, per tool, the
   * epoch of its last change. A read of stored rows notes the epoch it
   * started at ({@link beginRead}), and an admission adopts what it read only
   * while the tool has not changed since and no removal or rewrite of its
   * rows is still pending ({@link adopt}), so a row read before a removal or
   * a promotion, or during one, is never put back, with or without storage.
   */
  private epoch = 0;
  private readonly changedAt = new Map<string, number>();
  /** Removals whose row deletes have not landed yet, counted per tool. */
  private readonly removing = new Map<string, number>();
  /** Rewrites of the tool row from memory that have not landed yet, counted per tool. */
  private readonly rewriting = new Map<string, number>();
  /**
   * Restrictions this process requested, per tool: how many of their writes
   * are queued or running, and the read point at which the tool's last state
   * write settled (`Infinity` while a host's restriction whose write failed
   * is in force here). See {@link restrictionUnread}.
   */
  private readonly restrictionWrites = new Map<string, { pending: number; settledAt: number }>();
  /**
   * The session of each stored session-tier tool this process admitted, or
   * restricted without loading it (the row's `created_by_session`), recorded
   * before any state is held for it. {@link cleanupSession} lets go of the
   * states held for such tools without the tools before it returns.
   */
  private readonly storedSessions = new Map<string, string>();
  /** Reads in flight; change points are forgotten only when none is. */
  private openReads = 0;

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
   * Creates the `agentos_emergent_tools`, `agentos_emergent_audit_log`,
   * `agentos_emergent_tool_state` and `agentos_emergent_effects` tables along with their indexes. Safe to
   * call multiple times — all statements use `CREATE TABLE IF NOT EXISTS` /
   * `CREATE INDEX IF NOT EXISTS`.
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

    // State and the stored request live in their own table: persistToolToDb
    // rewrites the whole tool row with INSERT OR REPLACE, which would reset any
    // column added to agentos_emergent_tools on every call.
    const stateTable = `
CREATE TABLE IF NOT EXISTS agentos_emergent_tool_state (
  tool_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  state_reason TEXT,
  set_by TEXT NOT NULL DEFAULT 'host',
  state_at BIGINT NOT NULL,
  request_json TEXT,
  updated_at BIGINT NOT NULL,
  flag_synced INTEGER NOT NULL DEFAULT 1,
  write_id TEXT
);`;

    // One row per capability call of a code-forged tool under a ceiling: the
    // intent before the call, the outcome after it (a row with no outcome is
    // unknown). Pruned by `audit.retainDays` through the intent_at index, so
    // the prune that the first record of each engine waits on costs what it
    // deletes, not the table's size; tool rows and state never are pruned.
    const effectsTable = `
CREATE TABLE IF NOT EXISTS agentos_emergent_effects (
  id TEXT PRIMARY KEY,
  tool_id TEXT NOT NULL,
  call_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  target TEXT NOT NULL,
  target_form TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  intent_at BIGINT NOT NULL,
  outcome TEXT,
  code TEXT,
  bytes BIGINT,
  uses INTEGER,
  terminal_at BIGINT
);`;
    const effectsToolIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_effects_tool ON agentos_emergent_effects(tool_id, intent_at);`;
    const effectsCallIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_effects_call ON agentos_emergent_effects(call_id);`;
    const effectsIntentIndex = `CREATE INDEX IF NOT EXISTS idx_emergent_effects_intent ON agentos_emergent_effects(intent_at);`;

    // Tables and indexes only: the flag on the tool row is written by the
    // library's own statements, never by a trigger, so the schema stays
    // portable (PostgreSQL has no SQLite trigger syntax) and every write to the
    // tool row passes through the storage adapter's hooks.
    const statements = [
      toolsTable,
      toolsTierIndex,
      toolsAgentIndex,
      auditTable,
      auditIndex,
      stateTable,
      effectsTable,
      effectsToolIndex,
      effectsCallIndex,
      effectsIntentIndex,
    ];
    // Prefer `exec` for multi-statement DDL; fall back to individual `run` calls.
    if (this.db.exec) {
      await this.db.exec(statements.join('\n'));
    } else {
      for (const statement of statements) {
        await this.db.run(statement);
      }
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

    this.bump(tool.id);
    // Stamp the tier on the tool object; a fresh registration is active, so the
    // convention property says so whatever the given object carried.
    const registered: EmergentTool = { ...tool, tier };
    (registered as EmergentTool & { isActive?: boolean }).isActive = true;

    if (tier === 'session') {
      this.sessionTools.set(registered.id, registered);
    } else {
      this.persistedTools.set(registered.id, registered);
    }

    this.states.set(registered.id, {
      toolId: registered.id,
      state: 'active',
      reason: null,
      setBy: 'library',
      at: Date.now(),
      request: null,
    });

    if (this.db) {
      // In the tool's write queue, so its first state write (which inserts a
      // state row only while the tool row exists) runs after the row lands;
      // persistToolToDb waits for the schema itself. Best-effort: in-memory
      // state remains authoritative.
      this.queueStateWrite(registered.id, () => this.persistToolToDb(registered)).catch(() => {
        // Best-effort persistence mirror.
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

  // --------------------------------------------------------------------------
  // STATE
  // --------------------------------------------------------------------------

  /** The held state of a tool, or `undefined` when none has been recorded. */
  getState(toolId: string): ToolStateRecord | undefined {
    return this.states.get(toolId);
  }

  /** Whether a tool may run. A tool with no recorded state is active. */
  isActive(toolId: string): boolean {
    return (this.states.get(toolId)?.state ?? 'active') === 'active';
  }

  /**
   * Record a tool's state, awaiting the write.
   *
   * `options.request` left out leaves the stored request alone: a new row
   * stores none, and an existing row's `request_json` is not named by the
   * update, so a request this process could not read (one a newer release
   * wrote, say) is still there afterwards. A request writes it; `null` clears
   * it.
   *
   * `options.setBy` records who set the state (`'host'` when left out). The
   * library re-checks only its own suspensions at the next load; a host's
   * stays until the host clears it, whatever words its reason uses.
   *
   * Writes for one tool run in call order, one after another. The `isActive`
   * convention property of a tool held in memory follows the state.
   *
   * A restriction (`suspended`, `demoted`) is held in memory at call time, so
   * the running process honours it whatever its write does. A reactivation
   * (`active`) is held only once both writes have succeeded, and only when no
   * other state change arrived while they ran: a suspension or demotion made
   * meanwhile is the newer word, it stays, and this call returns that record
   * instead of its own.
   *
   * `options.ifRow` makes the write conditional: an existing row is changed
   * only while its state, setter and time are still the ones given, and
   * `'absent'` lets the write create a row but never change one. The loader
   * uses it for its active write, so a restriction another process stored
   * after the row was read is never written over; a refused write returns the
   * row's own record, and a restriction read that way is held here as well.
   * Every write, conditional or not, reads the row back after it: a state
   * another process stored meanwhile is what is returned and held, and a tool
   * another process removed reads as `demoted` with the reason `removed`.
   *
   * `options.yieldToHost` makes the write give way to the host's word: a row
   * that holds a host's suspension, or a demotion, is not changed, and its
   * record is returned and held instead. The library's suspensions from a run
   * or a promotion check use it, so they never replace a restriction a host
   * set, in this process or in another.
   *
   * @returns the record now in force for the tool.
   * @throws If the storage adapter rejects.
   */
  async setState(
    toolId: string,
    state: ToolState,
    reason: string | null,
    options: {
      request?: StoredRequest | null;
      setBy?: StateSetter;
      ifRow?: { at: number; state: ToolState; setBy: StateSetter } | 'absent';
      yieldToHost?: boolean;
    } = {},
  ): Promise<ToolStateRecord> {
    const previous = this.states.get(toolId);
    const setBy: StateSetter = options.setBy ?? 'host';
    const named = options.request !== undefined;
    const record: ToolStateRecord = {
      toolId,
      state,
      reason,
      setBy,
      at: Date.now(),
      request: named ? (options.request ?? null) : (previous?.request ?? null),
    };
    const hold = (): void => {
      this.states.set(toolId, record);
      const held = this.get(toolId);
      if (held) {
        (held as EmergentTool & { isActive?: boolean }).isActive = state === 'active';
      }
      this.logAudit(toolId, 'state', { state, reason, setBy });
    };
    const restriction = state !== 'active';
    if (restriction) {
      hold();
      const entry = this.restrictionWrites.get(toolId);
      if (entry) {
        entry.pending += 1;
      } else {
        this.restrictionWrites.set(toolId, { pending: 1, settledAt: 0 });
      }
    }

    let inForce: ToolStateRecord = record;
    try {
      if (this.db) {
        inForce = await this.queueStateWrite(toolId, () =>
          this.writeStateRow(toolId, record, named, options.ifRow, options.yieldToHost === true),
        );
      }
    } catch (error: unknown) {
      this.noteStateWriteSettled(toolId, restriction, false, setBy);
      throw error;
    }
    this.noteStateWriteSettled(toolId, restriction, true, setBy);
    if (inForce !== record) {
      // The row changed under the condition: the write was refused, and the
      // row's own state is what holds. A restriction read that way is held here.
      this.logAudit(toolId, 'state_refused', { state, reason, setBy, by: inForce.state });
      // The row's word is held here too, active or not: it is stored, and it
      // is the newer one.
      this.states.set(toolId, inForce);
      const held = this.get(toolId);
      if (held) {
        (held as EmergentTool & { isActive?: boolean }).isActive = inForce.state === 'active';
      }
      return inForce;
    }

    if (state === 'active') {
      const current = this.states.get(toolId);
      if (current !== previous && current?.state !== 'active' && current?.writeId === undefined) {
        // A restriction requested in this process while this reactivation
        // was being written: its own write is queued after this one, so it is
        // the newer word and stays. (A restriction observed from another
        // process's row carries that write's id; this write landed after it
        // and is the newer word, as is another activation held meanwhile.)
        this.logAudit(toolId, 'state_superseded', { state, reason, setBy, by: current?.state ?? null });
        return current ?? record;
      }
      hold();
    }
    return record;
  }

  /**
   * Book a settled state write of a tool requested here: a restriction's
   * write is no longer pending; a write that landed (applied, or refused by
   * the row, whose word is then held) moves the tool's settle point to a new
   * read point; a host's restriction whose write failed stays in force here
   * until a later write of the tool lands. A library restriction whose write
   * failed leaves the settle point where it was, so the row decides.
   */
  private noteStateWriteSettled(toolId: string, restriction: boolean, landed: boolean, setBy: StateSetter): void {
    const entry = this.restrictionWrites.get(toolId);
    if (!entry) {
      return;
    }
    if (restriction) {
      entry.pending = Math.max(0, entry.pending - 1);
    }
    if (landed) {
      this.epoch += 1;
      entry.settledAt = this.epoch;
    } else if (restriction && setBy === 'host') {
      entry.settledAt = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Whether a restriction this process requested for a tool may be missing
   * from a row read that began at `readAt` (a {@link beginRead} point): its
   * write is still queued or running, or settled after the read began, or it
   * is a host's restriction whose write failed. A held restriction for which
   * none of these is true is older than the row the read saw, whatever the
   * clocks of the processes that wrote them say: the row decides.
   */
  restrictionUnread(toolId: string, readAt: number): boolean {
    const entry = this.restrictionWrites.get(toolId);
    return entry !== undefined && (entry.pending > 0 || entry.settledAt > readAt);
  }

  /** Runs `write` after every earlier state write of the same tool has settled. */
  private queueStateWrite<T>(toolId: string, write: () => Promise<T>): Promise<T> {
    const prior = this.stateWrites.get(toolId) ?? Promise.resolve();
    const next: Promise<T> = prior.catch(() => undefined).then(write);
    this.stateWrites.set(toolId, next);
    next
      .finally(() => {
        if (this.stateWrites.get(toolId) === next) {
          this.stateWrites.delete(toolId);
        }
      })
      .catch(() => undefined);
    return next;
  }

  /**
   * The statements of a state change: the state row upsert, with its flag
   * write marked pending; the legacy flag, read from the state row inside its
   * own statement so the two agree whatever other processes write in between;
   * then the mark cleared. A failure after the state row leaves the mark
   * pending, and the next state write or load finishes the flag write, so a
   * crash or a failed write between the two never leaves the pair apart
   * beyond the next load. With `ifRow`, an existing row is changed only while
   * its state, setter and time are the ones given (`'absent'`: never); with
   * `yieldToHost`, only while it is active or the library's suspension. A
   * refused write changes nothing, flag included, and the row as it stands
   * afterwards is returned, so it shows as a record other than the one given.
   */
  private async writeStateRow(
    toolId: string,
    record: ToolStateRecord,
    named: boolean,
    ifRow?: { at: number; state: ToolState; setBy: StateSetter } | 'absent',
    yieldToHost = false,
  ): Promise<ToolStateRecord> {
    const db = this.db;
    if (!db) {
      return record;
    }
    await this.ensureSchemaReady();
    const requestJson = named && record.request ? JSON.stringify(record.request) : null;
    const setList = named
      ? `state = excluded.state,
             state_reason = excluded.state_reason,
             set_by = excluded.set_by,
             state_at = excluded.state_at,
             request_json = excluded.request_json,
             updated_at = excluded.updated_at,
             write_id = excluded.write_id`
      : `state = excluded.state,
             state_reason = excluded.state_reason,
             set_by = excluded.set_by,
             state_at = excluded.state_at,
             updated_at = excluded.updated_at,
             write_id = excluded.write_id`;
    // state_at is the call's time; updated_at the write's own.
    // Every write has an id of its own: the row read back tells this write
    // from another of the same content in the same millisecond.
    const writeId = randomUUID();
    record.writeId = writeId;
    const values: unknown[] = [toolId, record.state, record.reason, record.setBy, record.at, requestJson, Date.now(), writeId];
    const conditions: string[] = [];
    const guardParams: unknown[] = [];
    if (ifRow === 'absent') {
      conditions.push('0 = 1');
    } else if (ifRow !== undefined) {
      conditions.push(
        `agentos_emergent_tool_state.state = ?
             AND agentos_emergent_tool_state.set_by = ?
             AND agentos_emergent_tool_state.state_at = ?`,
      );
      guardParams.push(ifRow.state, ifRow.setBy, ifRow.at);
    }
    if (yieldToHost) {
      // A host's suspension and a demotion stay; only an active row or the
      // library's own suspension is changed.
      conditions.push(
        `(agentos_emergent_tool_state.state = 'active'
               OR (agentos_emergent_tool_state.state = 'suspended' AND agentos_emergent_tool_state.set_by = 'library'))`,
      );
    }
    const guard =
      conditions.length > 0
        ? `
           WHERE ${conditions.join('\n             AND ')}`
        : '';
    const readRow = async (): Promise<StateRowRead | undefined> =>
      (await db.get(
        `SELECT s.state, s.state_reason, s.set_by, s.state_at, s.request_json, s.write_id,
                EXISTS (SELECT 1 FROM agentos_emergent_tools t WHERE t.id = s.tool_id) AS tool_exists
           FROM agentos_emergent_tool_state s
          WHERE s.tool_id = ?`,
        [toolId],
      )) as StateRowRead | undefined;
    const rowRecord = (row: StateRowRead): ToolStateRecord => ({
      toolId,
      state: row.state as ToolState,
      reason: row.state_reason ?? null,
      setBy: stateSetterFromColumn(row.set_by),
      at: Number(row.state_at ?? 0),
      request: parseStoredRequest(row.request_json),
      ...(row.write_id ? { writeId: row.write_id } : {}),
    });
    // Applied when the row carries this write's id and its tool row is still
    // there; content and time cannot tell two writes of the same record in one
    // millisecond apart. A row that is gone, or whose tool row is gone, was
    // removed by another process: not applied.
    const matches = (row: StateRowRead | undefined): boolean =>
      !!row?.state && !!row.tool_exists && row.write_id === writeId;
    // What a caller gets for a tool another process removed meanwhile: off,
    // with the reason, so a load does not register it.
    const removed = (): ToolStateRecord => ({
      toolId,
      state: 'demoted',
      reason: 'removed',
      setBy: 'host',
      at: Date.now(),
      request: null,
    });

    const before = await readRow();
    if (ifRow === 'absent' && before?.state) {
      // "No row yet" was the condition and a row exists: refused, without a
      // statement; the row and its flag are as another process left them, or
      // the tool is on its way out.
      return before.tool_exists ? rowRecord(before) : removed();
    }
    // The state row, its flag write marked pending until it is done. A new
    // state row is inserted only while the tool row exists, so a tool another
    // process removed meanwhile gets no orphan state row; an existing state
    // row can still be changed, and the read below reports a removal.
    await db.run(
      `INSERT INTO agentos_emergent_tool_state
         (tool_id, state, state_reason, set_by, state_at, request_json, updated_at, write_id, flag_synced)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, 0
        WHERE EXISTS (SELECT 1 FROM agentos_emergent_tools WHERE id = ?)
           OR EXISTS (SELECT 1 FROM agentos_emergent_tool_state WHERE tool_id = ?)
       ON CONFLICT (tool_id) DO UPDATE SET
         ${setList},
         flag_synced = 0${guard}`,
      [...values, toolId, toolId, ...guardParams],
    );
    const row = await readRow();
    if (!matches(row)) {
      // Refused, or the tool is gone: the row and its flag are as another
      // process left them.
      return row?.state && row.tool_exists ? rowRecord(row) : removed();
    }
    if (!named) {
      // The record returned carries the request the row holds, not what this
      // process happened to hold, so a caller can compare grants.
      record.request = parseStoredRequest(row?.request_json);
    }
    // The legacy flag follows the state row, then the mark is cleared. A
    // failure here leaves the mark pending for the next write or load.
    await this.writeLegacyFlag(toolId, record.state);
    await db.run(
      `UPDATE agentos_emergent_tool_state
          SET flag_synced = 1
        WHERE tool_id = ? AND ${record.writeId !== undefined ? 'write_id = ?' : 'state = ? AND set_by = ? AND state_at = ?'}`,
      record.writeId !== undefined ? [toolId, record.writeId] : [toolId, record.state, record.setBy, record.at],
    );
    // The row's word after the flag write: a restriction another process
    // stored meanwhile, or a removal, is what holds, not the record written
    // here. Read for every write, conditional or not, so a host's reactivation
    // overtaken by another process's suspension yields to it in memory too.
    let after = await readRow();
    if (!matches(after)) {
      if (after?.state && after.tool_exists) {
        // Overtaken after this write's upsert: this write's flag statement
        // may have landed after the newer write's own, with this write's
        // state (see flagAfterOvertaking), so the flag is written again from
        // the newer state.
        await this.flagAfterOvertaking(toolId, after.state, writeId);
        after = await readRow();
      }
      return after?.state && after.tool_exists ? rowRecord(after) : removed();
    }
    return record;
  }

  /** The legacy flag hosts query, read from the state row inside the statement. */
  private async writeLegacyFlag(toolId: string, state: ToolState): Promise<void> {
    await this.db!.run(
      `UPDATE agentos_emergent_tools
          SET is_active = COALESCE((SELECT CASE WHEN state = 'active' THEN 1 ELSE 0 END
                                      FROM agentos_emergent_tool_state WHERE tool_id = ?), ?)
        WHERE id = ?`,
      [toolId, state === 'active' ? 1 : 0, toolId],
    );
  }

  /** The id of the state row's last write, or null when the row has none (or there is no row). */
  private async readStateWriteId(toolId: string): Promise<string | null> {
    const row = (await this.db!.get(`SELECT write_id FROM agentos_emergent_tool_state WHERE tool_id = ?`, [
      toolId,
    ])) as { write_id?: string | null } | undefined;
    return row?.write_id ?? null;
  }

  /**
   * After a statement that set the legacy flag from the state row read inside
   * it: when another state write landed since `seen` (the state row's write
   * id when the statement was sent), the flag is written again from the state
   * row, until a flag write is not overtaken (three rounds at most). On
   * PostgreSQL under READ COMMITTED a statement reads the state row from its
   * own snapshot and applies its update to the newest row version, so a flag
   * statement that started before another write's upsert can land after that
   * write's own flag statement, with the older state; a new statement reads
   * the newer one. On SQLite every statement reads the newest row, and a
   * round here only writes the flag the state row already gives.
   */
  private async flagAfterOvertaking(toolId: string, fallback: ToolState, seen: string | null): Promise<void> {
    let last = seen;
    for (let round = 0; round < 3; round += 1) {
      const now = await this.readStateWriteId(toolId);
      if (now === last) {
        return;
      }
      last = now;
      await this.writeLegacyFlag(toolId, fallback);
    }
  }

  /**
   * Finish a state write whose flag write did not: the legacy flag from the
   * state row, then the row's mark cleared, under the record the row holds so
   * a newer write's mark is left alone. The loader calls it for a row whose
   * mark is pending, before anything about the row is decided.
   */
  async syncLegacyFlag(toolId: string, record: Pick<ToolStateRecord, 'state' | 'setBy' | 'at' | 'writeId'>): Promise<void> {
    const db = this.db;
    if (!db) {
      return;
    }
    await this.ensureSchemaReady();
    await this.writeLegacyFlag(toolId, record.state);
    await db.run(
      `UPDATE agentos_emergent_tool_state
          SET flag_synced = 1
        WHERE tool_id = ? AND ${record.writeId !== undefined ? 'write_id = ?' : 'state = ? AND set_by = ? AND state_at = ?'}`,
      record.writeId !== undefined ? [toolId, record.writeId] : [toolId, record.state, record.setBy, record.at],
    );
  }

  /**
   * Suspend a tool on the host's word: an awaited write of its state and of
   * `is_active = 0`, recorded as the host's, so no load lifts it whatever the
   * reason says; only a reactivation does. Usage statistics are left alone.
   * The caller unregisters the executable.
   *
   * @throws If the tool is unknown or the write fails.
   */
  async suspend(toolId: string, reason: string): Promise<void> {
    if (!this.get(toolId)) {
      throw new Error(`Cannot suspend: tool "${toolId}" not found.`);
    }
    await this.setState(toolId, 'suspended', reason, { setBy: 'host' });
  }

  /** Resolves once every queued state write and deletion of the tool has run. */
  async settled(toolId: string): Promise<void> {
    await (this.stateWrites.get(toolId) ?? Promise.resolve()).catch(() => undefined);
  }

  /**
   * Drop a tool from memory without touching its rows: for a load whose
   * registration with the host failed, so the row is there for the next load
   * and nothing here claims a tool the executor does not run; and for a state
   * held for a tool that has neither a row nor an object here any more.
   */
  forget(toolId: string): void {
    this.sessionTools.delete(toolId);
    this.persistedTools.delete(toolId);
    this.states.delete(toolId);
    this.restrictionWrites.delete(toolId);
    this.storedSessions.delete(toolId);
    this.bump(toolId);
  }

  /**
   * A number that grows on every change to the tool in this process (a
   * registration, an adoption, a row write, a removal); 0 for a tool not
   * seen. Two equal readings mean nothing changed in between.
   */
  generation(toolId: string): number {
    return this.changedAt.get(toolId) ?? 0;
  }

  private bump(toolId: string): void {
    this.epoch += 1;
    this.changedAt.set(toolId, this.epoch);
  }

  /**
   * Start a read of stored rows. Returns the point the read started at, for
   * {@link adopt}'s `ifUnchangedSince`; every call is paired with
   * {@link endRead}.
   */
  beginRead(): number {
    this.openReads += 1;
    return this.epoch;
  }

  /** End a read started with {@link beginRead}. */
  endRead(): void {
    this.openReads = Math.max(0, this.openReads - 1);
    if (this.openReads > 0) {
      return;
    }
    // No read in flight can hold a stale row: forget the change points of
    // tools this process neither holds nor is removing or rewriting.
    for (const toolId of [...this.changedAt.keys()]) {
      if (
        !this.sessionTools.has(toolId) &&
        !this.persistedTools.has(toolId) &&
        !this.states.has(toolId) &&
        !this.removing.has(toolId) &&
        !this.rewriting.has(toolId)
      ) {
        this.changedAt.delete(toolId);
      }
    }
    // A settle point matters only to a read that began before it.
    for (const [toolId, entry] of [...this.restrictionWrites]) {
      if (entry.pending === 0 && Number.isFinite(entry.settledAt)) {
        this.restrictionWrites.delete(toolId);
      }
    }
  }

  /** Whether a storage adapter is configured. */
  hasStorage(): boolean {
    return this.db !== undefined;
  }

  /**
   * The writer of effect records over this registry's storage, or undefined
   * without a storage adapter. The schema is made ready before its first write.
   */
  effectsStore(options: { content: 'digest' | 'full'; retainDays?: number }): EffectsStore | undefined {
    return this.db
      ? new EffectsStore(this.db, { ...options, ensureSchema: () => this.ensureSchemaReady() })
      : undefined;
  }

  /**
   * Write a tool's row from the object given, awaited. For a host that
   * hydrates a tool from its own store through `syncPersistedTool` and has no
   * row for it yet; a tool that has a row is loaded from the row, never
   * rewritten by a load.
   */
  async writeToolRow(tool: EmergentTool): Promise<void> {
    this.bump(tool.id);
    // In the tool's write queue: a removal queued before it deletes first, so
    // the row the host asks for is the one that stays.
    await this.queueStateWrite(tool.id, () => this.persistToolToDb(tool));
  }

  /**
   * The rows of a tool, deleted after every queued state write of the tool,
   * so a write still in the queue cannot recreate the state row once it is
   * deleted. Until the deletes land the removal counts as pending, and when
   * they land the tool counts as changed: a read that started before either
   * point may hold the row as it was. Best-effort.
   *
   * With `onlySessionOf`, the tool row goes only while it is still a session
   * row of that session (another process may have promoted it since), and
   * the state row only once the tool row is gone.
   */
  private queueRowDeletes(toolId: string, onlySessionOf?: string): void {
    const db = this.db;
    if (!db) {
      return;
    }
    this.removing.set(toolId, (this.removing.get(toolId) ?? 0) + 1);
    this.queueStateWrite(toolId, async () => {
      if (onlySessionOf === undefined) {
        await db.run(`DELETE FROM agentos_emergent_tools WHERE id = ?`, [toolId]);
        await db.run(`DELETE FROM agentos_emergent_tool_state WHERE tool_id = ?`, [toolId]);
        return;
      }
      await db.run(
        `DELETE FROM agentos_emergent_tools WHERE id = ? AND tier = 'session' AND created_by_session = ?`,
        [toolId, onlySessionOf],
      );
      await db.run(
        `DELETE FROM agentos_emergent_tool_state
          WHERE tool_id = ? AND NOT EXISTS (SELECT 1 FROM agentos_emergent_tools WHERE id = ?)`,
        [toolId, toolId],
      );
    })
      .catch(() => {
        // Best-effort cleanup only.
      })
      .finally(() => {
        const left = (this.removing.get(toolId) ?? 1) - 1;
        if (left > 0) {
          this.removing.set(toolId, left);
        } else {
          this.removing.delete(toolId);
        }
        this.bump(toolId);
      });
  }

  /**
   * A rewrite of the tool row from the object held in memory (a promotion,
   * an `upsert`), in the tool's write queue: after the tool's earlier state
   * writes, and before the deletes of a removal that comes after it, so a
   * removal is never undone by a row write that lands late. The write is
   * skipped when the registry no longer holds that object by the time it
   * runs (the tool was removed, or replaced under its id). Until it lands an
   * admission does not adopt the tool, and when it lands the tool counts as
   * changed, so a row read before it is read again.
   */
  private queueToolRowWrite(tool: EmergentTool, approvedBy?: string): Promise<void> {
    this.rewriting.set(tool.id, (this.rewriting.get(tool.id) ?? 0) + 1);
    return this.queueStateWrite(tool.id, async () => {
      try {
        if (this.get(tool.id) === tool) {
          await this.persistToolToDb(tool, approvedBy);
        }
      } finally {
        const left = (this.rewriting.get(tool.id) ?? 1) - 1;
        if (left > 0) {
          this.rewriting.set(tool.id, left);
        } else {
          this.rewriting.delete(tool.id);
        }
        this.bump(tool.id);
      }
    });
  }

  /**
   * Take a tool read from storage into memory without rewriting its row.
   * `upsert` re-serialises the source; a loaded tool must keep the row it has.
   *
   * @param ifUnchangedSince - The point the caller's read started at
   *   ({@link beginRead}), or a {@link generation} reading. The adoption is
   *   refused when the tool changed in this process after it, or a removal or
   *   a rewrite of the tool's rows is still pending: the row the caller holds
   *   may then be one that is gone or about to change.
   */
  adopt(tool: EmergentTool, record: ToolStateRecord, ifUnchangedSince?: number): boolean {
    if (
      ifUnchangedSince !== undefined &&
      (this.generation(tool.id) > ifUnchangedSince || this.removing.has(tool.id) || this.rewriting.has(tool.id))
    ) {
      return false;
    }
    this.sessionTools.delete(tool.id);
    this.persistedTools.delete(tool.id);
    if (tool.tier === 'session') {
      this.sessionTools.set(tool.id, tool);
    } else {
      this.persistedTools.set(tool.id, tool);
    }
    (tool as EmergentTool & { isActive?: boolean }).isActive = record.state === 'active';
    this.states.set(tool.id, record);
    this.bump(tool.id);
    return true;
  }

  private static readonly ROW_COLUMNS = `
        t.id, t.name, t.description, t.input_schema, t.output_schema,
        t.implementation_mode, t.implementation_source, t.tier,
        t.created_by_agent, t.created_by_session, t.created_at,
        t.judge_verdicts, t.confidence_score, t.total_uses, t.success_count,
        t.failure_count, t.avg_execution_ms, t.last_used_at, t.is_active,
        s.state AS state, s.state_reason AS state_reason, s.set_by AS set_by,
        s.state_at AS state_at, s.request_json AS request_json,
        s.flag_synced AS flag_synced, s.write_id AS write_id
   FROM agentos_emergent_tools t
   LEFT JOIN agentos_emergent_tool_state s ON s.tool_id = t.id`;

  /**
   * The stored rows of the given tiers, in creation order, with their state
   * rows: every `shared` row, the `agent` rows of `scope.agentId` and the
   * `session` rows of `scope.sessionId`. A tier named without its selector
   * contributes no rows; the engine refuses such a call before it gets here.
   */
  async loadRows(
    tiers: readonly ToolTier[],
    scope: { agentId?: string; sessionId?: string } = {},
  ): Promise<PersistedToolRow[]> {
    if (!this.db || tiers.length === 0) {
      return [];
    }
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (tiers.includes('shared')) {
      clauses.push(`t.tier = 'shared'`);
    }
    if (tiers.includes('agent') && scope.agentId !== undefined) {
      clauses.push(`(t.tier = 'agent' AND t.created_by_agent = ?)`);
      params.push(scope.agentId);
    }
    if (tiers.includes('session') && scope.sessionId !== undefined) {
      clauses.push(`(t.tier = 'session' AND t.created_by_session = ?)`);
      params.push(scope.sessionId);
    }
    if (clauses.length === 0) {
      return [];
    }
    await this.ensureSchemaReady();
    const rows = await this.db.all(
      `SELECT ${EmergentToolRegistry.ROW_COLUMNS}
        WHERE ${clauses.join(' OR ')}
        ORDER BY t.created_at ASC`,
      params,
    );
    return rows as PersistedToolRow[];
  }

  /** One stored row with its state row, or `undefined`. */
  async loadRow(toolId: string): Promise<PersistedToolRow | undefined> {
    if (!this.db) {
      return undefined;
    }
    await this.ensureSchemaReady();
    const row = await this.db.get(
      `SELECT ${EmergentToolRegistry.ROW_COLUMNS}
        WHERE t.id = ?`,
      [toolId],
    );
    return (row as PersistedToolRow | undefined) ?? undefined;
  }

  /** A tool's state: the held one, else the stored one, else `undefined`. */
  async readState(toolId: string): Promise<ToolStateRecord | undefined> {
    const held = this.states.get(toolId);
    if (held || !this.db) {
      return held;
    }
    return this.readStoredState(toolId);
  }

  /**
   * Hold a stored state for a tool this process holds no object for: a load
   * that finds a restriction already stored on a row it does not activate
   * takes it in here, so {@link listStates} carries it (a registration of a
   * composition's missing step tool re-checks the composition from it).
   * Nothing is written.
   */
  holdState(record: ToolStateRecord): void {
    this.states.set(record.toolId, record);
  }

  /**
   * Record the session a stored session-tier tool belongs to (its row's
   * `created_by_session`), before a state is held for it here: a load's
   * admission, or a host's restriction of a tool this process never loaded.
   * {@link cleanupSession} then lets go of a state held for it without the
   * tool, and deletes its rows.
   */
  noteStoredSession(toolId: string, sessionId: string): void {
    this.storedSessions.set(toolId, sessionId);
  }

  /** Every state held in memory: the tools this process forged, loaded or suspended. */
  listStates(): ToolStateRecord[] {
    return [...this.states.values()];
  }

  /**
   * A tool's state as its row reads now, or `undefined`; what this process
   * holds is not consulted. The loader reads it before adopting a row it has
   * nothing to write for, since a restriction another process stored after
   * the row was read is the newer word.
   */
  async readStoredState(toolId: string): Promise<ToolStateRecord | undefined> {
    if (!this.db) {
      return undefined;
    }
    await this.ensureSchemaReady();
    const row = (await this.db.get(
      `SELECT s.state, s.state_reason, s.set_by, s.state_at, s.request_json, s.write_id,
              EXISTS (SELECT 1 FROM agentos_emergent_tools t WHERE t.id = s.tool_id) AS tool_exists
         FROM agentos_emergent_tool_state s
        WHERE s.tool_id = ?`,
      [toolId],
    )) as StateRowRead | undefined;
    if (!row?.state || !row.tool_exists) {
      // No state row, or a tool row already gone: nothing stored to hold.
      return undefined;
    }
    return {
      toolId,
      state: row.state,
      reason: row.state_reason ?? null,
      setBy: stateSetterFromColumn(row.set_by),
      at: Number(row.state_at ?? 0),
      request: parseStoredRequest(row.request_json),
      ...(row.write_id ? { writeId: row.write_id } : {}),
    };
  }

  /**
   * Replace the in-memory copy of a tool and mirror it to storage.
   *
   * The row is rewritten from the object given, in the tool's write queue.
   * To bring stored tools back after a restart, call the engine's
   * `loadPersistedTools`, which reads each row, checks it and never rewrites
   * it. A tool whose state this process does not hold keeps the `is_active`
   * its row has.
   */
  upsert(tool: EmergentTool): void {
    this.sessionTools.delete(tool.id);
    this.persistedTools.delete(tool.id);

    const normalized: EmergentTool = { ...tool };
    // The convention property follows the held state, not the given object.
    (normalized as EmergentTool & { isActive?: boolean }).isActive = this.isActive(normalized.id);
    this.bump(normalized.id);
    if (normalized.tier === 'session') {
      this.sessionTools.set(normalized.id, normalized);
    } else {
      this.persistedTools.set(normalized.id, normalized);
    }

    if (this.db && this.schemaReady) {
      this.queueToolRowWrite(normalized).catch(() => {
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
    this.states.delete(toolId);
    this.restrictionWrites.delete(toolId);
    this.storedSessions.delete(toolId);
    // The rows go whether or not this process held the tool, so a host can
    // remove a stored tool it never loaded; the generation moves, so an
    // admission that read the tool before this does not put it back.
    this.bump(toolId);
    this.queueRowDeletes(toolId);
    if (removed) {
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
   * @returns `false` when the tool is suspended or demoted and nothing was recorded.
   *
   * @throws {Error} If no tool with the given ID is registered.
   */
  recordUse(
    toolId: string,
    _input: unknown,
    _output: unknown,
    success: boolean,
    executionTimeMs: number,
  ): boolean {
    const tool = this.get(toolId);
    if (!tool) {
      throw new Error(`Cannot record use: tool "${toolId}" not found.`);
    }

    // A suspended or demoted tool records nothing: its statistics must not
    // move while it cannot run, and nothing here may write it back as active.
    if (!this.isActive(toolId)) {
      return false;
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

    const usedAtMs = Date.now();
    stats.lastUsedAt = new Date(usedAtMs).toISOString();

    if (this.db && this.schemaReady) {
      // Usage columns only. Rewriting the whole row re-serialises the source,
      // which replaced a stored source with the redacted record whenever
      // persistSandboxSource was off.
      this.db
        .run(
          `UPDATE agentos_emergent_tools
              SET confidence_score = ?, total_uses = ?, success_count = ?,
                  failure_count = ?, avg_execution_ms = ?, last_used_at = ?
            WHERE id = ?`,
          [
            stats.confidenceScore,
            stats.totalUses,
            stats.successCount,
            stats.failureCount,
            stats.avgExecutionTimeMs,
            usedAtMs,
            toolId,
          ],
        )
        .catch(() => {
          // Best-effort persistence mirror. Usage stats still live in memory.
        });
    }

    this.logAudit(toolId, 'use', { success, executionTimeMs });
    return true;
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
   * shared, the tool is persisted to the database. The promotion is a change
   * point, and its row write runs in the tool's write queue: an admission that
   * read the row before it reads the row again, and a removal that comes
   * after it deletes the promoted row.
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

    if (targetTier === 'agent' && tool.createdBy.startsWith(GMI_INSTANCE_ID_PREFIX)) {
      // An agent-tier row with this owner reads as one an earlier release
      // wrote, and loads suspended (legacy_owner).
      throw new Error(
        `Cannot promote tool "${toolId}" to "agent": its owner "${tool.createdBy}" begins with the reserved ` +
          `prefix "${GMI_INSTANCE_ID_PREFIX}", which marks agent-tier rows from earlier releases.`,
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
    this.bump(toolId);

    // Persist to DB if adapter is available and target is a persisted tier.
    if (this.db && this.schemaReady) {
      await this.queueToolRowWrite(tool, approvedBy);
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
   * (`confidenceScore` set to 0), records the `demoted` state and logs the
   * demotion event with a reason.
   *
   * Inactive tools are still retrievable via `get()` but should be filtered
   * out by callers when building tool lists for the LLM.
   *
   * Returns a promise for the state write, which rejects when the write fails;
   * await it when the demotion must be durable. An un-awaited call cannot
   * become an unhandled rejection. The in-memory effects have happened by the
   * time this returns.
   *
   * @param toolId - The ID of the tool to demote.
   * @param reason - Human-readable explanation for why the tool is being demoted.
   *
   * @throws {Error} If the tool is not found (thrown synchronously).
   */
  demote(toolId: string, reason: string): Promise<void> {
    const tool = this.get(toolId);
    if (!tool) {
      throw new Error(`Cannot demote: tool "${toolId}" not found.`);
    }

    tool.usageStats.confidenceScore = 0;

    this.logAudit(toolId, 'demote', { reason });
    // The state row is what keeps a demoted tool off at the next load; it is
    // the host's word, so no load lifts it. setState sets the convention
    // property `isActive` before it writes.
    const write = this.setState(toolId, 'demoted', reason, { setBy: 'host' }).then(() => undefined);
    // Handled here so a caller that does not await is not left with an
    // unhandled rejection; an awaiting caller still sees the failure.
    write.catch(() => {});
    return write;
  }

  // --------------------------------------------------------------------------
  // CLEANUP SESSION
  // --------------------------------------------------------------------------

  /**
   * Remove all session-tier tools associated with a specific session.
   *
   * Iterates the session map and deletes every tool whose `source` names the
   * given session; the rows go after the tool's queued writes. Logs a cleanup
   * audit event for each removed tool. The session's stored tools whose state
   * this process holds without the tool (a load admitted them suspended or
   * demoted, or the host restricted one it never loaded) go too: the state
   * before this returns, so no registration from then on re-checks one and a
   * re-check already under way does not adopt it, and the rows after their
   * queued writes, while they are still the session's. Rows of the session
   * this process never admitted or restricted are left to the process that
   * holds them.
   *
   * @param sessionId - The session identifier to match against tool `source`
   *   strings.
   * @returns The number of live tools removed.
   */
  cleanupSession(sessionId: string): number {
    let removedCount = 0;

    for (const [id, tool] of this.sessionTools) {
      // The session the source names, whole: "sess-1" is not "sess-10".
      if (sessionFromSource(tool.source) === sessionId) {
        this.sessionTools.delete(id);
        this.states.delete(id);
        this.restrictionWrites.delete(id);
        this.storedSessions.delete(id);
        this.bump(id);
        this.queueRowDeletes(id);
        this.logAudit(id, 'cleanup', { sessionId });
        removedCount += 1;
      }
    }

    for (const [id, session] of [...this.storedSessions]) {
      if (session !== sessionId) {
        continue;
      }
      this.storedSessions.delete(id);
      // A tool live here is not one of these (one promoted out of the
      // session belongs to its agent now), and with no state held there is
      // nothing to let go.
      if (this.sessionTools.has(id) || this.persistedTools.has(id) || !this.states.has(id)) {
        continue;
      }
      this.states.delete(id);
      this.restrictionWrites.delete(id);
      this.bump(id);
      this.queueRowDeletes(id, sessionId);
      this.logAudit(id, 'cleanup', { sessionId });
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
    if (this.auditLog.length > AUDIT_RING_SIZE) {
      this.auditLog.splice(0, this.auditLog.length - AUDIT_RING_SIZE);
    }

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

    // The session the tool was forged in, from its source line, kept whole:
    // the loader's session selector compares it with the id the host gives.
    const sessionId = sessionFromSource(tool.source) ?? 'unknown';

    let promotedAt: number | null = null;
    let promotedBy: string | null = approvedBy ?? null;

    // The row as it is, read when the write depends on it: a promoted tool
    // keeps its promotion, and a tool whose state this process does not hold
    // keeps the is_active flag its row has.
    const held = this.states.get(tool.id);
    let existing:
      | { promoted_at?: number | null; promoted_by?: string | null; is_active?: number | boolean | null }
      | undefined;
    if (tool.tier !== 'session' || !held) {
      existing = (await this.db.get(
        `SELECT promoted_at, promoted_by, is_active
           FROM agentos_emergent_tools
          WHERE id = ?
          LIMIT 1`,
        [tool.id],
      )) as typeof existing;
    }

    if (tool.tier !== 'session') {
      const row = existing ?? { promoted_at: null, promoted_by: null };
      promotedAt =
        approvedBy != null
          ? Date.now()
          : typeof row.promoted_at === 'number'
            ? row.promoted_at
            : Date.now();
      promotedBy =
        approvedBy ??
        (row.promoted_by != null ? String(row.promoted_by) : null);
    }

    const implementationSource = await this.resolveSourceToStore(tool);

    // The legacy flag. For a state this process holds it follows the state
    // row, read inside the statement (a state change that landed during the
    // reads above is the newer word), and a flag the host lowered with its own
    // SQL stays lowered until a load records the host's decision or the host
    // reactivates the tool. A process that holds no state writes 1 for a new
    // row and leaves an existing row's flag as it stands at write time, not
    // as it read it earlier: a whole-row write is never a reactivation, and
    // never a disable either. A state write another process lands while the
    // statement runs can leave it with the older state (PostgreSQL, READ
    // COMMITTED): the state row's write id is read before it, and when it has
    // moved the flag is written again from the state row, as that state
    // write's own flag write does.
    const stateWriteBefore = this.states.has(tool.id) ? await this.readStateWriteId(tool.id) : null;
    const heldNow = this.states.get(tool.id);
    const flagExpr = heldNow
      ? `COALESCE((SELECT CASE WHEN state = 'active' THEN 1 ELSE 0 END
                     FROM agentos_emergent_tool_state WHERE tool_id = ?), ?)`
      : `1`;
    const flagParams: unknown[] = heldNow ? [tool.id, heldNow.state === 'active' ? 1 : 0] : [];
    const flagOnConflict = heldNow
      ? `CASE WHEN agentos_emergent_tools.is_active = 0 THEN 0 ELSE excluded.is_active END`
      : `agentos_emergent_tools.is_active`;
    const columns = [
      'id', 'name', 'description', 'input_schema', 'output_schema', 'implementation_mode',
      'implementation_source', 'tier', 'created_by_agent', 'created_by_session',
      'created_at', 'promoted_at', 'promoted_by', 'judge_verdicts', 'confidence_score',
      'total_uses', 'success_count', 'failure_count', 'avg_execution_ms', 'last_used_at',
    ];

    await this.db.run(
      `INSERT INTO agentos_emergent_tools
       (${columns.join(', ')}, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${flagExpr})
       ON CONFLICT (id) DO UPDATE SET
         ${columns.slice(1).map((column) => `${column} = excluded.${column}`).join(',\n         ')},
         is_active = ${flagOnConflict}`,
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
        // The flag of a new row; on conflict, see flagOnConflict above.
        ...flagParams,
      ],
    );
    if (heldNow) {
      await this.flagAfterOvertaking(tool.id, heldNow.state, stateWriteBefore);
    }
  }

  /**
   * The `implementation_source` to write for a tool. With source persistence
   * off the registry writes the redacted record for a fresh forge, or over an
   * earlier redacted record, and never over any other stored source: that
   * source was put there by a host, or while persistence was on, and
   * replacing it would destroy the tool.
   */
  private async resolveSourceToStore(tool: EmergentTool): Promise<string> {
    if (tool.implementation.mode !== 'sandbox') {
      return JSON.stringify(tool.implementation);
    }
    if (this.config.persistSandboxSource || !this.db) {
      return this.serializeSandboxImplementation(tool);
    }
    const existing = (await this.db.get(
      `SELECT implementation_source
         FROM agentos_emergent_tools
        WHERE id = ?
        LIMIT 1`,
      [tool.id],
    )) as { implementation_source?: string | null } | undefined;
    const stored = existing?.implementation_source;
    if (typeof stored === 'string' && parsePersistedSource('sandbox', stored).format !== 'redacted') {
      return stored;
    }
    return this.serializeSandboxImplementation(tool);
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
