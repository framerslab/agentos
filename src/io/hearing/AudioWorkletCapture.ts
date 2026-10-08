/// <reference lib="dom" />
/**
 * @module hearing/AudioWorkletCapture
 * A page's audio as mono Float32 blocks, read off the main thread by an `AudioWorkletNode` (beside `AudioProcessor`,
 * whose `ScriptProcessorNode` capture the worklet succeeds): a `MediaStream` through `createMediaStreamSource` into the
 * worklet, whose one output goes to the destination through a gain of zero so every engine pulls it, and each block
 * handed to the listeners with the context's sample rate. The worklet module is `capture-worklet.js`, beside this
 * entry's built file in the package's `dist`, which the host serves from its own origin.
 *
 * @example
 * ```typescript
 * const capture = new AudioWorkletCapture({ context, stream, moduleUrl: '/live/capture-worklet.js' });
 * capture.onBlock((samples, sampleRate) => session.pushAudio({ samples, sampleRate, timestamp: Date.now() }));
 * await capture.start();
 * ```
 */
import { CAPTURE_PROCESSOR_NAME } from './capture-worklet.js';

/** Options of {@link AudioWorkletCapture}. */
export interface AudioWorkletCaptureOptions {
  /** The page's audio context. */
  context: AudioContext;
  /** The stream to hear: a microphone's, or a mix the page made. */
  stream: MediaStream;
  /** Where the host serves `capture-worklet.js`, the module beside this entry in the package's `dist`. */
  moduleUrl: string;
  /** Samples per block. @defaultValue 2048 */
  blockSize?: number;
}

/**
 * The module each context loaded, so a second capture on one context loads nothing. A load that fails is dropped, so
 * the next start on that context loads the module again.
 */
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** A page's audio as mono Float32 blocks through an `AudioWorkletNode`. */
export class AudioWorkletCapture {
  private node: AudioWorkletNode | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private silent: GainNode | undefined;
  private stream: MediaStream;
  /** Advanced by each `start()` and `stop()`, so a start whose module loads after a later call builds nothing. */
  private generation = 0;
  private readonly listeners = new Set<(samples: Float32Array, sampleRate: number) => void>();

  constructor(private readonly options: AudioWorkletCaptureOptions) {
    this.stream = options.stream;
  }

  /** Adds a listener for each block; answers the function that removes it. */
  onBlock(listener: (samples: Float32Array, sampleRate: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Loads the module (once per context), builds the path, and starts handing blocks on. A started capture is left as
   * it is, so a second call builds no second path; when calls overlap while the module loads, the last one builds.
   * A start that fails leaves nothing connected, and the next call tries again.
   */
  async start(): Promise<void> {
    if (this.node) return;
    const generation = ++this.generation;
    const { context } = this.options;
    let ready = loaded.get(context);
    if (!ready) {
      ready = context.audioWorklet.addModule(this.options.moduleUrl).catch((error: unknown) => {
        loaded.delete(context);
        throw error;
      });
      loaded.set(context, ready);
    }
    await ready;
    if (generation !== this.generation) return;
    // The path is built whole before it is kept: a stream with no audio track throws here, with nothing connected.
    const source = context.createMediaStreamSource(this.stream);
    const node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { blockSize: this.options.blockSize ?? 2048 },
    });
    node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const listener of this.listeners) listener(event.data, context.sampleRate);
    };
    const silent = context.createGain();
    silent.gain.value = 0;
    node.connect(silent);
    silent.connect(context.destination);
    source.connect(node);
    this.source = source;
    this.node = node;
    this.silent = silent;
  }

  /** Hears another stream with the same node: a new microphone, or the tab's sound added. */
  setStream(stream: MediaStream): void {
    this.stream = stream;
    this.source?.disconnect();
    if (this.node) this.connectSource();
  }

  /** Stops: every node disconnected, and no block handed on after it; a start still loading the module builds nothing. */
  stop(): void {
    this.generation += 1;
    this.listeners.clear();
    if (this.node) this.node.port.onmessage = null;
    this.source?.disconnect();
    this.node?.disconnect();
    this.silent?.disconnect();
    this.source = undefined;
    this.node = undefined;
    this.silent = undefined;
  }

  /** Connects the stream to the node. */
  private connectSource(): void {
    this.source = this.options.context.createMediaStreamSource(this.stream);
    this.source.connect(this.node!);
  }
}
