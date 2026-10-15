import { describe, expect, it } from 'vitest';
const modules = [
  ['voice-platform/CallTransportBinding', 'CallTransportBinding'], ['voice-platform/WebSocketCallServer', 'WebSocketCallServer'],
  ['voice-pipeline/PlaybackAcknowledgements', 'PlaybackAcknowledgements'], ['voice-pipeline/LiveKitAudioPublisher', 'LiveKitAudioPublisher'],
  ['voice-pipeline/LiveKitStreamTransport', 'LiveKitStreamTransport'],
] as const;
describe.skipIf(!process.env.CI)('compiled call transport surfaces', () => {
  for (const [path, symbol] of modules) it(path, async () => {
    const module = await import(`@framers/agentos/io/${path}`) as Record<string, unknown>;
    expect(typeof module[symbol]).toBe('function');
  });
});
