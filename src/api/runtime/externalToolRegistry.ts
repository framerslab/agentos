import { GMIErrorCode } from '../../core/utils/errors.js';
import type { UserContext } from '../../cognition/substrate/IGMI';

import type { ToolDefinitionForLLM } from '../../core/tools/IToolOrchestrator';
import type { IToolOrchestrator } from '../../core/tools/IToolOrchestrator';
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ITool,
  JSONSchemaObject,
} from '../../core/tools/ITool';
import { AgentOSServiceError } from '../errors';
import type { AgentOSExternalToolHandlerResult } from './processRequestWithExternalTools';

export type ExternalToolExecutor<
  TArgs extends Record<string, any> = Record<string, any>,
  TOutput = unknown,
> = (args: TArgs, context: ToolExecutionContext) => Promise<ToolExecutionResult<TOutput>>;

type ExternalToolPromptMetadata = Partial<
  Pick<
    ITool<Record<string, any>, unknown>,
    | 'name'
    | 'displayName'
    | 'description'
    | 'inputSchema'
    | 'outputSchema'
    | 'requiredCapabilities'
    | 'category'
    | 'version'
    | 'hasSideEffects'
  >
>;

export type ExternalToolRegistryEntry =
  | ExternalToolExecutor
  | (Pick<ITool<Record<string, any>, unknown>, 'execute'> & ExternalToolPromptMetadata);

export type NamedExternalToolRegistryEntry = Pick<
  ITool<Record<string, any>, unknown>,
  'name' | 'execute'
> &
  ExternalToolPromptMetadata;

export type ExternalToolRegistry =
  | ReadonlyMap<string, ExternalToolRegistryEntry>
  | Record<string, ExternalToolRegistryEntry>
  | Iterable<NamedExternalToolRegistryEntry>;

export type NormalizedExternalToolRegistry = ReadonlyMap<string, ExternalToolRegistryEntry>;

type ResolvedExternalToolRegistryEntry = {
  name: string;
  entry: ExternalToolRegistryEntry;
};

export type PromptAwareExternalToolRegistryEntry = {
  name: string;
  execute: ITool<Record<string, any>, unknown>['execute'];
  description: string;
  inputSchema: JSONSchemaObject;
  displayName?: string;
  outputSchema?: JSONSchemaObject;
  requiredCapabilities?: string[];
  category?: string;
  version?: string;
  hasSideEffects?: boolean;
};

export interface OpenAIFunctionToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: JSONSchemaObject;
  };
}

type TemporaryExternalToolRefState = {
  count: number;
};

type TemporaryExternalToolRegistration = {
  name: string;
  managesLifecycle: boolean;
};

const temporaryExternalToolRefs = new WeakMap<object, Map<string, TemporaryExternalToolRefState>>();

export function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

export function buildScopedExternalToolContextParts(input: {
  userId: string;
  organizationId?: string;
  sessionId?: string;
  conversationId?: string;
  userContext?: Record<string, unknown>;
}): {
  userContext: UserContext;
  sessionData: Record<string, unknown>;
} {
  const organizationId = normalizeOptionalString(input.organizationId);
  const userContext: UserContext = {
    ...(input.userContext ?? {}),
    userId: input.userId,
  };
  if (organizationId) {
    userContext.organizationId = organizationId;
  }

  const sessionData: Record<string, unknown> = {};
  const sessionId = normalizeOptionalString(input.sessionId);
  const conversationId = normalizeOptionalString(input.conversationId);
  if (sessionId) {
    sessionData.sessionId = sessionId;
  }
  if (conversationId) {
    sessionData.conversationId = conversationId;
  }
  if (organizationId) {
    sessionData.organizationId = organizationId;
  }

  return { userContext, sessionData };
}

function isIterableRegistry(value: unknown): value is Iterable<NamedExternalToolRegistryEntry> {
  return (
    value !== null &&
    value !== undefined &&
    typeof value !== 'string' &&
    typeof (value as Iterable<NamedExternalToolRegistryEntry>)[Symbol.iterator] === 'function'
  );
}

function isFunctionEntry(value: ExternalToolRegistryEntry): value is ExternalToolExecutor {
  return typeof value === 'function';
}

function isRecordRegistry(
  value: ExternalToolRegistry | undefined
): value is Record<string, ExternalToolRegistryEntry> {
  return (
    value !== null && value !== undefined && !isIterableRegistry(value) && !(value instanceof Map)
  );
}

