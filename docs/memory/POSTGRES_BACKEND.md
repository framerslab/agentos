# Postgres + pgvector Backend

The Postgres backend stores embeddings, metadata, and full-text content in a single relational database using the [pgvector](https://github.com/pgvector/pgvector) extension. This gives you ACID transactions, hybrid search (dense vectors and full-text ranking in one query), and JSONB metadata filtering, all without a separate vector service.

## Prerequisites

| Requirement | Minimum version |
|---|---|
| PostgreSQL | 14+ (15+ recommended for `HNSW` index type) |
| pgvector extension | 0.5.0+ (`CREATE EXTENSION vector`); 0.8.0+ for `iterativeScan` |
| Node.js | 18+ (uses the `pg` npm package) |

## Quick start — Docker

```bash
docker run -d \
  --name agentos-pgvector \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  pgvector/pgvector:pg16

# Verify
psql postgresql://postgres:password@localhost:5432/postgres \
  -c "CREATE EXTENSION IF NOT EXISTS vector; SELECT extversion FROM pg_extension WHERE extname='vector';"
```

The `pgvector/pgvector` image ships with the extension pre-installed. No manual compilation needed.

## Manual setup

If you are using an existing Postgres instance (self-hosted or managed), install pgvector manually:

```sql
-- Run as a superuser or a user with CREATE EXTENSION privilege.
CREATE EXTENSION IF NOT EXISTS vector;
```

AgentOS creates its own tables on first use, unless `manageSchema` is `false` ([Tables made by your migrations](#tables-made-by-your-migrations)). The schema looks like:

```sql
CREATE TABLE IF NOT EXISTS "<prefix>my_collection" (
  id            TEXT PRIMARY KEY,
  embedding     vector(1536),          -- pgvector column
  metadata_json JSONB,                 -- GIN-indexed for filtering
  text_content  TEXT,                  -- raw text for hybrid search
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english'::regconfig, COALESCE(text_content, ''))) STORED,  -- textSearchConfig, 'english' by default
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
);

-- Indexes created automatically, each named after the table ("<prefix>my_collection_hnsw", "_metadata", "_fts")
-- and made only when the table has no index of its kind:
-- 1. HNSW index for approximate nearest neighbor search
-- 2. GIN index on metadata_json for JSONB filtering
-- 3. GIN index on tsv for full-text search
```

## Configuration

```typescript
import { PostgresVectorStore } from '@framers/agentos/cognition/rag';

const store = new PostgresVectorStore({
  id: 'my-pg-store',
  type: 'postgres',
  connectionString: 'postgresql://postgres:password@localhost:5432/agent_memory',
  poolSize: 10,              // Connection pool size (default: 10)
  defaultDimension: 1536,    // Default embedding dimensions (default: 1536)
  similarityMetric: 'cosine', // 'cosine' | 'euclidean' | 'dotproduct'
  tablePrefix: 'agent1_',    // Optional prefix for multi-tenancy
});

await store.initialize();
```

### Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `connectionString` | `string` | required unless `pool` is given | Standard Postgres connection URI |
| `pool` | `PgPoolLike` (a `pg.Pool`) | none | A pool you own: the store opens none, and `close()` leaves it open |
| `poolSize` | `number` | `10` | Max concurrent connections in the pool the store opens |
| `defaultDimension` | `number` | `1536` | Embedding vector dimensions for new collections |
| `similarityMetric` | `string` | `'cosine'` | Distance function: `cosine`, `euclidean`, or `dotproduct` |
| `tablePrefix` | `string` | `''` | Table name prefix for multi-tenant deployments |
| `manageSchema` | `boolean` | `true` | `false`: the store runs no DDL; your migrations make the tables from `PostgresVectorStore.schemaSql()` |
| `textSearchConfig` | `string` | `'english'` | Text search configuration of the `tsv` column and the lexical queries |
| `iterativeScan` | `'strict_order' \| 'relaxed_order'` | none | pgvector's iterative index scan for filtered `query()` and `hybridSearch()` |
| `efSearch` | `number` | pgvector's (40) | `hnsw.ef_search` for a search, 1 to 1000 |
| `maxScanTuples` | `number` | pgvector's (20,000) | `hnsw.max_scan_tuples` for an iterative scan |

## Hybrid search

The Postgres backend runs **hybrid search in one SQL statement**: pgvector HNSW for dense vectors and PostgreSQL full-text ranking (`ts_rank` over the `tsv` column; not BM25), fused with Reciprocal Rank Fusion (RRF). `alpha` and `fusion` are accepted and not read: the two ranks always count equally.

```typescript
const results = await store.hybridSearch(
  'my_collection',
  queryEmbedding,
  'natural language query text',
  {
    topK: 10,
    rrfK: 60,  // RRF constant (default: 60)
  },
);
```

How it works internally:

1. **Dense CTE**: Finds top candidates by pgvector HNSW distance (`<=>` for cosine).
2. **Lexical CTE**: Finds top candidates by `ts_rank()` against the `tsvector` column: `plainto_tsquery` under the store's text search configuration, which asks for every word, or `to_tsquery` over the query's own words when `match` or `prefix` is given ([Lexical search, and the words of a hybrid search](#lexical-search-and-the-words-of-a-hybrid-search)).
3. **Fusion CTE**: Merges both result sets with `1/(k + rank_dense) + 1/(k + rank_lexical)`; a document missing from one list takes rank 10,000 there. Each list holds up to `topK × 3` candidates, and a metadata filter applies to each before ranking.
4. **Final join**: Fetches full documents for the top fused results.

This avoids two separate queries and application-level fusion.

## Multi-tenancy via schema isolation

For SaaS deployments where each tenant needs isolated data:

```typescript
// Tenant A
const storeA = new PostgresVectorStore({
  // ...
  tablePrefix: 'tenant_a_',
});

// Tenant B
const storeB = new PostgresVectorStore({
  // ...
  tablePrefix: 'tenant_b_',
});
```

Each prefix creates a separate set of tables: `"tenant_a_my_collection"`, `"tenant_a__collections"`, etc., with indexes named after each table (`"tenant_a_my_collection_hnsw"` and so on). Alternatively, use Postgres schemas (`SET search_path`) for stronger isolation. For many small tenants in one table, see [One collection, many tenants](#one-collection-many-tenants).

## One collection, many tenants

A table per tenant suits a few large tenants. For many small ones, keep one collection, give every document its tenant's keys in its metadata, and pass them as a filter: the options and methods below keep each search, change and deletion inside the filter.

### A pool you own

```typescript
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const store = new PostgresVectorStore({ id: 'docs', type: 'postgres', pool, manageSchema: false });
```

With `pool`, the store opens no pool of its own and `close()` leaves yours open; `connectionString` is then not needed. With neither, `initialize()` throws.

### Tables made by your migrations

`manageSchema: false` turns off every statement that changes the schema: `initialize()` runs no `CREATE EXTENSION` and makes no collections table, and `createCollection()` does nothing. `CREATE EXTENSION vector` and the tables are then yours, and `PostgresVectorStore.schemaSql()` prints one collection's statements for a migration:

```typescript
const statements = PostgresVectorStore.schemaSql('chunks', 1536, {
  metric: 'cosine',          // the default; 'euclidean' and 'dotproduct' choose the other operator classes
  tablePrefix: 'app_',
  textSearchConfig: 'simple',
});
// CREATE TABLE IF NOT EXISTS "app_chunks" (...), then CREATE INDEX for "app_chunks_hnsw", "_metadata" and "_fts"
```

The third argument may also be the metric alone: `schemaSql('chunks', 1536, 'cosine')`. Give the store the same prefix, text search configuration and `similarityMetric`: with `manageSchema: false` it takes the metric from `similarityMetric` and reads no collections table. `schemaSql()` throws unless the collection's name, with and without its prefix, is letters, digits and underscores that do not start with a digit, and the dimension is a positive integer. `dropCollection()` throws on a store with `manageSchema: false`: its tables are dropped by a migration too.

### Text search configuration

`textSearchConfig` (default `'english'`) names the configuration of the `tsv` column that `createCollection()` adds and of every lexical query; it must be a plain lower-case name. `'simple'` lower-cases words and stems none, which suits text in several languages. A column keeps the configuration it was made with, so give a store over an existing table the configuration its column was made with.

### Filters on array fields

`$in`, `$nin`, `$all` and `$contains` read a field that holds an array as well as one that holds a single value:

| Operator | Single value | Array |
|---|---|---|
| `$in: [...]` | the value, as text, is in the list | the array holds a value in the list |
| `$nin: [...]` | the field is present and its value, as text, is not in the list | the field is present and the array holds no value in the list |
| `$all: [...]` | no match | the array holds every value |
| `$contains: v` | the text contains `v` | the array holds `v` |

An array's elements are compared as JSON values, so `$in: [5]` matches an array that holds the number 5 and not one that holds the string `'5'`; a single value is compared as text.

```typescript
await store.query('chunks', embedding, {
  topK: 8,
  filter: { tenantId: 'org_1', aclGroups: { $in: ['acct:42', 'org:org_1'] } },
});
```

A metadata key in a filter, and a key `updateMetadata()` sets or removes, must be letters, digits, underscore, dot or hyphen, since a filter's key is written into the SQL; any other key throws.

A key's condition takes `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$all`, `$exists`, `$contains` and `$textSearch`, which matches a string value that contains the text, in any case. Any other operator, `$in`, `$nin` or `$all` without an array, and a condition with no operator throw rather than drop out of the SQL, so no search, change or deletion runs wider than its filter.

### Deleting and changing by filter

```typescript
await store.delete('chunks', undefined, { filter: { sourceId: 'doc_7' } });
await store.updateMetadata('chunks', { sourceId: 'doc_7' }, { aclGroups: ['org:org_1'], folderId: null });
```

`delete()` deletes by `ids` when they are given; otherwise by `options.filter`, where a filter that yields no condition deletes nothing; otherwise every row when `deleteAll` is set. `updateMetadata()` merges the patch into the metadata of every document the filter matches: a key given as `null` is removed, the others replace the stored values, and the rest stays. It throws when the filter holds no condition, so that no call changes every document.

A filter compiles each comparison of a key's value to an expression on `metadata_json->>'key'` or `metadata_json->'key'`, which the GIN index on `metadata_json` does not serve ([PostgreSQL: jsonb indexing](https://www.postgresql.org/docs/current/datatype-json.html#JSON-INDEXING)), so without an index of your own on that expression `delete()` and `updateMetadata()` by such a filter read every row of the collection, and a large collection changed this way is better split into narrower ones.

### Lexical search, and the words of a hybrid search

```typescript
// Every word, each also matching a longer stored word: "chap budg" finds "chapters of the budget".
await store.lexicalSearch('chunks', 'chap budg', { topK: 20, match: 'all', prefix: true, filter: { tenantId: 'org_1' } });

// A question's own words on the hybrid search's lexical leg: any of them may match.
await store.hybridSearch('chunks', embedding, 'what did we decide about the budget', { topK: 8, match: 'any' });
```

`lexicalSearch()` searches the `tsv` column alone, with no embedding, and ranks by `ts_rank`. The query's words are its runs of letters and digits, lower-cased, at most 32. `match` asks for every word (`'all'`) or any word (`'any'`, the default), and `prefix: true` lets each word match a stored word that begins with it. A query with no word returns no document and runs no search.

`hybridSearch()` takes the same `match` and `prefix` for its lexical leg, with `match` `'any'` when only `prefix` is given, and a query with no word then runs the dense search alone. Without either option its lexical leg reads the query with `plainto_tsquery`, which asks for every word.

### Filtered searches and iterative scans

pgvector applies a filter after it scans an HNSW index, so a filtered `query()` or `hybridSearch()` can return fewer than `topK` rows: the scan holds `hnsw.ef_search` candidates (40 by default) whether or not they pass the filter ([pgvector: iterative index scans](https://github.com/pgvector/pgvector#iterative-index-scans)). With `iterativeScan` (pgvector 0.8.0 and later) the scan goes on until the filtered search has its rows or has visited `hnsw.max_scan_tuples` (20,000 by default):

```typescript
const store = new PostgresVectorStore({
  id: 'docs', type: 'postgres', pool, manageSchema: false,
  iterativeScan: 'strict_order', // or 'relaxed_order'
  efSearch: 100,                  // hnsw.ef_search, 1 to 1000
  maxScanTuples: 20000,           // hnsw.max_scan_tuples
});
```

With any of the three set, `query()` and `hybridSearch()` run in a transaction on one connection with `SET LOCAL`, so the settings never reach the pool's other users. `relaxed_order` may return rows slightly out of distance order: `query()` sorts its rows again by similarity, and `hybridSearch()` returns its rows in fused-score order. `lexicalSearch()` reads no HNSW index and runs with no setting.

## Cloud providers

Any managed Postgres with pgvector works. Just set the connection string:

| Provider | Connection string example |
|---|---|
| **Neon** | `postgresql://user:pass@ep-cool-grass-123456.us-east-2.aws.neon.tech/neondb?sslmode=require` |
| **Supabase** | `postgresql://postgres:pass@db.xyzabc.supabase.co:5432/postgres` |
| **AWS RDS** | `postgresql://postgres:pass@mydb.cluster-xyz.us-east-1.rds.amazonaws.com:5432/mydb` |
| **Google Cloud SQL** | `postgresql://postgres:pass@/mydb?host=/cloudsql/project:region:instance` |
| **Azure Flexible Server** | `postgresql://postgres:pass@myserver.postgres.database.azure.com:5432/mydb?sslmode=require` |

All of these support pgvector. Neon and Supabase have it pre-installed. For RDS, enable the `pgvector` extension in the parameter group.

## Troubleshooting

### `ERROR: could not open extension control file "vector"`

pgvector is not installed. On managed services, check that the extension is enabled in your database configuration. For self-hosted:

```bash
# Ubuntu/Debian
sudo apt install postgresql-16-pgvector

# macOS (Homebrew)
brew install pgvector
```

Then run `CREATE EXTENSION vector;` as a superuser.

### `ERROR: different vector dimensions`

You changed `defaultDimension` after creating a collection. pgvector enforces dimension constraints at the column level. Drop and recreate the collection, or create a new collection with the correct dimension.

### Connection refused / timeout

- Verify the connection string host, port, and credentials.
- Check that `pg_hba.conf` allows connections from your IP.
- For Docker: ensure `-p 5432:5432` is set and the container is running.
- For cloud: check firewall / security group rules.

### Pool exhaustion (`too many clients already`)

Increase `poolSize` in the config, or reduce concurrent usage. The default of 10 is usually sufficient for single-agent deployments. Multi-agent setups may need 20-50.

## Postgres for the cognitive Brain

Beyond the [`PostgresVectorStore`](https://github.com/framerslab/agentos/blob/master/src/cognition/rag/vector_stores/PostgresVectorStore.ts), AgentOS runs the entire cognitive [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) on Postgres via three named factories. The [`Brain`](https://github.com/framerslab/agentos/blob/master/src/cognition/memory/retrieval/store/Brain.ts) class is dialect-agnostic; the factory chooses the backend.

```ts
import { Brain } from '@framers/agentos/memory';

const brain = await Brain.openPostgres(
  'postgresql://user:pass@host:5432/db',
  { brainId: 'companion-alice', poolSize: 10 },
);
```

`brainId` is required in Postgres mode because all brains share the same schema. The discriminator scopes every query so two brains in the same database stay isolated. Per-file SQLite mode derives `brainId` from the filename automatically.

### Multi-tenant isolation

```ts
const aliceBrain = await Brain.openPostgres(connStr, { brainId: 'companion-alice' });
const bobBrain = await Brain.openPostgres(connStr, { brainId: 'companion-bob' });

// alice's traces are not visible to bob (and vice versa).
await aliceBrain.run(
  `INSERT INTO memory_traces (brain_id, id, type, scope, content, created_at)
   VALUES ($1, $2, $3, $4, $5, $6)`,
  ['companion-alice', 't1', 'episodic', 'user', 'private to alice', Date.now()],
);
```

### Sharing an adapter pool

When the application already owns a [`StorageAdapter`](https://github.com/framerslab/sql-storage-adapter/blob/master/src/core/contracts/index.ts) (e.g. wilds-ai's foundation store) and wants the brain to share that connection pool:

```ts
import { Brain } from '@framers/agentos/memory';
import { createDatabase } from '@framers/sql-storage-adapter';

const adapter = await createDatabase({
  postgres: { connectionString: process.env.DATABASE_URL },
});
const brain = await Brain.openWithAdapter(adapter, { brainId: 'companion-alice' });
```

**Pool contention:** the pool is shared across all brains opened against the same adapter. Five brains opened against a `max: 10` pool compete for the same 10 connections; one slow query can starve the others. Size the pool for the total concurrent query load across all brains, not per-brain. For high-fan-out deployments (e.g., one process serving 50 active brains), consider a dedicated pool per brain via `Brain.openPostgres(connStr, { brainId, poolSize: N })` instead of sharing.

Schema migrations take a `pg_advisory_xact_lock` keyed on the `brainId`, which serializes concurrent first-opens of the same brain. The lock is per-brain (different brainIds boot in parallel; same brainId from two workers serializes), so pool sizing should account for one extra connection-second per brain at process startup.

### Schema migration

The first call to `Brain.openPostgres` (or `openSqlite`) on an existing v1 database runs an idempotent v1→v2 migration that adds the `brain_id` column to every brain-owned table and updates primary keys to `(brain_id, id)`. SQLite uses the recreate-table dance; Postgres uses `ALTER TABLE ADD COLUMN` + `ALTER TABLE ADD PRIMARY KEY`. Subsequent opens are no-ops once the schema is at v2.

### Portable export / import

The brain's `exportToSqlite()` and `importFromSqlite()` decouple portability from live storage. Use a Postgres-backed live brain in production while keeping `.wildsoul`-style snapshots as portable SQLite files:

```ts
const liveBrain = await Brain.openPostgres(connStr, { brainId: 'alice' });
await liveBrain.exportToSqlite('/tmp/alice-snapshot.sqlite');

// Later, fork into a different brain (importing rewrites brain_id).
const forkBrain = await Brain.openPostgres(connStr, { brainId: 'alice-fork' });
await forkBrain.importFromSqlite('/tmp/alice-snapshot.sqlite');
```

---

## See also

- [Incremental Vector Ingestion](./INCREMENTAL_VECTOR_INGESTION.md): content-hash caching to keep a flat pgvector collection in sync, re-embedding only the chunks that changed.
