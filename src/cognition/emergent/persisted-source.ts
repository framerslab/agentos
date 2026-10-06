/**
 * @fileoverview Parsers for the forms a tool's `implementation_source` column
 * has been written in, the request inference used for rows stored before
 * requests were kept, and the mapping of a stored row to the in-memory tool.
 * @module @framers/agentos/emergent/persisted-source
 *
 * Three forms exist for code-forged tools:
 * - raw code (the registry, with `persistSandboxSource` on);
 * - JSON `{ mode: 'sandbox', code, allowlist }` (written by hosts that import
 *   tools with their own SQL);
 * - a redacted record `{ redacted: true, allowlist, codeBytes }` (the registry,
 *   with `persistSandboxSource` off), which cannot be rebuilt.
 * Any other JSON in a code tool's row is unreadable, and so is a stored list
 * this release cannot read in full (a name outside the catalogue, an entry
 * that is not a string): nothing is narrowed to the part that could be read.
 * Compose tools are always the JSON of their spec; a spec whose steps the
 * builder cannot run is unreadable. A row whose schema columns do not hold a
 * JSON object is unreadable too, whatever its source.
 */

import type {
  CapabilityName,
  ComposableStep,
  ComposableToolSpec,
  EmergentTool,
  PersistedToolRow,
  SandboxedToolSpec,
  StateSetter,
  StoredRequest,
  ToolImplementation,
} from './types.js';
import type { JSONSchemaObject } from '../../core/tools/ITool.js';
import { normalizeAllowlist, toSandboxApis } from './capabilities.js';

export type PersistedSource =
  | { format: 'compose'; implementation: ComposableToolSpec }
  | {
      format: 'raw-code';
      implementation: SandboxedToolSpec;
      capabilities: CapabilityName[];
      inferred: true;
    }
  | {
      format: 'code-with-list';
      implementation: SandboxedToolSpec;
      capabilities: CapabilityName[];
      inferred: false;
    }
  | { format: 'redacted'; capabilities: CapabilityName[] }
  | { format: 'unreadable'; error: string };

/**
 * Infers the capabilities a piece of forged code uses, with the same text
 * scan `SandboxedToolForge.validateCode` applies. For code that `forge()`
 * stored, the code passed that scan against the list the judge reviewed, so
 * the result is never wider than what was approved. Code written into the
 * store by other means never met the judge, and nothing bounds its inferred
 * request until a ceiling is in force.
 */
