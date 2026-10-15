import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { agent } from '../agent.js';
import { getCapabilitySupport } from '../runtime/capabilityContract.js';
import { getDeferredCapabilities, warnOnDeferredLightweightAgentCapabilities } from '../runtime/lightweightAgentDiagnostics.js';
import { SPEECH_PROVIDER_CATALOG } from '../../io/speech/providerCatalog.js';
import { factoryFixture } from '../../io/voice-platform/__tests__/factoryFixtures.js';
const require = createRequire(import.meta.url);
const readGuide = (path: string): string => readFileSync(new URL(`../../../docs/${path}`, import.meta.url), 'utf8');

describe('documented voice capability', () => {
  it('distinguishes an explicit agent voice session from the deferred runtime flag', () => {
    expect(getCapabilitySupport('agent', 'voice')).toBe('partially_enforced');
    expect(getCapabilitySupport('runtime', 'voice')).toBe('accepted_but_deferred');
    expect(getCapabilitySupport('generation', 'voice')).toBe('runtime_only');
    expect(getCapabilitySupport('gmi', 'voice')).toBe('runtime_only');
    expect(getDeferredCapabilities({ voice: { enabled: true } }, 'agent')).toContain('voice');
    const warn = vi.fn(); warnOnDeferredLightweightAgentCapabilities({ voice: { enabled: true } }, warn);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain('voice.session');
    expect(warn.mock.calls[0]![0]).not.toContain('requires the full AgentOS runtime or agency(): voice');
  });
  it('keeps the original configured factory and revision after caller mutation', async () => {
    const f = await factoryFixture(); const other = await factoryFixture();
    const first = vi.spyOn(f.factory, 'startSession').mockRejectedValue(new Error('first-factory'));
    const second = vi.spyOn(other.factory, 'startSession').mockRejectedValue(new Error('second-factory'));
    const config = { factory: f.factory, agent: f.request.agent };
    const originalPrompt = config.agent.prompt;
    const a = agent({ voice: { enabled: true, session: config } });
    config.factory = other.factory; config.agent.prompt = 'mutated';
    const { agent: _agent, ...request } = f.request;
    try {
      await expect(a.voiceSession!(request)).rejects.toThrow('first-factory');
      expect(first).toHaveBeenCalledOnce(); expect(second).not.toHaveBeenCalled();
      expect(first.mock.calls[0]![0].agent.prompt).toBe(originalPrompt);
      expect((a as unknown as { __config: { voice: unknown } }).__config.voice).toEqual({ enabled: true });
    } finally { await a.close(); }
  });
  it('labels the installed batch paths accurately and includes all catalog TTS ids', () => {
    for (const id of ['vosk', 'google-cloud-stt']) {
      const row = SPEECH_PROVIDER_CATALOG.find((entry) => entry.id === id)!;
      expect(row.streaming).toBe(false); expect(row.features).not.toContain('streaming');
    }
    const guide = readGuide('features/SPEECH_PROVIDERS.md');
    for (const id of ['vosk', 'google-cloud-stt', 'deepgram-aura', 'minimax-tts']) expect(guide).toContain('`' + id + '`');
    expect(guide).toContain('Batch capability is not a streaming session');
    expect(readGuide('features/VOICE_PIPELINE.md')).toContain('voiceSession');
  });
  it('publishes the runtime guide exactly once and keeps the real safety path', () => {
    const manifest = require('../../../docs/publication-manifest.cjs') as { publicationManifest: Array<{ sourcePath: string; dest: string }> };
    const row = manifest.publicationManifest.filter((entry) => entry.dest === 'features/voice-platform.md');
    expect(row).toEqual([{ ...row[0], sourcePath: 'packages/agentos/docs/features/VOICE_PLATFORM.md', dest: 'features/voice-platform.md' }]);
    expect(readGuide('features/VOICE_PLATFORM.md')).toContain('VoiceSessionFactory');
    expect(readGuide('safety/SAFETY_PRIMITIVES.md')).toContain('ModelAttemptBudget');
  });
});
