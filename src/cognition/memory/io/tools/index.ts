/**
 * @fileoverview Barrel exports for the agent memory editor tools.
 *
 * These tools expose a self-management API that lets AgentOS agents
 * read, write, search, and consolidate their own long-term memory traces.
 *
 * ## Available tools
 *
 * | Tool class           | Tool name         | Description                                |
 * |----------------------|-------------------|--------------------------------------------|
 * | {@link MemoryAddTool}    | `memory_add`      | Store a new memory trace                   |
 * | {@link MemoryUpdateTool} | `memory_update`   | Update content or tags of an existing trace|
 * | {@link MemoryDeleteTool} | `memory_delete`   | Soft-delete a trace by ID                  |
 * | {@link MemoryMergeTool}  | `memory_merge`    | Merge multiple traces into one             |
 * | {@link MemorySearchTool} | `memory_search`   | FTS5 full-text search over traces          |
 * | {@link MemoryReflectTool}| `memory_reflect`  | Trigger offline consolidation cycle        |
 *
 * @module memory/tools
 */

export { MemoryAddTool } from './MemoryAddTool.js';
export type { MemoryAddInput, MemoryAddOutput } from './MemoryAddTool.js';

export { MemoryUpdateTool } from './MemoryUpdateTool.js';
export type { MemoryUpdateInput, MemoryUpdateOutput } from './MemoryUpdateTool.js';

export { MemoryDeleteTool } from './MemoryDeleteTool.js';
export type { MemoryDeleteInput, MemoryDeleteOutput } from './MemoryDeleteTool.js';

export { MemoryMergeTool } from './MemoryMergeTool.js';
export type { MemoryMergeInput, MemoryMergeOutput } from './MemoryMergeTool.js';

export { MemorySearchTool } from './MemorySearchTool.js';
export type { MemorySearchInput, MemorySearchOutput, MemorySearchResult } from './MemorySearchTool.js';

export { MemoryReflectTool } from './MemoryReflectTool.js';
export type { MemoryReflectInput } from './MemoryReflectTool.js';

/** What the tools that write take a write back through: the `Memory` facade that made them. */
export type { MemoryToolWriteBack } from './learningWrite.js';

/** Opt-in tool for rehydrating gisted/archived memory traces. */
export { RehydrateMemoryTool } from './RehydrateMemoryTool.js';
export type { RehydrateMemoryInput, RehydrateMemoryOutput } from './RehydrateMemoryTool.js';
