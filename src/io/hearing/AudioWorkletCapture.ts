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

/** The module each context loaded, so a second capture on one context loads nothing. */
const loaded = new WeakMap<BaseAudioContext, Promise<void>>();

/** A page's audio as mono Float32 blocks through an `AudioWorkletNode`. */
export class AudioWorkletCapture {
  private node: AudioWorkletNode | undefined;
  private source: MediaStreamAudioSourceNode | undefined;
  private silent: GainNode | undefined;
  private stream: MediaStream;
  private readonly listeners = new Set<(samples: Float32Array, sampleRate: number) => void>();

  constructor(private readonly options: AudioWorkletCaptureOptions) {
    this.stream = options.stream;
  }

  /** Adds a listener for each block; answers the function that removes it. */
  onBlock(listener: (samples: Float32Array, sampleRate: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Loads the module (once per context), builds the path, and starts handing blocks on. */
  async start(): Promise<void> {
    const { context } = this.options;
    let ready = loaded.get(context);
    if (!ready) {
      ready = context.audioWorklet.addModule(this.options.moduleUrl);
      loaded.set(context, ready);
    }
    await ready;
    this.node = new AudioWorkletNode(context, CAPTURE_PROCESSOR_NAME, {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      processorOptions: { blockSize: this.options.blockSize ?? 2048 },
    });
    this.node.port.onmessage = (event: MessageEvent<Float32Array>) => {
      for (const listener of this.listeners) listener(event.data, context.sampleRate);
    };
    this.silent = context.createGain();
    this.silent.gain.value = 0;
    this.node.connect(this.silent);
    this.silent.connect(context.destination);
    this.connectSource();
  }

  /** Hears another stream with the same node: a new microphone, or the tab's sound added. */
  setStream(stream: MediaStream): void {
    this.stream = stream;
    this.source?.disconnect();
    if (this.node) this.connectSource();
  }

  /** Stops: every node disconnected, and no block handed on after it. */
  stop(): void {
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
