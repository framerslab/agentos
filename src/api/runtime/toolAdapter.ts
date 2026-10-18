/**
 * @file toolAdapter.ts
 * Adapts user-supplied tool definitions (plain objects, Zod schemas, or `ITool`
 * instances) into the canonical `ITool` shape expected by the AgentOS runtime.
 *
 * This module is used internally by {@link generateText} and {@link streamText} to
 * normalise the `tools` option before handing them to a provider.
 */
import type {
  ITool,
  ToolExecutionResult,
  ToolExecutionContext,
  JSONSchemaObject,
} from '../../core/tools/ITool.js';
import type { ToolDefinitionForLLM } from '../../core/tools/IToolOrchestrator.js';
import type { ExternalToolRegistry } from './externalToolRegistry.js';

/**
 * Loose tool definition accepted by the high-level API.
 * Consumers may supply a plain object with an optional Zod or JSON Schema
 * `parameters` shape plus an `execute` callback.
 */
export interface ToolDefinition {
  /** Human-readable description forwarded to the model in the tool schema. */
  description?: string;
  /**
   * Parameter schema for the tool. Accepts a JSON Schema object or a Zod schema.
   * When a Zod schema is detected (`_def` property present) the adapter attempts
   * to convert it via `zod-to-json-schema`, falling back to an empty object schema
   * if that package is not installed.
   */
  parameters?: Record<string, unknown> | object;
  /**
   * Async function that receives the parsed tool arguments and returns any value.
   * Omit to create a no-op tool (returns `{ success: true }`).
   */
  execute?: (args: any) => Promise<any>;
}

/** Map of tool name → definition accepted by the high-level API. */
export type ToolDefinitionMap = Record<string, ToolDefinition | ITool>;

/**
 * Additional tool inputs accepted by the high-level API.
 *
 * - `ExternalToolRegistry`: host-managed external tools, including `Map` and iterable forms.
 * - `ToolDefinitionForLLM[]`: prompt-only schemas with no attached executor.
 */
export type AdaptableToolInput =
  | ToolDefinitionMap
  | ExternalToolRegistry
  | ReadonlyArray<ToolDefinitionForLLM>;

type NamedExternalToolEntry = {
  name: string;
  execute?: (args: any, context: ToolExecutionContext) => Promise<ToolExecutionResult | unknown>;
  description?: string;
  displayName?: string;
  inputSchema?: JSONSchemaObject;
  outputSchema?: JSONSchemaObject;
  requiredCapabilities?: string[];
  category?: string;
  version?: string;
  hasSideEffects?: boolean;
};

function defaultObjectSchema(): JSONSchemaObject {
  return { type: 'object', properties: {} };
}

function humanizeToolName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function isIterableInput(value: unknown): value is Iterable<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    !Array.isArray(value) &&
    typeof (value as Iterable<unknown>)[Symbol.iterator] === 'function'
  );
}

function isITool(value: unknown): value is ITool {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'inputSchema' in value &&
    typeof (value as ITool).execute === 'function'
  );
}

function isToolDefinitionForLLM(value: unknown): value is ToolDefinitionForLLM {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolDefinitionForLLM).name === 'string' &&
    typeof (value as ToolDefinitionForLLM).description === 'string' &&
    typeof (value as ToolDefinitionForLLM).inputSchema === 'object' &&
    (value as ToolDefinitionForLLM).inputSchema !== null &&
    !('execute' in (value as Record<string, unknown>))
  );
}

function isNamedExternalToolEntry(value: unknown): value is NamedExternalToolEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NamedExternalToolEntry).name === 'string' &&
    ('execute' in (value as Record<string, unknown>) ||
      'inputSchema' in (value as Record<string, unknown>) ||
      'description' in (value as Record<string, unknown>) ||
      'displayName' in (value as Record<string, unknown>))
  );
}

function isExternalRegistryObjectEntry(value: unknown): value is NamedExternalToolEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as NamedExternalToolEntry).execute === 'function' &&
    !('parameters' in (value as Record<string, unknown>))
  );
}

function normalizeExecutionResult(output: unknown): ToolExecutionResult {
  if (
    typeof output === 'object' &&
    output !== null &&
    'success' in (output as Record<string, unknown>) &&
    typeof (output as ToolExecutionResult).success === 'boolean'
  ) {
    return output as ToolExecutionResult;
  }

  return {
    success: true,
    output,
  };
}

function createPromptOnlyTool(definition: ToolDefinitionForLLM): ITool {
  return {
    id: `${definition.name}-prompt-only-v1`,
    name: definition.name,
    displayName: humanizeToolName(definition.name),
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    hasSideEffects: false,
    async execute(): Promise<ToolExecutionResult> {
      return {
        success: false,
        error: `No executor configured for prompt-only tool "${definition.name}".`,
      };
    },
  };
}

function createToolFromDefinition(name: string, def: ToolDefinition): ITool {
  let schema: JSONSchemaObject;

  if (def.parameters && '_def' in (def.parameters as any)) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { zodToJsonSchema } = require('zod-to-json-schema') as any;
      schema = zodToJsonSchema(def.parameters) as JSONSchemaObject;
    } catch {
      schema = defaultObjectSchema();
    }
  } else {
    schema = (def.parameters ?? defaultObjectSchema()) as JSONSchemaObject;
  }

  const executeFn = def.execute ?? (async () => ({ success: true }));

  return {
    id: `${name}-v1`,
    name,
    displayName: humanizeToolName(name),
    description: def.description ?? '',
    inputSchema: schema,
    hasSideEffects: false,
    async execute(args: any, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      try {
        return normalizeExecutionResult(await executeFn(args));
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    },
  };
}