export function inferRequestFromCode(code: string): CapabilityName[] {
  const found: CapabilityName[] = [];
  if (/\bfetch\s*\(/.test(code)) found.push('fetch');
  if (/\bfs\s*\./.test(code)) found.push('fs.read');
  if (/\bcrypto\s*\./.test(code)) found.push('crypto');
  return found;
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A JSON object: not null and not an array. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads a `set_by` column: anything but the library's own mark is the host's. */
export function stateSetterFromColumn(value: unknown): StateSetter {
  return value === 'library' ? 'library' : 'host';
}

/**
 * Reads a stored allowlist. Every entry must be a string naming a catalogue
 * capability or its alias; anything else makes the source unreadable, so a
 * list this release cannot read in full is never narrowed to the part it can.
 * No list is an empty one.
 */
function readAllowlist(value: unknown): { capabilities: CapabilityName[] } | { error: string } {
  if (value === undefined || value === null) {
    return { capabilities: [] };
  }
  if (!Array.isArray(value)) {
    return { error: 'allowlist is not an array' };
  }
  if (!value.every((entry) => typeof entry === 'string')) {
    return { error: 'allowlist holds an entry that is not a string' };
  }
  const { capabilities, unknown } = normalizeAllowlist(value as string[]);
  if (unknown.length > 0) {
    return { error: `allowlist names capabilities outside the catalogue: ${unknown.join(', ')}` };
  }
  return { capabilities };
}

/**
 * Reads a composition's steps by the rules the builder runs them by: at least
 * one step, each an object with a string `name`, a non-empty `tool` and an
 * `inputMapping` object; `condition` is kept when it is a string. The steps
 * are rebuilt field by field, so nothing else the source carried comes along.
 */
function readComposeSteps(steps: unknown): { steps: ComposableStep[] } | { error: string } {
  if (!Array.isArray(steps)) {
    return { error: 'compose source has no steps array' };
  }
  if (steps.length === 0) {
    return { error: 'compose source has no steps' };
  }
  const read: ComposableStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step: unknown = steps[i];
    if (!isRecord(step)) {
      return { error: `compose step ${i} is not an object` };
    }
    const { name, tool, inputMapping, condition } = step;
    if (typeof name !== 'string') {
      return { error: `compose step ${i} has no name` };
    }
    if (typeof tool !== 'string' || tool.trim() === '') {
      return { error: `compose step ${i} has no tool` };
    }
    if (!isRecord(inputMapping)) {
      return { error: `compose step ${i} has no inputMapping object` };
    }
    read.push(
      typeof condition === 'string'
        ? { name, tool, inputMapping, condition }
        : { name, tool, inputMapping },
    );
  }
  return { steps: read };
}

/** Reads one row's `implementation_mode` and `implementation_source`. */
export function parsePersistedSource(mode: string, source: string): PersistedSource {
  if (mode === 'compose') {
    let spec: unknown;
    try {
      spec = JSON.parse(source);
    } catch (err) {
      return { format: 'unreadable', error: `compose source is not JSON: ${describeError(err)}` };
    }
    if (!isRecord(spec)) {
      return { format: 'unreadable', error: 'compose source is not a JSON object' };
    }
    const read = readComposeSteps(spec.steps);
    if ('error' in read) {
      return { format: 'unreadable', error: read.error };
    }
    return { format: 'compose', implementation: { mode: 'compose', steps: read.steps } };
  }

  if (mode !== 'sandbox') {
    return { format: 'unreadable', error: `unknown implementation mode "${mode}"` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    // Not JSON, so the source is the code itself.
    const capabilities = inferRequestFromCode(source);
    return {
      format: 'raw-code',
      implementation: { mode: 'sandbox', code: source, allowlist: toSandboxApis(capabilities) },
      capabilities,
      inferred: true,
    };
  }

  if (isRecord(parsed)) {
    const record = parsed;
    const isRedacted = record.redacted === true;
    const isCodeWithList = record.mode === 'sandbox' && typeof record.code === 'string';
    if (isRedacted || isCodeWithList) {
      const list = readAllowlist(record.allowlist);
      if ('error' in list) {
        return { format: 'unreadable', error: list.error };
      }
      if (isRedacted) {
        return { format: 'redacted', capabilities: list.capabilities };
      }
      return {
        format: 'code-with-list',
        implementation: {
          mode: 'sandbox',
          code: record.code as string,
          allowlist: toSandboxApis(list.capabilities),
        },
        capabilities: list.capabilities,
        inferred: false,
      };
    }
  }

  // Text that JSON.parse accepts cannot define `execute` or `run`, so this is
  // no code a tool can be rebuilt from: most likely a form some host wrote.
  return { format: 'unreadable', error: 'sandbox source is JSON of an unknown shape' };
}

/** The request to store for a source read from a row. */
export function requestFromSource(source: PersistedSource): StoredRequest | null {
  switch (source.format) {
    case 'compose':
      return {
        kind: 'compose',
        steps: source.implementation.steps.map((step) => ({ name: step.name, tool: step.tool })),
      };
    case 'raw-code':
      return { kind: 'sandbox', capabilities: source.capabilities, inferred: true };
    case 'code-with-list':
    case 'redacted':
      return { kind: 'sandbox', capabilities: source.capabilities };
    default:
      return null;
  }
}

/** The request to store for an implementation held in memory (a fresh forge, or a host-built tool). */
export function requestFromImplementation(implementation: ToolImplementation): StoredRequest {
  if (implementation.mode === 'compose') {
    return {
      kind: 'compose',
      steps: implementation.steps.map((step) => ({ name: step.name, tool: step.tool })),
    };
  }
  return { kind: 'sandbox', capabilities: normalizeAllowlist(implementation.allowlist).capabilities };
}

/** The source form of an implementation held in memory, for the same checks a stored row gets. */
export function sourceFromImplementation(implementation: ToolImplementation): PersistedSource {
  if (implementation.mode === 'compose') {
    // The step rules a stored composition is read by.
    const read = readComposeSteps(implementation.steps);
    return 'error' in read
      ? { format: 'unreadable', error: read.error }
      : { format: 'compose', implementation };
  }
  return {
    format: 'code-with-list',
    implementation,
    capabilities: normalizeAllowlist(implementation.allowlist).capabilities,
    inferred: false,
  };
}

/**
 * Reads a `request_json` column. Anything unreadable is treated as no stored
 * request, and so is a request without its list or one that names a
 * capability outside the catalogue: the caller derives the request from the
 * source again. The result is rebuilt field by field, so it holds catalogue
 * names and nothing the column carried beyond the request.
 */
export function parseStoredRequest(json: string | null | undefined): StoredRequest | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;

  if (record.kind === 'sandbox') {
    const names = record.capabilities;
    if (!Array.isArray(names) || !names.every((name) => typeof name === 'string')) return null;
    const { capabilities, unknown } = normalizeAllowlist(names as string[]);
    if (unknown.length > 0) return null;
    return record.inferred === true
      ? { kind: 'sandbox', capabilities, inferred: true }
      : { kind: 'sandbox', capabilities };
  }

  if (record.kind === 'compose') {
    if (!Array.isArray(record.steps)) return null;
    const steps: Array<{ name: string; tool: string }> = [];
    for (const step of record.steps as unknown[]) {
      if (!step || typeof step !== 'object') return null;
      const { name, tool } = step as Record<string, unknown>;
      if (typeof name !== 'string' || typeof tool !== 'string') return null;
      steps.push({ name, tool });
    }
    return { kind: 'compose', steps };
  }

  return null;
}

type SchemaRead = { schema: JSONSchemaObject } | { error: string };

function readSchemaColumn(raw: string | null, column: 'input_schema' | 'output_schema'): SchemaRead {
  if (raw == null || raw.trim() === '') {
    // A tool may have no output schema; it always has an input schema.
    return column === 'output_schema'
      ? { schema: { type: 'object', properties: {} } }
      : { error: `${column} is empty` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { error: `${column} is not JSON: ${describeError(err)}` };
  }
  if (!isRecord(parsed)) {
    return { error: `${column} is not a JSON object` };
  }
  return { schema: parsed as JSONSchemaObject };
}

/**
 * Reads a row's schema columns. A column that does not hold a JSON object is
 * reported, never replaced by a schema that accepts any input; the loader
 * reads such a row as unreadable.
 */
export function parseRowSchemas(
  row: Pick<PersistedToolRow, 'input_schema' | 'output_schema'>,
): { inputSchema: JSONSchemaObject; outputSchema: JSONSchemaObject } | { error: string } {
  const input = readSchemaColumn(row.input_schema, 'input_schema');
  if ('error' in input) return { error: input.error };
  const output = readSchemaColumn(row.output_schema, 'output_schema');
  if ('error' in output) return { error: output.error };
  return { inputSchema: input.schema, outputSchema: output.schema };
}

/**
 * Builds the in-memory tool for a stored row and the implementation read from it.
 *
 * @throws If the row's schema columns do not read (see {@link parseRowSchemas});
 *   the loader refuses such a row before it gets here.
 */
export function toolFromRow(row: PersistedToolRow, implementation: ToolImplementation): EmergentTool {
  const schemas = parseRowSchemas(row);
  if ('error' in schemas) {
    throw new Error(`stored tool "${row.name}" (${row.id}): ${schemas.error}`);
  }
  // judge_verdicts is a list or nothing; any other JSON is read as none.
  const readVerdicts = (raw: string | null): EmergentTool['judgeVerdicts'] => {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as EmergentTool['judgeVerdicts']) : [];
    } catch {
      return [];
    }
  };
  // BIGINT columns come back as numbers from SQLite and as strings from Postgres.
  const toIso = (value: number | string | null): string | null => {
    if (value == null) return null;
    // A blank column is no time; Number('') is 0, which would read it as 1970.
    if (typeof value === 'string' && value.trim() === '') return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    inputSchema: schemas.inputSchema,
    outputSchema: schemas.outputSchema,
    implementation,
    tier: row.tier,
    createdBy: row.created_by_agent,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    judgeVerdicts: readVerdicts(row.judge_verdicts),
    usageStats: {
      totalUses: row.total_uses ?? 0,
      successCount: row.success_count ?? 0,
      failureCount: row.failure_count ?? 0,
      avgExecutionTimeMs: row.avg_execution_ms ?? 0,
      lastUsedAt: toIso(row.last_used_at),
      confidenceScore: row.confidence_score ?? 0,
    },
    // The same wording forge() writes, so the session id can be read back out of it.
    source: `forged by agent ${row.created_by_agent} during session ${row.created_by_session}`,
  };
}
