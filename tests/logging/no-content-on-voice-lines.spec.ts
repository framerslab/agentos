/**
 * Actual voice fallback paths under the loaded package's content-safe mode.
 *
 * @module
 */
import { expect, it, vi } from 'vitest';
import { enableContentSafeTelemetry, type ContentSafeLogEvent } from '../../src/core/logging/contentSafeTelemetry.js';
import { startListenSession } from '../../src/io/voice-pipeline/ListenSession.js';
import { ReconnectingSTT } from '../../src/io/voice-pipeline/ReconnectingSTT.js';
import { StreamingSTTChain } from '../../src/io/voice-pipeline/providers/StreamingSTTChain.js';
import { LiveKitStreamTransport } from '../../src/io/voice-pipeline/LiveKitStreamTransport.js';
import { FakeRoom, fakeRtc, settle } from '../../src/io/hearing/__tests__/livekit-fakes.js';
import { PRIVATE, Sink, final, hostile, provider, transport } from './voice-fixtures.js';

it('counts each voice owner without reading warning content, printing text or replacing host listeners', async () => {
  const records: ContentSafeLogEvent[] = [];
  const native = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined));
  const bytes: string[] = [];
  for (const stream of [process.stdout, process.stderr]) vi.spyOn(stream, 'write').mockImplementation((chunk: string | Uint8Array) => {
    bytes.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')); return true;
  });
  enableContentSafeTelemetry((event) => { records.push(event); });
  try {
    const direct = provider(); const sink = new Sink();
    const session = await startListenSession(transport(), sink, {
      streamingSTT: direct.peer, runId: 'fixture-run', reconnect: false,
      speaker: () => { throw hostile(); },
    });
    try {
      direct.sessions[0].emit('transcript', final());
      await vi.waitFor(() => expect(sink.turns).toHaveLength(1));
      expect(sink.turns[0].speaker).toBeUndefined();
      expect(session.state).toBe('listening');
    } finally { await session.close('purged'); }

    for (const kind of ['reconnect', 'chain'] as const) {
      const source = provider();
      const wrapper = kind === 'reconnect' ? new ReconnectingSTT(source.peer) : new StreamingSTTChain([source.peer], { enableMidUtteranceFailover: true });
      const opened = await wrapper.startSession();
      try {
        expect(() => source.sessions[0].emit('warning', hostile())).not.toThrow();
        const before = records.length;
        const listener = vi.fn(); opened.on('warning', listener);
        const warning = new Error(PRIVATE);
        source.sessions[0].emit('warning', warning);
        expect(listener).toHaveBeenCalledWith(warning);
        expect(records).toHaveLength(before);
        opened.off('warning', listener);
      } finally { opened.close(); }
    }

    const room = new FakeRoom(); room.addParticipant('fixture-participant');
    const live = new LiveKitStreamTransport({ room, participant: 'fixture-participant', sampleRate: 16_000, rtc: fakeRtc() });
    try {
      room.chat('fixture-participant', PRIVATE.repeat(100));
      await settle();
      expect(live.state).toBe('open');
    } finally { live.close(); await live.whenClosed(); }
    expect(records.map((event) => Reflect.get(event, 'component'))).toEqual(['listen_session', 'reconnecting_stt', 'streaming_stt_chain', 'livekit_transport']);
    expect(records.every((event) => event.state === 'warn' && event.n === 1 && Object.isFrozen(event))).toBe(true);
    expect(records.every((event) => Object.keys(event).sort().join(',') === 'component,kind,n,state')).toBe(true);

    // A supplied logger is the host's output, kept exactly as the old API specified.
    const customRoom = new FakeRoom(); customRoom.addParticipant('fixture-participant');
    const logger = { warn: vi.fn() };
    const custom = new LiveKitStreamTransport({ room: customRoom, participant: 'fixture-participant', sampleRate: 16_000, rtc: fakeRtc(), logger });
    try {
      customRoom.chat('fixture-participant', ' ');
      await settle();
      expect(logger.warn).toHaveBeenCalledWith('LiveKitStreamTransport: livekit text input refused');
      expect(records).toHaveLength(4);
    } finally { custom.close(); await custom.whenClosed(); }
    for (const spy of native) expect(spy).not.toHaveBeenCalled();
    expect(bytes.join('')).toBe('');
    for (const marker of ['spoken private words', 'Private Fixture Person', 'person@example.invalid', '203.0.113.7', 'sk_private_key']) {
      expect(JSON.stringify(records).includes(marker), 'no input in diagnostic records').toBe(false);
    }
  } finally { vi.restoreAllMocks(); }
});