function createToolFromExternalEntry(name: string, entry: NamedExternalToolEntry): ITool {
  const displayName = entry.displayName ?? humanizeToolName(name);
  const description =
    typeof entry.description === 'string' && entry.description.trim().length > 0
      ? entry.description
      : displayName;
  const executeFn =
    typeof entry.execute === 'function'
      ? entry.execute
      : async () => ({
          success: false,
          error: `No executor configured for external tool "${name}".`,
        });

  return {
    id: `${name}-external-v1`,
    name,
    displayName,
    description,
    inputSchema: entry.inputSchema ?? defaultObjectSchema(),
    outputSchema: entry.outputSchema,
    requiredCapabilities: entry.requiredCapabilities,
    category: entry.category,
    version: entry.version,
    hasSideEffects: entry.hasSideEffects ?? false,
    async execute(args: any, context: ToolExecutionContext): Promise<ToolExecutionResult> {
      try {
        return normalizeExecutionResult(await executeFn(args, context));
      } catch (err: any) {
        return { success: false, error: err?.message ?? String(err) };
      }
    },
  };
}

function adaptNamedEntries(entries: Iterable<[string, unknown]>): ITool[] {
  const result: ITool[] = [];

  for (const [name, def] of entries) {
    if (isITool(def)) {
      result.push(def);
      continue;
    }

    if (typeof def === 'function') {
      result.push(
        createToolFromExternalEntry(name, {
          name,
          execute: def as NamedExternalToolEntry['execute'],
        })
      );
      continue;
    }

    if (isExternalRegistryObjectEntry(def)) {
      result.push(createToolFromExternalEntry(name, def));
      continue;
    }

    result.push(createToolFromDefinition(name, def as ToolDefinition));
  }

  return result;
}

/**
 * Converts supported tool inputs into an array of `ITool` instances
 * suitable for use with the AgentOS provider layer.
 *
 * - Existing `ITool` instances (identified by `inputSchema` + `id` properties)
 *   are passed through unchanged.
 * - Plain `ToolDefinition` objects are wrapped in a minimal `ITool`
 *   implementation.  Zod schemas are converted to JSON Schema when `zod-to-json-schema`
 *   is available.
 * - {@link ExternalToolRegistry} inputs are adapted into executable `ITool`
 *   instances, preserving any prompt metadata they expose.
 * - `ToolDefinitionForLLM[]` arrays are treated as prompt-only schemas and
 *   produce tools that fail explicitly when invoked without an executor.
 *
 * @param tools - Optional map of tool names to definitions. Returns `[]` when falsy.
 * @returns Flat array of normalised `ITool` instances ready for provider dispatch.
 *
 * @example
 * ```ts
 * const tools = adaptTools({
 *   getWeather: {
 *     description: 'Returns current weather for a city.',
 *     parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
 *     execute: async ({ city }) => fetchWeather(city),
 *   },
 * });
 * ```
 */
/**
 * Whether `tools` is an iterator, which one read exhausts (a generator): such
 * a table is read once, since a second {@link adaptTools} of it would be
 * empty. An array, a Map, a record and an iterable that makes a fresh iterator
 * on each read are read again before a later step.
 *
 * @param tools - The high-level tool input.
 * @returns `true` for an iterator.
 */
export function isSingleUseToolInput(tools: AdaptableToolInput | undefined): boolean {
  return isIterableInput(tools) && typeof (tools as { next?: unknown }).next === 'function';
}

export function adaptTools(tools: AdaptableToolInput | undefined): ITool[] {
  if (!tools) return [];

  if (Array.isArray(tools)) {
    if (tools.every(isToolDefinitionForLLM)) {
      return tools.map((definition) => createPromptOnlyTool(definition));
    }

    if (tools.every(isNamedExternalToolEntry)) {
      return adaptNamedEntries(tools.map((entry) => [entry.name, entry]));
    }

    return [];
  }

  if (tools instanceof Map) {
    return adaptNamedEntries(tools.entries());
  }

  if (isIterableInput(tools)) {
    const namedEntries = Array.from(tools as Iterable<unknown>).filter(isNamedExternalToolEntry);
    return adaptNamedEntries(namedEntries.map((entry) => [entry.name, entry]));
  }

  return adaptNamedEntries(Object.entries(tools));
}

/**
 * Converts any supported tool input into a named tool map.
 *
 * Later helpers such as `agent()` / `agency()` use this to safely merge tool
 * inputs that may arrive as records, `Map` registries, or prompt-only schemas.
 * The returned map always contains executable `ITool` instances keyed by
 * tool name.
 *
 * @param tools - Optional high-level tool input.
 * @returns A name-keyed tool map. Returns `{}` when no tools are supplied.
 */
export function adaptToolsToMap(tools: AdaptableToolInput | undefined): ToolDefinitionMap {
  if (!tools) return {};

  const map: ToolDefinitionMap = {};
  for (const tool of adaptTools(tools)) {
    map[tool.name] = tool;
  }
  return map;
}

/**
 * Merges supported tool inputs with later inputs taking precedence by tool name.
 *
 * This normalizes each input first, which means agency-level defaults can be
 * combined safely with per-agent maps, external registries, or prompt-only tool
 * schemas without relying on object spread semantics.
 *
 * @param inputs - Tool inputs ordered from lowest to highest precedence.
 * @returns A merged tool map, or `undefined` when no tools were supplied.
 */
export function mergeAdaptableTools(
  ...inputs: Array<AdaptableToolInput | undefined>
): ToolDefinitionMap | undefined {
  const merged: ToolDefinitionMap = {};

  for (const input of inputs) {
    Object.assign(merged, adaptToolsToMap(input));
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}
