/** AVATAR_PROVIDER_CATALOG — the avatar seam's discovery surface. */
import { describe, expect, it } from 'vitest';
import { AVATAR_PROVIDER_CATALOG } from '../providerCatalog.js';

describe('AVATAR_PROVIDER_CATALOG', () => {
  it('lists simli with both media modes and the pcm16 contract', () => {
    const simli = AVATAR_PROVIDER_CATALOG.find((e) => e.id === 'simli');
    expect(simli).toBeDefined();
    expect(simli!.envVars).toContain('SIMLI_API_KEY');
    expect(simli!.mediaModes).toEqual(['client-delegated', 'server-driven']);
    expect(simli!.audioFormat).toBe('pcm16');
    expect(simli!.defaultSampleRate).toBe(16000);
  });

  it('every entry carries the discovery fields', () => {
    for (const entry of AVATAR_PROVIDER_CATALOG) {
      expect(entry.id.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.envVars.length).toBeGreaterThan(0);
      expect(entry.features.length).toBeGreaterThan(0);
    }
  });
});
