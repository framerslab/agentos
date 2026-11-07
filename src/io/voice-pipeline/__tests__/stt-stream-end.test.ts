/**
 * The end of an STT session's stream, over the real path: a client's binary frames through
 * `WebSocketStreamTransport`, the orchestrator, the chain and reconnect wrappers, and the providers' wire code, as a
 * host that ends input on a push-to-talk stop drives them. The sockets are fakes that never leave the process; fake
 * time runs only on the runner.
 *
 * A frame the client sent before it heard the stop arrives after the host's flush(). When that flush ended the stream,
 * the frame is not new input: the provider's close is still the end the host asked for, whichever provider and
 * wrappers are in use. When the session stays open after the flush, the same frame is new input and a later close is a
 * failure. A session that stops on its own at a hard stop is a failure, flush or no flush.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  IBargeinHandler,
  IEndpointDetector,
  IStreamingSTT,
  IStreamingTTS,
  IVoicePipelineAgentSession,
  SttConnectionHooks,
  StreamingSTTConfig,
  StreamingSTTSession,
  StreamingTTSSession,
} from '../types.js';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class Socket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: Socket[] = [];
    readyState = 1;
    sent: Array<string | Buffer> = [];
    constructor(readonly url: string) {
      super();
      Socket.instances.push(this);
      process.nextTick(() => {
        if (this.readyState === 1) this.emit('open');
      });
    }
    send(data: string | Buffer): void {
      this.sent.push(data);
      if (typeof data !== 'string') return;
      const event = JSON.parse(data) as { type?: string; session?: unknown };
      if (event.type === 'session.update') {
        process.nextTick(() => this.emit('message', JSON.stringify({ type: 'session.updated', session: event.session })));
      }
    }
    close(): void { this.readyState = 3; }
    terminate(): void { this.readyState = 3; }
    drop(): void {
      this.readyState = 3;
      this.emit('close', 1006, Buffer.from(''));
    }
  }
  return { default: Socket };
});

import Ws from 'ws';
import { CircuitBreaker } from '../CircuitBreaker.js';
import { ReconnectingSTT } from '../ReconnectingSTT.js';
import { VoiceMetricsReporter, type VoiceMetricEvent } from '../VoiceMetricsReporter.js';
import { VoicePipelineOrchestrator } from '../VoicePipelineOrchestrator.js';
import { WebSocketStreamTransport, type WebSocketLike } from '../WebSocketStreamTransport.js';
import { DeepgramStreamingSTT } from '../providers/DeepgramStreamingSTT.js';
import { OpenAIRealtimeTranscriptionSTT } from '../providers/OpenAIRealtimeTranscriptionSTT.js';
import { StreamingSTTChain } from '../providers/StreamingSTTChain.js';

interface SocketView extends EventEmitter {
  url: string;
  sent: Array<string | Buffer>;
  drop(): void;
}
const sockets = Ws as unknown as { instances: SocketView[] };

/** 125 ms of 16 kHz audio, as a client sends it: a length a funded ceiling in seconds holds exactly. */
const SAMPLES = 2_000;
const pcm = (): Buffer => Buffer.from(new Float32Array(SAMPLES).fill(0.25).buffer);

async function turns(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function deepgram(priority = 10): DeepgramStreamingSTT {
  return new DeepgramStreamingSTT({ apiKey: 'fixture', mipOptOut: true, inputSampleRate: 16_000, priority });
}

function openai(options: { priority?: number; refuseRollover?: boolean } = {}): OpenAIRealtimeTranscriptionSTT {
  return new OpenAIRealtimeTranscriptionSTT({
    apiKey: 'fixture',
    maxRetries: 0,
    priority: options.priority ?? 10,
    rollover: options.refuseRollover
      ? { afterMs: 1_000, deadlineMs: 2_000, overlapMs: 100, hardStopMs: 3_000, approve: () => false }
      : false,
  });
}

/** The client's end of the session's socket: it keeps the control messages it was told. */
class ClientSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly told: Array<Record<string, unknown>> = [];

  send(data: Buffer | string, cb?: (err?: Error) => void): void {
    if (typeof data === 'string') this.told.push(JSON.parse(data) as Record<string, unknown>);
    cb?.();
  }

  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
}

