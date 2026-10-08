import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioWorkletCapture } from '../AudioWorkletCapture.js';
import { BlockAccumulator, CAPTURE_PROCESSOR_NAME, mixToMono } from '../capture-worklet.js';

/** A fake AudioWorkletNode: the capture sets its port's handler, and `emit` plays a block the processor posted. */
class FakeNode {
  static made: FakeNode[] = [];
  readonly port = { onmessage: null as ((event: { data: Float32Array }) => void) | null };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
  constructor(
    readonly context: unknown,
    readonly name: string,
    readonly options: { processorOptions?: { blockSize?: number } },
  ) {
    FakeNode.made.push(this);
  }
  emit(samples: number[]): void {
    this.port.onmessage?.({ data: new Float32Array(samples) });
  }
}

/** A fake AudioContext with the parts the capture calls. */
function fakeContext() {
  return {
    sampleRate: 48_000,
    destination: {},
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeNode.made = [];
});

describe('the capture worklet module', () => {
  it('averages the channels of the first input, copies a mono one, and answers null for none', () => {
    expect([...(mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]) ?? [])]).toEqual([0.5, 0.5]);
    expect([...(mixToMono([new Float32Array([0.25, -0.25])]) ?? [])]).toEqual([0.25, -0.25]);
    expect(mixToMono([])).toBeNull();
    expect(mixToMono([new Float32Array(0)])).toBeNull();
  });

  it('hands out a block once it holds its size, and keeps the rest for the next', () => {
    const blocks = new BlockAccumulator(4);
    expect(blocks.push(new Float32Array([1, 2, 3]))).toEqual([]);
    expect(blocks.push(new Float32Array([4, 5, 6])).map((block) => [...block])).toEqual([[1, 2, 3, 4]]);
    expect(blocks.push(new Float32Array([7, 8])).map((block) => [...block])).toEqual([[5, 6, 7, 8]]);
    expect(CAPTURE_PROCESSOR_NAME).toBe('agentos-capture');
  });
});

describe('AudioWorkletCapture', () => {
  it("loads its module once per context, pulls the stream through a silent path, and hands each block on with the context's rate", async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const context = fakeContext();
    const heard: Array<[number[], number]> = [];
    const first = new AudioWorkletCapture({ context: context as unknown as AudioContext, stream: {} as MediaStream, moduleUrl: '/live/capture-worklet.js' });
    first.onBlock((samples, rate) => heard.push([[...samples], rate]));
    await first.start();
    await new AudioWorkletCapture({ context: context as unknown as AudioContext, stream: {} as MediaStream, moduleUrl: '/live/capture-worklet.js' }).start();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(1);
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith('/live/capture-worklet.js');
    const node = FakeNode.made[0]!;
    expect(node.name).toBe('agentos-capture');
    expect(node.options.processorOptions?.blockSize).toBe(2048);
    const gain = context.createGain.mock.results[0]!.value as { gain: { value: number }; connect: ReturnType<typeof vi.fn> };
    expect(gain.gain.value).toBe(0);
    expect(gain.connect).toHaveBeenCalledWith(context.destination);
    node.emit([0.25, 0.5]);
    expect(heard).toEqual([[[0.25, 0.5], 48_000]]);
  });

  it('takes a new stream without a new node, and hands on nothing once stopped', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const context = fakeContext();
    const capture = new AudioWorkletCapture({ context: context as unknown as AudioContext, stream: {} as MediaStream, moduleUrl: '/w.js' });
    const heard: number[] = [];
    capture.onBlock((samples) => heard.push(samples.length));
    await capture.start();
    capture.setStream({} as MediaStream);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(FakeNode.made).toHaveLength(1);
    capture.stop();
    FakeNode.made[0]!.emit([1, 2, 3]);
    expect(heard).toEqual([]);
    expect(FakeNode.made[0]!.disconnect).toHaveBeenCalled();
  });
});
