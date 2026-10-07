/**
 * @file SelfImprovementSessionManager.ts
 * @module api/SelfImprovementSessionManager
 *
 * @description
 * Manages self-improvement session runtime state: per-session skill
 * activation/deactivation, model option overrides, user preference
 * tracking, and prompt context generation.
 *
 * Previously these concerns were distributed across ~10 private methods
 * inside `AgentOS.ts`. This extraction centralizes session-scoped
 * self-improvement logic into a single focused class.
 *
 * The class also exposes a `buildToolDeps()` factory that assembles the
 * `SelfImprovementToolDeps` closure object required by the emergent
 * capability engine. The closures returned by `buildToolDeps()` reference
 * runtime services lazily through callback accessors, so they resolve
 * against the fully initialized AgentOS at tool-call time, not at
 * bootstrap.
 */

import { randomUUID } from 'node:crypto';
import type { AgentOSInput } from '../types/AgentOSInput';
import type { ILogger } from '../../core/logging/ILogger';
import type { ToolExecutionContext } from '../../core/tools/ITool.js';
import type { SelfImprovementToolDeps } from '../../cognition/emergent/EmergentCapabilityEngine.js';
import { PersonalityMutationStore } from '../../cognition/emergent/PersonalityMutationStore.js';
import { resolveSelfImprovementSessionKey } from '../../cognition/emergent/sessionScope.js';
import type { CapabilityIndexSources } from '../../cognition/discovery/types';
import type { IGMI } from '../../cognition/substrate/IGMI.js';
import {
  HEXACO_TRAIT_KEYS,
  normalizeHexacoTraits,
} from '../../cognition/substrate/personas/hexaco.js';
import type { MemoryScope } from '../../cognition/memory/core/types.js';
import { resolveMemoryToolScopeId } from '../../cognition/memory/io/tools/scopeContext.js';
import type { StorageAdapter } from '@framers/sql-storage-adapter';

import {
  applySelfImprovementSessionOverrides as applySessionRuntimeOverrides,
  buildSelfImprovementSkillPromptContext as buildSessionSkillPromptContext,
  buildSelfImprovementSessionRuntimeKey as buildSessionRuntimeKey,
  disableSelfImprovementSessionSkill as disableSessionSkill,
  enableSelfImprovementSessionSkill as enableSessionSkill,
  getSelfImprovementRuntimeParam as getSessionRuntimeParam,
  listSelfImprovementDisabledSkillIds as listDisabledSessionSkillIds,
  listSelfImprovementSessionSkills as listSessionSkills,
  type SelfImprovementSkillDescriptor,
  type SelfImprovementSessionRuntimeState,
  setSelfImprovementRuntimeParam as setSessionRuntimeParam,
} from './selfImprovementRuntime.js';

/**
 * Shape for configured skills discovered from the AgentOS config.
 * Matches the non-null element type of `CapabilityIndexSources['skills']`
 * augmented with an optional `id` field.
 */
type ConfiguredSkill = NonNullable<CapabilityIndexSources['skills']>[number] & {
  id?: string;
};

function resolveSessionKey(
  context?: import('../core/tools/ITool.js').ToolExecutionContext,
): string {
  return resolveSelfImprovementSessionKey(
    (context ?? {
      gmiId: 'self-improvement',
      personaId: 'self-improvement',
      userContext: { userId: 'system' } as any,
    }) as import('../core/tools/ITool.js').ToolExecutionContext,
  );
}

/**
 * Lazy accessors injected by AgentOS so that `buildToolDeps()` closures
 * can resolve runtime services at tool-call time rather than at bootstrap.
 */
export interface SelfImprovementRuntimeAccessors {
  /**
   * Returns the GMI that issued a tool call, resolved from the call's
   * execution context, or `undefined` when no active GMI matches. It must
   * never fall back to an arbitrary GMI: the hooks that use it change that
   * instance's personality and write to its memory.
   */
  getGMIForContext: (context?: ToolExecutionContext) => IGMI | undefined;
  /** Returns the tool orchestrator instance. */
  getToolOrchestrator: () => import('../core/tools/IToolOrchestrator').IToolOrchestrator;
}

