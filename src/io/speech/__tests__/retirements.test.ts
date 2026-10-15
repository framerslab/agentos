import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SPEECH_RETIREMENTS, assertSpeechAvailable } from '../retirements.js';
describe('versioned speech retirement policy', () => {
  it('records source-backed deadlines and forbids retiring providers in hosted selection', () => {
    expect(SPEECH_RETIREMENTS).toHaveLength(5);
    expect(SPEECH_RETIREMENTS[0]!.shutdownAt).toBe('2026-11-13T05:01:00Z');
    for (const row of SPEECH_RETIREMENTS) {
      expect(row.source.startsWith('https://')).toBe(true);
      expect(() => assertSpeechAvailable(row.providerId, row.modelId, Date.parse('2026-10-12T00:00:00Z'), 'hosted')).toThrow('retirement');
      expect(() => assertSpeechAvailable(row.providerId, row.modelId, Date.parse(row.shutdownAt), 'local')).toThrow('retirement');
      expect(() => assertSpeechAvailable(row.providerId, row.modelId, Date.parse(row.shutdownAt) - 1, 'local')).not.toThrow();
      expect(() => assertSpeechAvailable(row.providerId, row.modelId, Date.parse('2026-10-12T00:00:00Z'), 'local', 'default')).toThrow('retirement');
    }
    expect(() => assertSpeechAvailable('fixture-local', 'weights-a', Date.now(), 'local')).not.toThrow();
  });
  it('fails thirty days ahead of shutdown if retained constructors still make a retiring automatic choice', () => {
    const now = Date.now();
    const sources = [
      readFileSync(new URL('../SpeechRuntime.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../providers/OpenAITextToSpeechProvider.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../providerCatalog.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../../voice-pipeline/env-constructor.ts', import.meta.url), 'utf8'),
    ];
    for (const row of SPEECH_RETIREMENTS) {
      if (now < Date.parse(row.shutdownAt) - 30 * 86400000) continue;
      if (row.providerId === 'hume') expect(sources[3]).not.toMatch(/if\s*\(humeKey\)\s*\{/);
      else for (const source of sources) expect(source).not.toMatch(new RegExp(`(?:\\?\\?|defaultModel:)\\s*['"]${row.modelId}['"]`));
    }
  });
});
