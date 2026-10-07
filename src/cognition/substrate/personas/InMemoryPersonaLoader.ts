/**
 * @file InMemoryPersonaLoader.ts
 * An IPersonaLoader over a fixed list of definitions: what `AgentOS.create({ personas })`
 * uses, and a building block for callers composing their own sources.
 */
import { uuidv4 } from '../../../core/utils/uuid';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import type { IPersonaDefinition } from './IPersonaDefinition';
import type { IPersonaLoader, PersonaLoaderConfig } from './IPersonaLoader';
import { clonePersonaDefinition, normalizePersonaDefinition } from './personaNormalization';

/** The `personaLoaderConfig` the runtime records when personas come from an inline list. */
export const INLINE_PERSONA_LOADER_CONFIG: PersonaLoaderConfig = { personaSource: 'inline', loaderType: 'in_memory' };

/**
 * Structural rules for an inline persona list, cheap enough to run before any subsystem
 * starts: an array; every entry an object with a non-empty string `id`; no duplicate `id`;
 * `activationKeywords`, when present, an array of strings; `sentimentTracking.presets`, when present,
 * an array. Semantic validation (required fields,
 * semver, prompt length) still runs in GMIManager through `validatePersonas`.
 * @throws GMIError CONFIGURATION_ERROR naming the offending index or id.
 */
export function assertInlinePersonaDefinitions(definitions: unknown): asserts definitions is IPersonaDefinition[] {
  if (!Array.isArray(definitions)) {
    throw new GMIError('`personas` must be an array of persona definitions.', GMIErrorCode.CONFIGURATION_ERROR, {
      received: definitions === null ? 'null' : typeof definitions,
    });
  }
  const seen = new Set<string>();
  definitions.forEach((definition, index) => {
    const id = definition && typeof definition === 'object' ? (definition as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || id.trim() === '') {
      throw new GMIError(`personas[${index}] must be an object with a non-empty string \`id\`.`, GMIErrorCode.CONFIGURATION_ERROR, { index });
    }
    if (seen.has(id)) {
      throw new GMIError(`personas[${index}] repeats the persona id '${id}'.`, GMIErrorCode.CONFIGURATION_ERROR, { index, id });
    }
    seen.add(id);
    const keywords = (definition as { activationKeywords?: unknown }).activationKeywords;
    if (keywords !== undefined && (!Array.isArray(keywords) || keywords.some((keyword) => typeof keyword !== 'string'))) {
      throw new GMIError(`personas[${index}] ('${id}'): \`activationKeywords\` must be an array of strings when present.`, GMIErrorCode.CONFIGURATION_ERROR, { index, id });
    }
    const presets = (definition as { sentimentTracking?: { presets?: unknown } }).sentimentTracking?.presets;
    if (presets !== undefined && !Array.isArray(presets)) {
      throw new GMIError(`personas[${index}] ('${id}'): \`sentimentTracking.presets\` must be an array when present.`, GMIErrorCode.CONFIGURATION_ERROR, { index, id });
    }
  });
}

/**
 * Serves a fixed list of persona definitions. The constructor checks the list's structure
 * (see `assertInlinePersonaDefinitions`), normalizes each definition the way the file-system
 * loader does (sentiment presets become metaprompts) and stores its own copies, so edits the
 * caller makes to its objects after construction never reach the runtime; load results are
 * copies too, so a caller cannot change a stored definition through them. `initialize()` accepts
 * any `PersonaLoaderConfig` (the source is the list, not `personaSource`); `refreshPersonas()`
 * is a no-op because the set is fixed. Used by `AgentOS.create({ personas })` and exported for
 * callers composing their own sources.
 */
export class InMemoryPersonaLoader implements IPersonaLoader {
  public readonly loaderId: string;
  private readonly personas: Map<string, IPersonaDefinition>;
  private isInitialized = false;

  constructor(definitions: IPersonaDefinition[]) {
    assertInlinePersonaDefinitions(definitions);
    this.loaderId = `persona-loader-mem-${uuidv4()}`;
    // Own copies in a new Map: later pushes to the list or edits to the caller's objects do not change the set.
    this.personas = new Map(definitions.map((definition) => [definition.id, clonePersonaDefinition(normalizePersonaDefinition(definition))]));
  }

  public async initialize(_config: PersonaLoaderConfig): Promise<void> {
    this.isInitialized = true;
  }

  /** Returns a copy; edits to a load result never reach the stored definition. */
  public async loadPersonaById(personaId: string): Promise<IPersonaDefinition | undefined> {
    this.ensureInitialized();
    const stored = this.personas.get(personaId);
    return stored ? clonePersonaDefinition(stored) : undefined;
  }

  /** Returns copies, in the order given at construction. */
  public async loadAllPersonaDefinitions(): Promise<IPersonaDefinition[]> {
    this.ensureInitialized();
    return Array.from(this.personas.values(), (stored) => clonePersonaDefinition(stored));
  }

  /** The set is fixed at construction; refreshing is a no-op. */
  public async refreshPersonas(): Promise<void> {
    this.ensureInitialized();
  }

  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new GMIError('InMemoryPersonaLoader has not been initialized. Call initialize() first.', GMIErrorCode.NOT_INITIALIZED, { loaderId: this.loaderId });
    }
  }
}
