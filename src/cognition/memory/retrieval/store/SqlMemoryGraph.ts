/**
 * @fileoverview SQLite-backed implementation of IMemoryGraph.
 *
 * Stores memory graph nodes in the `knowledge_nodes` table (type = 'memory_graph')
 * and memory association edges in the `knowledge_edges` table — both managed by
 * Brain. All node metadata is serialised into the `properties` JSON column.
 *
 * ## Algorithms
 *
 * ### Spreading activation (Anderson's ACT-R model)
 * BFS from each seed node. At each hop the activation value is multiplied by
 * `(1 - decayPerHop) * edgeWeight`, modelling the attenuation of priming
 * signals as they propagate through associative memory. Multiple paths to the
 * same node are resolved by keeping the maximum activation reached so far
 * (best-path semantics). The BFS terminates when:
 * - the current activation falls below `activationThreshold`, or
 * - the hop count exceeds `maxDepth`.
 *
 * ### Hebbian co-activation (recordCoActivation)
 * For every unordered pair (A, B) in `memoryIds`, a CO_ACTIVATED edge is
 * upserted. If the edge already exists its weight is incremented by
 * `learningRate` (capped at 1.0). This implements the classic Hebbian rule:
 * "neurons that fire together wire together".
 *
 * ### Connected-component clustering (detectClusters)
 * Union-Find (path-compressed) over all edges in the graph. Each component
 * with at least `minSize` members is returned as a {@link MemoryCluster}.
 * The `centroidId` is chosen as the member with the highest total edge weight
 * (i.e. the most central node in the component's subgraph).
 *
 * @module memory/store/SqlMemoryGraph
 */

import { sha256 } from '../../core/util/crossPlatformCrypto.js';
import type { Brain } from './Brain.js';
import type {
  IMemoryGraph,
  MemoryEdge,
  MemoryEdgeType,
  MemoryGraphNodeMeta,
  SpreadingActivationConfig,
  ActivatedNode,
  MemoryCluster,
} from '../graph/IMemoryGraph.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Hard cap on BFS queue size during spreading activation.
 * Prevents unbounded memory growth when "better path" re-enqueues create
 * an explosion of entries in dense graphs.
 */
const MAX_QUEUE_SIZE = 10_000;

// ---------------------------------------------------------------------------
// Internal row shapes
// ---------------------------------------------------------------------------

/** Row shape returned from `knowledge_nodes` for memory graph entries. */
interface NodeRow {
  id: string;
  properties: string;
}

/** Row shape returned from `knowledge_edges` for memory graph edges. */
interface EdgeRow {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  created_at: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default spreading activation parameters (ACT-R reasonable defaults). */
const SA_DEFAULTS: Required<SpreadingActivationConfig> = {
  maxDepth: 3,
  decayPerHop: 0.5,
  activationThreshold: 0.1,
  maxResults: 20,
};

/** Node type discriminator stored in knowledge_nodes.type. */
const NODE_TYPE = 'memory_graph';

/** The `knowledge_edges.type` values of the memory graph's edges (the `MemoryEdgeType` values), as an SQL list. */
const MEMORY_EDGE_TYPES_SQL = `'SHARED_ENTITY','TEMPORAL_SEQUENCE','SAME_TOPIC',
         'CONTRADICTS','SUPERSEDES','CAUSED_BY','CO_ACTIVATED','SCHEMA_INSTANCE'`;

// ---------------------------------------------------------------------------
// SqlMemoryGraph
// ---------------------------------------------------------------------------

/**
 * SQLite-backed implementation of {@link IMemoryGraph}.
 *
 * **Thread safety**: inherits the underlying adapter's concurrency model.
 * Writes serialise automatically through WAL when using SQLite-backed adapters.
 *
 * **Usage:**
 * ```ts
 * const brain = await Brain.openSqlite('/path/to/brain.sqlite');
 * const graph = new SqlMemoryGraph(brain);
 * await graph.initialize();
 *
 * await graph.addNode('mem-1', { type: 'episodic', scope: 'session', scopeId: 's1', strength: 1.0, createdAt: Date.now() });
 * await graph.addEdge({ sourceId: 'mem-1', targetId: 'mem-2', type: 'SAME_TOPIC', weight: 0.8, createdAt: Date.now() });
 *
 * const activated = await graph.spreadingActivation(['mem-1']);
 * ```
 */
export class SqlMemoryGraph implements IMemoryGraph {
  /**
   * In-memory node index: maps memoryId → MemoryGraphNodeMeta.
   *
   * We keep an in-memory cache so that `hasNode()` and `nodeCount()` are O(1)
   * without requiring a synchronous SQLite query (both are called from
   * hot-path retrieval code). The cache is hydrated during `initialize()` and
   * kept in sync through every `addNode` / `removeNode` / `clear` call.
   */
  private readonly _nodes = new Map<string, MemoryGraphNodeMeta>();

