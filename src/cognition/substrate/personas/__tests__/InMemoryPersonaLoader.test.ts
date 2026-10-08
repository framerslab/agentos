import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../IPersonaDefinition';
import { GMIErrorCode } from '../../../../core/utils/errors.js';
import { InMemoryPersonaLoader, assertInlinePersonaDefinitions, INLINE_PERSONA_LOADER_CONFIG } from '../InMemoryPersonaLoader';

const a: IPersonaDefinition = { id: 'a', name: 'A', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi' };
const b: IPersonaDefinition = { id: 'b', name: 'B', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi' };

describe('assertInlinePersonaDefinitions', () => {
  it('rejects a non-array', () => {
    expect(() => assertInlinePersonaDefinitions({} as unknown)).toThrowError(/must be an array/);
  });
  it('rejects an entry without a string id, naming the index', () => {
    expect(() => assertInlinePersonaDefinitions([a, { name: 'no id' }] as unknown)).toThrowError(/personas\[1\]/);
  });
  it('rejects a duplicate id, naming the index and the id', () => {
    expect(() => assertInlinePersonaDefinitions([a, { ...b, id: 'a' }] as unknown)).toThrowError(/personas\[1\] repeats the persona id 'a'/);
  });
  it('rejects a non-array activationKeywords, naming the id', () => {
    expect(() => assertInlinePersonaDefinitions([{ ...a, activationKeywords: {} }] as unknown)).toThrowError(/'a'.*activationKeywords/);
  });
  it('rejects a non-string activationKeywords entry', () => {
    expect(() => assertInlinePersonaDefinitions([{ ...a, activationKeywords: ['ok', null] }] as unknown)).toThrowError(/array of strings/);
  });
  it('rejects a sentimentTracking.presets that is not an array', () => {
    expect(() => assertInlinePersonaDefinitions([{ ...a, sentimentTracking: { enabled: true, presets: 'frustration_recovery' } }] as unknown)).toThrowError(/sentimentTracking\.presets/);
  });
  it('throws GMIError CONFIGURATION_ERROR', () => {
    try {
      assertInlinePersonaDefinitions('x' as unknown);
    } catch (e: any) {
      expect(e.code).toBe(GMIErrorCode.CONFIGURATION_ERROR);
      return;
    }
    throw new Error('did not throw');
  });
});

describe('InMemoryPersonaLoader', () => {
  it('throws NOT_INITIALIZED before initialize()', async () => {
    const loader = new InMemoryPersonaLoader([a]);
    await expect(loader.loadAllPersonaDefinitions()).rejects.toMatchObject({ code: GMIErrorCode.NOT_INITIALIZED });
  });
  it('serves the definitions it was built with, in order, after initialize()', async () => {
    const loader = new InMemoryPersonaLoader([a, b]);
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    expect((await loader.loadAllPersonaDefinitions()).map((p) => p.id)).toEqual(['a', 'b']);
    expect((await loader.loadPersonaById('b'))?.name).toBe('B');
    expect(await loader.loadPersonaById('zzz')).toBeUndefined();
  });
  it('copies the list: later pushes by the caller do not change the set', async () => {
    const list = [a];
    const loader = new InMemoryPersonaLoader(list);
    list.push(b);
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    expect((await loader.loadAllPersonaDefinitions()).map((p) => p.id)).toEqual(['a']);
  });
  it('applies the shared normalization (sentiment presets become metaprompts)', async () => {
    const withPreset = { ...a, sentimentTracking: { enabled: true, presets: ['error_recovery'] } } as unknown as IPersonaDefinition;
    const loader = new InMemoryPersonaLoader([withPreset]);
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    expect((await loader.loadPersonaById('a'))?.metaPrompts?.map((m) => m.id)).toEqual(['gmi_error_recovery']);
  });
  it('stores its own copies: edits to the caller\'s object after construction do not reach the runtime', async () => {
    const mine = { ...a, activationKeywords: ['one'] };
    const loader = new InMemoryPersonaLoader([mine]);
    mine.name = 'Changed';
    mine.activationKeywords.push('two');
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    const served = await loader.loadPersonaById('a');
    expect(served?.name).toBe('A');
    expect(served?.activationKeywords).toEqual(['one']);
  });
  it('returns copies from loads: edits to a load result do not change the stored definition', async () => {
    const loader = new InMemoryPersonaLoader([a]);
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    const first = await loader.loadPersonaById('a');
    (first as { name: string }).name = 'Edited';
    expect((await loader.loadPersonaById('a'))?.name).toBe('A');
    expect((await loader.loadAllPersonaDefinitions())[0].name).toBe('A');
  });
  it('refreshPersonas keeps the set', async () => {
    const loader = new InMemoryPersonaLoader([a]);
    await loader.initialize(INLINE_PERSONA_LOADER_CONFIG);
    await loader.refreshPersonas();
    expect((await loader.loadAllPersonaDefinitions()).length).toBe(1);
  });
});
