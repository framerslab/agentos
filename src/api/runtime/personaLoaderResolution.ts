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

export interface PersonaSourceConfig {
  personas?: IPersonaDefinition[];
  personaLoader?: IPersonaLoader;
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