  /**
   * In-memory edge index: maps `${sourceId}:${targetId}` → MemoryEdge.
   *
   * Edges are also kept in-memory for O(1) adjacency lookups used by
   * spreading activation and cluster detection. Persisted to SQLite on every
   * write so the graph survives restarts.
   */
  private readonly _edges = new Map<string, MemoryEdge>();

  // ---------------------------------------------------------------------------
  // Constructor
  // ---------------------------------------------------------------------------

  /**
   * @param brain - The shared Brain connection for this agent.
   *   The `knowledge_nodes` and `knowledge_edges` tables must already exist
   *   (Brain creates them in its constructor).
   */
  constructor(private readonly brain: Brain) {}

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Hydrate the in-memory node and edge caches from the SQLite database.
   *
   * Must be called once before any other method. Safe to call multiple times
   * (idempotent — fully replaces in-memory state each time).
   */
  async initialize(): Promise<void> {
    this._nodes.clear();
    this._edges.clear();

    // Load all memory graph nodes.
    const nodeRows = await this.brain.all<NodeRow>(
      `SELECT id, properties FROM knowledge_nodes WHERE brain_id = ? AND type = ?`,
      [this.brain.brainId, NODE_TYPE],
    );

    for (const row of nodeRows) {
      try {
        const meta = JSON.parse(row.properties) as MemoryGraphNodeMeta;
        this._nodes.set(row.id, meta);
      } catch {
        // Skip rows with corrupted JSON — log is intentionally omitted to
        // avoid pulling in a logger dependency here.
      }
    }

    // Load all edges whose source node is a memory graph node.
    // We identify them by checking the source_id against known node IDs.
    // Because the edge type column stores the MemoryEdgeType string directly,
    // we can filter by the set of known types.
    const edgeRows = await this.brain.all<EdgeRow>(
      `SELECT id, source_id, target_id, type, weight, created_at
       FROM knowledge_edges
       WHERE brain_id = ? AND type IN (${MEMORY_EDGE_TYPES_SQL})`,
      [this.brain.brainId],
    );

    for (const row of edgeRows) {
      const key = `${row.source_id}:${row.target_id}`;
      this._edges.set(key, {
        sourceId: row.source_id,
        targetId: row.target_id,
        type: row.type as MemoryEdgeType,
        weight: row.weight,
        createdAt: row.created_at,
      });
    }
  }

  /**
   * Shut down the memory graph.
   *
   * Currently a no-op because Brain owns the DB connection lifetime.
   * Provided for interface compliance and forward compatibility.
   */
  async shutdown(): Promise<void> {
    // No-op: Brain owns the connection; callers must call brain.close().
  }

  // ---------------------------------------------------------------------------
  // Node operations
  // ---------------------------------------------------------------------------

  /**
   * Add a memory node to the graph.
   *
   * The node is persisted to `knowledge_nodes` (type = 'memory_graph') with
   * the metadata serialised into the `properties` JSON column. If a node with
   * the same `memoryId` already exists it is silently replaced (upsert).
   *
   * @param memoryId - Unique identifier for the memory trace this node represents.
   * @param metadata - Structural metadata describing the memory.
   */
  async addNode(memoryId: string, metadata: MemoryGraphNodeMeta): Promise<void> {
    const now = Date.now();

    const { dialect } = this.brain.features;
    await this.brain.run(
      dialect.insertOrReplace(
        'knowledge_nodes',
        ['brain_id', 'id', 'type', 'label', 'properties', 'confidence', 'source', 'created_at'],
        ['?', '?', '?', '?', '?', '?', '?', '?'],
        'brain_id, id',
      ),
      [
        this.brain.brainId,
        memoryId,
        NODE_TYPE,
        memoryId,
        JSON.stringify(metadata),
        metadata.strength,
        JSON.stringify({}),
        metadata.createdAt ?? now,
      ],
    );

    this._nodes.set(memoryId, metadata);
  }

