/**
 * Item-keyed speech ends, end to end: `OpenAIRealtimeTranscriptionSTT` on a fake socket names the item of each
 * `speech_start` and `speech_end`, a listen session forwards it, and `HeuristicEndpointDetector` pairs each speech end
 * with its own final by item. A final that arrives more than `silenceTimeoutMs` after its own speech end then answers
 * no later speech end, and a final whose turn has completed joins no later turn
 * (https://github.com/framerslab/agentos/issues/390). The user says "Book a table for two." and, after a pause,
 * "At seven tonight." The sockets are fakes that never leave the process; fake time runs the detector's clock.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IStreamTransport, ITranscriptInputSink, TranscriptEvent, TranscriptInput, TurnCompleteEvent, VadEvent } from '../types.js';

vi.mock('ws', () => {
  const { EventEmitter: EE } = require('node:events');
  class Socket extends EE {
    static OPEN = 1;
    static CLOSED = 3;
    static instances: Socket[] = [];
    readyState = 1;
    constructor(readonly url: string, readonly options: { headers: Record<string, string> }) {
      super();
      Socket.instances.push(this);
      process.nextTick(() => {
        if (this.readyState === 1) this.emit('open');
      });
    }
    send(data: string | Buffer): void {
      if (typeof data !== 'string') return;
      const event = JSON.parse(data) as { type?: string; session?: unknown };
      if (event.type === 'session.update') process.nextTick(() => {
        this.emit('message', JSON.stringify({ type: 'session.updated', session: event.session }));
      });
    }
    close(): void { this.readyState = 3; }
    terminate(): void { this.readyState = 3; }
  }
  return { default: Socket };
});

import Ws from 'ws';
import { OpenAIRealtimeTranscriptionSTT } from '../providers/OpenAIRealtimeTranscriptionSTT.js';
import { startListenSession } from '../ListenSession.js';
import { HeuristicEndpointDetector } from '../HeuristicEndpointDetector.js';

const sockets = Ws as unknown as { instances: Array<EventEmitter & { readyState: number }> };

/** A transport that only carries the events a listen session listens for. */
function listenTransport(): IStreamTransport & EventEmitter {
  const transport = new EventEmitter() as IStreamTransport & EventEmitter;
  Object.defineProperty(transport, 'id', { value: 'listen-transport' });
  Object.defineProperty(transport, 'state', { value: 'open', writable: true });
  transport.sendAudio = vi.fn();
  transport.sendControl = vi.fn();
  transport.close = vi.fn();
  return transport;
}

/**
 * Starts a listen session over OpenAI's real transcription handler with a heuristic detector at its default silence
 * timeout, and gives the server's wire, the detector's turns and its late finals.
 */
