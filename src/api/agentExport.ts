/**
 * @fileoverview Agent configuration export/import for AgentOS.
 * @module @framers/agentos/api/agentExport
 *
 * Provides portable serialization and deserialization of agent and agency
 * configurations. Agents can be exported as JSON or YAML, transferred across
 * environments, and re-imported to create identical agent instances.
 *
 * The export captures the full `BaseAgentConfig` surface — model, tools,
 * personality, guardrails, memory, RAG, voice, channels, etc. — as well as
 * agency-specific fields (sub-agent roster, strategy, rounds).
 *
 * Security note: API keys and base URLs are intentionally **included** in the
 * export for self-contained portability. Callers that publish or share exports
 * should strip sensitive fields first, or use `validateAgentExport()` to
 * inspect the payload before distribution.
 *
 * @example
 * ```ts
 * import { agent } from '@framers/agentos';
 * import { exportAgentConfig, importAgent, exportAgentConfigJSON } from '@framers/agentos/api/agentExport';
 *
 * const myAgent = agent({ provider: 'openai', model: 'gpt-4o', instructions: 'Be helpful.' });
 * const json = exportAgentConfigJSON(myAgent);
 *
 * // Later, in another process:
 * const restored = importAgentFromJSON(json);
 * const reply = await restored.generate('Hello!');
 * ```
 */

import YAML from 'yaml';

import { agent as createAgent } from './agent.js';
import { agency as createAgency } from './agency.js';
import type { AgencyOptions, Agent } from './types.js';
import {
  exportAgentConfig,
  exportAgentConfigJSON,
  buildExportDocument,
  type ExportAgentConfigOptions,
} from './agentExportCore.js';
export { exportAgentConfig, exportAgentConfigJSON };
export type { AgentExportConfig, ExportAgentConfigOptions, PrebuiltSeatMarker } from './agentExportCore.js';
import type { AgentExportConfig } from './agentExportCore.js';
import { REDACTED, REDACTED_ENCODED, INSTANCE_MARKER_KEY } from './agentExportRedact.js';
import { providerEnvVars } from './model.js';
import { getDefaultProvider } from './runtime/global-default.js';

/**
 * Exports an agent's configuration as a YAML string.
 *
 * Uses the `yaml` npm package for consistent, human-readable output.
 *
 * @param agentInstance - The agent (or agency) instance to export.
 * @param metadata - Optional human-readable metadata to attach.
 * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
 * @returns YAML-formatted string (class instances always as `<<instance>>` markers).
 *
 * @example
 * ```ts
 * const yamlStr = exportAgentConfigYAML(myAgent);
 * fs.writeFileSync('agent.yaml', yamlStr);
 * ```
 */
export function exportAgentConfigYAML(
  agentInstance: Agent,
  metadata?: AgentExportConfig['metadata'],
  options?: ExportAgentConfigOptions,
): string {
  return YAML.stringify(buildExportDocument(agentInstance, metadata, options, 'serialized'));
}

// ============================================================================
// IMPORT FUNCTIONS
// ============================================================================

/** Options for {@link importAgent}. Paths are JSON Pointers into the export document (`/agents/support/channels/slack/credential`). */
export interface ImportAgentOptions {
  /** A redacted string's value, by the JSON Pointer of the redacted string. A redacted URL's entry is the whole URL. */
  secrets?: Record<string, string>;
  /** The object to put where an `<<instance>>` marker stands, or where a dropped function stood (a handler, a tool, a router). */
  values?: Record<string, unknown>;
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error(`Invalid JSON Pointer "${pointer}": it must start with "/"`);
  return pointer.slice(1).split('/').map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function setAtPointer(root: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = parsePointer(pointer);
  if (parts.length === 0) throw new Error('Cannot set the document root');
  let node: Record<string, unknown> = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== 'object') {
      node[part] = {};
    }
    node = node[part] as Record<string, unknown>;
  }
  node[parts[parts.length - 1]] = value;
}

