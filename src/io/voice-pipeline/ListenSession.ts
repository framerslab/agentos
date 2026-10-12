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
 * queued; faults are `stt_failed` (the transcriber failed for good, past {@link ReconnectingSTT}'s cap or at once
 * without it), `transport_closed`, `transport_failed` (the transport emitted an error, included in `ended`)
 * and `sink_failed` (the sink threw on a write).
 */
export type ListenEndReason = 'stopped' | 'purged' | 'stt_failed' | 'transport_closed' | 'transport_failed' | 'sink_failed';

/** What {@link startListenSession} takes besides the transport and the sink: only the transcriber and the run are required. */
export interface ListenSessionOverrides {
  /** The streaming transcriber; wrapped in {@link ReconnectingSTT} unless `reconnect` is `false`. */
  streamingSTT: IStreamingSTT;
  /** The run the turns belong to; turn ids are `<runId>:<n>`. */
  runId: string;
  /**
   * When given, its `turn_complete` events are the turns; without one, each final is a turn.
   * An empty detector transcript uses the STT finals since the previous turn, joined with spaces,
   * and their first start and last end times (including with {@link AcousticEndpointDetector}).
   */
  endpointDetector?: IEndpointDetector;
  /** Passed to the transcriber's `startSession()`. */
  sttConfig?: StreamingSTTConfig;
  /** Wrap the transcriber in {@link ReconnectingSTT} (default true). A chain of several providers passes `false`. */
  reconnect?: boolean | ReconnectingSTTOptions;
  /** Finals waiting for the sink before the transport is paused. Default 8. */
  sinkQueueLimit?: number;
  /**
   * Names who spoke a turn, from the transcriber's final. A detector turn carries its text and no words,
   * unless empty detector text uses the accumulated STT finals and their words.
   */
  speaker?: (event: TranscriptEvent) => string | undefined;
  /** How long a stop waits for the flushed final to arrive, before draining a pending detector turn. Default 250. */
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
  /**
   * `stopped` flushes the transcriber, waits `drainMs`, then waits for a pending detector turn up to
   * its `turnCompletionTimeoutMs` (3250 ms if omitted), plus one timer tick, before resetting. `purged` drops everything
   * queued without draining. Every end releases an outstanding transport pause; resolves at `ended`.
   */
  close(reason?: ListenEndReason): Promise<void>;
}