/** One session on the real transport: the client's socket, the session a host holds, and what the client was told. */
async function startVoiceSession(stt: IStreamingSTT, connection?: Pick<StreamingSTTConfig, 'connectionHooks'>) {
  const client = new ClientSocket();
  const transport = new WebSocketStreamTransport(client as unknown as WebSocketLike, { sampleRate: 16_000 });
  let held: StreamingSTTSession | undefined;
  const hosted: IStreamingSTT = {
    providerId: stt.providerId,
    isStreaming: true,
    startSession: async (config) => (held = await stt.startSession({ ...config, ...connection })),
  };
  const tts = Object.assign(new EventEmitter(), {
    pushTokens: vi.fn(),
    flush: vi.fn(async () => {}),
    cancel: vi.fn(),
    close: vi.fn(),
  }) as unknown as StreamingTTSSession;
  const streamingTTS: IStreamingTTS = { providerId: 'tts', startSession: async () => tts };
  const endpointDetector = Object.assign(new EventEmitter(), {
    mode: 'heuristic',
    pushVadEvent: vi.fn(),
    pushTranscript: vi.fn(),
    reset: vi.fn(),
  }) as unknown as IEndpointDetector;
  const bargeinHandler: IBargeinHandler = { mode: 'hard-cut', handleBargein: vi.fn(() => ({ type: 'cancel' as const })) };
  const agent: IVoicePipelineAgentSession = { sendText: vi.fn(), abort: vi.fn() };
  const orchestrator = new VoicePipelineOrchestrator({ stt: 'stt', tts: 'tts', maxTurnDurationMs: 30_000 });
  orchestrator.on('error', () => undefined);
  await orchestrator.startSession(transport, agent, { streamingSTT: hosted, streamingTTS, endpointDetector, bargeinHandler });
  return {
    orchestrator,
    client,
    /** The session the host holds, as its stop handler calls `flush()` on it. */
    stt: held!,
    /** A binary frame from the client. */
    frame: (): void => {
      client.emit('message', pcm(), true);
    },
    /** The client was told the session failed. */
    failed: (): boolean => client.told.some((message) => message.type === 'session_ended' && message.reason === 'provider_failure'),
  };
}

/** The chain's metrics by type, and a breaker that records nothing silently. */
function watched() {
  const metrics = new VoiceMetricsReporter();
  const events: VoiceMetricEvent[] = [];
  metrics.subscribe((event) => events.push(event));
  const breaker = new CircuitBreaker({ failureThreshold: 5, windowMs: 60_000, cooldownMs: 60_000 });
  const breakerFailures = vi.spyOn(breaker, 'recordFailure');
  return { metrics, breaker, breakerFailures, failovers: () => events.filter((event) => event.type === 'provider_failover') };
}

/** What a socket received after Deepgram's close frame. */
function afterCloseStream(socket: SocketView): Array<string | Buffer> {
  const at = socket.sent.findIndex((item) => typeof item === 'string' && item.includes('CloseStream'));
  expect(at).toBeGreaterThanOrEqual(0);
  return socket.sent.slice(at + 1);
}

/** The host flushes, a frame the client had in flight arrives, the drain runs out and the provider closes its socket. */
async function stopWithFrameInFlight(voice: Awaited<ReturnType<typeof startVoiceSession>>): Promise<void> {
  voice.frame();
  await turns();
  const flushing = voice.stt.flush();
  await turns();
  voice.frame();
  await vi.advanceTimersByTimeAsync(200);
  await flushing;
  await turns();
  sockets.instances[0]!.drop();
  await turns();
}

