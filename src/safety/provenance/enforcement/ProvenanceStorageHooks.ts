/**
 * @file ProvenanceStorageHooks.ts
 * @description StorageHooks implementation that enforces provenance policies.
 * Integrates with sql-storage-adapter's onBeforeWrite/onAfterWrite hooks.
 *
 * @module AgentOS/Provenance/Enforcement
 */

import type { ProvenanceSystemConfig, ProvenanceEventType } from '../types.js';
import { ProvenanceViolationError } from '../types.js';
import type { SignedEventLedger } from '../ledger/SignedEventLedger.js';
import type { RevisionManager } from './RevisionManager.js';
import type { TombstoneManager } from './TombstoneManager.js';

// =============================================================================
// Hook Context Types (mirrors sql-storage-adapter WriteContext shape)
// =============================================================================

interface WriteContext {
  readonly operation: 'run' | 'batch';
  statement: string;
  parameters?: unknown[];
  affectedTables?: string[];
  readonly inTransaction?: boolean;
  operationId: string;
  startTime: number;
  adapterKind?: string;
  metadata?: Record<string, unknown>;
}

interface StorageRunResult {
  changes: number;
  lastInsertRowid?: string | number | null;
}

type WriteHookResult = WriteContext | undefined | void;

interface StorageHooks {
  onBeforeWrite?(context: WriteContext): Promise<WriteHookResult>;
  onAfterWrite?(context: WriteContext, result: StorageRunResult): Promise<void>;
}

// =============================================================================
// SQL Parsing Helpers
// =============================================================================

type SqlOperation = 'INSERT' | 'UPDATE' | 'DELETE' | 'CREATE' | 'ALTER' | 'DROP' | 'UNKNOWN';

function detectSqlOperation(statement: string): SqlOperation {
  const trimmed = statement.trim().toUpperCase();
  if (trimmed.startsWith('INSERT')) return 'INSERT';
  // SQLite supports `REPLACE INTO ...` which is semantically an upsert (delete + insert).
  // Treat as INSERT for event mapping, but enforce in sealed mode as a mutation.
  if (trimmed.startsWith('REPLACE')) return 'INSERT';
  if (trimmed.startsWith('UPDATE')) return 'UPDATE';
  if (trimmed.startsWith('DELETE')) return 'DELETE';
  if (trimmed.startsWith('CREATE')) return 'CREATE';
  if (trimmed.startsWith('ALTER')) return 'ALTER';
  if (trimmed.startsWith('DROP')) return 'DROP';
  return 'UNKNOWN';
}

function isUpsertLikeMutation(statement: string): boolean {
  const upper = statement.trim().toUpperCase();

  // `REPLACE INTO ...` (SQLite) overwrites existing rows.
  if (upper.startsWith('REPLACE')) return true;

  // `INSERT OR REPLACE INTO ...` (SQLite) overwrites existing rows.
  if (/INSERT\s+OR\s+REPLACE\s+INTO\s+/i.test(statement)) return true;

  // `INSERT ... ON CONFLICT ... DO UPDATE` (SQLite/Postgres) mutates existing rows.
  if (/ON\s+CONFLICT[\s\S]*DO\s+UPDATE/i.test(statement)) return true;

  return false;
}

function extractTableFromStatement(statement: string): string | undefined {
  const trimmed = statement.trim();

  // INSERT INTO <table>
  const insertMatch = trimmed.match(/INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(\S+)/i);
  if (insertMatch) return insertMatch[1];

  // REPLACE INTO <table>
  const replaceMatch = trimmed.match(/REPLACE\s+INTO\s+(\S+)/i);
  if (replaceMatch) return replaceMatch[1];

  // UPDATE <table>
  const updateMatch = trimmed.match(/UPDATE\s+(\S+)/i);
  if (updateMatch) return updateMatch[1];

  // DELETE FROM <table>
  const deleteMatch = trimmed.match(/DELETE\s+FROM\s+(\S+)/i);
  if (deleteMatch) return deleteMatch[1];

  return undefined;
}

function extractWhereClause(statement: string): { clause: string; params: unknown[] } | null {
  const whereMatch = statement.match(/WHERE\s+(.+?)(?:;|\s*$)/i);
  if (!whereMatch) return null;
  return { clause: whereMatch[1], params: [] };
}

function inferWhereParameters(whereClause: string, parameters?: unknown): unknown[] {
  const positional = Array.isArray(parameters) ? parameters : [];
  const placeholderCount = (whereClause.match(/\?/g) || []).length;

  if (placeholderCount <= 0) {
    return positional;
  }

  if (positional.length <= placeholderCount) {
    return positional;
  }

  return positional.slice(positional.length - placeholderCount);
}

// =============================================================================
// isTableProtected
// =============================================================================

/**
 * Whether the storage policy enforces its mode on a table. Provenance's own tables never; a table in `exemptTables`
 * never; with `protectedTables` set, exactly the tables it names (by their exact names); otherwise every table.
 *
 * @param tableName - The table a statement writes to.
 * @param config - The storage policy.
 */
