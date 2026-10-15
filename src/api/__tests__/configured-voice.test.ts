import { describe, expect, it, vi } from 'vitest';
import { agent } from '../agent.js';
import { factoryFixture } from '../../io/voice-platform/__tests__/factoryFixtures.js';
describe('explicit agent voice session', () => {
  it('delegates configuration to exactly the direct factory and hides runtime wiring from export configuration', async () => {
    const f = await factoryFixture(); const start = vi.spyOn(f.factory, 'startSession');
    const a = agent({ voice: { enabled: true, session: { factory: f.factory, agent: f.request.agent } } });
    const { agent: _revision, ...request } = f.request; const runtime = await a.voiceSession!(request);
    expect(start).toHaveBeenCalledOnce(); expect(start.mock.calls[0]![0].agent.agentId).toBe(f.request.agent.agentId);
    expect((a as unknown as { __config: { voice: unknown } }).__config.voice).toEqual({ enabled: true });
    await runtime.abortModelAndTools(); await runtime.cancelTts(); await runtime.releaseMedia(); await runtime.confirmStopped(); await runtime.releaseSlots(); await a.close();
  });
  it('refuses ignored fields, disabled sessions and the unsupported GMI entry', async () => {
    const f = await factoryFixture(); const session = { factory: f.factory, agent: f.request.agent };
    expect(() => agent({ voice: { enabled: true, session, diarization: true } })).toThrow('fields refused');
    expect(() => agent({ voice: { enabled: false, session } })).toThrow('fields refused');
    expect(() => agent({ runtime: 'gmi', voice: { enabled: true, session } })).toThrow('fields refused');
  });
});
