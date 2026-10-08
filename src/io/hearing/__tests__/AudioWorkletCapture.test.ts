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

/** A fake source or gain node, read for its connections. */
type FakeLink = { connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> };

/** The processor class the worklet module registers, as a test constructs it. */
type ProcessorClass = new (options?: { processorOptions?: { blockSize?: number } }) => {
  process(inputs: Float32Array[][]): boolean;
};

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

  it("registers in a worklet's scope a processor that posts its input's blocks mixed to mono, each buffer transferred", async () => {
    const registered = new Map<string, ProcessorClass>();
    const posted: Array<{ block: Float32Array; transfer: unknown[] }> = [];
    class FakeProcessor {
      readonly port = { postMessage: (block: Float32Array, transfer: unknown[]) => posted.push({ block, transfer }) };
    }
    vi.stubGlobal('AudioWorkletProcessor', FakeProcessor);
    vi.stubGlobal('registerProcessor', (name: string, processor: ProcessorClass) => registered.set(name, processor));
    vi.resetModules();
    await import('../capture-worklet.js');
    expect([...registered.keys()]).toEqual([CAPTURE_PROCESSOR_NAME]);
    const Processor = registered.get(CAPTURE_PROCESSOR_NAME)!;
    const processor = new Processor({ processorOptions: { blockSize: 4 } });
    expect(processor.process([[new Float32Array([1, 1, 1]), new Float32Array([0, 0, 0])]])).toBe(true);
    expect(posted).toEqual([]);
    expect(processor.process([[new Float32Array([0, 0, 0])]])).toBe(true);
    expect(posted.map(({ block }) => [...block])).toEqual([[0.5, 0.5, 0.5, 0]]);
    expect(posted[0]!.transfer).toHaveLength(1);
    expect(posted[0]!.transfer[0]).toBe(posted[0]!.block.buffer);
    expect(processor.process([[]])).toBe(true);
    expect(posted).toHaveLength(1);
    expect(new Processor().process([[new Float32Array(2048)]])).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.block).toHaveLength(2048);
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
    const source = context.createMediaStreamSource.mock.results[0]!.value as FakeLink;
    expect(source.connect).toHaveBeenCalledWith(node);
    expect(node.connect).toHaveBeenCalledWith(gain);
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
    const next = { id: 'next' } as MediaStream;
    capture.setStream(next);
    expect(context.createMediaStreamSource).toHaveBeenLastCalledWith(next);
    const sources = context.createMediaStreamSource.mock.results.map((result) => result.value as FakeLink);
    expect(sources[0]!.disconnect).toHaveBeenCalled();
    expect(sources[1]!.disconnect).toHaveBeenCalled();
    expect(sources[2]!.connect).toHaveBeenCalledWith(FakeNode.made[0]);
    expect(sources[2]!.disconnect).not.toHaveBeenCalled();
    capture.stop();
    FakeNode.made[0]!.emit([1, 2, 3]);
    expect(heard).toEqual([]);
    expect(FakeNode.made[0]!.disconnect).toHaveBeenCalled();
    expect(sources[2]!.disconnect).toHaveBeenCalled();
    expect((context.createGain.mock.results[0]!.value as FakeLink).disconnect).toHaveBeenCalled();
  });

  it('builds nothing when stopped while its module loads, and one path however often it is started', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const context = fakeContext();
    let finishLoading: () => void = () => undefined;
    context.audioWorklet.addModule.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishLoading = () => resolve(undefined);
        }),
    );
    const capture = new AudioWorkletCapture({ context: context as unknown as AudioContext, stream: {} as MediaStream, moduleUrl: '/w.js' });
    const starting = capture.start();
    capture.stop();
    finishLoading();
    await starting;
    expect(FakeNode.made).toHaveLength(0);
    expect(context.createMediaStreamSource).not.toHaveBeenCalled();
    await Promise.all([capture.start(), capture.start()]);
    await capture.start();
    expect(FakeNode.made).toHaveLength(1);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(1);
    expect(context.createGain).toHaveBeenCalledTimes(1);
  });

  it('starts again after a start that failed, on a module that did not load or a stream it could not hear', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeNode);
    const context = fakeContext();
    context.audioWorklet.addModule.mockRejectedValueOnce(new Error('the module did not load'));
    context.createMediaStreamSource.mockImplementationOnce(() => {
      throw new Error('the stream has no audio track');
    });
    const capture = new AudioWorkletCapture({ context: context as unknown as AudioContext, stream: {} as MediaStream, moduleUrl: '/w.js' });
    await expect(capture.start()).rejects.toThrow('the module did not load');
    expect(FakeNode.made).toHaveLength(0);
    await expect(capture.start()).rejects.toThrow('the stream has no audio track');
    expect(FakeNode.made).toHaveLength(0);
    expect(context.createGain).not.toHaveBeenCalled();
    await capture.start();
    expect(context.audioWorklet.addModule).toHaveBeenCalledTimes(2);
    expect(context.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(FakeNode.made).toHaveLength(1);
  });
});