function isInstanceMarker(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value as object).length === 1 &&
    INSTANCE_MARKER_KEY in (value as object)
  );
}

function holdsPlaceholder(value: string): boolean {
  return value.includes(REDACTED) || value.toUpperCase().includes(REDACTED_ENCODED);
}

/**
 * Walks the document, filling every redacted string from `secrets`. A
 * `<<REDACTED>>` provider key (an `apiKey` beside a `provider` or `model`) with
 * no entry is dropped and resolves as an unset key does (an applicable
 * `setDefaultProvider()` default, then the environment). A redacted `baseUrl`
 * beside one is dropped when a default naming that provider carries a
 * `baseUrl` or the provider's URL variable is set, and listed otherwise.
 * Every other unrestored placeholder and every unrestored instance marker is
 * collected in `unresolved`.
 */
function restoreDocument(
  node: unknown,
  pointer: string,
  parent: Record<string, unknown> | unknown[] | undefined,
  key: string | number | undefined,
  secrets: Record<string, string>,
  unresolved: string[],
): void {
  if (typeof node === 'string') {
    if (!holdsPlaceholder(node)) return;
    if (pointer in secrets) {
      (parent as Record<string, unknown>)[key as string] = secrets[pointer];
      return;
    }
    const siblings = parent && !Array.isArray(parent) ? parent : undefined;
    const besideProvider = !!siblings && (typeof siblings.provider === 'string' || typeof siblings.model === 'string');
    if (siblings && besideProvider && key === 'apiKey' && node === REDACTED) {
      // Dropped, the key resolves as an unset one does on every other call: an
      // applicable setDefaultProvider() default first, then the environment.
      // Import never writes the environment's values into the config: that would
      // freeze the environment at import time and put the live key into the stash
      // that export({ redactSecrets: false }) re-emits.
      delete siblings.apiKey;
      return;
    }
    if (siblings && besideProvider && key === 'baseUrl') {
      const providerId =
        typeof siblings.provider === 'string' ? siblings.provider : String(siblings.model).split(':')[0];
      // Dropped, the URL resolves to a same-provider default's URL or to the URL
      // variable, in that order: the importer's own configured endpoint, never the
      // vendor's default and never one the file chose. With neither, the path is
      // listed and import throws.
      const def = getDefaultProvider();
      const defaultUrl = def?.provider === providerId && typeof def.baseUrl === 'string' && def.baseUrl !== '';
      const urlVar = providerEnvVars(providerId).url;
      if (defaultUrl || (urlVar && process.env[urlVar])) {
        delete siblings.baseUrl;
        return;
      }
    }
    unresolved.push(pointer);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  if (isInstanceMarker(node)) {
    unresolved.push(`${pointer} (instance ${String((node as Record<string, unknown>)[INSTANCE_MARKER_KEY])})`);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => restoreDocument(item, `${pointer}/${i}`, node, i, secrets, unresolved));
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    restoreDocument(v, `${pointer}/${escapeToken(k)}`, node as Record<string, unknown>, k, secrets, unresolved);
  }
}

/**
 * Imports an agent from an {@link AgentExportConfig} object.
 *
 * For `type: 'agent'`, calls the `agent()` factory with the stored config.
 * For `type: 'agency'`, calls the `agency()` factory with the stored config
 * plus the sub-agent roster and strategy. The roster is read from `agents`;
 * the copy inside `config` is dropped.
 *
 * Exports redact secrets and replace class instances by default, so import
 * restores them: `options.secrets` maps the JSON Pointer of each redacted
 * string to its value, and `options.values` maps the pointer of each
 * `<<instance>>` marker (or dropped function) to the object to put there. A
 * redacted provider key with no entry resolves as an unset key does (an
 * applicable `setDefaultProvider()` default, then the environment). A
 * redacted `baseUrl` with no entry is dropped when a default naming that
 * provider carries a `baseUrl` or the provider's URL variable is set.
 *
 * The document is copied through JSON first, so importing the object form of
 * an unredacted export loses its functions and instances exactly as JSON does;
 * pass them through `values`.
 *
 * @param exportConfig - A validated export config object.
 * @param options - Values for what the export redacted or replaced.
 * @returns A new Agent instance constructed from the config.
 *
 * @throws {Error} If the config is invalid, if the roster holds a pre-built
 *   seat, or if a redacted value or instance marker has no entry; the error
 *   lists every such path.
 *
 * @example
 * ```ts
 * const config = JSON.parse(fs.readFileSync('agent.json', 'utf-8'));
 * const agent = importAgent(config, {
 *   secrets: { '/agents/support/channels/slack/credential': process.env.SLACK_BOT_TOKEN! },
 *   values: { '/config/router': myRouter },
 * });
 * const reply = await agent.generate('Hello!');
 * ```
 */
