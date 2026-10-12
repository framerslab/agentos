import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { startListenSession } from '../ListenSession.js';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';
import type { AudioFrame, IStreamTransport, IStreamingSTT, ITranscriptInputSink, StreamingSTTSession, TranscriptEvent, TranscriptInput, TranscriptTurn } from '../types.js';

function transport(): IStreamTransport & EventEmitter {
  const t = new EventEmitter() as IStreamTransport & EventEmitter;
  Object.defineProperty(t, 'id', { value: 'tr-1' });
  Object.defineProperty(t, 'state', { value: 'open', writable: true });
  t.sendAudio = vi.fn();
  t.sendControl = vi.fn();
  t.close = vi.fn(() => t.emit('close'));
  return t;
}
function stt() {
  const sessions: Array<StreamingSTTSession & EventEmitter & { frames: AudioFrame[] }> = [];
  const provider: IStreamingSTT = {
    providerId: 'scripted', isStreaming: true,
    async startSession() {
      const s = new EventEmitter() as StreamingSTTSession & EventEmitter & { frames: AudioFrame[] };
      s.frames = []; s.pushAudio = (f) => { s.frames.push(f); }; s.flush = vi.fn().mockResolvedValue(undefined); s.close = vi.fn(() => { s.emit('close'); });
      sessions.push(s); return s;
    },
  };
  return { provider, sessions };
}
class ArraySink implements ITranscriptInputSink {
  readonly turns: TranscriptTurn[] = [];
  delayMs = 0;
  failAfter = Number.POSITIVE_INFINITY;
  async append(turn: TranscriptTurn): Promise<void> {
    this.turns.push(turn);
  }
  async appendNext(turn: TranscriptInput): Promise<TranscriptTurn> {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.turns.length >= this.failAfter) throw new Error('the store is down');
    const seq = Math.max(0, ...this.turns.filter((t) => t.runId === turn.runId).map((t) => t.seq)) + 1;
    const stored = { ...turn, seq, turnId: `${turn.runId}:${seq}` };
    this.turns.push(stored);
    return stored;
  }
}
const frame = (t: number): AudioFrame => ({ samples: new Float32Array(320), sampleRate: 16_000, timestamp: t });
const final = (text: string, startMs: number, endMs: number): TranscriptEvent => ({ text, confidence: 1, words: [], isFinal: true, startMs, endMs });

