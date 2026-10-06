/**
 * @fileoverview Parsers for the forms a tool's `implementation_source` column
 * has been written in, and the request inference used for rows stored before
 * requests were kept.
 * @module @framers/agentos/emergent/persisted-source
 *
 * Three forms exist for code-forged tools:
 * - raw code (the registry, with `persistSandboxSource` on);
 * - JSON `{ mode: 'sandbox', code, allowlist }` (written by hosts that import
 *   tools with their own SQL);
 * - a redacted record `{ redacted: true, allowlist, codeBytes }` (the registry,
 *   with `persistSandboxSource` off), which cannot be rebuilt.
 * Compose tools are always the JSON of their spec.
 */

import type {
  CapabilityName,
  ComposableToolSpec,
  EmergentTool,
  PersistedToolRow,
  SandboxedToolSpec,
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
 * scan `SandboxedToolForge.validateCode` applies. The code passed that scan
 * against the list the judge reviewed, so the result is never wider than what
 * was approved at forge time.
 */
export function inferRequestFromCode(code: string): CapabilityName[] {
  const found: CapabilityName[] = [];
  if (/\bfetch\s*\(/.test(code)) found.push('fetch');
  if (/\bfs\s*\./.test(code)) found.push('fs.read');
  if (/\bcrypto\s*\./.test(code)) found.push('crypto');
  return found;
}

const describeError = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Reads one row's `implementation_mode` and `implementation_source`. */
export function parsePersistedSource(mode: string, source: string): PersistedSource {
  if (mode === 'compose') {
    try {
      const parsed = JSON.parse(source) as Partial<ComposableToolSpec> | null;
      if (parsed && Array.isArray(parsed.steps)) {
        return { format: 'compose', implementation: { mode: 'compose', steps: parsed.steps } };
      }
      return { format: 'unreadable', error: 'compose source has no steps array' };
    } catch (err) {
      return { format: 'unreadable', error: `compose source is not JSON: ${describeError(err)}` };
    }
  }

  if (mode !== 'sandbox') {
    return { format: 'unreadable', error: `unknown implementation mode "${mode}"` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    parsed = undefined;
  }

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>;
    const names = Array.isArray(record.allowlist) ? record.allowlist.map(String) : [];
    if (record.redacted === true) {
      return { format: 'redacted', capabilities: normalizeAllowlist(names).capabilities };
    }
    if (record.mode === 'sandbox' && typeof record.code === 'string') {
      const { capabilities } = normalizeAllowlist(names);
      return {
        format: 'code-with-list',
        implementation: { mode: 'sandbox', code: record.code, allowlist: toSandboxApis(capabilities) },
        capabilities,
        inferred: false,
      };
    }
  }

  const capabilities = inferRequestFromCode(source);
  return {
    format: 'raw-code',
    implementation: { mode: 'sandbox', code: source, allowlist: toSandboxApis(capabilities) },
    capabilities,
    inferred: true,
  };
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
    return { format: 'compose', implementation };
  }
  return {
    format: 'code-with-list',
    implementation,
    capabilities: normalizeAllowlist(implementation.allowlist).capabilities,
    inferred: false,
  };
}

/** Reads a `request_json` column. Anything unreadable is treated as no stored request. */
export function parseStoredRequest(json: string | null | undefined): StoredRequest | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as StoredRequest | null;
    if (parsed && (parsed.kind === 'sandbox' || parsed.kind === 'compose')) {
      return parsed;
    }
  } catch {
    // Fall through: an unreadable request is re-derived from the source.
  }
  return null;
}

/** Builds the in-memory tool for a stored row and the implementation read from it. */
export function toolFromRow(row: PersistedToolRow, implementation: ToolImplementation): EmergentTool {
  const parseJson = <T>(raw: string | null, fallback: T): T => {
    if (!raw) return fallback;
    try {
      return (JSON.parse(raw) as T) ?? fallback;
    } catch {
      return fallback;
    }
  };
  // BIGINT columns come back as numbers from SQLite and as strings from Postgres.
  const toIso = (value: number | string | null): string | null => {
    if (value == null) return null;
    const numeric = typeof value === 'number' ? value : Number(value);
    const date = Number.isFinite(numeric) ? new Date(numeric) : new Date(String(value));
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  };
  const emptySchema: JSONSchemaObject = { type: 'object', properties: {} };
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    inputSchema: parseJson<JSONSchemaObject>(row.input_schema, emptySchema),
    outputSchema: parseJson<JSONSchemaObject>(row.output_schema, emptySchema),
    implementation,
    tier: row.tier,
    createdBy: row.created_by_agent,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    judgeVerdicts: parseJson<EmergentTool['judgeVerdicts']>(row.judge_verdicts, []),
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