  /**
   * Remove a node and all its incident edges from the graph.
   *
   * Edges referencing the removed node are deleted from both SQLite and the
   * in-memory cache to keep the graph consistent. The SQL delete takes every
   * memory-graph edge that names the node, those another graph instance on the
   * same Brain wrote after this one loaded included, so the node's own delete
   * meets no edge that still references it.
   *
   * @param memoryId - ID of the node to remove.
   */
  async removeNode(memoryId: string): Promise<void> {
    // Delete incident edges first: foreign keys are on, and an edge that names
    // the node would refuse its delete.
    await this.brain.run(
      `DELETE FROM knowledge_edges
        WHERE brain_id = ? AND (source_id = ? OR target_id = ?) AND type IN (${MEMORY_EDGE_TYPES_SQL})`,
      [this.brain.brainId, memoryId, memoryId],
    );
    for (const [key, edge] of this._edges) {
      if (edge.sourceId === memoryId || edge.targetId === memoryId) {
        this._edges.delete(key);
      }
    }

    // Now delete the node itself.
    await this.brain.run(
      `DELETE FROM knowledge_nodes WHERE brain_id = ? AND id = ? AND type = ?`,
      [this.brain.brainId, memoryId, NODE_TYPE],
    );

    this._nodes.delete(memoryId);
  }

  /**
   * Check whether a node exists in the graph.
   *
   * O(1) in-memory lookup — does not touch SQLite.
   *
   * @param memoryId - ID to check.
   * @returns `true` if the node is present, `false` otherwise.
   */
  hasNode(memoryId: string): boolean {
    return this._nodes.has(memoryId);
  }

  // ---------------------------------------------------------------------------
  // Edge operations
  // ---------------------------------------------------------------------------

  /**
   * Add a directed edge between two memory nodes.
   *
   * If an edge with the same `(sourceId, targetId)` pair already exists it is
   * replaced (upsert by composite key). The underlying SQLite row is identified
   * by a deterministic UUID derived from the source/target pair so that
   * repeated upserts land on the same row.
   *
   * @param edge - Edge descriptor including type, weight, and timestamp.
   */
  async addEdge(edge: MemoryEdge): Promise<void> {
    const edgeId = await this._edgeId(edge.sourceId, edge.targetId);
    const key = `${edge.sourceId}:${edge.targetId}`;

    const { dialect } = this.brain.features;
    await this.brain.run(
      dialect.insertOrReplace(
        'knowledge_edges',
        ['brain_id', 'id', 'source_id', 'target_id', 'type', 'weight', 'bidirectional', 'metadata', 'created_at'],
        ['?', '?', '?', '?', '?', '?', '0', "'{}'", '?'],
        'brain_id, id',
      ),
      [this.brain.brainId, edgeId, edge.sourceId, edge.targetId, edge.type, edge.weight, edge.createdAt],
    );

    this._edges.set(key, { ...edge });
  }

  /**
   * Retrieve all edges incident to a memory node.
   *
   * Returns edges where `memoryId` appears as either source or target.
   * Optionally filters by edge type.
   *
   * O(E) scan over the in-memory edge map — acceptable for typical graph sizes
   * (< 10k edges).
   *
   * @param memoryId - Node ID to query.
   * @param type     - Optional edge type filter.
   * @returns Array of matching {@link MemoryEdge} objects.
   */
  getEdges(memoryId: string, type?: MemoryEdgeType): MemoryEdge[] {
    const result: MemoryEdge[] = [];

    for (const edge of this._edges.values()) {
      if (edge.sourceId !== memoryId && edge.targetId !== memoryId) continue;
      if (type !== undefined && edge.type !== type) continue;
      result.push({ ...edge });
    }

    return result;
  }

  /**
   * Remove a directed edge from the graph.
   *
   * @param sourceId - Source node ID.
   * @param targetId - Target node ID.
   */
  async removeEdge(sourceId: string, targetId: string): Promise<void> {
    const edgeId = await this._edgeId(sourceId, targetId);

    await this.brain.run(
      `DELETE FROM knowledge_edges WHERE brain_id = ? AND id = ?`,
      [this.brain.brainId, edgeId],
    );

    this._edges.delete(`${sourceId}:${targetId}`);
  }

