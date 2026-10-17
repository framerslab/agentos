/**
 * @fileoverview Barrel exports for the Memory I/O subsystem.
 *
 * All importers and exporters for the AgentOS memory brain are re-exported
 * from this single entry point.
 *
 * **Exporters** — serialise a `Brain` to an external format:
 * - `JsonExporter`     — JSON file with optional base64-encoded embeddings.
 * - `MarkdownExporter` — directory of `.md` files with YAML front-matter.
 * - `ObsidianExporter` — Obsidian vault with `[[wikilinks]]` and `#tags`.
 * - `SqliteExporter`   — new SQLite file holding the brain's own rows of every portable table.
 *
 * **Importers** — merge external data into a `Brain`:
 * - `JsonImporter`     — parses a `JsonExporter` JSON file.
 * - `MarkdownImporter` — walks a directory of YAML front-matter Markdown files.
 * - `ObsidianImporter` — extends `MarkdownImporter` with wikilink → edge parsing.
 * - `SqliteImporter`   — merges another SQLite brain file (smart dedup + tag union).
 * - `ChatGptImporter`  — parses ChatGPT's `conversations.json` export format.
 * - `CsvImporter`      — imports flat CSV files with a required `content` column.
 *
 * @module memory/io
 */

export { JsonExporter } from './JsonExporter.js';
export { JsonImporter } from './JsonImporter.js';
export { MarkdownExporter } from './MarkdownExporter.js';
export { MarkdownImporter } from './MarkdownImporter.js';
export { ObsidianExporter } from './ObsidianExporter.js';
export { ObsidianImporter } from './ObsidianImporter.js';
// SqliteImporter now uses StorageAdapter (cross-platform) and can be barrel-exported.
export { SqliteImporter } from './SqliteImporter.js';
// SqliteExporter uses IDatabaseExporter which may require native modules.
// Import directly when needed:
//   const { SqliteExporter } = await import('./memory/io/SqliteExporter.js');
export { ChatGptImporter } from './ChatGptImporter.js';
export { CsvImporter } from './CsvImporter.js';
export { MemoryTransplantPipeline } from './MemoryTransplantPipeline.js';
export type { TransplantOptions, TransplantResult } from './MemoryTransplantPipeline.js';
