/**
 * @file personaLoaderResolution.ts
 * Decides where personas come from for a runtime: an inline list (`personas`), a
 * caller-written loader (`personaLoader`), or the file-system loader GMIManager
 * builds by default. Pure; AgentOS calls `validatePersonaSource` from
 * `validateConfiguration()` and `resolvePersonaLoader` where GMIManager is built.
 */
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import type { IPersonaLoader, PersonaLoaderConfig } from '../../cognition/substrate/personas/IPersonaLoader';
import {
  INLINE_PERSONA_LOADER_CONFIG,
  InMemoryPersonaLoader,
  assertInlinePersonaDefinitions,
} from '../../cognition/substrate/personas/InMemoryPersonaLoader';
import { GMIError, GMIErrorCode } from '../../core/utils/errors.js';
import { AgentOSServiceError } from '../errors';

/** The three config fields that decide a runtime's persona source. */
export interface PersonaSourceConfig {
  /** Inline definitions; served by an in-memory loader. Exclusive with `personaLoader`. */
  personas?: IPersonaDefinition[];
  /** A caller-written loader; used as given. */
  personaLoader?: IPersonaLoader;
  /** The loader config GMIManager would otherwise use (the file-system directory). */
  gmiManagerConfig?: { personaLoaderConfig: PersonaLoaderConfig };
}

const DEFAULT_LOADER_CONFIG: PersonaLoaderConfig = { personaSource: './personas', loaderType: 'file_system' };

/**
 * @throws AgentOSServiceError CONFIGURATION_ERROR when both `personas` and `personaLoader`
 * are set, or when `personas` breaks a structural rule (see assertInlinePersonaDefinitions).
 */
export function validatePersonaSource(config: PersonaSourceConfig): void {
  if (config.personas !== undefined && config.personaLoader !== undefined) {
    throw new AgentOSServiceError(
      'Provide either `personas` or `personaLoader`, not both.',
      GMIErrorCode.CONFIGURATION_ERROR,
      undefined,
      'AgentOS.validateConfiguration',
    );
  }
  if (config.personas !== undefined) {
    try {
      assertInlinePersonaDefinitions(config.personas);
    } catch (error) {
      if (error instanceof GMIError) {
        throw new AgentOSServiceError(error.message, GMIErrorCode.CONFIGURATION_ERROR, error.details, 'AgentOS.validateConfiguration');
      }
      throw error;
    }
  }
}

/**
 * Picks the loader GMIManager receives and the `personaLoaderConfig` recorded with it:
 * `personas` → a new `InMemoryPersonaLoader` with `{ personaSource: 'inline', loaderType: 'in_memory' }`
 * (the existing `options` kept); `personaLoader` → that loader with the config unchanged; neither →
 * no loader (GMIManager builds the file-system loader) with the config unchanged. Assumes
 * `validatePersonaSource` already ran.
 */
export function resolvePersonaLoader(config: PersonaSourceConfig): {
  loader: IPersonaLoader | undefined;
  personaLoaderConfig: PersonaLoaderConfig;
} {
  const current = config.gmiManagerConfig?.personaLoaderConfig ?? DEFAULT_LOADER_CONFIG;
  if (config.personas !== undefined) {
    return {
      loader: new InMemoryPersonaLoader(config.personas),
      personaLoaderConfig: { ...INLINE_PERSONA_LOADER_CONFIG, ...(current.options ? { options: current.options } : {}) },
    };
  }
  return { loader: config.personaLoader, personaLoaderConfig: current };
}
