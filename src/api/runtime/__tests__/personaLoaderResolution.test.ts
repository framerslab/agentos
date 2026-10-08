import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../../../cognition/substrate/personas/IPersonaDefinition';
import type { IPersonaLoader } from '../../../cognition/substrate/personas/IPersonaLoader';
import { InMemoryPersonaLoader } from '../../../cognition/substrate/personas/InMemoryPersonaLoader';
import { GMIErrorCode } from '../../../core/utils/errors.js';
import { resolvePersonaLoader, validatePersonaSource } from '../personaLoaderResolution';

const p: IPersonaDefinition = { id: 'p', name: 'P', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi' };
const loader: IPersonaLoader = { initialize: async () => undefined, loadPersonaById: async () => undefined, loadAllPersonaDefinitions: async () => [] };
const fileConfig = { personaLoaderConfig: { personaSource: './personas', loaderType: 'file_system', options: { validationLevel: 'strict' } } };

describe('validatePersonaSource', () => {
  it('accepts neither, personas alone, and personaLoader alone', () => {
    expect(() => validatePersonaSource({})).not.toThrow();
    expect(() => validatePersonaSource({ personas: [p] })).not.toThrow();
    expect(() => validatePersonaSource({ personaLoader: loader })).not.toThrow();
  });
  it('rejects both with CONFIGURATION_ERROR', () => {
    try {
      validatePersonaSource({ personas: [p], personaLoader: loader });
    } catch (e: any) {
      expect(e.code).toBe(GMIErrorCode.CONFIGURATION_ERROR);
      expect(e.message).toMatch(/not both/);
      return;
    }
    throw new Error('did not throw');
  });
  it('rejects a malformed list with CONFIGURATION_ERROR naming the index', () => {
    try {
      validatePersonaSource({ personas: [p, { ...p }] });
    } catch (e: any) {
      expect(e.code).toBe(GMIErrorCode.CONFIGURATION_ERROR);
      expect(e.message).toMatch(/personas\[1\]/);
      return;
    }
    throw new Error('did not throw');
  });
});

describe('resolvePersonaLoader', () => {
  it('builds an in-memory loader and records the inline config, keeping the options', () => {
    const r = resolvePersonaLoader({ personas: [p], gmiManagerConfig: fileConfig });
    expect(r.loader).toBeInstanceOf(InMemoryPersonaLoader);
    expect(r.personaLoaderConfig).toEqual({ personaSource: 'inline', loaderType: 'in_memory', options: { validationLevel: 'strict' } });
  });
  it('passes a custom loader through with the config unchanged', () => {
    const r = resolvePersonaLoader({ personaLoader: loader, gmiManagerConfig: fileConfig });
    expect(r.loader).toBe(loader);
    expect(r.personaLoaderConfig).toBe(fileConfig.personaLoaderConfig);
  });
  it('returns no loader when neither is given (GMIManager builds the file-system loader)', () => {
    const r = resolvePersonaLoader({ gmiManagerConfig: fileConfig });
    expect(r.loader).toBeUndefined();
    expect(r.personaLoaderConfig).toBe(fileConfig.personaLoaderConfig);
  });
});