/**
 * Starts listening. Emits `turn` (a {@link TranscriptTurn}), `interim` (a {@link TranscriptEvent}), `stt:reconnected`,
 * `stt:gap`, `paused`, `resumed` and `ended` (`{ reason, error? }`).
 *
 * The transport's frames go to the transcriber. Each final, or with an endpoint detector each `turn_complete`, goes
 * to the sink, one write at a time in arrival order; the sink numbers it. When `sinkQueueLimit` finals wait for the
 * sink, the session emits `pause` on the transport and `paused` on itself, and `resume` and `resumed` once the queue
 * is down to half or the session ends; a final is never dropped for a slow sink. The transcriber's `speech_start`
 * and `speech_end` reach the detector as voice activity, as the orchestrator gives them. The session ends once, for the first
 * {@link ListenEndReason}; it closes the transcriber and leaves the transport open, since the transport is the
 * caller's. A transport error ends it with `transport_failed` and the error in `ended`. Its transport listeners
 * are removed on every end. An empty detector turn uses the accumulated STT finals and their timing.
 *
 * @param transport - Where the audio comes from: the session listens for its `audio`, `close` and `error`.
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
  const finals: TranscriptEvent[] = [];
  let speechEnded = false;
  let writing: Promise<void> = Promise.resolve();
  let endPromise: Promise<void> | undefined;

  const accepting = (): boolean => state === 'listening' || state === 'draining';

  const resume = (): void => {
    if (!paused) return;
    paused = false;
    transport.emit('resume');
    emitter.emit('resumed');
  };

  const drainDetector = async (): Promise<void> => {
    if (!detector || finals.length === 0) return;
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        detector.off('turn_complete', done);
        resolve();
      };
      // One timer tick lets a detector scheduled by the synthetic speech_end
      // below emit at its bound before the fallback removes its listener.
      const timer = setTimeout(done, (detector.turnCompletionTimeoutMs ?? 3_250) + 1);
      detector.on('turn_complete', done);
      // A provider need not report speech_end when flushed. End the input so
      // the detector can start its silence timer, without restarting a pending one.
      if (!speechEnded) detector.pushVadEvent({ type: 'speech_end', timestamp: Date.now(), source: 'stt' });
    });
  };

  /** One end for every path. The writer calls it with `fromWriter` and never waits for its own chain. */
  const end = (reason: ListenEndReason, error?: Error, fromWriter = false): Promise<void> => {
    if (endPromise) return endPromise;
    // Reserve the end before cleanup emits resume: its listeners may call close again.
    let resolveEnd: () => void = () => {};
    let rejectEnd: (error: unknown) => void = () => {};
    endPromise = new Promise<void>((resolve, reject) => { resolveEnd = resolve; rejectEnd = reject; });
    void (async () => {
      if (reason === 'stopped') {
        // the transcriber is flushed and its last finals are still written
        state = 'draining';
        try {
          await sttSession.flush();
        } catch {
          // the transcriber is gone; nothing to drain
        }
        await new Promise((r) => setTimeout(r, drainMs));
        await drainDetector();
      }
      state = 'ending';
      transport.off('audio', onAudio);
      transport.off('close', onTransportClose);
      detector?.off('turn_complete', onTurnComplete);
      finals.length = 0;
      if (reason === 'purged') pending.length = 0;
      resume();
      sttSession.close();
      detector?.reset();
      if (!fromWriter) await writing;
      transport.off('error', onTransportError);
      state = 'ended';
      emitter.emit('ended', error ? { reason, error } : { reason });
    })().then(resolveEnd, rejectEnd);
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
        resume();
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
  const onTransportError = (error: Error): void => {
    void end('transport_failed', error);
  };
  const onTurnComplete = (turn: TurnCompleteEvent): void => {
    if (!accepting()) return;
    const accumulated = finals.splice(0);
    if (!turn.transcript.trim()) {
      const text = accumulated.map((event) => event.text).filter(Boolean).join(' ');
      if (text) write(text, {
        text, confidence: accumulated[accumulated.length - 1].confidence,
        words: accumulated.flatMap((event) => event.words), isFinal: true,
        startMs: accumulated[0].startMs, endMs: accumulated[accumulated.length - 1].endMs,
      });
      return;
    }
    // a detector turn has its text and confidence, and no audio boundaries of its own
    write(turn.transcript, { text: turn.transcript, confidence: turn.confidence, words: [], isFinal: true, durationMs: turn.durationMs });
  };

  sttSession.on('transcript', (event: TranscriptEvent) => {
    if (!accepting()) return;
    if (detector) {
      if (event.isFinal) finals.push(event);
      detector.pushTranscript(event);
      if (!event.isFinal) emitter.emit('interim', event);
      return;
    }
    if (event.isFinal) write(event.text, event);
    else emitter.emit('interim', event);
  });
  const onVad = (event: VadEvent): void => {
    if (!accepting()) return;
    if (event.type === 'speech_start') speechEnded = false;
    else if (event.type === 'speech_end') speechEnded = true;
    detector?.pushVadEvent(event);
  };
  sttSession.on('vad', onVad);
  // the transcriber's own speech events reach the detector as voice activity, as the orchestrator gives them
  sttSession.on('speech_start', () => onVad({ type: 'speech_start', timestamp: Date.now(), source: 'stt' }));
  sttSession.on('speech_end', () => onVad({ type: 'speech_end', timestamp: Date.now(), source: 'stt' }));
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
  transport.on('error', onTransportError);

  const session = Object.assign(emitter, {
    runId: overrides.runId,
    transport,
    stats: (): ListenSessionStats => ({ turns, dropped, reconnects }),
    close: (reason: ListenEndReason = 'stopped') => end(reason),
  }) as ListenSession;
  Object.defineProperty(session, 'state', { get: () => state, enumerable: true });
  return session;
}