/**
 * The part of GMIManager that maps instance ids and session ids to active
 * GMIs. GMIManager exposes both maps publicly.
 */
export interface GMISessionRegistry {
  /** Active GMIs keyed by GMI instance id. */
  readonly activeGMIs: ReadonlyMap<string, IGMI>;
  /** GMI instance id keyed by session id. */
  readonly gmiSessionMap: ReadonlyMap<string, string>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/**
 * Resolves the GMI that issued a tool call. The GMI instance id in
 * `context.gmiId` is tried first, then the session id in
 * `context.sessionData.sessionId`. Returns `undefined` when neither matches an
 * active GMI, and never falls back to another session's GMI.
 *
 * The maps are read directly rather than through
 * `GMIManager.getGMIByInstanceId`, which throws before the manager is
 * initialized.
 *
 * @param registry - GMIManager (or any object with the same two maps).
 * @param context - Execution context of the tool call.
 * @returns The calling GMI, or `undefined`.
 */
export function resolveGMIForToolContext(
  registry: GMISessionRegistry | undefined,
  context?: ToolExecutionContext,
): IGMI | undefined {
  if (!registry || !context) {
    return undefined;
  }

  const gmiId = nonEmptyString(context.gmiId);
  if (gmiId) {
    const byInstanceId = registry.activeGMIs.get(gmiId);
    if (byInstanceId) {
      return byInstanceId;
    }
  }

  const sessionId = nonEmptyString(context.sessionData?.sessionId);
  if (sessionId) {
    const instanceId = registry.gmiSessionMap.get(sessionId);
    if (instanceId) {
      return registry.activeGMIs.get(instanceId);
    }
  }

  return undefined;
}

/**
 * Maps the free-form scope on a self-improvement trace to a cognitive memory
 * scope and its id for the calling session. 'session' (and any unknown value)
 * becomes the `thread` scope of the calling conversation; 'user' and
 * 'organization' keep their meaning; 'agent' and 'persona' become the
 * per-user persona scope. Ids come from the execution context, the same way
 * the memory tools resolve them.
 *
 * @param scope - Scope named on the trace, e.g. 'session'.
 * @param context - Execution context of the tool call.
 * @returns The target scope, or `undefined` when its id cannot be resolved.
 */
function resolveSelfImprovementMemoryScope(
  scope: string | undefined,
  context: ToolExecutionContext,
): { scope: MemoryScope; scopeId: string } | undefined {
  const requested = (scope ?? '').trim().toLowerCase();
  const memoryScope: MemoryScope =
    requested === 'user'
      ? 'user'
      : requested === 'organization'
        ? 'organization'
        : requested === 'agent' || requested === 'persona'
          ? 'persona'
          : 'thread';
  const scopeId = resolveMemoryToolScopeId(memoryScope, context);
  return scopeId ? { scope: memoryScope, scopeId } : undefined;
}

/**
 * @class SelfImprovementSessionManager
 *
 * Owns the `selfImprovementSessionRuntime` map and exposes all session-scoped
 * operations: key building, param get/set, skill enable/disable, override
 * application, prompt context generation, and tool-deps factory.
 */
export class SelfImprovementSessionManager {
  /** Per-session runtime state (model options, user prefs, skills). */
  private readonly sessionRuntime = new Map<string, SelfImprovementSessionRuntimeState>();

  /** Skill catalog from config, resolved lazily on first access. */
  private configuredSkillsGetter?: () => ConfiguredSkill[];

  constructor(private readonly logger: ILogger) {}

  // ---------------------------------------------------------------------------
  // Configuration
  // ---------------------------------------------------------------------------

  /**
   * Provide a lazy getter for the configured skill catalog. This is called
   * once during AgentOS initialization with a closure that reads the frozen
   * config at call time.
   *
   * @param getter - Callable that returns the current configured skills array.
   */
  public setConfiguredSkillsGetter(getter: () => ConfiguredSkill[]): void {
    this.configuredSkillsGetter = getter;
  }

  // ---------------------------------------------------------------------------
  // Session key helpers
  // ---------------------------------------------------------------------------

