/**
 * @file InMemoryPersonaLoader.ts
 * An IPersonaLoader over a fixed list of definitions: what `AgentOS.create({ personas })`
 * uses, and a building block for callers composing their own sources.
 */
import { uuidv4 } from '../../../core/utils/uuid';
import { GMIError, GMIErrorCode } from '../../../core/utils/errors.js';
import type { IPersonaDefinition } from './IPersonaDefinition';
import type { IPersonaLoader, PersonaLoaderConfig } from './IPersonaLoader';
import { normalizePersonaDefinition } from './personaNormalization';

/** The `personaLoaderConfig` the runtime records when personas come from an inline list. */
export const INLINE_PERSONA_LOADER_CONFIG: PersonaLoaderConfig = { personaSource: 'inline', loaderType: 'in_memory' };

/**
 * Structural rules for an inline persona list, cheap enough to run before any subsystem
 * starts: an array; every entry an object with a non-empty string `id`; no duplicate `id`;
 * `activationKeywords`, when present, an array. Semantic validation (required fields,
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
    if (keywords !== undefined && !Array.isArray(keywords)) {
      throw new GMIError(`personas[${index}] ('${id}'): \`activationKeywords\` must be an array when present.`, GMIErrorCode.CONFIGURATION_ERROR, { index, id });
    }
  });
}

export class InMemoryPersonaLoader implements IPersonaLoader {
  public readonly loaderId: string;
  private readonly personas: Map<string, IPersonaDefinition>;
  private isInitialized = false;

  constructor(definitions: IPersonaDefinition[]) {
    assertInlinePersonaDefinitions(definitions);
    this.loaderId = `persona-loader-mem-${uuidv4()}`;
    // A new Map from the list: later pushes by the caller do not change the set.
    this.personas = new Map(definitions.map((definition) => [definition.id, normalizePersonaDefinition(definition)]));
  }

  public async initialize(_config: PersonaLoaderConfig): Promise<void> {
    this.isInitialized = true;
  }

  public async loadPersonaById(personaId: string): Promise<IPersonaDefinition | undefined> {
    this.ensureInitialized();
    return this.personas.get(personaId);
  }

  public async loadAllPersonaDefinitions(): Promise<IPersonaDefinition[]> {
    this.ensureInitialized();
    return Array.from(this.personas.values());
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
