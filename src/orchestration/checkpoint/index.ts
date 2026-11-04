/**
 * @file index.ts
 * @description Public barrel for the orchestration checkpoint subsystem.
 *
 * Exports the `ICheckpointStore` interface, the `Checkpoint` and `CheckpointMetadata`
 * types, and the built-in implementations: `InMemoryCheckpointStore`, and
 * `SqlCheckpointStore` over `@framers/sql-storage-adapter` with its `checkpointDdl`.
 */

export * from './ICheckpointStore.js';
export { InMemoryCheckpointStore } from './InMemoryCheckpointStore.js';
export { SqlCheckpointStore, checkpointDdl, type SqlCheckpointStoreOptions } from './SqlCheckpointStore.js';