  /**
   * Build the canonical session runtime key from a session ID.
   *
   * @param sessionId - The raw session identifier.
   * @returns Normalized session key string.
   */
  public buildSessionRuntimeKey(sessionId: string): string {
    return buildSessionRuntimeKey(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Parameter access
  // ---------------------------------------------------------------------------

  /**
   * Get a runtime parameter value for a session.
   *
   * @param sessionKey - Canonical session key.
   * @param param      - Parameter name.
   * @returns The stored value, or `undefined`.
   */
  public getRuntimeParam(sessionKey: string, param: string): unknown {
    return getSessionRuntimeParam(this.sessionRuntime, sessionKey, param);
  }

  /**
   * Set a runtime parameter value for a session.
   *
   * @param sessionKey - Canonical session key.
   * @param param      - Parameter name.
   * @param value      - Value to store.
   */
  public setRuntimeParam(sessionKey: string, param: string, value: unknown): void {
    setSessionRuntimeParam(this.sessionRuntime, sessionKey, param, value);
  }

  // ---------------------------------------------------------------------------
  // Session overrides
  // ---------------------------------------------------------------------------

  /**
   * Apply self-improvement session overrides (model options, user preferences)
   * to an `AgentOSInput` payload.
   *
   * @param input - The original input.
   * @returns A new input with merged session overrides.
   */
  public applySessionOverrides(input: AgentOSInput): AgentOSInput {
    return applySessionRuntimeOverrides(this.sessionRuntime, input);
  }

  // ---------------------------------------------------------------------------
  // Skill catalog
  // ---------------------------------------------------------------------------

  /**
   * Return the configured discovery skills from the AgentOS config.
   *
   * @returns Array of configured skill descriptors.
   */
  public getConfiguredDiscoverySkills(): ConfiguredSkill[] {
    if (this.configuredSkillsGetter) {
      return this.configuredSkillsGetter();
    }
    return [];
  }

  /**
   * Normalize a partial configured skill into a full descriptor.
   *
   * @param skill      - Partial skill data.
   * @param fallbackId - Optional fallback ID when none is available.
   * @returns Normalized skill descriptor.
   */
  public normalizeConfiguredSkill(
    skill: Partial<ConfiguredSkill>,
    fallbackId?: string,
  ): SelfImprovementSkillDescriptor {
    const skillId = String(skill.id ?? skill.name ?? fallbackId ?? 'unknown');
    return {
      skillId,
      name: String(skill.name ?? fallbackId ?? skillId),
      category: String(skill.category ?? 'general'),
      ...(typeof skill.description === 'string' ? { description: skill.description } : {}),
      ...(typeof skill.content === 'string' ? { content: skill.content } : {}),
      ...(typeof skill.sourcePath === 'string' ? { sourcePath: skill.sourcePath } : {}),
    };
  }

  /**
   * Resolve a skill descriptor by ID from the configured skill catalog.
   *
   * @param skillId - The skill identifier to look up.
   * @returns The resolved descriptor, or `undefined` if not found.
   */
  public resolveConfiguredSkill(skillId: string): SelfImprovementSkillDescriptor | undefined {
    const configured = this.getConfiguredDiscoverySkills().find(
      (skill) => String(skill.id ?? skill.name ?? '') === skillId,
    );
    return configured ? this.normalizeConfiguredSkill(configured, skillId) : undefined;
  }

  // ---------------------------------------------------------------------------
  // Session skill management
  // ---------------------------------------------------------------------------

  /**
   * List active skills for a session.
   *
   * @param sessionKey - Canonical session key.
   * @returns Array of enabled skill descriptors.
   */
  public listSessionSkills(sessionKey: string): SelfImprovementSkillDescriptor[] {
    return listSessionSkills(this.sessionRuntime, sessionKey);
  }

  /**
   * List disabled skill IDs for a session.
   *
   * @param sessionKey - Canonical session key.
   * @returns Array of disabled skill identifier strings.
   */
  public listDisabledSkillIds(sessionKey: string): string[] {
    return listDisabledSessionSkillIds(this.sessionRuntime, sessionKey);
  }

  /**
   * Build skill-related prompt context for a session.
   *
   * @param sessionId - The raw session identifier.
   * @returns Prompt context string, or `undefined` when empty.
   */
  public buildSkillPromptContext(sessionId: string): string | undefined {
    const sessionKey = this.buildSessionRuntimeKey(sessionId);
    return buildSessionSkillPromptContext(this.sessionRuntime, sessionKey);
  }

  // ---------------------------------------------------------------------------
  // SelfImprovementToolDeps factory
  // ---------------------------------------------------------------------------

  /**
   * Build the `SelfImprovementToolDeps` closure object consumed by the
   * emergent capability engine. All closures resolve lazily against the
   * provided runtime accessors.
   *
   * @param storageAdapter - Optional storage adapter for the personality mutation store.
   * @param accessors      - Lazy runtime service accessors.
   * @returns Assembled `SelfImprovementToolDeps`, or `undefined` when no
   *          storage adapter or accessors are available.
   */
  public buildToolDeps(
    storageAdapter: StorageAdapter | undefined,
    accessors: SelfImprovementRuntimeAccessors,
  ): SelfImprovementToolDeps {
    const mutationStore = storageAdapter
      ? new PersonalityMutationStore({
          run: async (sql: string, params?: unknown[]) =>
            storageAdapter.run(sql, params as any),
          get: async (sql: string, params?: unknown[]) =>
            storageAdapter.get(sql, params as any),
          all: async (sql: string, params?: unknown[]) =>
            storageAdapter.all(sql, params as any),
          exec: async (sql: string) => storageAdapter.exec(sql),
          // Forward transaction support so decayForAgent's guard-first
          // decay unit is atomic (spec batch-1 C6). Mirrors the main
          // AgentOS storage wrapper, which preserves this capability —
          // this wrapper previously dropped it.
          transaction: async <T>(
            fn: (tx: {
              run: (sql: string, params?: unknown[]) => Promise<unknown>;
              get: (sql: string, params?: unknown[]) => Promise<unknown>;
              all: (sql: string, params?: unknown[]) => Promise<unknown[]>;
            }) => Promise<T>,
          ): Promise<T> =>
            storageAdapter.transaction(async (trx) =>
              fn({
                run: async (sql, params) => trx.run(sql, params as any),
                get: async (sql, params) => trx.get(sql, params as any),
                all: async (sql, params) => trx.all(sql, params as any),
              }),
            ),
        })
      : undefined;

    return {
      // --- Personality (HEXACO) ---
      // Both hooks act on the GMI that made the tool call. Traits are read
      // under canonical keys, so a persona authored with `honestyHumility`
      // reports its real Honesty-Humility score.
      getPersonality: (context?: ToolExecutionContext): Record<string, number> => {
        const result: Record<string, number> = {};
        try {
          const traits = normalizeHexacoTraits(
            accessors.getGMIForContext(context)?.getPersona()?.personalityTraits,
          );
          for (const key of HEXACO_TRAIT_KEYS) {
            const value = traits[key];
            if (value !== undefined) result[key] = value;
          }
        } catch { /* GMI not initialized: report no traits. */ }
        return result;
      },
      setPersonality: (trait: string, value: number, context?: ToolExecutionContext): boolean => {
        const gmi = accessors.getGMIForContext(context);
        if (!gmi || typeof gmi.setPersonalityTrait !== 'function') {
          return false;
        }
        try {
          // Copy-on-write inside the GMI: the shared persona definition is untouched.
          gmi.setPersonalityTrait(trait, value);
          return true;
        } catch {
          // GMI not initialized: nothing was changed.
          return false;
        }
      },
      mutationStore,

      // --- Skills ---
      getActiveSkills: (
        context?: import('../core/tools/ITool.js').ToolExecutionContext,
      ): Array<{ skillId: string; name: string; category: string }> => {
        const sessionKey = resolveSessionKey(context);
        return this.listSessionSkills(sessionKey).map((skill) => ({
          skillId: skill.skillId,
          name: skill.name,
          category: skill.category,
        }));
      },
      getLockedSkills: (): string[] => [],
      loadSkill: async (
        id: string,
        context?: import('../core/tools/ITool.js').ToolExecutionContext,
      ) => {
        const sessionKey = resolveSessionKey(context);
        const resolvedSkill = this.resolveConfiguredSkill(id) ?? {
          skillId: id,
          name: id,
          category: 'dynamic',
        };
        enableSessionSkill(this.sessionRuntime, sessionKey, resolvedSkill);
        return {
          skillId: resolvedSkill.skillId,
          name: resolvedSkill.name,
          category: resolvedSkill.category,
        };
      },
      unloadSkill: (
        id: string,
        context?: import('../core/tools/ITool.js').ToolExecutionContext,
      ) => {
        const sessionKey = resolveSessionKey(context);
        const resolvedSkill = this.resolveConfiguredSkill(id);
        disableSessionSkill(this.sessionRuntime, sessionKey, resolvedSkill?.name ?? id);
      },
      searchSkills: (query: string) => {
        const q = query.toLowerCase();
        return this.getConfiguredDiscoverySkills()
          .filter(
            (skill) =>
              (skill.name ?? '').toLowerCase().includes(q) ||
              (skill.description ?? '').toLowerCase().includes(q),
          )
          .map((skill) => {
            const normalizedSkill = this.normalizeConfiguredSkill(skill);
            return {
              skillId: normalizedSkill.skillId,
              name: normalizedSkill.name,
              category: normalizedSkill.category,
              description: normalizedSkill.description ?? '',
            };
          });
      },

      // --- Tools ---
      executeTool: async (
        name: string,
        args: unknown,
        context?: ToolExecutionContext,
        signal?: AbortSignal,
      ): Promise<unknown> => {
        const orchestrator = accessors.getToolOrchestrator();
        const caller: ToolExecutionContext = context ?? {
          gmiId: 'self-improvement',
          personaId: 'self-improvement',
          userContext: { userId: 'system' } as ToolExecutionContext['userContext'],
        };
        // Through processToolCall, so a workflow step meets the disabled list,
        // the permission check (as the caller) and the approval a direct call
        // meets; an expired step's signal stops it before its tool starts.
        const result = await orchestrator.processToolCall({
          toolCallRequest: {
            id: `workflow-step-${randomUUID()}`,
            name,
            arguments: (args ?? {}) as Record<string, any>,
          },
          gmiId: caller.gmiId,
          personaId: caller.personaId,
          personaCapabilities: caller.personaCapabilities ?? [],
          userContext: caller.userContext,
          correlationId: caller.correlationId,
          sessionData: caller.sessionData,
          ...(signal ? { signal } : {}),
        });
        if (result.isError) {
          throw new Error(
            (result.errorDetails as { message?: string } | undefined)?.message ?? `Tool "${name}" failed.`,
          );
        }
        return result.output;
      },
      listTools: (): string[] => {
        try {
          const orchestrator = accessors.getToolOrchestrator();
          return (orchestrator as any).toolExecutor
            ?.listAvailableTools()
            ?.map((t: any) => t.name) ?? [];
        } catch {
          return [];
        }
      },
      getSessionParam: (param: string, context) => {
        const sessionKey = resolveSessionKey(context);
        return this.getRuntimeParam(sessionKey, param);
      },
      setSessionParam: (param: string, value: unknown, context) => {
        const sessionKey = resolveSessionKey(context);
        this.setRuntimeParam(sessionKey, param, value);
      },

      // --- Memory ---
      // Self-evaluation traces carry the user's query. They go to the calling
      // GMI's memory under a valid scope with an explicit id, so a memory
      // backend shared by several sessions keeps them in the session that
      // produced them.
      storeMemory: async (trace, context): Promise<void> => {
        if (!context) {
          return;
        }
        const memory = accessors.getGMIForContext(context)?.getCognitiveMemoryManager?.();
        if (!memory) {
          return;
        }
        const target = resolveSelfImprovementMemoryScope(trace.scope, context);
        if (!target) {
          this.logger.debug?.('[SelfImprovement] Skipped a memory trace: no scope id for the calling session.', {
            traceType: trace.type,
            scope: trace.scope,
            gmiId: context.gmiId,
          });
          return;
        }
        try {
          await memory.encode(
            `[self-improvement:${trace.type}] ${trace.content}`,
            { valence: 0, arousal: 0, dominance: 0.5 },
            'neutral',
            {
              type: 'semantic',
              scope: target.scope,
              scopeId: target.scopeId,
              tags: trace.tags,
            },
          );
        } catch { /* Memory not available: skip. */ }
      },
    };
  }
}