export function importAgent(exportConfig: AgentExportConfig, options: ImportAgentOptions = {}): Agent {
  const validation = validateAgentExport(exportConfig);
  if (!validation.valid) {
    throw new Error(`Invalid agent export config: ${validation.errors.join('; ')}`);
  }
  // Work on a copy: the caller's document is not written.
  const doc = JSON.parse(JSON.stringify(exportConfig)) as AgentExportConfig & Record<string, unknown>;
  // Import reads only the roster copy it builds the agency from.
  delete (doc.config as Record<string, unknown>).agents;
  for (const [pointer, value] of Object.entries(options.values ?? {})) {
    setAtPointer(doc as Record<string, unknown>, pointer, value);
  }
  const prebuilt = Object.entries(doc.agents ?? {}).filter(
    ([, seat]) => (seat as { prebuilt?: unknown }).prebuilt === true,
  );
  if (prebuilt.length > 0) {
    throw new Error(
      `Cannot import pre-built seat "${prebuilt[0][0]}": the agent it stood for cannot be rebuilt from the file. ` +
        `Rebuild the agency in code and place the agent in the roster.`,
    );
  }
  const secrets = options.secrets ?? {};
  const unresolved: string[] = [];
  restoreDocument(doc.config, '/config', doc as Record<string, unknown>, 'config', secrets, unresolved);
  if (doc.agents) restoreDocument(doc.agents, '/agents', doc as Record<string, unknown>, 'agents', secrets, unresolved);
  if (unresolved.length > 0) {
    throw new Error(
      `Cannot import: ${unresolved.length} value(s) were redacted or replaced on export and have no entry in ` +
        `secrets or values: ${unresolved.join(', ')}`,
    );
  }

  if (doc.type === 'agency' && doc.agents) {
    // Reconstruct an agency with its sub-agent roster
    const agencyOpts: AgencyOptions = {
      ...(doc.config as AgencyOptions),
      agents: doc.agents as AgencyOptions['agents'],
      strategy: doc.strategy,
      adaptive: doc.adaptive,
      maxRounds: doc.maxRounds,
    };
    const agencyInstance = createAgency(agencyOpts);
    // The export writes the roster twice (inside config and as agents); the
    // re-stash carries the restored roster so an export of the imported agency
    // matches the file.
    Object.defineProperty(agencyInstance, '__config', {
      value: { ...doc.config, agents: doc.agents },
      enumerable: false,
      configurable: true,
    });
    Object.defineProperty(agencyInstance, '__agencyConfig', {
      value: { agents: doc.agents, strategy: doc.strategy, adaptive: doc.adaptive, maxRounds: doc.maxRounds },
      enumerable: false,
      configurable: true,
    });
    return agencyInstance;
  }

  // Single agent
  const agentInstance = createAgent(doc.config);
  // Stash config for re-export round-tripping
  Object.defineProperty(agentInstance, '__config', {
    value: doc.config,
    enumerable: false,
    configurable: true,
  });
  return agentInstance;
}