export function isTableProtected(
  tableName: string,
  config: ProvenanceSystemConfig['storagePolicy'],
): boolean {
  // Skip provenance's own tables
  if (
    tableName.includes('signed_events') ||
    tableName.includes('revisions') ||
    tableName.includes('tombstones') ||
    tableName.includes('anchors') ||
    tableName.includes('agent_keys')
  ) {
    return false;
  }

  // Check exempt tables
  if (config.exemptTables?.includes(tableName)) {
    return false;
  }

  // If protectedTables is specified, only those are protected
  if (config.protectedTables && config.protectedTables.length > 0) {
    return config.protectedTables.includes(tableName);
  }

  // Default: all tables are protected
  return true;
}

// =============================================================================
// Factory: createProvenanceHooks
// =============================================================================

/**
 * Create StorageHooks that enforce provenance policies.
 *
 * @param config - The provenance system configuration.
 * @param ledger - The signed event ledger (optional, for logging events).
 * @param revisionManager - For capturing revisions in revisioned mode.
 * @param tombstoneManager - For creating tombstones in revisioned mode.
 * @returns StorageHooks compatible with sql-storage-adapter's combineHooks().
 */
export function createProvenanceHooks(
  config: ProvenanceSystemConfig,
  ledger?: SignedEventLedger,
  revisionManager?: RevisionManager,
  tombstoneManager?: TombstoneManager,
): StorageHooks {
  return {
    onBeforeWrite: async (context: WriteContext): Promise<WriteHookResult> => {
      const operation = detectSqlOperation(context.statement);
      const table = context.affectedTables?.[0] ?? extractTableFromStatement(context.statement);

      // Schema operations always allowed
      if (operation === 'CREATE' || operation === 'ALTER' || operation === 'DROP') {
        return context;
      }

      // Check if the table is protected
      if (!table || !isTableProtected(table, config.storagePolicy)) {
        return context;
      }

      const mode = config.storagePolicy.mode;

      switch (mode) {
        case 'sealed': {
          const isUpsert = operation === 'INSERT' && isUpsertLikeMutation(context.statement);
          if (operation === 'UPDATE' || operation === 'DELETE' || isUpsert) {
            throw new ProvenanceViolationError(
              `${isUpsert ? 'UPSERT' : operation} operations are forbidden in sealed mode on table '${table}'`,
              { code: 'SEALED_MUTATION_BLOCKED', table, operation },
            );
          }
          break;
        }

        case 'revisioned':
          if (operation === 'UPDATE' && revisionManager) {
            // Capture snapshot before the update
            const where = extractWhereClause(context.statement);
            if (where) {
              await revisionManager.captureRevision(
                table,
                where.clause,
                inferWhereParameters(where.clause, context.parameters),
              );
            }
          }

          if (operation === 'DELETE' && tombstoneManager) {
            // Create tombstone and abort the actual DELETE
            const where = extractWhereClause(context.statement);
            if (where) {
              await tombstoneManager.createTombstone(
                table,
                where.clause,
                inferWhereParameters(where.clause, context.parameters),
              );
            }
            // Return undefined to abort the DELETE
            return undefined;
          }
          break;

        case 'mutable':
          // No enforcement
          break;
      }

      return context;
    },

    onAfterWrite: async (context: WriteContext, result: StorageRunResult): Promise<void> => {
      // Log events to the signed ledger (for all modes when provenance is enabled)
      if (!config.provenance.enabled || !ledger || result.changes === 0) {
        return;
      }

      const operation = detectSqlOperation(context.statement);
      const table = context.affectedTables?.[0] ?? extractTableFromStatement(context.statement);

      if (!table) return;

      // Skip logging for provenance's own tables (prevent infinite recursion)
      if (
        table.includes('signed_events') ||
        table.includes('revisions') ||
        table.includes('tombstones') ||
        table.includes('anchors') ||
        table.includes('agent_keys')
      ) {
        return;
      }

      // Map SQL operation to event type
      const eventType = mapOperationToEventType(operation, table);
      if (!eventType) return;

      await ledger.appendEvent(eventType, {
        table,
        operation,
        changes: result.changes,
        operationId: context.operationId,
      });
    },
  };
}

// =============================================================================
// Helpers
// =============================================================================

function mapOperationToEventType(
  operation: SqlOperation,
  table: string,
): ProvenanceEventType | null {
  if (table.includes('message')) {
    switch (operation) {
      case 'INSERT': return 'message.created';
      case 'UPDATE': return 'message.revised';
      case 'DELETE': return 'message.tombstoned';
    }
  }

  if (table.includes('conversation')) {
    switch (operation) {
      case 'INSERT': return 'conversation.created';
      case 'UPDATE': return 'conversation.archived';
      case 'DELETE': return 'conversation.tombstoned';
    }
  }

  // Generic storage events
  switch (operation) {
    case 'INSERT': return 'memory.stored';
    case 'UPDATE': return 'memory.revised';
    case 'DELETE': return 'memory.tombstoned';
  }

  return null;
}
