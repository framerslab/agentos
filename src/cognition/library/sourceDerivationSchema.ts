/**
 * @fileoverview The PostgreSQL tables of the durable source derivation store: results derived from private sources
 * with the sources each depends on, one fence row per owner, and content-free deletion records for recovery.
 * @module agentos/cognition/library/sourceDerivationSchema
 */

/**
 * Internal table-name construction shared by the schema and store.
 *
 * @param prefix - Table-name prefix: a lower-case letter, then at most 39 lower-case letters, digits or underscores.
 * @returns The quoted names of the store's tables and indexes.
 * @throws {Error} `invalid_derivation_table_prefix` when the prefix does not have that form.
 */
export function sourceDerivationTables(prefix = 'agentos_source_derivation') {
  if (!/^[a-z][a-z0-9_]{0,39}$/.test(prefix)) throw new Error('invalid_derivation_table_prefix');
  return {
    owners: `"${prefix}_owners"`, results: `"${prefix}_results"`,
    edges: `"${prefix}_edges"`, tombstones: `"${prefix}_tombstones"`,
    expiryIndex: `"${prefix}_expiry"`, dependencyIndex: `"${prefix}_dependency"`, journal: `"${prefix}_journal"`,
  };
}

/**
 * PostgreSQL DDL for migration-owned durable provenance and content-free fences.
 *
 * Each statement creates its table or index only when it is missing. The store never runs them: the application's
 * migration does, before a store with the same prefix is used. The results and edges tables hold restricted
 * content (a result's payload and its dependencies); the owners, journal and tombstones tables hold only opaque keys,
 * counters and flags, and none of them references an account table, so removing an account cannot erase its deletion
 * records.
 *
 * @param prefix - Table-name prefix: a lower-case letter, then at most 39 lower-case letters, digits or underscores.
 * @returns The statements, in the order they must run.
 * @throws {Error} `invalid_derivation_table_prefix` when the prefix does not have that form.
 */
export function sourceDerivationSchema(prefix = 'agentos_source_derivation'): readonly string[] {
  const t = sourceDerivationTables(prefix);
  return [
    `CREATE TABLE IF NOT EXISTS ${t.owners} (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      epoch BIGINT NOT NULL DEFAULT 0 CHECK (epoch >= 0 AND epoch <= 9007199254740991),
      active BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (tenant_id, owner_id))`,
    `CREATE TABLE IF NOT EXISTS ${t.results} (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, id TEXT NOT NULL,
      derivation JSONB NOT NULL, payload TEXT NOT NULL,
      expires_at BIGINT NOT NULL CHECK (expires_at >= 0 AND expires_at <= 9007199254740991),
      PRIMARY KEY (tenant_id, owner_id, id),
      FOREIGN KEY (tenant_id, owner_id) REFERENCES ${t.owners}(tenant_id, owner_id))`,
    `CREATE TABLE IF NOT EXISTS ${t.edges} (
      tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL, result_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, source_id TEXT NOT NULL,
      PRIMARY KEY (tenant_id, owner_id, result_id, connection_id, source_id),
      FOREIGN KEY (tenant_id, owner_id, result_id)
        REFERENCES ${t.results}(tenant_id, owner_id, id) ON DELETE CASCADE)`,
    `CREATE INDEX IF NOT EXISTS ${t.expiryIndex} ON ${t.results}(tenant_id, owner_id, expires_at)`,
    `CREATE INDEX IF NOT EXISTS ${t.dependencyIndex}
      ON ${t.edges}(tenant_id, owner_id, connection_id, source_id)`,
    `CREATE TABLE IF NOT EXISTS ${t.journal} (id INTEGER PRIMARY KEY CHECK (id=1))`, `CREATE TABLE IF NOT EXISTS ${t.tombstones} (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id TEXT NOT NULL UNIQUE, tenant_id TEXT NOT NULL, owner_id TEXT NOT NULL,
      epoch BIGINT NOT NULL, at_ms BIGINT NOT NULL,
      affected JSONB NOT NULL, owner_disabled BOOLEAN NOT NULL)`,
  ];
}