  // ---------------------------------------------------------------------------
  // Spreading activation (ACT-R)
  // ---------------------------------------------------------------------------

  /**
   * Run spreading activation from a set of seed nodes.
   *
   * Implements Anderson's ACT-R spreading activation model using BFS:
   *
   * 1. Each seed node starts with activation = 1.0.
   * 2. When a node propagates to a neighbour, the neighbour's activation
   *    receives: `parentActivation * (1 - decayPerHop) * edgeWeight`.
   * 3. If a node is reached by multiple paths, the maximum activation is kept.
   * 4. Nodes below `activationThreshold` are not expanded further.
   * 5. BFS stops at depth `maxDepth`.
   *
   * Seed nodes are excluded from the returned list (they are the query, not
   * the result).
   *
   * @param seedIds - IDs of the memory nodes that trigger the activation.
   * @param config  - Optional tuning parameters.
   * @returns Activated nodes sorted by activation descending, capped at `maxResults`.
   */
  async spreadingActivation(
    seedIds: string[],
    config?: SpreadingActivationConfig,
  ): Promise<ActivatedNode[]> {
    const { maxDepth, decayPerHop, activationThreshold, maxResults } = {
      ...SA_DEFAULTS,
      ...config,
    };

    const seedSet = new Set(seedIds);

    /**
     * Maps memoryId → best (activation, depth, activatedBy set) seen so far.
     * We track activatedBy to attribute which seeds contributed.
     */
    const visited = new Map<
      string,
      { activation: number; depth: number; activatedBy: Set<string> }
    >();

    /**
     * BFS queue entry.
     * `seedOrigin` is the seed node that started this particular activation wave.
     */
    interface QueueEntry {
      nodeId: string;
      activation: number;
      depth: number;
      seedOrigin: string;
    }

    const queue: QueueEntry[] = [];

    // Initialise the queue with each seed at full activation.
    for (const seedId of seedIds) {
      if (!this._nodes.has(seedId)) continue;
      queue.push({ nodeId: seedId, activation: 1.0, depth: 0, seedOrigin: seedId });
    }

    // Process the queue. The MAX_QUEUE_SIZE guard prevents unbounded growth
    // when dense graphs cause many "better path" re-enqueues.
    while (queue.length > 0) {
      const { nodeId, activation, depth, seedOrigin } = queue.shift()!;

      // Propagate to neighbours if we have headroom.
      if (depth < maxDepth && activation >= activationThreshold) {
        for (const edge of this._edges.values()) {
          let neighbourId: string | null = null;

          if (edge.sourceId === nodeId) {
            neighbourId = edge.targetId;
          } else if (edge.targetId === nodeId) {
            // Treat all edges as bidirectional for spreading activation —
            // associative priming flows both ways in memory research.
            neighbourId = edge.sourceId;
          }

          if (neighbourId === null) continue;
          if (seedSet.has(neighbourId)) continue; // don't activate seeds

          const newActivation = activation * (1 - decayPerHop) * edge.weight;
          if (newActivation < activationThreshold) continue;

          const existing = visited.get(neighbourId);
          if (existing) {
            if (newActivation > existing.activation) {
              // Better path found — update and re-enqueue.
              existing.activation = newActivation;
              existing.depth = depth + 1;
              existing.activatedBy.add(seedOrigin);
              if (queue.length < MAX_QUEUE_SIZE) {
                queue.push({
                  nodeId: neighbourId,
                  activation: newActivation,
                  depth: depth + 1,
                  seedOrigin,
                });
              }
            } else {
              // Just attribute this seed to the existing entry.
              existing.activatedBy.add(seedOrigin);
            }
          } else {
            visited.set(neighbourId, {
              activation: newActivation,
              depth: depth + 1,
              activatedBy: new Set([seedOrigin]),
            });
            if (queue.length < MAX_QUEUE_SIZE) {
              queue.push({
                nodeId: neighbourId,
                activation: newActivation,
                depth: depth + 1,
                seedOrigin,
              });
            }
          }
        }
      }
    }

    // Convert to ActivatedNode[], sort descending by activation, cap at maxResults.
    const results: ActivatedNode[] = [];

    for (const [memoryId, { activation, depth, activatedBy }] of visited) {
      results.push({
        memoryId,
        activation,
        depth,
        activatedBy: Array.from(activatedBy),
      });
    }

    results.sort((a, b) => b.activation - a.activation);
    return results.slice(0, maxResults);
  }