/**
 * Imports an agent from a JSON string.
 *
 * Parses the string and delegates to {@link importAgent}.
 *
 * @param json - JSON string containing an {@link AgentExportConfig}.
 * @param options - Values for what the export redacted or replaced.
 * @returns A new Agent instance.
 *
 * @throws {SyntaxError} If the JSON is malformed.
 * @throws {Error} If the parsed config fails validation or holds a value import cannot restore.
 *
 * @example
 * ```ts
 * const agent = importAgentFromJSON(fs.readFileSync('agent.json', 'utf-8'));
 * ```
 */
export function importAgentFromJSON(json: string, options?: ImportAgentOptions): Agent {
  const parsed = JSON.parse(json) as AgentExportConfig;
  return importAgent(parsed, options);
}

/**
 * Imports an agent from a YAML string.
 *
 * Parses the string using the `yaml` npm package and delegates to
 * {@link importAgent}.
 *
 * @param yamlStr - YAML string containing an {@link AgentExportConfig}.
 * @param options - Values for what the export redacted or replaced.
 * @returns A new Agent instance.
 *
 * @throws {Error} If the YAML is malformed, the config fails validation, or it holds a value import cannot restore.
 *
 * @example
 * ```ts
 * const agent = importAgentFromYAML(fs.readFileSync('agent.yaml', 'utf-8'));
 * ```
 */
export function importAgentFromYAML(yamlStr: string, options?: ImportAgentOptions): Agent {
  const parsed = YAML.parse(yamlStr) as AgentExportConfig;
  return importAgent(parsed, options);
}

// ============================================================================
// VALIDATION
// ============================================================================

/**
 * Validates an export config object without importing it.
 *
 * Checks structural correctness: schema version, required fields, type
 * discriminator, and agency-specific field consistency. Does NOT validate
 * the semantic correctness of the config (e.g. whether the model exists).
 *
 * @param config - Unknown value to validate as an {@link AgentExportConfig}.
 * @returns Object with `valid` boolean and an array of error messages.
 *
 * @example
 * ```ts
 * const result = validateAgentExport(someObject);
 * if (!result.valid) {
 *   console.error('Validation errors:', result.errors);
 * }
 * ```
 */
export function validateAgentExport(config: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!config || typeof config !== 'object') {
    return { valid: false, errors: ['Config must be a non-null object'] };
  }

  const c = config as Record<string, unknown>;

  // Version check
  if (c.version !== '1.0.0') {
    errors.push(`Unsupported version: ${String(c.version ?? 'missing')}. Expected "1.0.0".`);
  }

  // Type discriminator
  if (c.type !== 'agent' && c.type !== 'agency') {
    errors.push(`Invalid type: ${String(c.type ?? 'missing')}. Expected "agent" or "agency".`);
  }

  // exportedAt must be a string (ISO 8601)
  if (typeof c.exportedAt !== 'string') {
    errors.push('Missing or invalid "exportedAt" field. Expected an ISO 8601 string.');
  }

  // config must be an object
  if (!c.config || typeof c.config !== 'object') {
    errors.push('Missing or invalid "config" field. Expected an object.');
  }

  // Agency-specific: agents must be present when type is 'agency'
  if (c.type === 'agency') {
    if (!c.agents || typeof c.agents !== 'object' || Object.keys(c.agents as object).length === 0) {
      errors.push('Agency export requires a non-empty "agents" roster.');
    }

    // Strategy, if present, must be a valid value
    const validStrategies = new Set([
      'sequential',
      'parallel',
      'debate',
      'review-loop',
      'hierarchical',
      'graph',
    ]);
    if (c.strategy !== undefined && !validStrategies.has(c.strategy as string)) {
      errors.push(
        `Invalid strategy: ${String(c.strategy)}. Expected one of: ${[...validStrategies].join(', ')}.`
      );
    }
  }

  // Metadata validation (optional, but if present must be an object)
  if (c.metadata !== undefined && (typeof c.metadata !== 'object' || c.metadata === null)) {
    errors.push('"metadata" must be an object when present.');
  }

  return { valid: errors.length === 0, errors };
}