async function listen() {
  const detector = new HeuristicEndpointDetector();
  const turns: string[] = [];
  const late: string[] = [];
  detector.on('turn_complete', (event: TurnCompleteEvent) => turns.push(event.transcript));
  detector.on('late_final', (event: TranscriptEvent) => late.push(event.text));
  // What the listen session tells the detector of each speech edge: its type and the item it names.
  const edges: string[] = [];
  const push = detector.pushVadEvent.bind(detector);
  detector.pushVadEvent = (event: VadEvent) => {
    edges.push(`${event.type} ${event.itemId ?? '-'}`);
    push(event);
  };
  const inputs: TranscriptInput[] = [];
  const sink: ITranscriptInputSink = {
    async append() {},
    async appendNext(input: TranscriptInput) {
      inputs.push(input);
      return { ...input, seq: inputs.length, turnId: `${input.runId}:${inputs.length}` };
    },
  };
  const session = await startListenSession(listenTransport(), sink, {
    streamingSTT: new OpenAIRealtimeTranscriptionSTT({ apiKey: 'fixture', rollover: false, maxRetries: 0 }),
    endpointDetector: detector,
    runId: 'run-1',
    sttConfig: { language: 'en' },
    reconnect: false,
  });
  const socket = sockets.instances[0];
  if (socket === undefined) throw new Error('missing fixture socket');
  let clock = 0;
  /** At `atMs` on the session's clock, the server sends `event` through the provider's real message handler. */
  const at = (atMs: number, event: Record<string, unknown>): void => {
    vi.advanceTimersByTime(atMs - clock);
    clock = atMs;
    socket.emit('message', JSON.stringify(event));
  };
  const started = (atMs: number, item: string) =>
    at(atMs, { type: 'input_audio_buffer.speech_started', item_id: item, audio_start_ms: atMs });
  const stopped = (atMs: number, item: string) => {
    at(atMs, { type: 'input_audio_buffer.speech_stopped', item_id: item, audio_end_ms: atMs });
    at(atMs, { type: 'input_audio_buffer.committed', item_id: item });
  };
  const completed = (atMs: number, item: string, transcript: string) =>
    at(atMs, { type: 'conversation.item.input_audio_transcription.completed', item_id: item, transcript });
  /** Lets the session's clock run to `atMs` with nothing sent. */
  const wait = (atMs: number): void => {
    vi.advanceTimersByTime(atMs - clock);
    clock = atMs;
  };
  return { session, turns, late, edges, started, stopped, completed, wait };
}

beforeEach(() => {
  sockets.instances.length = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('item-keyed speech ends over the real OpenAI transcription handler (#390)', () => {
  it('keeps both clauses when the first final comes after its speech end expired and the second utterance ended', async () => {
    const run = await listen();
    run.started(0, 'item_A');
    run.stopped(1_000, 'item_A');
    run.started(1_300, 'item_B');
    // item_A's speech end has waited past the 1500 ms silence timeout when item_B's speech ends.
    run.stopped(2_700, 'item_B');
    run.completed(2_800, 'item_A', 'Book a table for two.');
    run.completed(2_900, 'item_B', 'At seven tonight.');
    run.wait(6_000);

    expect(run.turns).toEqual(['Book a table for two. At seven tonight.']);
    expect(run.late).toEqual([]);
    expect(run.edges).toEqual(['speech_start item_A', 'speech_end item_A', 'speech_start item_B', 'speech_end item_B']);
    await run.session.close('purged');
  });

  it('keeps both clauses when the first speech end expires while the second utterance is spoken', async () => {
    const run = await listen();
    run.started(0, 'item_A');
    run.stopped(1_000, 'item_A');
    run.started(1_200, 'item_B');
    // item_A's speech end stops waiting at 2500, while item_B is spoken.
    run.stopped(3_000, 'item_B');
    run.completed(3_100, 'item_A', 'Book a table for two.');
    run.completed(3_300, 'item_B', 'At seven tonight.');
    run.wait(8_000);

    expect(run.turns).toEqual(['Book a table for two. At seven tonight.']);
    expect(run.late).toEqual([]);
    await run.session.close('purged');
  });

  it("reports a final whose turn has completed as late, and lets the next utterance's final decide its own turn", async () => {
    const run = await listen();
    run.started(0, 'item_A');
    run.stopped(1_000, 'item_A');
    run.started(1_200, 'item_B');
    run.completed(1_300, 'item_A', 'Book a table for two.');
    run.stopped(2_000, 'item_B');
    // item_B's speech end waits until 3500 for its final and stops waiting: the turn ends on item_A's words.
    run.wait(3_600);
    expect(run.turns).toEqual(['Book a table for two.']);

    run.started(4_000, 'item_C');
    run.stopped(5_000, 'item_C');
    run.completed(5_100, 'item_B', 'At seven tonight.');
    run.completed(5_200, 'item_C', 'Thanks.');
    run.wait(9_000);

    expect(run.turns).toEqual(['Book a table for two.', 'Thanks.']);
    expect(run.late).toEqual(['At seven tonight.']);
    await run.session.close('purged');
  });
});
