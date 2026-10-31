/**
 * @file index.ts
 * @description Barrel export for AgentOS storage module.
 * 
 * Provides centralized access to all storage-related interfaces and implementations.
 * 
 * @version 1.0.0
 * @author AgentOS Team
 * @license Apache-2.0
 */

export * from './IStorageAdapter.js';
export { SqlStorageAdapter, type AgentOsSqlStorageConfig } from './SqlStorageAdapter.js';
export { InMemoryStorageAdapter } from './InMemoryStorageAdapter.js';
