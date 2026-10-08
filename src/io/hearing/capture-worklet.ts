/// <reference lib="dom" />
/**
 * @module hearing/capture-worklet
 * The worklet module of `AudioWorkletCapture`: in an `AudioWorkletGlobalScope` it registers a processor that mixes its
 * first input to mono and posts blocks of `blockSize` samples to the page. It imports nothing, so its built file
 * (`dist/io/hearing/capture-worklet.js`) is served on its own from the host's origin; outside a worklet (a test, a
 * bundle) it registers nothing and exports its pure parts.
 */

/** The name the processor registers under. */
export const CAPTURE_PROCESSOR_NAME = 'agentos-capture';

/** The channels of one input mixed to mono (their mean); `null` when the input has no channel or no sample. */
export function mixToMono(channels: readonly Float32Array[]): Float32Array | null {
  const first = channels[0];
  if (!first || first.length === 0) return null;
  if (channels.length === 1) return new Float32Array(first);
  const mixed = new Float32Array(first.length);
  for (const channel of channels) {
    for (let i = 0; i < mixed.length; i += 1) mixed[i] = (mixed[i] ?? 0) + (channel[i] ?? 0) / channels.length;
  }
  return mixed;
}

/** Gathers samples into blocks of one size, keeping the rest for the next push. */
export class BlockAccumulator {
  private buffer: Float32Array;
  private filled = 0;

  /** @throws {RangeError} When `size` is not a positive whole number. */
  constructor(private readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new RangeError('BlockAccumulator: size must be a positive whole number');
    this.buffer = new Float32Array(size);
  }

  /** Takes samples; answers every block they completed, in order. */
  push(samples: Float32Array): Float32Array[] {
    const out: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const take = Math.min(this.size - this.filled, samples.length - offset);
      this.buffer.set(samples.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;
      if (this.filled === this.size) {
        out.push(this.buffer);
        this.buffer = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return out;
  }
}

/** What a worklet's global scope gives this module. */
interface WorkletScope {
  registerProcessor?: (name: string, processor: unknown) => void;
  AudioWorkletProcessor?: new (options?: unknown) => { readonly port: MessagePort };
}

const scope = globalThis as unknown as WorkletScope;
if (typeof scope.registerProcessor === 'function' && scope.AudioWorkletProcessor) {
  const Base = scope.AudioWorkletProcessor;
  scope.registerProcessor(
    CAPTURE_PROCESSOR_NAME,
    class extends Base {
      private readonly blocks: BlockAccumulator;

      constructor(options?: { processorOptions?: { blockSize?: number } }) {
        super(options);
        this.blocks = new BlockAccumulator(options?.processorOptions?.blockSize ?? 2048);
      }

      process(inputs: Float32Array[][]): boolean {
        const mono = mixToMono(inputs[0] ?? []);
        if (mono) for (const block of this.blocks.push(mono)) this.port.postMessage(block, [block.buffer as ArrayBuffer]);
        return true;
      }
    },
  );
}
