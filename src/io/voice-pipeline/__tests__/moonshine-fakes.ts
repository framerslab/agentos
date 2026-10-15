/**
 * Fakes of the @moonshine-ai/moonshine-wasm surface the Moonshine browser
 * provider uses: Transcriber, Stream and SttWorkerHost. A fake stream turns
 * the transcripts a test queues into line events by the package's own diff
 * rule (its events.ts, diffTranscript), so the provider sees the sequences
 * the package produces; no model is loaded and nothing is downloaded.
 */

import type {
  MoonshineLineLike,
  MoonshineLineListener,
  MoonshineLoadOptionsLike,
  MoonshineModelSource,
  MoonshineWasmModule,
  MoonshineWordLike,
} from '../providers/MoonshineBrowserSTT.js';

/** The package's ModelArch values for the streaming sizes. */
export const MODEL_ARCH = { TinyStreaming: 2, SmallStreaming: 4, MediumStreaming: 5 } as const;

/** A line as the package reports it. */
export function line(
  id: string,
  text: string,
  startTime: number,
  duration: number,
  isComplete = false,
  words: readonly MoonshineWordLike[] = []
): MoonshineLineLike {
  return { id, text, startTime, duration, isComplete, words };
}

/**
 * The package's Stream. Each `transcribe()` takes the next queued snapshot
 * (the lines the engine would return) and dispatches line events as the
 * package's diffTranscript does: `onLineStarted` at a line's first sighting,
 * `onLineTextChanged` when its text changes, `onLineUpdated` on each later
 * sighting (the fake marks every later sighting updated), and
 * `onLineCompleted` once, when it is complete. `stop()` takes a queued
 * snapshot, or the open lines, and completes every line in it.
 */
export class FakeStream {
  static created: FakeStream[] = [];
  readonly listeners: MoonshineLineListener[] = [];
  /** Transcript snapshots, one per pass; a test pushes them. */
  readonly passes: MoonshineLineLike[][] = [];
  /** The frames the stream took. */
  readonly audio: Array<{ samples: number; sampleRate: number }> = [];
  running = false;
  closed = false;
  starts = 0;
  stops = 0;
  /** Makes the next pass fail as the package's does: `onError` to the listeners, then a throw. */
  failNextPass: Error | undefined;
  private started = new Set<string>();
  private seen = new Map<string, string>();
  private completed = new Set<string>();
  private open = new Map<string, MoonshineLineLike>();

  constructor(readonly options: { flags?: number; updateInterval?: number } = {}) {
    FakeStream.created.push(this);
  }

  addListener(listener: MoonshineLineListener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.closed) throw new Error('Stream is closed');
    this.running = true;
    this.starts += 1;
    // A started stream begins from an empty transcript.
    this.started = new Set();
    this.seen = new Map();
    this.completed = new Set();
    this.open = new Map();
  }

  addAudio(audio: Float32Array, sampleRate: number): void {
    if (!this.running) {
      throw new Error('Adding new audio for stream with ID 1 but VAD is not active. Did you call start_stream()?');
    }
    this.audio.push({ samples: audio.length, sampleRate });
  }

  transcribe(): unknown {
    if (this.failNextPass) {
      const error = this.failNextPass;
      this.failNextPass = undefined;
      for (const listener of this.listeners) listener.onError?.({ error });
      throw error;
    }
    const snapshot = this.passes.shift() ?? [];
    this.diff(snapshot);
    return { lines: snapshot };
  }

  stop(): void {
    this.running = false;
    this.stops += 1;
    const snapshot = this.passes.shift() ?? [...this.open.values()];
    this.diff(snapshot.map((l) => ({ ...l, isComplete: true })));
  }

  close(): void {
    this.closed = true;
    this.running = false;
  }

  private diff(lines: readonly MoonshineLineLike[]): void {
    for (const l of lines) {
      if (!this.started.has(l.id)) {
        this.started.add(l.id);
        this.seen.set(l.id, l.text);
        this.dispatch((listener) => listener.onLineStarted?.({ line: l }));
      } else {
        if (this.seen.get(l.id) !== l.text) {
          this.seen.set(l.id, l.text);
          this.dispatch((listener) => listener.onLineTextChanged?.({ line: l }));
        }
        this.dispatch((listener) => listener.onLineUpdated?.({ line: l }));
      }
      if (l.isComplete) {
        this.open.delete(l.id);
        if (!this.completed.has(l.id)) {
          this.completed.add(l.id);
          this.dispatch((listener) => listener.onLineCompleted?.({ line: l }));
        }
      } else {
        this.open.set(l.id, l);
      }
    }
  }

  private dispatch(call: (listener: MoonshineLineListener) => void): void {
    for (const listener of this.listeners) call(listener);
  }
}

/** The package's Transcriber: where it was loaded from, its options, and the streams made on it. */
export class FakeTranscriber {
  static loaded: FakeTranscriber[] = [];
  readonly streams: FakeStream[] = [];
  closed = false;

  constructor(
    readonly source: MoonshineModelSource,
    readonly options: MoonshineLoadOptionsLike
  ) {
    FakeTranscriber.loaded.push(this);
  }

  createStream(options?: { flags?: number; updateInterval?: number }): FakeStream {
    const stream = new FakeStream(options);
    this.streams.push(stream);
    return stream;
  }

  close(): void {
    this.closed = true;
  }
}