  // ---------------------------------------------------------------------------
  // Hebbian co-activation
  // ---------------------------------------------------------------------------

  /**
   * Record that a set of memories were activated together (Hebbian learning).
   *
   * For every unordered pair (A, B) in `memoryIds`, a CO_ACTIVATED edge is
   * upserted:
   * - If no edge exists, it is created with `weight = learningRate`.
   * - If an edge already exists, its weight is incremented by `learningRate`
   *   and capped at 1.0.
   *
   * This implements the Hebbian rule "neurons that fire together wire together"
   * at the memory graph level, gradually strengthening associations between
   * memories that are frequently retrieved in the same context.
   *
   * @param memoryIds    - IDs of co-activated memories.
   * @param learningRate - Weight increment per co-activation event. @default 0.1
   */
  async recordCoActivation(memoryIds: string[], learningRate = 0.1): Promise<void> {
    if (memoryIds.length < 2) return;

    const now = Date.now();

    // Process all unordered pairs.
    for (let i = 0; i < memoryIds.length; i++) {
      for (let j = i + 1; j < memoryIds.length; j++) {
        const sourceId = memoryIds[i]!;
        const targetId = memoryIds[j]!;
        const key = `${sourceId}:${targetId}`;
        const existing = this._edges.get(key);

        if (existing && existing.type === 'CO_ACTIVATED') {
          // Increment weight, capped at 1.0.
          const newWeight = Math.min(1.0, existing.weight + learningRate);
          existing.weight = newWeight;

          // Update SQLite row weight in-place.
          const edgeId = await this._edgeId(sourceId, targetId);
          await this.brain.run(
            `UPDATE knowledge_edges SET weight = ? WHERE brain_id = ? AND id = ?`,
            [newWeight, this.brain.brainId, edgeId],
          );
        } else {
          // Create a new CO_ACTIVATED edge.
          await this.addEdge({
            sourceId,
            targetId,
            type: 'CO_ACTIVATED',
            weight: learningRate,
            createdAt: now,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Conflict detection
  // ---------------------------------------------------------------------------

  /**
   * Return all CONTRADICTS edges incident to a given memory node.
   *
   * A CONTRADICTS edge signals that two memories express mutually incompatible
   * beliefs or facts. The consolidation engine uses this to trigger
   * conflict-resolution passes.
   *
   * @param memoryId - The memory node to check for contradictions.
   * @returns Array of CONTRADICTS edges (may be empty).
   */
  getConflicts(memoryId: string): MemoryEdge[] {
    return this.getEdges(memoryId, 'CONTRADICTS');
  }

  // ---------------------------------------------------------------------------
  // Cluster detection (Union-Find)
  // ---------------------------------------------------------------------------

  /**
   * Detect connected components (clusters) in the memory graph.
   *
   * Uses path-compressed Union-Find over all edges. Components are filtered
   * to those with at least `minSize` members.
   *
   * The `centroidId` of each cluster is the member with the highest total
   * incident edge weight (most central node). If the cluster has only one
   * member, `centroidId` equals that member.
   *
   * The `density` of a cluster is computed as:
   * `actualEdges / maxPossibleEdges` where `maxPossibleEdges = n*(n-1)`.
   * For single-member clusters, density = 0.
   *
   * @param minSize - Minimum component size to include. @default 2
   * @returns Array of {@link MemoryCluster} objects.
   */
  async detectClusters(minSize = 2): Promise<MemoryCluster[]> {
    const nodeIds = Array.from(this._nodes.keys());
    if (nodeIds.length === 0) return [];

    // ---------------------------------------------------------------------------
    // Union-Find with path compression + union by rank.
    // ---------------------------------------------------------------------------
    const parent = new Map<string, string>();
    const rank = new Map<string, number>();

    const find = (id: string): string => {
      if (!parent.has(id)) {
        parent.set(id, id);
        rank.set(id, 0);
      }
      if (parent.get(id) !== id) {
        parent.set(id, find(parent.get(id)!));
      }
      return parent.get(id)!;
    };

    const union = (a: string, b: string): void => {
      const ra = find(a);
      const rb = find(b);
      if (ra === rb) return;

      const rankA = rank.get(ra) ?? 0;
      const rankB = rank.get(rb) ?? 0;

      if (rankA < rankB) {
        parent.set(ra, rb);
      } else if (rankA > rankB) {
        parent.set(rb, ra);
      } else {
        parent.set(rb, ra);
        rank.set(ra, rankA + 1);
      }
    };

    // Initialise every known node.
    for (const id of nodeIds) {
      find(id);
    }

    // Merge components using all edges.
    for (const edge of this._edges.values()) {
      // Only union nodes that exist in the graph.
      if (this._nodes.has(edge.sourceId) && this._nodes.has(edge.targetId)) {
        union(edge.sourceId, edge.targetId);
      }
    }

    // ---------------------------------------------------------------------------
    // Collect members per root.
    // ---------------------------------------------------------------------------
    const components = new Map<string, string[]>();

    for (const id of nodeIds) {
      const root = find(id);
      if (!components.has(root)) components.set(root, []);
      components.get(root)!.push(id);
    }

    // ---------------------------------------------------------------------------
    // Build cluster objects for components >= minSize.
    // ---------------------------------------------------------------------------
    const clusters: MemoryCluster[] = [];

    for (const [, members] of components) {
      if (members.length < minSize) continue;

      // Compute per-member total edge weight to find the centroid.
      const weightSum = new Map<string, number>();
      for (const m of members) weightSum.set(m, 0);

      const memberSet = new Set(members);
      let internalEdgeCount = 0;

      for (const edge of this._edges.values()) {
        if (memberSet.has(edge.sourceId) && memberSet.has(edge.targetId)) {
          weightSum.set(edge.sourceId, (weightSum.get(edge.sourceId) ?? 0) + edge.weight);
          weightSum.set(edge.targetId, (weightSum.get(edge.targetId) ?? 0) + edge.weight);
          internalEdgeCount++;
        }
      }

      // Centroid = member with highest total incident weight.
      let centroidId = members[0]!;
      let maxWeight = -Infinity;
      for (const m of members) {
        const w = weightSum.get(m) ?? 0;
        if (w > maxWeight) {
          maxWeight = w;
          centroidId = m;
        }
      }

      // Density = actualEdges / (n * (n-1))  — directed graph formula.
      const n = members.length;
      const maxEdges = n * (n - 1);
      const density = maxEdges > 0 ? internalEdgeCount / maxEdges : 0;

      clusters.push({
        clusterId: centroidId,
        memberIds: members,
        density,
      });
    }

    return clusters;
  }

  // ---------------------------------------------------------------------------
  // Stats & lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Return the number of nodes currently in the graph.
   * O(1) — backed by the in-memory Map size.
   */
  nodeCount(): number {
    return this._nodes.size;
  }

  /**
   * Return the number of edges currently in the graph.
   * O(1) — backed by the in-memory Map size.
   */
  edgeCount(): number {
    return this._edges.size;
  }

  /**
   * Remove all nodes and edges from the graph (both in-memory and SQLite).
   *
   * This is a destructive, irreversible operation. Intended for tests and
   * administrative resets only.
   */
  async clear(): Promise<void> {
    const brainId = this.brain.brainId;
    // Delete all knowledge_edges whose type is a MemoryEdgeType value.
    await this.brain.run(
      `DELETE FROM knowledge_edges
       WHERE brain_id = ? AND type IN (${MEMORY_EDGE_TYPES_SQL})`,
      [brainId],
    );

    // Delete all memory_graph nodes.
    await this.brain.run(
      `DELETE FROM knowledge_nodes WHERE brain_id = ? AND type = ?`,
      [brainId, NODE_TYPE],
    );

    this._nodes.clear();
    this._edges.clear();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Derive a deterministic, stable UUID for a directed edge from
   * `sourceId` to `targetId`.
   *
   * Using a deterministic ID means that calling `addEdge` twice with the same
   * source/target lands on the same SQLite row — enabling the `INSERT OR REPLACE`
   * upsert semantics.
   *
   * @param sourceId - Edge source node ID.
   * @param targetId - Edge target node ID.
   * @returns A UUID v5-style hex string.
   */
  private async _edgeId(sourceId: string, targetId: string): Promise<string> {
    const hash = await sha256(`mem_edge:${sourceId}:${targetId}`);
    return hash.slice(0, 32);
  }
}
