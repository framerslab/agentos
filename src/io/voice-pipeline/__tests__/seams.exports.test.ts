/**
 * The call-runtime seams by their `@framers/agentos/io/voice-pipeline/<module>`
 * specifiers, the subpaths the package's existing `./*` export serves, each
 * with the runtime export a consumer imports from it. Under vitest.config.ts
 * the `@framers/agentos` alias resolves the specifier to the module's source.
 * The suite runs in CI and is skipped elsewhere.
 */
import { describe, expect, it } from 'vitest';

const modules = [
  ['AudioFanout', 'AudioFanout'],
  ['AudioWindowRing', 'AudioWindowRing'],
  ['PlaybackQueue', 'PlaybackQueue'],
  ['TtsUsageMeter', 'TtsUsageMeter'],
  ['audioFormat', 'inspectPcm16'],
  ['adaptEndpointDetector', 'adaptEndpointDetector'],
  ['ProviderPolicy', 'assertCallProviderPolicy'],
  ['VoicePipelineOrchestrator', 'VoicePipelineOrchestrator'],
] as const;

describe.skipIf(!process.env.CI)('compiled pipeline seams through existing wildcard exports', () => {
  for (const [module, name] of modules) {
    it(module, async () => {
      const built = await import(`@framers/agentos/io/voice-pipeline/${module}`) as Record<string, unknown>;
      expect(typeof built[name]).toBe('function');
    });
  }
});