beforeEach(() => {
  sockets.instances.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a frame in flight after the flush that ended the stream', () => {
  it('leaves the provider close the end the host asked for, and sends no audio after the close frame', async () => {
    const voice = await startVoiceSession(deepgram());
    await stopWithFrameInFlight(voice);

    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
    expect(afterCloseStream(sockets.instances[0]!)).toEqual([]);
    expect(voice.stt.inputEnded).toBe(true);

    // The host's stop ends the session with its own reason.
    voice.client.close();
    await turns();
    expect(voice.orchestrator.state).toBe('closed');
    expect(voice.failed()).toBe(false);
  });

  it('holds for a frame in the same tick as the flush, as ws can deliver two messages of one read', async () => {
    const voice = await startVoiceSession(deepgram());
    voice.frame();
    await turns();
    const flushing = voice.stt.flush();
    voice.frame();
    await vi.advanceTimersByTimeAsync(200);
    await flushing;
    sockets.instances[0]!.drop();
    await turns();

    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });

  it('starts no failover on a chain with failover on: no backup, no provider_failover, no breaker failure', async () => {
    const health = watched();
    const chain = new StreamingSTTChain([deepgram(10), openai({ priority: 20 })], {
      enableMidUtteranceFailover: true,
      metrics: health.metrics,
      breaker: health.breaker,
    });
    const voice = await startVoiceSession(chain);
    await stopWithFrameInFlight(voice);

    expect(sockets.instances).toHaveLength(1);
    expect(health.failovers()).toEqual([]);
    expect(health.breakerFailures).not.toHaveBeenCalled();
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
    expect(afterCloseStream(sockets.instances[0]!)).toEqual([]);
  });

  it('holds on a chain for a frame in the same tick as the flush', async () => {
    const health = watched();
    const chain = new StreamingSTTChain([deepgram(10), openai({ priority: 20 })], {
      enableMidUtteranceFailover: true,
      metrics: health.metrics,
      breaker: health.breaker,
    });
    const voice = await startVoiceSession(chain);
    voice.frame();
    await turns();
    const flushing = voice.stt.flush();
    voice.frame();
    await vi.advanceTimersByTimeAsync(200);
    await flushing;
    sockets.instances[0]!.drop();
    await turns();

    expect(sockets.instances).toHaveLength(1);
    expect(health.failovers()).toEqual([]);
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });

  it('opens no new session through ReconnectingSTT, frame or transcript after the flush', async () => {
    const voice = await startVoiceSession(new ReconnectingSTT(deepgram()));
    voice.frame();
    await turns();
    const flushing = voice.stt.flush();
    await vi.advanceTimersByTimeAsync(200);
    await flushing;
    // Deepgram's last final comes after the drain's wait, and a frame after it.
    sockets.instances[0]!.emit('message', JSON.stringify({
      type: 'Results',
      start: 0,
      duration: 0.1,
      is_final: true,
      channel: { alternatives: [{ transcript: 'the last words', confidence: 0.9 }] },
    }));
    voice.frame();
    await turns();
    sockets.instances[0]!.drop();
    await turns();
    await vi.advanceTimersByTimeAsync(1_000);
    await turns();

    expect(sockets.instances).toHaveLength(1);
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });

  it('opens no successor over funded sockets when the frame meets the socket ceiling after the flush', async () => {
    const hooks: SttConnectionHooks = {
      authorize: async () => {},
      usage: () => {},
      audioCeiling: () => SAMPLES / 16_000,
    };
    const voice = await startVoiceSession(deepgram(), { connectionHooks: hooks });
    await stopWithFrameInFlight(voice);

    expect(sockets.instances).toHaveLength(1);
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
    expect(voice.stt.inputEnded).toBe(true);
  });

  it('drops a frame after the flush that ended the stream over funded sockets before checking it', async () => {
    const hooks: SttConnectionHooks = {
      authorize: async () => {},
      usage: () => {},
      audioCeiling: () => 60,
    };
    const voice = await startVoiceSession(deepgram(), { connectionHooks: hooks });
    voice.frame();
    await turns();
    const flushing = voice.stt.flush();
    await turns();
    // A frame the stream no longer takes: its rate is not checked, so it fails nothing.
    void voice.stt.pushAudio({ samples: new Float32Array(160), sampleRate: 0, timestamp: 0 });
    await vi.advanceTimersByTimeAsync(200);
    await flushing;
    await turns();
    sockets.instances[0]!.drop();
    await turns();

    expect(sockets.instances).toHaveLength(1);
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });

  it('does not take a ceiling drain of funded sockets for the end of the stream', async () => {
    const hooks: SttConnectionHooks = {
      authorize: async () => {},
      usage: () => {},
      audioCeiling: () => SAMPLES / 16_000,
    };
    const voice = await startVoiceSession(deepgram(), { connectionHooks: hooks });
    voice.frame();
    await turns();
    voice.frame(); // past the ceiling: the facade drains this socket for itself and moves to the next
    await turns();
    expect(voice.stt.inputEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await turns();

    expect(sockets.instances).toHaveLength(2);
    expect(voice.stt.inputEnded).toBe(false);
    sockets.instances[1]!.drop();
    await turns();
    expect(voice.orchestrator.state).toBe('closed');
    expect(voice.failed()).toBe(true);
  });
});

describe('a session that stays open after its flush', () => {
  it('counts the frame after the flush as new input: a later end of the session is a failure', async () => {
    const voice = await startVoiceSession(openai());
    await voice.stt.flush();
    voice.frame();
    await turns();
    expect(voice.stt.inputEnded).not.toBe(true);

    sockets.instances[0]!.drop();
    await turns();

    expect(voice.orchestrator.state).toBe('closed');
    expect(voice.failed()).toBe(true);
  });

  it('fails over on a chain when it later drops', async () => {
    const health = watched();
    const chain = new StreamingSTTChain([openai({ priority: 10 }), deepgram(20)], {
      enableMidUtteranceFailover: true,
      metrics: health.metrics,
      breaker: health.breaker,
    });
    const voice = await startVoiceSession(chain);
    await voice.stt.flush();
    voice.frame();
    await turns();

    sockets.instances[0]!.drop();
    await turns();

    expect(sockets.instances).toHaveLength(2);
    expect(health.failovers()).toHaveLength(1);
    expect(health.breakerFailures).toHaveBeenCalledOnce();
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });
});

describe('a hard stop with no next connection', () => {
  it('ends the session as a failure though a flush came before it and no frame since', async () => {
    const voice = await startVoiceSession(openai({ refuseRollover: true }));
    await vi.advanceTimersByTimeAsync(2_000); // the deadline: the host refuses the next connection
    await turns();
    await voice.stt.flush();
    await vi.advanceTimersByTimeAsync(1_000); // the connection's hard stop
    await turns();
    await vi.advanceTimersByTimeAsync(5_000); // the drain's longest wait for finals
    await turns();

    expect(voice.orchestrator.state).toBe('closed');
    expect(voice.failed()).toBe(true);
  });

  it("goes on through the next provider in the user's order", async () => {
    const health = watched();
    const chain = new StreamingSTTChain([openai({ priority: 10, refuseRollover: true }), deepgram(20)], {
      enableMidUtteranceFailover: true,
      metrics: health.metrics,
      breaker: health.breaker,
    });
    const voice = await startVoiceSession(chain);
    await vi.advanceTimersByTimeAsync(2_000);
    await turns();
    await voice.stt.flush();
    await vi.advanceTimersByTimeAsync(1_000);
    await turns();
    await vi.advanceTimersByTimeAsync(5_000);
    await turns();

    expect(sockets.instances).toHaveLength(2);
    expect(health.failovers()).toHaveLength(1);
    expect(voice.orchestrator.state).toBe('listening');
    expect(voice.failed()).toBe(false);
  });
});