function createDisplayName(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeToolName(name: string): string | undefined {
  if (typeof name !== 'string') {
    return undefined;
  }

  const trimmed = name.trim();
  return trimmed || undefined;
}

function resolveExternalToolRegistryEntries(
  registry: ExternalToolRegistry | undefined
): ResolvedExternalToolRegistryEntry[] {
  if (!registry) {
    return [];
  }

  if (registry instanceof Map) {
    return Array.from(registry.entries()).map(([name, entry]) => ({ name, entry }));
  }

  if (isIterableRegistry(registry)) {
    const resolved: ResolvedExternalToolRegistryEntry[] = [];
    for (const entry of registry) {
      resolved.push({
        name: entry.name,
        entry,
      });
    }
    return resolved;
  }

  if (!isRecordRegistry(registry)) {
    return [];
  }

  return Object.entries(registry).map(([name, entry]) => ({ name, entry }));
}

function resolveRegistryEntry(
  registry: ExternalToolRegistry | undefined,
  toolName: string
): ExternalToolRegistryEntry | undefined {
  for (const resolved of resolveExternalToolRegistryEntries(registry)) {
    if (resolved.name === toolName) {
      return resolved.entry;
    }
  }

  return undefined;
}

export function normalizeExternalToolRegistry(
  registry: ExternalToolRegistry | undefined
): NormalizedExternalToolRegistry | undefined {
  const normalized = new Map<string, ExternalToolRegistryEntry>();

  for (const resolved of resolveExternalToolRegistryEntries(registry)) {
    const toolName = normalizeToolName(resolved.name);
    if (!toolName) {
      continue;
    }

    normalized.set(toolName, resolved.entry);
  }

  return normalized.size > 0 ? normalized : undefined;
}

export function mergeExternalToolRegistries(
  ...registries: Array<ExternalToolRegistry | undefined>
): NormalizedExternalToolRegistry | undefined {
  const merged = new Map<string, ExternalToolRegistryEntry>();

  for (const registry of registries) {
    const normalized = normalizeExternalToolRegistry(registry);
    if (!normalized) {
      continue;
    }

    for (const [toolName, entry] of normalized.entries()) {
      merged.set(toolName, entry);
    }
  }

  return merged.size > 0 ? merged : undefined;
}

function getEntryExecutor(
  entry: ExternalToolRegistryEntry
): ITool<Record<string, any>, unknown>['execute'] {
  return isFunctionEntry(entry) ? entry : entry.execute.bind(entry);
}

function isPromptAwareEntry(
  name: string,
  entry: ExternalToolRegistryEntry
): entry is Pick<ITool<Record<string, any>, unknown>, 'execute'> &
  ExternalToolPromptMetadata & {
    description: string;
    inputSchema: JSONSchemaObject;
  } {
  if (isFunctionEntry(entry)) {
    return false;
  }

  return (
    typeof name === 'string' &&
    name.trim().length > 0 &&
    typeof entry.description === 'string' &&
    entry.description.trim().length > 0 &&
    typeof entry.inputSchema === 'object' &&
    entry.inputSchema !== null
  );
}

export function listPromptAwareExternalTools(
  registry: ExternalToolRegistry | undefined
): PromptAwareExternalToolRegistryEntry[] {
  return resolveExternalToolRegistryEntries(registry)
    .filter(
      (
        resolved
      ): resolved is {
        name: string;
        entry: Pick<ITool<Record<string, any>, unknown>, 'execute'> &
          ExternalToolPromptMetadata & {
            description: string;
            inputSchema: JSONSchemaObject;
          };
      } => isPromptAwareEntry(resolved.name, resolved.entry)
    )
    .map(({ name, entry }) => ({
      name,
      execute: getEntryExecutor(entry),
      displayName:
        typeof entry.displayName === 'string' && entry.displayName.trim().length > 0
          ? entry.displayName
          : createDisplayName(name),
      description: entry.description,
      inputSchema: entry.inputSchema,
      outputSchema: entry.outputSchema,
      requiredCapabilities: entry.requiredCapabilities,
      category: entry.category,
      version: entry.version,
      hasSideEffects: entry.hasSideEffects,
    }));
}

export function listExternalToolDefinitionsForLLM(
  registry: ExternalToolRegistry | undefined
): ToolDefinitionForLLM[] {
  return listPromptAwareExternalTools(registry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));
}

export function formatToolDefinitionsForOpenAI(
  definitions: ReadonlyArray<ToolDefinitionForLLM>
): OpenAIFunctionToolSchema[] {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      parameters: definition.inputSchema,
    },
  }));
}

