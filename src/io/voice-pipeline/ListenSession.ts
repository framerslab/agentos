/**
 * @module voice-pipeline/ListenSession
 *
 * A session that listens and writes: a transport's audio into a streaming
 * transcriber, each final (or each detector turn) into a sink as a numbered
 * turn. No synthesis, no barge-in, no agent turn. Built for a notetaker, a
 * meeting bot or a transcription job, where {@link VoicePipelineOrchestrator}
 * is built for a conversation.
 */
import { EventEmitter } from 'node:events';
import { ReconnectingSTT, type ReconnectingSTTOptions, type SttGapEvent, type SttReconnectedEvent } from './ReconnectingSTT.js';
import type { AudioFrame, IEndpointDetector, IStreamingSTT, IStreamTransport, ITranscriptInputSink, StreamingSTTConfig, StreamingSTTSession, TranscriptEvent, TranscriptInput, TranscriptTurn, TurnCompleteEvent, VadEvent } from './types.js';

export type { ITranscriptSink, ITranscriptInputSink, TranscriptInput, TranscriptTurn } from './types.js';

/**
 * Why a listen session ended. `stopped` drains the last utterance first; `purged` drains nothing and drops what is
 * queued; the other three are faults: `stt_failed` (the transcriber failed for good, past {@link ReconnectingSTT}'s
 * cap or at once without it), `transport_closed` (the transport closed) and `sink_failed` (the sink threw on a write).
 */
export type ListenEndReason = 'stopped' | 'purged' | 'stt_failed' | 'transport_closed' | 'sink_failed';

/** What {@link startListenSession} takes besides the transport and the sink: only the transcriber and the run are required. */
export interface ListenSessionOverrides {
  /** The streaming transcriber; wrapped in {@link ReconnectingSTT} unless `reconnect` is `false`. */
  streamingSTT: IStreamingSTT;
  /** The run the turns belong to; turn ids are `<runId>:<n>`. */
  runId: string;
  /** When given, its `turn_complete` events are the turns; without one, each final of the transcriber is a turn. */
  endpointDetector?: IEndpointDetector;
  /** Passed to the transcriber's `startSession()`. */
  sttConfig?: StreamingSTTConfig;
  /** Wrap the transcriber in {@link ReconnectingSTT} (default true). A chain of several providers passes `false`. */
  reconnect?: boolean | ReconnectingSTTOptions;
  /** Finals waiting for the sink before the transport is paused. Default 8. */
  sinkQueueLimit?: number;
  /** Names who spoke a turn, from the transcriber's final (a detector turn's event carries its text and no words). */
  speaker?: (event: TranscriptEvent) => string | undefined;
  /** How long a stop waits for the flushed final to arrive. Default 250. */
  drainMs?: number;
}

/** A listen session's counts so far. */
export interface ListenSessionStats {
  /** Turns the sink stored; one it dropped (behind a fence, or for a run that is over) is not counted. */
  turns: number;
  /**
   * Audio frames that came while the transport was asked to pause. They still reach the transcriber, so a count
   * above zero shows a transport that does not hold its buffer.
   */
  dropped: number;
  /** Reconnects of the transcriber. */
  reconnects: number;
}

/**
 * `listening`: audio flows and finals are written. `draining`: a stop was asked; the transcriber is flushed and the
 * finals it still emits are written. `ending`: nothing new is accepted; the queue is written out. `ended`: done.
 */
export type ListenSessionState = 'listening' | 'draining' | 'ending' | 'ended';

/** A running listen session; {@link startListenSession} lists its events. */
export interface ListenSession extends EventEmitter {
  /** The run its turns belong to. */
  readonly runId: string;
  /** Where the session is in its life, read when asked. */
  readonly state: ListenSessionState;
  /** The transport it reads. */
  readonly transport: IStreamTransport;
  /** The counts so far. */
  stats(): ListenSessionStats;
  /** `stopped` drains the transcriber's last utterance and writes it; `purged` drops everything queued; resolves at `ended`. */
  close(reason?: ListenEndReason): Promise<void>;
}

/**
 * Starts listening. Emits `turn` (a {@link TranscriptTurn}), `interim` (a {@link TranscriptEvent}), `stt:reconnected`,
 * `stt:gap`, `paused`, `resumed` and `ended` (`{ reason, error? }`).
 *
 * The transport's frames go to the transcriber. Each final, or with an endpoint detector each `turn_complete`, goes
 * to the sink, one write at a time in arrival order; the sink numbers it. When `sinkQueueLimit` finals wait for the
 * sink, the session emits `pause` on the transport and `paused` on itself, and `resume` and `resumed` once the queue
 * is down to half; a final is never dropped for a slow sink. The transcriber's `speech_start` and `speech_end` reach
 * the detector as voice activity, as the orchestrator gives them. The session ends once, for the first
 * {@link ListenEndReason}; it closes the transcriber and leaves the transport open, since the transport is the
 * caller's.
 *
 * @param transport - Where the audio comes from: the session listens for its `audio` and `close`.
 * @param sink - Where the turns go; it assigns each turn's number and id.
 * @param overrides - The transcriber, the run and the session's options.
 * @returns The session, listening.
 * @throws {Error} When the transcriber's first session fails to open.
 *
 * @example
 * ```typescript
 * const session = await startListenSession(transport, sink, {
 *   streamingSTT: new DeepgramStreamingSTT({ apiKey: process.env.DEEPGRAM_API_KEY! }),
 *   runId: 'run-1',
 * });
 * session.on('ended', ({ reason }: { reason: ListenEndReason }) => console.log(`listening ended: ${reason}`));
 * await session.close('stopped');
 * ```
 */
