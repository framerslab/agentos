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

import type { AgentOSInput } from '../types/AgentOSInput';
import type { ILogger } from '../../core/logging/ILogger';
import type { SelfImprovementToolDeps } from '../../cognition/emergent/EmergentCapabilityEngine.js';
import { PersonalityMutationStore } from '../../cognition/emergent/PersonalityMutationStore.js';
import { resolveSelfImprovementSessionKey } from '../../cognition/emergent/sessionScope.js';
import type { CapabilityIndexSources } from '../../cognition/discovery/types';
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
  /** Returns the first active GMI, if any. */
  getActiveGMI: () => any | undefined;
  /** Returns the tool orchestrator instance. */
  getToolOrchestrator: () => import('../core/tools/IToolOrchestrator').IToolOrchestrator;
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
      getPersonality: (): Record<string, number> => {
        try {
          const gmi = accessors.getActiveGMI();
          const traits = gmi?.getPersona()?.personalityTraits;
          if (traits && typeof traits === 'object') {
            const result: Record<string, number> = {};
            for (const [k, v] of Object.entries(traits)) {
              if (typeof v === 'number') result[k] = v;
            }
            return result;
          }
        } catch { /* GMI not ready yet — return empty. */ }
        return {};
      },
      setPersonality: (trait: string, value: number): void => {
        try {
          const gmi = accessors.getActiveGMI();
          const persona = gmi?.getPersona();
          if (persona) {
            if (!persona.personalityTraits) {
              persona.personalityTraits = {};
            }
            persona.personalityTraits[trait] = value;
          }
        } catch { /* GMI not ready — ignore. */ }
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
        context?: import('../core/tools/ITool.js').ToolExecutionContext,
      ): Promise<unknown> => {
        const orchestrator = accessors.getToolOrchestrator();
        const tool = await orchestrator.getTool(name);
        if (!tool) {
          throw new Error(`Tool "${name}" not found in orchestrator.`);
        }
        const result = await tool.execute(
          (args ?? {}) as Record<string, unknown>,
          context ?? {
            gmiId: 'self-improvement',
            personaId: 'self-improvement',
            userContext: { userId: 'system' } as any,
          },
        );
        if (!result.success) {
          throw new Error(result.error ?? `Tool "${name}" failed.`);
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
      storeMemory: async (trace): Promise<void> => {
        try {
          const gmi = accessors.getActiveGMI();
          const mem = gmi?.getCognitiveMemoryManager?.();
          if (mem) {
            await mem.encode(
              `[self-improvement:${trace.type}] ${trace.content}`,
              { valence: 0, arousal: 0, dominance: 0.5 },
              'neutral',
              {
                type: 'semantic' as any,
                scope: (trace.scope ?? 'agent') as any,
                tags: trace.tags,
              },
            );
          }
        } catch { /* Memory not available — silently skip. */ }
      },
    };
  }
}
