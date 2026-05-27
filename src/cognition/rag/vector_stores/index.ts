/**
 * Vector Store Implementations
 * 
 * This module exports all available vector store implementations for AgentOS RAG.
 * 
 * @module @framers/agentos/cognition/rag/vector_stores
 */

// In-memory vector store (development/testing)
export { InMemoryVectorStore } from './InMemoryVectorStore.js';

// SQL-backed vector store (cross-platform persistence)
export { SqlVectorStore, type SqlVectorStoreConfig } from './SqlVectorStore.js';

// HNSW-based vector store (fast ANN search via hnswlib-node)
export { HnswlibVectorStore, type HnswlibVectorStoreConfig } from './HnswlibVectorStore.js';

// Qdrant vector store (remote/self-hosted via HTTP API)
export { QdrantVectorStore, type QdrantVectorStoreConfig } from './QdrantVectorStore.js';

// Neo4j vector store (native vector indexes via neo4j-driver)
export { Neo4jVectorStore, type Neo4jVectorStoreConfig } from './Neo4jVectorStore.js';

// Postgres vector store (pgvector + tsvector hybrid search via single SQL CTE)
export { PostgresVectorStore, type PostgresVectorStoreConfig } from './PostgresVectorStore.js';



