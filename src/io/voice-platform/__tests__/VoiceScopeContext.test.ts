import { describe, expect, it, vi } from 'vitest';
import { captureVoiceScope, requireVoiceScope, voiceNamespace, type VoiceScopeContext } from '../VoiceScopeContext.js';
/** Explicit authority fixture; no process environment is consulted. */
export function scopeFixture(scopeId = 'scope-a', callId = 'call-a'): VoiceScopeContext {
  return captureVoiceScope({ scopeId, callId, principal: { kind: 'service_key', principalId: 'key-a' },
    credentials: { resolve: async () => undefined }, signal: new AbortController().signal, allowedToolRefs: [],
    policy: { mode: 'local', fallback: 'none', identity: { scopeId, callId, turnId: 'turn-0', generation: { workerGeneration: 1, inferenceGeneration: 1, transportEpoch: 1 } },
      purposes: ['stt', 'tts', 'vad', 'endpoint', 'reasoning'], providers: ['stt', 'tts', 'vad', 'endpoint', 'model'].map((providerId) => ({ providerId, locality: 'local', purposes: [providerId === 'model' ? 'reasoning' as const : providerId as 'stt' | 'tts' | 'vad' | 'endpoint'], priceVersion: 'local' })),
      authorize: async () => {}, onFallback: () => {} } });
}
describe('required voice authority', () => {
  it('rejects missing, foreign and cancelled scope before credential access', async () => {
    const raw = scopeFixture(); const resolve = vi.fn(async () => 'not-a-real-secret');
    const s = captureVoiceScope({ ...raw, credentials: { resolve } });
    expect(() => requireVoiceScope(undefined, 'scope-a', 'call-a')).toThrow('scope');
    expect(() => requireVoiceScope(s, 'scope-b', 'call-a')).toThrow('scope');
    await expect(s.credentials.resolve({ scopeId: 'scope-b', callId: 'call-a', providerId: 'model', purpose: 'reasoning', credentialRef: 'credential-a', signal: s.signal })).rejects.toThrow('scope');
    expect(resolve).not.toHaveBeenCalled();
    const abort = new AbortController(); const stopped = captureVoiceScope({ ...raw, signal: abort.signal }); abort.abort();
    expect(() => requireVoiceScope(stopped, raw.scopeId, raw.callId)).toThrow();
  });
  it('captures policy, principal and tools and never falls back to global', () => {
    const s = scopeFixture(); expect(Object.isFrozen(s.policy.providers)).toBe(true);
    expect(() => captureVoiceScope({ ...s, scopeId: '' })).toThrow();
    expect(voiceNamespace(s)).not.toBe(voiceNamespace(scopeFixture('scope-b')));
    expect(voiceNamespace(s)).not.toBe(voiceNamespace(scopeFixture('scope-a', 'call-b')));
    expect(JSON.stringify(s)).not.toContain('credentials');
  });
});