describe('startListenSession', () => {
  it('needs only a transcriber, forwards audio, and writes each final as a numbered turn', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    const session = await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1' });
    t.emit('audio', frame(0));
    expect(sessions[0].frames.length).toBe(1);
    sessions[0].emit('transcript', { ...final('hello', 0, 500), isFinal: false });
    sessions[0].emit('transcript', final('hello everyone', 0, 900));
    sessions[0].emit('transcript', final('second turn', 1_000, 1_900));
    await vi.waitFor(() => expect(sink.turns.length).toBe(2));
    expect(sink.turns.map((x) => [x.turnId, x.seq, x.text, x.startMs, x.endMs])).toEqual([['r1:1', 1, 'hello everyone', 0, 900], ['r1:2', 2, 'second turn', 1_000, 1_900]]);
    expect(session.state).toBe('listening');
    const ended = vi.fn();
    session.on('ended', ended);
    const closing = session.close('stopped');
    expect(session.state).toBe('draining');
    sessions[0].emit('transcript', final('the last words', 2_000, 2_600)); // the flushed final arrives while draining
    await closing;
    expect(sessions[0].flush).toHaveBeenCalledTimes(1);
    expect(sink.turns.map((x) => x.text)).toEqual(['hello everyone', 'second turn', 'the last words']);
    expect(session.state).toBe('ended');
    expect(ended).toHaveBeenCalledWith({ reason: 'stopped' });
  });
  it('a second listen session on one run continues the sink sequence', async () => {
    const sink = new ArraySink();
    const a = stt();
    const first = await startListenSession(transport(), sink, { streamingSTT: a.provider, runId: 'r1', drainMs: 0 });
    a.sessions[0].emit('transcript', final('first', 0, 100));
    await vi.waitFor(() => expect(sink.turns.length).toBe(1));
    await first.close();
    const b = stt();
    const second = await startListenSession(transport(), sink, { streamingSTT: b.provider, runId: 'r1', drainMs: 0 });
    const emitted: TranscriptTurn[] = [];
    second.on('turn', (turn: TranscriptTurn) => emitted.push(turn));
    b.sessions[0].emit('transcript', final('second', 0, 100));
    await vi.waitFor(() => expect(emitted.length).toBe(1));
    expect(sink.turns.map((t) => t.turnId)).toEqual(['r1:1', 'r1:2']);
    expect(emitted[0].seq).toBe(2);
    expect(second.stats().turns).toBe(1);
    await second.close();
  });
  it('a sink that throws ends the session with sink_failed, without hanging, and a purge drains nothing', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    sink.failAfter = 1;
    const session = await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1' });
    const ended = vi.fn();
    session.on('ended', ended);
    sessions[0].emit('transcript', final('kept', 0, 500));
    sessions[0].emit('transcript', final('refused', 600, 900));
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith({ reason: 'sink_failed', error: expect.any(Error) }), { timeout: 2_000 });
    expect(session.state).toBe('ended');
    const t2 = transport();
    const s2 = stt();
    const sink2 = new ArraySink();
    const session2 = await startListenSession(t2, sink2, { streamingSTT: s2.provider, runId: 'r2' });
    s2.sessions[0].emit('transcript', final('before the purge', 0, 500));
    await session2.close('purged');
    expect(s2.sessions[0].flush).not.toHaveBeenCalled();
    expect(session2.state).toBe('ended');
  });
  it('ends with stt_failed when the transcriber fails for good, and with transport_closed when the transport closes', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const session = await startListenSession(t, new ArraySink(), { streamingSTT: provider, runId: 'r1', reconnect: false });
    const ended = vi.fn();
    session.on('ended', ended);
    sessions[0].emit('error', new Error('gone'));
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith({ reason: 'stt_failed', error: expect.any(Error) }));
    const t2 = transport();
    const s2 = await startListenSession(t2, new ArraySink(), { streamingSTT: stt().provider, runId: 'r2', reconnect: false });
    const ended2 = vi.fn();
    s2.on('ended', ended2);
    t2.emit('close');
    await vi.waitFor(() => expect(ended2).toHaveBeenCalledWith({ reason: 'transport_closed' }));
  });
  it('pauses the transport while the sink is slow and never drops a final', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    sink.delayMs = 30;
    const paused = vi.fn();
    t.on('pause', paused);
    const session = await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1', sinkQueueLimit: 2 });
    for (let i = 1; i <= 6; i++) sessions[0].emit('transcript', final(`turn ${i}`, i * 1000, i * 1000 + 500));
    await vi.waitFor(() => expect(sink.turns.length).toBe(6), { timeout: 2_000 });
    expect(sink.turns.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(paused).toHaveBeenCalled();
    expect(session.stats().dropped).toBe(0);
  });
  it('uses the endpoint detector for turns when one is given', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    const detector = Object.assign(new EventEmitter(), { mode: 'heuristic' as const, pushVadEvent: vi.fn(), pushTranscript: vi.fn(), reset: vi.fn() });
    await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1', endpointDetector: detector });
    sessions[0].emit('transcript', final('a clause', 0, 400));
    expect(detector.pushTranscript).toHaveBeenCalledTimes(1);
    expect(sink.turns.length).toBe(0);
    detector.emit('turn_complete', { transcript: 'a clause and the rest', confidence: 1, durationMs: 900, timestamp: 0 });
    await vi.waitFor(() => expect(sink.turns.map((x) => x.text)).toEqual(['a clause and the rest']));
  });
  it('gives a detector the transcriber\'s speech start and end, so the library\'s heuristic detector ends the turn', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1', endpointDetector: new HeuristicEndpointDetector() });
    sessions[0].emit('speech_start');
    sessions[0].emit('transcript', final('we start at nine.', 0, 900));
    sessions[0].emit('speech_end'); // the final ends in a full stop, so the turn ends at the end of speech
    await vi.waitFor(() => expect(sink.turns.map((x) => x.text)).toEqual(['we start at nine.']));
  });
  it('stops over a transcriber that ends its stream on flush: the last final is written and nothing reconnects', async () => {
    const t = transport();
    const { provider, sessions } = stt();
    const sink = new ArraySink();
    const session = await startListenSession(t, sink, { streamingSTT: provider, runId: 'r1', drainMs: 0 });
    const reconnected = vi.fn();
    session.on('stt:reconnected', reconnected);
    sessions[0].flush = vi.fn(async () => {
      // as a provider that sends its last results and then closes its socket
      sessions[0].emit('transcript', final('the last words', 0, 600));
      sessions[0].emit('close');
    });
    await session.close('stopped');
    expect(sink.turns.map((x) => x.text)).toEqual(['the last words']);
    expect(sessions.length).toBe(1);
    expect(reconnected).not.toHaveBeenCalled();
  });
});
