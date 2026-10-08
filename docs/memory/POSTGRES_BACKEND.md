# Postgres + pgvector Backend

The Postgres backend stores embeddings, metadata, and full-text content in a single relational database using the [pgvector](https://github.com/pgvector/pgvector) extension. This gives you ACID transactions, hybrid search (dense vectors and full-text ranking in one query), and JSONB metadata filtering, all without a separate vector service.

## Prerequisites

| Requirement | Minimum version |
|---|---|
| PostgreSQL | 14+ (15+ recommended for `HNSW` index type) |
| pgvector extension | 0.5.0+ (`CREATE EXTENSION vector`) |
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

AgentOS creates its own tables on first use. The schema looks like:

```sql
CREATE TABLE IF NOT EXISTS "<prefix>my_collection" (
  id            TEXT PRIMARY KEY,
  embedding     vector(1536),          -- pgvector column
  metadata_json JSONB,                 -- GIN-indexed for filtering
  text_content  TEXT,                  -- raw text for hybrid search
  tsv           tsvector GENERATED ALWAYS AS (to_tsvector('english', COALESCE(text_content, ''))) STORED,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT
);

-- Indexes created automatically:
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
| `connectionString` | `string` | **required** | Standard Postgres connection URI |
| `poolSize` | `number` | `10` | Max concurrent connections in the pool |
| `defaultDimension` | `number` | `1536` | Embedding vector dimensions for new collections |
| `similarityMetric` | `string` | `'cosine'` | Distance function: `cosine`, `euclidean`, or `dotproduct` |
| `tablePrefix` | `string` | `''` | Table name prefix for multi-tenant deployments |

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
2. **Lexical CTE**: Finds top candidates by `ts_rank()` against the `tsvector` column (`plainto_tsquery('english', ...)`).
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

Each prefix creates a separate set of tables: `"tenant_a_my_collection"`, `"tenant_a__collections"`, etc. Alternatively, use Postgres schemas (`SET search_path`) for stronger isolation.

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