export async function startListenSession(transport: IStreamTransport, sink: ITranscriptInputSink, overrides: ListenSessionOverrides): Promise<ListenSession> {
  const stt = overrides.reconnect === false ? overrides.streamingSTT : new ReconnectingSTT(overrides.streamingSTT, typeof overrides.reconnect === 'object' ? overrides.reconnect : {});
  const sttSession: StreamingSTTSession = await stt.startSession(overrides.sttConfig);
  const detector = overrides.endpointDetector;
  const queueLimit = overrides.sinkQueueLimit ?? 8;
  const drainMs = overrides.drainMs ?? 250;
  const emitter = new EventEmitter();
  let state: ListenSessionState = 'listening';
  let turns = 0;
  let dropped = 0;
  let reconnects = 0;
  let paused = false;
  let sinkFailed = false;
  const pending: TranscriptInput[] = [];
  let writing: Promise<void> = Promise.resolve();
  let endPromise: Promise<void> | undefined;

  const accepting = (): boolean => state === 'listening' || state === 'draining';

  /** One end for every path. The writer calls it with `fromWriter` and never waits for its own chain. */
  const end = (reason: ListenEndReason, error?: Error, fromWriter = false): Promise<void> => {
    if (endPromise) return endPromise;
    endPromise = (async () => {
      if (reason === 'stopped') {
        // the transcriber is flushed and its last finals are still written
        state = 'draining';
        try {
          await sttSession.flush();
        } catch {
          // the transcriber is gone; nothing to drain
        }
        await new Promise((r) => setTimeout(r, drainMs));
      }
      state = 'ending';
      transport.off('audio', onAudio);
      transport.off('close', onTransportClose);
      detector?.off('turn_complete', onTurnComplete);
      if (reason === 'purged') pending.length = 0;
      sttSession.close();
      detector?.reset();
      if (!fromWriter) await writing;
      state = 'ended';
      emitter.emit('ended', error ? { reason, error } : { reason });
    })();
    return endPromise;
  };

  const write = (text: string, event: TranscriptEvent): void => {
    if (!accepting() || sinkFailed) return;
    const turn: TranscriptInput = { runId: overrides.runId, at: Date.now(), text, startMs: event.startMs, endMs: event.endMs, speaker: overrides.speaker?.(event) };
    pending.push(turn);
    if (pending.length >= queueLimit && !paused) {
      paused = true;
      transport.emit('pause');
      emitter.emit('paused');
    }
    writing = writing.then(async () => {
      const next = pending.shift();
      if (!next || sinkFailed) return;
      try {
        const stored: TranscriptTurn | undefined = await sink.appendNext(next);
        if (stored) {
          turns += 1;
          emitter.emit('turn', stored);
        }
      } catch (err) {
        sinkFailed = true;
        pending.length = 0;
        void end('sink_failed', err instanceof Error ? err : new Error(String(err)), true);
        return;
      }
      if (paused && pending.length < Math.ceil(queueLimit / 2)) {
        paused = false;
        transport.emit('resume');
        emitter.emit('resumed');
      }
    });
  };

  const onAudio = (frame: AudioFrame): void => {
    if (state !== 'listening') return;
    if (paused) dropped += 1; // the transport was asked to pause; a frame that still comes is counted, and the transcriber keeps its own buffer
    sttSession.pushAudio(frame);
  };
  const onTransportClose = (): void => {
    void end('transport_closed');
  };
  const onTurnComplete = (turn: TurnCompleteEvent): void => {
    if (!accepting()) return;
    // a detector turn has its text and confidence, and no audio boundaries of its own
    write(turn.transcript, { text: turn.transcript, confidence: turn.confidence, words: [], isFinal: true, durationMs: turn.durationMs });
  };

  sttSession.on('transcript', (event: TranscriptEvent) => {
    if (!accepting()) return;
    if (detector) {
      detector.pushTranscript(event);
      if (!event.isFinal) emitter.emit('interim', event);
      return;
    }
    if (event.isFinal) write(event.text, event);
    else emitter.emit('interim', event);
  });
  sttSession.on('vad', (event: VadEvent) => detector?.pushVadEvent(event));
  // the transcriber's own speech events reach the detector as voice activity, as the orchestrator gives them
  sttSession.on('speech_start', () => detector?.pushVadEvent({ type: 'speech_start', timestamp: Date.now(), source: 'stt' }));
  sttSession.on('speech_end', () => detector?.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'stt' }));
  sttSession.on('stt:reconnected', (e: SttReconnectedEvent) => {
    reconnects += 1;
    emitter.emit('stt:reconnected', e);
  });
  sttSession.on('stt:gap', (e: SttGapEvent) => emitter.emit('stt:gap', e));
  sttSession.on('error', (err: Error) => {
    if (state === 'listening') void end('stt_failed', err);
  });
  sttSession.on('close', () => {
    if (state === 'listening') void end('stt_failed', new Error('the transcriber closed'));
  });
  detector?.on('turn_complete', onTurnComplete);
  transport.on('audio', onAudio);
  transport.on('close', onTransportClose);

  const session = Object.assign(emitter, {
    runId: overrides.runId,
    transport,
    stats: (): ListenSessionStats => ({ turns, dropped, reconnects }),
    close: (reason: ListenEndReason = 'stopped') => end(reason),
  }) as ListenSession;
  Object.defineProperty(session, 'state', { get: () => state, enumerable: true });
  return session;
}