export function formatExternalToolsForOpenAI(
  registry: ExternalToolRegistry | undefined
): OpenAIFunctionToolSchema[] {
  return formatToolDefinitionsForOpenAI(listExternalToolDefinitionsForLLM(registry));
}

export function createExternalToolProxyTool(
  entry: PromptAwareExternalToolRegistryEntry
): ITool<Record<string, any>, unknown> {
  return {
    id: `external-tool-proxy-${entry.name}`,
    name: entry.name,
    displayName: entry.displayName ?? createDisplayName(entry.name),
    description: entry.description,
    inputSchema: entry.inputSchema,
    outputSchema: entry.outputSchema,
    requiredCapabilities: entry.requiredCapabilities,
    category: entry.category,
    version: entry.version ?? 'external-proxy',
    hasSideEffects: entry.hasSideEffects,
    execute: entry.execute,
  };
}

export async function registerTemporaryExternalTools(
  toolOrchestrator: Pick<IToolOrchestrator, 'getTool' | 'registerTool' | 'unregisterTool'>,
  registry: ExternalToolRegistry | undefined
): Promise<() => Promise<void>> {
  const acquiredRegistrations: TemporaryExternalToolRegistration[] = [];
  const orchestratorKey = toolOrchestrator as object;
  let orchestratorRefs = temporaryExternalToolRefs.get(orchestratorKey);
  if (!orchestratorRefs) {
    orchestratorRefs = new Map<string, TemporaryExternalToolRefState>();
    temporaryExternalToolRefs.set(orchestratorKey, orchestratorRefs);
  }

  try {
    for (const promptAwareTool of listPromptAwareExternalTools(registry)) {
      const existingTool = await toolOrchestrator.getTool(promptAwareTool.name);
      const existingRef = orchestratorRefs.get(promptAwareTool.name);
      if (existingRef) {
        existingRef.count += 1;
        acquiredRegistrations.push({
          name: promptAwareTool.name,
          managesLifecycle: true,
        });
        continue;
      }
      if (existingTool) {
        acquiredRegistrations.push({
          name: promptAwareTool.name,
          managesLifecycle: false,
        });
        continue;
      }

      await toolOrchestrator.registerTool(createExternalToolProxyTool(promptAwareTool));
      orchestratorRefs.set(promptAwareTool.name, { count: 1 });
      acquiredRegistrations.push({
        name: promptAwareTool.name,
        managesLifecycle: true,
      });
    }
  } catch (error) {
    for (const registration of acquiredRegistrations.reverse()) {
      if (!registration.managesLifecycle) {
        continue;
      }

      const refState = orchestratorRefs.get(registration.name);
      if (!refState) {
        continue;
      }

      if (refState.count > 1) {
        refState.count -= 1;
        continue;
      }

      orchestratorRefs.delete(registration.name);
      await toolOrchestrator.unregisterTool(registration.name).catch(() => false);
    }
    throw error;
  }

  return async () => {
    for (const registration of acquiredRegistrations.reverse()) {
      if (!registration.managesLifecycle) {
        continue;
      }

      const refState = orchestratorRefs.get(registration.name);
      if (!refState) {
        continue;
      }

      if (refState.count > 1) {
        refState.count -= 1;
        continue;
      }

      orchestratorRefs.delete(registration.name);
      await toolOrchestrator.unregisterTool(registration.name).catch(() => false);
    }

    if (orchestratorRefs.size === 0) {
      temporaryExternalToolRefs.delete(orchestratorKey);
    }
  };
}

export async function executeExternalToolFromRegistry(
  registry: ExternalToolRegistry | undefined,
  toolName: string,
  args: Record<string, any>,
  context: ToolExecutionContext,
  options: {
    errorOrigin: string;
    failureMessage: string;
  }
): Promise<AgentOSExternalToolHandlerResult | undefined> {
  const entry = resolveRegistryEntry(registry, toolName);
  if (!entry) {
    return undefined;
  }

  const executor = getEntryExecutor(entry);

  try {
    const execution = await executor(args, context);

    return {
      toolOutput: execution.output,
      isSuccess: execution.success,
      errorMessage: execution.error,
    };
  } catch (error: unknown) {
    throw AgentOSServiceError.wrap(
      error,
      GMIErrorCode.TOOL_ERROR,
      options.failureMessage,
      options.errorOrigin
    );
  }
}
