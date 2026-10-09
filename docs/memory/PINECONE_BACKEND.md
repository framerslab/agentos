# Pinecone Backend

The Pinecone backend stores embeddings in [Pinecone](https://www.pinecone.io/), a fully managed vector database. Pinecone remains fully supported, but it is the optional managed-cloud path rather than the default production recommendation. If you want the recommended open-source production backend, use Qdrant.

## Prerequisites

| Requirement | Notes |
|---|---|
| Pinecone account | Free tier available at [pinecone.io](https://www.pinecone.io/) |
| API key | Found in the Pinecone console under "API Keys" |
| Index created | Create an index in the console or via the Pinecone API |
| Node.js 18+ | Uses native `fetch` (no SDK dependency) |

## Configuration

```typescript
import { PineconeVectorStore } from '@framers/agentos/cognition/rag';

const store = new PineconeVectorStore({
  id: 'my-pinecone',
  type: 'pinecone',
  apiKey: process.env.PINECONE_API_KEY!,
  indexHost: 'https://my-index-abc123.svc.aped-1234.pinecone.io',
  namespace: 'agent-default',
  defaultDimension: 1536,
});

await store.initialize();
```

### Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | **required** | Pinecone API key |
| `indexHost` | `string` | **required** | Data Plane URL for your index (from Pinecone console) |
| `apiVersion` | `string` | `'2026-04'` | Explicit Pinecone API version header used on data-plane requests |
| `namespace` | `string` | `''` | Default namespace; collections map to namespaces |
| `defaultDimension` | `number` | `1536` | Embedding dimensions (must match the index) |

The `indexHost` is the **Data Plane** endpoint for a specific index — not the control plane URL. Find it in the Pinecone console under your index details. It looks like `https://my-index-abc123.svc.aped-1234.pinecone.io`.

## Namespace-based collection isolation

Pinecone namespaces are used as "collections". Each namespace is fully isolated within the same index:

```typescript
// Agent A's memories
await store.upsert('agent-alice', documents);

// Agent B's memories — completely separate namespace
await store.upsert('agent-bob', documents);

// Query only Agent A's namespace
await store.query('agent-alice', embedding, { topK: 10 });
```

Namespaces are created implicitly on first upsert. `createCollection()` is a no-op.

## Metadata filtering

Pinecone supports MongoDB-style metadata filter operators. AgentOS translates its unified [`MetadataFilter`](https://github.com/framerslab/agentos/blob/master/src/core/vector-store/IVectorStore.ts) format to Pinecone's native syntax:

```typescript
const results = await store.query('my-namespace', embedding, {
  topK: 10,
  filter: {
    type: { $eq: 'semantic' },        // Equality
    importance: { $gte: 0.5 },        // Range
    tags: { $in: ['project', 'decision'] }, // Set membership
  },
});
```

### Supported operators

| Operator | Description | Example |
|---|---|---|
| `$eq` | Equal to | `{ status: { $eq: 'active' } }` |
| `$ne` | Not equal to | `{ status: { $ne: 'deleted' } }` |
| `$gt`, `$gte` | Greater than (or equal) | `{ score: { $gt: 0.8 } }` |
| `$lt`, `$lte` | Less than (or equal) | `{ age: { $lt: 30 } }` |
| `$in` | In set | `{ type: { $in: ['a', 'b'] } }` |
| `$nin` | Not in set | `{ type: { $nin: ['x'] } }` |
| `$exists` | Field exists | `{ tags: { $exists: true } }` |

Metadata values must be string, number, boolean, or string arrays. Complex objects are JSON-stringified before storage.

Lifecycle-sensitive metadata operations are also supported:

- `scanByMetadata()` uses Pinecone's `fetch_by_metadata` endpoint for filtered iteration
- `delete(..., { filter })` uses Pinecone's metadata-delete path
- transient `429` / `5xx` failures on query, upsert, scan, and delete are retried with capped exponential backoff

## Limitations

### No hybrid search

Pinecone requires a separate sparse encoder (e.g., SPLADE) for hybrid search. The AgentOS `hybridSearch()` method falls back to dense-only search on Pinecone. For true hybrid search, use the Postgres or Qdrant backends.

### No knowledge graph

There is no sidecar storage for knowledge graph data. If you enable `graph: true` in [`MemoryConfig`](https://github.com/framerslab/agentos/blob/master/src/api/types.ts) with the Pinecone backend, graph data is not persisted.

### Not self-hostable

Pinecone is a managed service only. You cannot run it on your own infrastructure. If self-hosting is a requirement, use Qdrant or Postgres.

### Batch size limit

Pinecone limits upserts to 100 vectors per request. AgentOS handles this automatically by splitting batches, but large ingestion jobs will make many sequential API calls.

### No `deleteAll` count

`delete({ deleteAll: true })` returns `deletedCount: -1` because Pinecone's API does not report how many vectors were deleted in a bulk operation.

`delete(..., { filter })` also returns `deletedCount: -1` for the same reason: Pinecone accepts the delete-by-filter request but does not return an exact deleted-row count.

## Migration FROM Pinecone to self-hosted backends

Use the AgentOS migration engine to move data from Pinecone to Postgres or Qdrant:

```typescript
import { MigrationEngine } from '@framers/agentos/cognition/rag/migration/MigrationEngine';

await MigrationEngine.migrate({
  from: {
    type: 'pinecone',
    // PineconeSourceAdapter uses indexHost + apiKey + namespace
    url: 'https://my-index-abc123.svc.aped-1234.pinecone.io',
    apiKey: process.env.PINECONE_API_KEY!,
  },
  to: {
    type: 'postgres',
    connectionString: 'postgresql://postgres:password@localhost:5432/agent_memory',
  },
  batchSize: 100,
  onProgress: (done, total, table) => {
    console.log(`[${table}] ${done}/${total}`);
  },
});
```

The migration reads vectors via Pinecone's `list` + `fetch` APIs and writes them to the target backend. Non-vector data (knowledge graph, conversations) is not stored in Pinecone and will not be migrated.

## Cost

Pinecone bills by its own plans ([pinecone.io/pricing](https://www.pinecone.io/pricing/)); a self-hosted Qdrant or Postgres backend costs the machine it runs on. For production agents with large knowledge bases, Postgres or Qdrant add hybrid search, and Qdrant is the default open-source production recommendation.
