/**
 * @fileoverview Types for the universal vector store migration engine.
 * @module rag/migration/types
 *
 * Defines the interfaces for streaming data between any pair of
 * vector store backends (SQLite, Postgres, Qdrant). The migration
 * engine reads batches from an IMigrationSource and writes them
 * to an IMigrationTarget, never loading the entire dataset into memory.
 */

import type { BrainScopeIdForm } from '../../memory/retrieval/store/scopeIdForm.js';

// ---------------------------------------------------------------------------
// Backend identification
// ---------------------------------------------------------------------------

/** Supported backend types for migration. */
export type BackendType = 'sqlite' | 'postgres' | 'qdrant' | 'pinecone';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration for a migration source or target backend.
 * Only the fields relevant to the chosen `type` need to be provided.
 */
export interface BackendConfig {
  /** Which backend type to connect to. */
  type: BackendType;
  /** SQLite file path. Required when type='sqlite'. */
  path?: string;
  /** Postgres connection string. Required when type='postgres'. */
  connectionString?: string;
  /** Qdrant base URL (e.g. 'http://localhost:6333'). Required when type='qdrant'. */
  url?: string;
  /** Qdrant API key for cloud instances. Optional. */
  apiKey?: string;
  /**
   * Optional SQLite sidecar path used by Qdrant deployments for non-vector
   * tables such as graph metadata and documents.
   */
  sidecarPath?: string;
  /** Qdrant collection name prefix. @default 'wunderland' */
  collectionPrefix?: string;
}

/**
 * Options for a migration operation.
 */
export interface MigrationOptions {
  /** Source backend configuration. */
  from: BackendConfig;
  /** Target backend configuration. */
  to: BackendConfig;
  /** Rows per batch for streaming reads/writes. @default 1000 */
  batchSize?: number;
  /**
   * Progress callback fired after each batch write.
   * @param done  - Number of rows written so far for the current table.
   * @param total - Total row count for the current table.
   * @param table - Name of the table currently being migrated.
   */
  onProgress?: (done: number, total: number, table: string) => void;
  /** If true, counts rows but does not write to target. @default false */
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/**
 * Result returned after a migration completes.
 */
export interface MigrationResult {
  /** Names of tables that were processed. */
  tablesProcessed: string[];
  /** Total rows migrated across all tables. */
  totalRows: number;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** True if post-migration verification passed. */
  verified: boolean;
  /** Any errors encountered (non-fatal errors are collected, not thrown). */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Adapter interfaces
// ---------------------------------------------------------------------------

/**
 * Adapter for reading data from a migration source backend.
 * Implementations exist for SQLite, Postgres, and Qdrant.
 */
export interface IMigrationSource {
  /** List table/collection names available for migration. */
  listTables(): Promise<string[]>;
  /** Count rows/points in a table. */
  countRows(table: string): Promise<number>;
  /**
   * Read a batch of rows starting at offset.
   * @param table  - Table name to read from.
   * @param offset - Number of rows to skip.
   * @param limit  - Maximum rows to return.
   * @returns Array of row objects with column values.
   */
  readBatch(table: string, offset: number, limit: number): Promise<Record<string, unknown>[]>;
  /**
   * Every brain the source holds, with its scope-id form (`brain_meta.scope_id_form`), for the handshake the engine
   * runs before it copies any table. A backend that holds no Brain tables (Qdrant, Pinecone) leaves it out.
   */
  scopeIdForms?(): Promise<Map<string, BrainScopeIdForm>>;
  /** Close the connection and release resources. */
  close(): Promise<void>;
}

/**
 * Adapter for writing data to a migration target backend.
 * Implementations exist for SQLite, Postgres, and Qdrant.
 */
export interface IMigrationTarget {
  /**
   * Ensure the target schema/collection exists for a table.
   * Creates it if it doesn't exist, using a sample row to infer column types.
   * @param table     - Table name to create.
   * @param sampleRow - A sample row to derive schema from.
   */
  ensureTable(table: string, sampleRow: Record<string, unknown>): Promise<void>;
  /**
   * Write a batch of rows to the target.
   * Uses INSERT OR REPLACE / upsert semantics to handle duplicates.
   * @param table - Table name to write to.
   * @param rows  - Array of row objects.
   * @returns Number of rows successfully written.
   */
  writeBatch(table: string, rows: Record<string, unknown>[]): Promise<number>;
  /**
   * These brains as the target holds them, with their scope-id forms, for the handshake the engine runs before it
   * copies any table; a brain the target does not hold reads as holding nothing. A backend that holds no Brain tables
   * (Qdrant) leaves it out.
   */
  scopeIdForms?(brainIds: readonly string[]): Promise<Map<string, BrainScopeIdForm>>;
  /** Removes one brain's scope-id form record, when the handshake gives the copy the source's plain form. */
  clearScopeIdForm?(brainId: string): Promise<void>;
  /** Close the connection and release resources. */
  close(): Promise<void>;
}
