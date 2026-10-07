/**
 * Shared export-only helpers for lightweight agents and agencies.
 *
 * Kept separate from `agentExport.ts` so the lightweight `agent()` entrypoint
 * can expose config export methods without pulling in agency import/runtime
 * code and optional channel adapters.
 */

import type { BaseAgentConfig, AgencyStrategy, Agent } from './types.js';
import { copyExportTree, isSecretName, isWebhookUrlName } from './agentExportRedact.js';
import { redactUrlForExport } from '../core/llm/providers/url-secrets.js';

/** Written in the roster for a pre-built `Agent` placed in `agents`, whose config the agency cannot see. */
export interface PrebuiltSeatMarker {
  prebuilt: true;
}

/**
 * Portable agent configuration envelope.
 *
 * Wraps a `BaseAgentConfig` with version metadata, export timestamp,
 * and type discriminator so import logic can reconstruct the correct agent
 * variant (single agent vs. multi-agent agency).
 */
export interface AgentExportConfig {
  /** Schema version for forward-compatible deserialization. */
  version: '1.0.0';

  /** ISO 8601 timestamp of when the export was created. */
  exportedAt: string;

  /**
   * Discriminator: `'agent'` for a single-agent export, `'agency'` for
   * a multi-agent export that includes a sub-agent roster.
   */
  type: 'agent' | 'agency';

  /** The full agent configuration. */
  config: BaseAgentConfig;

  /** Sub-agent roster keyed by agent name. Present for agency exports. A pre-built seat is `{ prebuilt: true }`. */
  agents?: Record<string, BaseAgentConfig | PrebuiltSeatMarker>;

  /** Orchestration strategy. Present for agency exports. */
  strategy?: AgencyStrategy;

  /** Whether runtime strategy adaptation is enabled. */
  adaptive?: boolean;

  /** Maximum orchestration rounds for iterative strategies. */
  maxRounds?: number;

  /** Human-readable metadata about the export (name, author, tags, etc.). */
  metadata?: {
    name?: string;
    description?: string;
    author?: string;
    tags?: string[];
  };
}

/** Options for {@link exportAgentConfig} and the instance methods `export()` / `exportJSON()`. */
export interface ExportAgentConfigOptions {
  /**
   * Default `true`: every secret string (by property name at any depth) becomes `<<REDACTED>>`,
   * URLs lose their credentials, and a class instance becomes `{ '<<instance>>': '<constructor name>' }`.
   * `false` keeps every string; the object form then keeps instances by reference (JSON and YAML
   * still carry the marker, because an instance cannot be serialized).
   */
  redactSecrets?: boolean;
}

/**
 * Extracts the stored configuration from an Agent instance.
 *
 * The agent's config is captured at creation time by the `agent()` and
 * `agency()` factories and attached as a non-enumerable `__config` property.
 */
function extractConfig(agentInstance: Agent): BaseAgentConfig {
  const config = (agentInstance as unknown as Record<string, unknown>).__config;
  if (config && typeof config === 'object') {
    return config as BaseAgentConfig;
  }
  return {};
}

/**
 * Extracts agency-specific fields from an Agent instance that was created
 * by the `agency()` factory.
 */
function extractAgencyFields(agentInstance: Agent):
  | {
      agents?: Record<string, BaseAgentConfig | PrebuiltSeatMarker>;
      strategy?: AgencyStrategy;
      adaptive?: boolean;
      maxRounds?: number;
    }
  | undefined {
  const raw = (agentInstance as unknown as Record<string, unknown>).__agencyConfig;
  if (raw && typeof raw === 'object') {
    return raw as {
      agents?: Record<string, BaseAgentConfig | PrebuiltSeatMarker>;
      strategy?: AgencyStrategy;
      adaptive?: boolean;
      maxRounds?: number;
    };
  }
  return undefined;
}

function redactUrl(url: string, name: string, parent: string): string {
  return redactUrlForExport(url, { webhook: isWebhookUrlName(name, parent), isSecretParam: isSecretName });
}

/**
 * Builds the export document on a copy of the agent's config: the live config
 * is never written. `form` is `'object'` for the object the caller holds and
 * `'serialized'` for JSON and YAML.
 *
 * @param agentInstance - The agent (or agency) instance to export.
 * @param metadata - Optional human-readable metadata to attach.
 * @param options - Redaction options; secrets are redacted unless `redactSecrets` is `false`.
 * @param form - `'object'` keeps functions (and, without redaction, instances by reference); `'serialized'` drops functions and marks instances.
 * @returns The export document.
 */
export function buildExportDocument(
  agentInstance: Agent,
  metadata: AgentExportConfig['metadata'] | undefined,
  options: ExportAgentConfigOptions | undefined,
  form: 'object' | 'serialized',
): AgentExportConfig {
  const redactSecrets = options?.redactSecrets !== false;
  const copy = (value: unknown) => copyExportTree(value, { redactSecrets, form, redactUrl });
  const config = copy(extractConfig(agentInstance)) as BaseAgentConfig;
  const agencyFields = extractAgencyFields(agentInstance);
  const isAgency = !!agencyFields?.agents;

  const exportConfig: AgentExportConfig = {
    version: '1.0.0',
    exportedAt: new Date().toISOString(),
    type: isAgency ? 'agency' : 'agent',
    config,
  };

  if (isAgency && agencyFields) {
    // Copied under its own name, so a seat named like a secret container
    // (`authorization`, `credentials`) is read as a name here too.
    exportConfig.agents = (copy({ agents: agencyFields.agents }) as { agents: AgentExportConfig['agents'] }).agents;
    exportConfig.strategy = agencyFields.strategy;
    exportConfig.adaptive = agencyFields.adaptive;
    exportConfig.maxRounds = agencyFields.maxRounds;
  }

  if (metadata) {
    exportConfig.metadata = { ...metadata };
  }

  return exportConfig;
}

/**
 * Exports an agent's configuration as a portable object. Secrets are redacted
 * unless `options.redactSecrets` is `false`.
 *
 * @param agentInstance - The agent (or agency) instance to export.
 * @param metadata - Optional human-readable metadata to attach.
 * @param options - Redaction options.
 * @returns A portable {@link AgentExportConfig} object, built on a copy of the config.
 */
export function exportAgentConfig(
  agentInstance: Agent,
  metadata?: AgentExportConfig['metadata'],
  options?: ExportAgentConfigOptions,
): AgentExportConfig {
  return buildExportDocument(agentInstance, metadata, options, 'object');
}

/**
 * Exports an agent's configuration as pretty-printed JSON. Class instances are
 * always written as `<<instance>>` markers, since they cannot be serialized.
 *
 * @param agentInstance - The agent (or agency) instance to export.
 * @param metadata - Optional human-readable metadata to attach.
 * @param options - Redaction options.
 * @returns JSON string with 2-space indentation.
 */
export function exportAgentConfigJSON(
  agentInstance: Agent,
  metadata?: AgentExportConfig['metadata'],
  options?: ExportAgentConfigOptions,
): string {
  return JSON.stringify(buildExportDocument(agentInstance, metadata, options, 'serialized'), null, 2);
}
