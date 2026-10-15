import { describe, expect, it } from 'vitest';

const surfaces = [
  ['stores/types', ['VoiceStoreConflict', 'voiceKey']],
  ['stores/memory', ['InMemoryVoiceStore']],
  ['stores/sql', ['SqlVoiceStore', 'voicePlatformDdl']],
  ['CallMinuteMeter', ['CallMinuteMeter', 'connectedUnionMs']],
  ['VoiceCallManager', ['VoiceCallManager', 'requestCallEndInTransaction', 'canonicalVoiceHash']],
  ['CallCredentials', ['CallCredentials', 'verifyCallProof', 'proofKeyThumbprint']],
  ['SlotLimiter', ['SlotLimiter']],
] as const;
describe.skipIf(!process.env.CI)('compiled call runtime through existing package wildcard exports', () => {
  for (const [path, symbols] of surfaces) it(path, async () => {
    const module = await import(`@framers/agentos/io/voice-platform/${path}`) as Record<string, unknown>;
    for (const symbol of symbols) expect(typeof module[symbol], symbol).toBe('function');
  });
});