/** The fake module, with the knobs a test sets. */
export interface FakeMoonshine extends MoonshineWasmModule {
  /** The progress reports each load makes, as `[loaded, total, file]`. */
  progress: Array<[number, number | undefined, string]>;
  /** Makes the next load fail with this error. */
  failLoad: Error | undefined;
  /** What `sttWorkerSupported()` answers. */
  workerSupported: boolean;
}

/** Loads a fake transcriber as the package's loaders do: its progress, then the model or the error. */
async function loadFake(
  fake: FakeMoonshine,
  source: MoonshineModelSource,
  options: MoonshineLoadOptionsLike
): Promise<FakeTranscriber> {
  await Promise.resolve();
  for (const [loaded, total, file] of fake.progress) options.onProgress?.(loaded, total, file);
  if (fake.failLoad) {
    const error = fake.failLoad;
    fake.failLoad = undefined;
    throw error;
  }
  return new FakeTranscriber(source, options);
}

/**
 * The package's SttWorkerHost with its "worker" on this thread: the
 * transcriber and the streams are the fakes above, and each line event
 * reaches the listener a microtask later, as a worker's message reaches the
 * page, and before the reply to the request that caused it.
 */
export class FakeWorkerHost {
  static created: FakeWorkerHost[] = [];
  onProgress?: (transcriberId: string, loaded: number, total: number | undefined, file: string) => void;
  readonly loads: Array<{
    transcriberId: string;
    modelArch: number;
    options?: Record<string, string>;
    source: MoonshineModelSource;
  }> = [];
  readonly transcribers = new Map<string, FakeTranscriber>();
  readonly streams = new Map<string, FakeStream>();
  closed = false;
  private readonly listeners = new Map<string, MoonshineLineListener>();

  constructor(
    private readonly fake: FakeMoonshine,
    readonly wasmBaseUrl?: string
  ) {
    FakeWorkerHost.created.push(this);
  }

  async loadTranscriber(config: {
    transcriberId: string;
    modelArch: number;
    options?: Record<string, string>;
    source: MoonshineModelSource;
  }): Promise<void> {
    this.loads.push(config);
    const transcriber = await loadFake(this.fake, config.source, {
      modelArch: config.modelArch,
      ...(config.options ? { options: config.options } : {}),
      onProgress: (loaded, total, file) => this.onProgress?.(config.transcriberId, loaded, total, file),
    });
    this.transcribers.set(config.transcriberId, transcriber);
  }

  async createStream(
    transcriberId: string,
    streamId: string,
    options?: { flags?: number; updateInterval?: number }
  ): Promise<void> {
    const transcriber = this.transcribers.get(transcriberId);
    if (!transcriber) throw new Error(`Unknown transcriber: ${transcriberId}`);
    this.streams.set(streamId, transcriber.createStream(options));
  }

  setListener(streamId: string, listener: MoonshineLineListener): void {
    this.listeners.set(streamId, listener);
    this.stream(streamId).addListener({
      onLineStarted: (event) => later(() => listener.onLineStarted?.(event)),
      onLineUpdated: (event) => later(() => listener.onLineUpdated?.(event)),
      onLineTextChanged: (event) => later(() => listener.onLineTextChanged?.(event)),
      onLineCompleted: (event) => later(() => listener.onLineCompleted?.(event)),
      onError: (event) => later(() => listener.onError?.(event)),
    });
  }

  async start(streamId: string): Promise<void> {
    this.stream(streamId).start();
  }

  addAudio(streamId: string, audio: Float32Array, sampleRate: number): void {
    if (this.closed) throw new Error('STT worker is closed.');
    const stream = this.stream(streamId);
    try {
      stream.addAudio(audio.slice(), sampleRate);
    } catch (err) {
      // The worker reports a frame its stream refuses as an error event.
      const listener = this.listeners.get(streamId);
      later(() => listener?.onError?.({ error: err as Error }));
      return;
    }
    try {
      stream.transcribe();
    } catch {
      // The stream told its listener; the worker goes on.
    }
  }

  async stop(streamId: string): Promise<void> {
    this.stream(streamId).stop();
    // The last pass's events were queued first, so they reach the page before this reply.
    await Promise.resolve();
  }

  async closeStream(streamId: string): Promise<void> {
    this.streams.get(streamId)?.close();
    this.streams.delete(streamId);
    this.listeners.delete(streamId);
  }

  close(): void {
    this.closed = true;
    for (const transcriber of this.transcribers.values()) transcriber.close();
  }

  private stream(streamId: string): FakeStream {
    const stream = this.streams.get(streamId);
    if (!stream) throw new Error(`Unknown stream: ${streamId}`);
    return stream;
  }
}

/** Runs `call` a microtask later, as a worker's message arrives. */
function later(call: () => void): void {
  void Promise.resolve().then(call);
}

/** A fake of the package module; `sttWorkerSupported()` answers `workerSupported`. */
export function fakeMoonshine(options: { workerSupported?: boolean } = {}): FakeMoonshine {
  const fake: FakeMoonshine = {
    progress: [],
    failLoad: undefined,
    workerSupported: options.workerSupported ?? true,
    ModelArch: MODEL_ARCH,
    Transcriber: {
      load: (loadOptions) => loadFake(fake, { kind: 'catalog', language: loadOptions.language }, loadOptions),
      loadFromUrls: (files, loadOptions = {}) => loadFake(fake, { kind: 'urls', files }, loadOptions),
    },
    SttWorkerHost: class extends FakeWorkerHost {
      constructor(wasmBaseUrl?: string) {
        super(fake, wasmBaseUrl);
      }
    },
    sttWorkerSupported: () => fake.workerSupported,
  };
  return fake;
}
