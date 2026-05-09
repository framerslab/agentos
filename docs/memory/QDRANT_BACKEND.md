# Qdrant Backend

The Qdrant backend stores embeddings in [Qdrant](https://qdrant.tech/), a purpose-built vector database with built-in BM25 sparse vectors for hybrid search. Non-vector data (knowledge graph, document metadata) lives in a sidecar SQLite file alongside Qdrant. Qdrant is the default OSS production recommendation for AgentOS.

## Prerequisites

| Requirement | Minimum version |
|---|---|
| Qdrant | 1.7+ (1.12+ for built-in BM25, 1.16+ for parameterized RRF) |
| Node.js | 18+ (uses native `fetch`) |

## Quick start — Docker

```bash
docker run -d \
  --name agentos-qdrant \
  -p 6333:6333 \
  -p 6334:6334 \
  -v $(pwd)/qdrant_data:/qdrant/storage \
  qdrant/qdrant:v1.13.6

# Verify
curl http://localhost:6333/healthz
```

Port 6333 is the HTTP API; 6334 is gRPC (optional).

## Cloud setup — Qdrant Cloud

1. Create a cluster at [cloud.qdrant.io](https://cloud.qdrant.io).
2. Copy the cluster URL and API key from the dashboard.
3. Configure:

```typescript
import { QdrantVectorStore } from '@framers/agentos/rag/implementations/vector_stores/QdrantVectorStore';

const store = new QdrantVectorStore({
  id: 'my-qdrant',
  type: 'qdrant',
  url: 'https://abc123-xyz.aws.cloud.qdrant.io:6333',
  apiKey: 'your-qdrant-cloud-api-key',
});

await store.initialize({ id: 'my-qdrant', type: 'qdrant', url: '...', apiKey: '...' } as any);
```

## Configuration options

| Option | Type | Default | Description |
|---|---|---|---|
| `url` | `string` | **required** | Qdrant base URL (e.g., `http://localhost:6333`) |
| `apiKey` | `string` | — | API key for Qdrant Cloud or secured deployments |
| `timeoutMs` | `number` | `15000` | Request timeout in milliseconds |
| `denseVectorName` | `string` | `'dense'` | Named vector field for dense embeddings |
| `bm25VectorName` | `string` | `'bm25'` | Named vector field for BM25 sparse vectors |
| `enableBm25` | `boolean` | `true` | Store BM25 sparse vectors and enable hybrid search |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom fetch implementation for testing or edge runtimes |

## Hybrid search (dense + sparse BM25)

When `enableBm25` is true (the default), collections are created with both a dense and a sparse vector field. Text content is automatically indexed with Qdrant's built-in `qdrant/bm25` model.

```typescript
const results = await store.hybridSearch(
  'my_collection',
  queryEmbedding,
  'search query text',
  {
    topK: 10,
    alpha: 0.7,        // Dense weight (0-1); 1-alpha for lexical
    fusion: 'rrf',     // 'rrf' (server-side) or 'weighted' (client-side)
    rrfK: 60,          // RRF constant
  },
);
```

**Server-side RRF** (default): Sends a single prefetch query with both dense and sparse sub-queries. Qdrant fuses results internally. Most efficient.

**Client-side weighted fusion**: Runs two separate queries (dense + BM25) and merges results in the application with weighted reciprocal rank fusion. Use when the server doesn't support parameterized RRF.

## Lifecycle-friendly metadata scans

Qdrant also supports `scanByMetadata()` in the AgentOS vector-store contract. That allows `MemoryLifecycleManager` to enumerate retention/decay candidates by payload filter instead of relying on placeholder discovery logic.

## Collection-per-agent isolation

Each agent (or tenant) gets its own Qdrant collection:

```typescript
await store.createCollection('agent-alice', 1536, { similarityMetric: 'cosine' });
await store.createCollection('agent-bob', 1536, { similarityMetric: 'cosine' });
```

Collections are fully isolated. Deleting one agent's collection does not affect others.

## Knowledge graph sidecar SQLite

Qdrant is a vector database — it stores embeddings and payload metadata. Non-vector data that the memory system needs (knowledge graph nodes/edges, consolidation logs, retrieval feedback, conversation history) lives in a **sidecar SQLite file**.

The sidecar is the same `Brain` used by the default SQLite backend, minus the embedding column (which lives in Qdrant). This means:

- Knowledge graph queries (entity lookup, relation traversal) stay fast (local SQLite).
- Vector queries go through Qdrant's optimized HNSW index.
- Migration between SQLite-only and Qdrant backends is straightforward.

## Scaling beyond 10M vectors

### Sharding

Qdrant supports automatic sharding. When creating a collection:

```bash
curl -X PUT 'http://localhost:6333/collections/my_collection' \
  -H 'Content-Type: application/json' \
  -d '{
    "vectors": { "dense": { "size": 1536, "distance": "Cosine" } },
    "shard_number": 4
  }'
```

For distributed deployments, use Qdrant's built-in replication and sharding across multiple nodes.

### Quantization

Reduce memory usage with scalar or product quantization:

```bash
curl -X PATCH 'http://localhost:6333/collections/my_collection' \
  -H 'Content-Type: application/json' \
  -d '{
    "quantization_config": {
      "scalar": { "type": "int8", "quantile": 0.99, "always_ram": true }
    }
  }'
```

INT8 scalar quantization reduces memory by ~4x with minimal accuracy loss. Binary quantization offers ~32x reduction for filtering-heavy workloads.

### Disk-backed indexes

For datasets that don't fit in RAM:

```bash
curl -X PATCH 'http://localhost:6333/collections/my_collection' \
  -H 'Content-Type: application/json' \
  -d '{
    "hnsw_config": { "on_disk": true },
    "vectors": { "dense": { "on_disk": true } }
  }'
```

## Troubleshooting

### Connection refused

- Verify Qdrant is running: `curl http://localhost:6333/healthz`
- Check Docker port mapping: `docker ps | grep qdrant`
- For cloud: verify the URL includes the port (`:6333`) and HTTPS if required.

### Health check timeout

The default timeout is 15 seconds. Increase `timeoutMs` for slow networks or large datasets:

```typescript
const store = new QdrantVectorStore({
  // ...
  timeoutMs: 30_000,
});
```

### `GMIError: QdrantVectorStore requires a non-empty url`

The `url` field is missing or empty. Ensure the configuration includes a valid Qdrant URL.

### Collection not found (404)

`createCollection()` must be called before upserting data. AgentOS does not auto-create collections — this is by design to prevent accidental data isolation issues.

### Dimension mismatch

If you change embedding dimensions after creating a collection, Qdrant will reject upserts. Delete the collection and recreate it with the correct dimension:

```typescript
await store.deleteCollection('my_collection');
await store.createCollection('my_collection', newDimension);
```

### BM25 not working

Ensure `enableBm25: true` (the default) and that documents include `textContent`. BM25 sparse vectors are only generated for documents with non-empty text content. Qdrant 1.12+ is required for built-in BM25 support.
