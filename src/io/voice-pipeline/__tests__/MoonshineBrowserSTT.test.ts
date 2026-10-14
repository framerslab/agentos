/**
 * Unit tests for the Moonshine browser speech-to-text provider.
 *
 * No unit test loads the package: the helpers read a scope object in place
 * of a page's globals, and the provider runs on fakes of the package's
 * Transcriber, Stream and SttWorkerHost (moonshine-fakes.ts);
 * MoonshineBrowserSTT.integration.test.ts runs it on the real package.
 * The type check below pins the provider's structural types to the real
 * @moonshine-ai/moonshine-wasm, which this repository installs as an optional
 * peer.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as Moonshine from '@moonshine-ai/moonshine-wasm';
import {
  MoonshineBrowserSTT,
  checkMoonshineBrowserSupport,
  chooseMoonshineModel,
  loadMoonshineWasm,
  readMoonshineDeviceSignals,
  type MoonshineBrowserSTTConfig,
  type MoonshineBrowserScope,
  type MoonshineDeviceSignals,
  type MoonshineLoadProgress,
  type MoonshineModelSize,
  type MoonshineWasmModule,
} from '../providers/MoonshineBrowserSTT.js';
import { StreamingSTTChain } from '../providers/StreamingSTTChain.js';
import { VoicePipelineError } from '../VoicePipelineError.js';
import type { StreamingSTTSession, TranscriptEvent } from '../types.js';
import { FakeStream, FakeTranscriber, FakeWorkerHost, fakeMoonshine, line } from './moonshine-fakes.js';

// Checked by the type check: the real package satisfies the structural type
// the provider accepts, so a host passes its import as it is.
type Expect<T extends true> = T;
type ModuleFits = Expect<typeof Moonshine extends MoonshineWasmModule ? true : false>;
const conformance: ModuleFits = true;

// Checked by the type check, for the docs: TypeScript 5.9's DOM lib declares
// WebAssembly.validate(bytes: BufferSource), with BufferSource =
// ArrayBufferView<ArrayBuffer> | ArrayBuffer, and a scope with that validate
// does not type as a MoonshineBrowserScope, so a host casts a page's globalThis.
type DomScope = { WebAssembly: { validate(bytes: ArrayBufferView<ArrayBuffer> | ArrayBuffer): boolean } };
type DomScopeNeedsCast = Expect<DomScope extends MoonshineBrowserScope ? false : true>;
const domScopeNeedsCast: DomScopeNeedsCast = true;

const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1';
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15';
const FIREFOX_ANDROID = 'Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0';
const ANDROID_WEBVIEW =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241005.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36';

describe('loadMoonshineWasm', () => {
  it('names the missing peer and how to install it, keeping the import error as the cause', async () => {
    const missing = Object.assign(new Error("Cannot find package '@moonshine-ai/moonshine-wasm'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    let failed: (Error & { cause?: unknown }) | undefined;
    try {
      await loadMoonshineWasm(async () => {
        throw missing;
      });
    } catch (err) {
      failed = err as Error & { cause?: unknown };
    }
    expect(failed?.message).toBe(
      '@moonshine-ai/moonshine-wasm is required for the Moonshine browser speech-to-text provider. Install it: npm install @moonshine-ai/moonshine-wasm'
    );
    expect(failed?.cause).toBe(missing);
  });

  it('names how to install the package when a page cannot resolve its bare specifier', async () => {
    const unresolved = new TypeError(
      'Failed to resolve module specifier \'@moonshine-ai/moonshine-wasm\'. Relative references must start with either "/", "./", or "../".'
    );
    let failed: (Error & { cause?: unknown }) | undefined;
    try {
      await loadMoonshineWasm(async () => {
        throw unresolved;
      });
    } catch (err) {
      failed = err as Error & { cause?: unknown };
    }
    expect(failed?.message).toBe(
      '@moonshine-ai/moonshine-wasm is required for the Moonshine browser speech-to-text provider. Install it: npm install @moonshine-ai/moonshine-wasm'
    );
    expect(failed?.cause).toBe(unresolved);
  });

  it("carries the import's own message when the import fails for another reason, keeping its error as the cause", async () => {
    const failures = [
      new TypeError('Failed to fetch dynamically imported module: https://cdn.example.com/moonshine/index.js'),
      // A CDN's URL names the package too, as part of the URL.
      new TypeError(
        'Failed to fetch dynamically imported module: https://cdn.example.com/npm/@moonshine-ai/moonshine-wasm@0.1.5/dist/index.js'
      ),
      new SyntaxError("Unexpected token '<'"),
    ];
    for (const failure of failures) {
      let failed: (Error & { cause?: unknown }) | undefined;
      try {
        await loadMoonshineWasm(async () => {
          throw failure;
        });
      } catch (err) {
        failed = err as Error & { cause?: unknown };
      }
      expect(failed?.message).toBe(
        `@moonshine-ai/moonshine-wasm could not be imported for the Moonshine browser speech-to-text provider: ${failure.message}`
      );
      expect(failed?.cause).toBe(failure);
    }
  });

  it('imports the package by its name', async () => {
    const asked: string[] = [];
    const module = { marker: true };
    const loaded = await loadMoonshineWasm(async (specifier) => {
      asked.push(specifier);
      return module;
    });
    expect(asked).toEqual(['@moonshine-ai/moonshine-wasm']);
    expect(loaded).toBe(module);
  });
});

describe('readMoonshineDeviceSignals', () => {
  const cases: Array<{ name: string; scope: MoonshineBrowserScope; signals: MoonshineDeviceSignals }> = [
    {
      name: 'Chrome on a desktop reports mobile false, its memory and its cores',
      scope: { navigator: { userAgent: CHROME_WINDOWS, userAgentData: { mobile: false }, deviceMemory: 8, hardwareConcurrency: 12 } },
      signals: { mobile: false, deviceMemoryGb: 8, logicalCores: 12 },
    },
    {
      name: 'Chrome on Android reports mobile true',
      scope: { navigator: { userAgent: CHROME_ANDROID, userAgentData: { mobile: true }, deviceMemory: 2, hardwareConcurrency: 8 } },
      signals: { mobile: true, deviceMemoryGb: 2, logicalCores: 8 },
    },
    {
      name: 'Safari on an iPhone has no userAgentData: its user agent names the phone',
      scope: { navigator: { userAgent: SAFARI_IPHONE, hardwareConcurrency: 4 } },
      signals: { mobile: true, logicalCores: 4 },
    },
    {
      name: 'Safari on a Mac',
      scope: { navigator: { userAgent: SAFARI_MAC, hardwareConcurrency: 8 } },
      signals: { mobile: false, logicalCores: 8 },
    },
    {
      name: 'Firefox on Android names Mobile in its user agent',
      scope: { navigator: { userAgent: FIREFOX_ANDROID, hardwareConcurrency: 8 } },
      signals: { mobile: true, logicalCores: 8 },
    },
    {
      name: "an Android WebView's userAgentData without mobile falls back to the user agent",
      scope: { navigator: { userAgent: ANDROID_WEBVIEW, userAgentData: {}, hardwareConcurrency: 8 } },
      signals: { mobile: true, logicalCores: 8 },
    },
    { name: 'a scope with no navigator', scope: {}, signals: { mobile: false } },
  ];
  for (const { name, scope, signals } of cases) {
    it(name, () => {
      expect(readMoonshineDeviceSignals(scope)).toEqual(signals);
    });
  }
});

describe('chooseMoonshineModel', () => {
  const cases: Array<[string, MoonshineDeviceSignals, MoonshineModelSize]> = [
    ['a laptop or desktop', { mobile: false }, 'moonshine-medium'],
    ['a desktop with memory and cores to spare', { mobile: false, deviceMemoryGb: 8, logicalCores: 12 }, 'moonshine-medium'],
    ['Safari on a Mac (cores clamped to 4 or 8, no memory figure)', { mobile: false, logicalCores: 4 }, 'moonshine-medium'],
    ['a desktop under 4 GB', { mobile: false, deviceMemoryGb: 2, logicalCores: 8 }, 'moonshine-small'],
    ['a desktop with 2 cores', { mobile: false, deviceMemoryGb: 8, logicalCores: 2 }, 'moonshine-small'],
    ['a phone', { mobile: true }, 'moonshine-small'],
    ['an iPhone (Safari reports 4 cores)', { mobile: true, logicalCores: 4 }, 'moonshine-small'],
    ['a phone with 4 GB', { mobile: true, deviceMemoryGb: 4, logicalCores: 8 }, 'moonshine-small'],
    ['a phone under 4 GB', { mobile: true, deviceMemoryGb: 2, logicalCores: 8 }, 'moonshine-tiny'],
  ];
  for (const [name, signals, model] of cases) {
    it(`picks ${model} for ${name}`, () => {
      expect(chooseMoonshineModel(signals)).toBe(model);
    });
  }
});

describe('checkMoonshineBrowserSupport', () => {
  /** A page's globals: a WebAssembly whose validate answers as told, window, document, Worker and URL. */
  function page(
    options: { isolated?: boolean; simd?: boolean; navigator?: MoonshineBrowserScope['navigator'] } = {}
  ): MoonshineBrowserScope {
    return {
      crossOriginIsolated: options.isolated ?? true,
      WebAssembly: { validate: () => options.simd ?? true },
      window: {},
      document: {},
      Worker: function Worker() {},
      URL,
      navigator: options.navigator ?? {
        userAgent: CHROME_WINDOWS,
        userAgentData: { mobile: false },
        deviceMemory: 8,
        hardwareConcurrency: 12,
      },
    };
  }

  it('supports a cross-origin isolated page with WebAssembly SIMD, in the package worker, at the device size', () => {
    expect(checkMoonshineBrowserSupport({ scope: page() })).toEqual({
      supported: true,
      missing: [],
      webAssemblySimd: true,
      crossOriginIsolated: true,
      thread: 'worker',
      model: 'moonshine-medium',
      signals: { mobile: false, deviceMemoryGb: 8, logicalCores: 12 },
    });
  });

  it('needs cross-origin isolation for the default build, and not for a single-thread build', () => {
    expect(checkMoonshineBrowserSupport({ scope: page({ isolated: false }) })).toMatchObject({
      supported: false,
      missing: ['cross-origin-isolation'],
      crossOriginIsolated: false,
    });
    expect(
      checkMoonshineBrowserSupport({ scope: page({ isolated: false }), singleThreadBuild: true })
    ).toMatchObject({ supported: true, missing: [] });
  });

  it('needs WebAssembly SIMD, whether validate refuses the probe, throws, or WebAssembly is missing', () => {
    expect(checkMoonshineBrowserSupport({ scope: page({ simd: false }) }).missing).toEqual(['webassembly-simd']);
    const throwing: MoonshineBrowserScope = {
      ...page(),
      WebAssembly: {
        validate: (): boolean => {
          throw new Error('not here');
        },
      },
    };
    expect(checkMoonshineBrowserSupport({ scope: throwing }).webAssemblySimd).toBe(false);
    const { WebAssembly: _absent, ...noWasm } = page();
    expect(checkMoonshineBrowserSupport({ scope: noWasm }).missing).toEqual(['webassembly-simd']);
  });

  it("has a SIMD probe that a real engine's WebAssembly.validate accepts", () => {
    const engine = (globalThis as unknown as { WebAssembly: { validate(bytes: Uint8Array): boolean } }).WebAssembly;
    expect(checkMoonshineBrowserSupport({ scope: { ...page(), WebAssembly: engine } }).webAssemblySimd).toBe(true);
  });

  it('runs on the calling thread where the scope cannot start the package worker, as inside a worker', () => {
    const { window: _window, document: _document, ...insideAWorker } = page();
    expect(checkMoonshineBrowserSupport({ scope: insideAWorker }).thread).toBe('calling');
  });

  it("picks the model for the scope's device", () => {
    const phone = page({ navigator: { userAgent: CHROME_ANDROID, userAgentData: { mobile: true }, deviceMemory: 2 } });
    expect(checkMoonshineBrowserSupport({ scope: phone }).model).toBe('moonshine-tiny');
  });
});

/** A mono frame of `ms` milliseconds at `sampleRate`. */
function frame(ms: number, sampleRate = 16_000) {
  return { samples: new Float32Array(Math.round((ms / 1000) * sampleRate)), sampleRate, timestamp: Date.now() };
}

/** Lets pending promise continuations and microtasks run. */
async function settle(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Collects what a session emits, in order. */
function record(session: StreamingSTTSession, options: { errorListener?: boolean } = {}) {
  const transcripts: TranscriptEvent[] = [];
  const errors: Error[] = [];
  const events: string[] = [];
  session.on('transcript', (event: TranscriptEvent) => {
    transcripts.push(event);
    events.push(`${event.isFinal ? 'final' : 'interim'} ${event.itemId} ${event.text}`);
  });
  if (options.errorListener !== false) {
    session.on('error', (err: Error) => {
      errors.push(err);
      events.push('error');
    });
  }
  session.on('close', () => events.push('close'));
  return { transcripts, errors, events };
}

/** The stream the newest session opened. */
function newestStream(): FakeStream {
  return FakeStream.created[FakeStream.created.length - 1];
}

/** How many sessions a provider holds: its private set, which a session leaves as it closes. */
function heldSessions(stt: MoonshineBrowserSTT): number {
  return (stt as unknown as { sessions: Set<unknown> }).sessions.size;
}

beforeEach(() => {
  FakeStream.created.length = 0;
  FakeTranscriber.loaded.length = 0;
  FakeWorkerHost.created.length = 0;
});

const THREADS: Array<'calling' | 'worker'> = ['calling', 'worker'];

for (const thread of THREADS) describe(`MoonshineBrowserSTT on the ${thread} thread`, () => {
  async function open(config: MoonshineBrowserSTTConfig = {}, options: { errorListener?: boolean } = {}) {
    const fake = fakeMoonshine();
    const stt = new MoonshineBrowserSTT({ moonshine: fake, thread, model: 'moonshine-small', ...config });
    const session = await stt.startSession();
    return { stt, session, stream: newestStream(), log: record(session, options) };
  }

  it('emits interim text keyed by the line id, then the final, with offsets on the session clock', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('101', 'Hello', 0.3, 0.4)]);
    stream.passes.push([line('101', 'Hello there', 0.3, 0.9)]);
    stream.passes.push([line('101', 'Hello there.', 0.3, 1.0, true)]);
    session.pushAudio(frame(500));
    session.pushAudio(frame(500));
    session.pushAudio(frame(500));
    await settle();
    const shared = { confidence: 1, words: [], itemId: '101', startMs: 300, language: 'en' };
    expect(log.transcripts).toEqual([
      { ...shared, text: 'Hello', isFinal: false, endMs: 700 },
      { ...shared, text: 'Hello there', isFinal: false, endMs: 1200 },
      { ...shared, text: 'Hello there.', isFinal: true, endMs: 1300, durationMs: 1000 },
    ]);
    session.close();
  });

  it('emits one interim for a pass that changes the text and updates the line, and none for a bare update', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('7', 'One', 0, 0.2)]);
    stream.passes.push([line('7', 'One two', 0, 0.5)]);
    stream.passes.push([line('7', 'One two', 0, 0.6)]);
    for (let i = 0; i < 3; i++) session.pushAudio(frame(500));
    await settle();
    expect(log.events).toEqual(['interim 7 One', 'interim 7 One two']);
    session.close();
  });

  it('keeps the interim text of two open lines apart', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('1', 'First', 0, 0.5), line('2', 'Sec', 0.6, 0.2)]);
    stream.passes.push([line('1', 'First line.', 0, 0.6, true), line('2', 'Second', 0.6, 0.4)]);
    session.pushAudio(frame(500));
    session.pushAudio(frame(500));
    await settle();
    expect(log.events).toEqual(['interim 1 First', 'interim 2 Sec', 'final 1 First line.', 'interim 2 Second']);
    session.close();
  });

  it('completes the open line on flush and starts again, placing later lines after the audio already pushed', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('a', 'Before', 0.2, 0.5)]);
    session.pushAudio(frame(1000));
    await settle();
    await session.flush();
    expect(stream.stops).toBe(1);
    expect(stream.starts).toBe(2);
    stream.passes.push([line('b', 'After', 0.1, 0.3)]);
    session.pushAudio(frame(500));
    await settle();
    expect(log.events).toEqual(['interim a Before', 'final a Before', 'interim b After']);
    expect(log.transcripts[1]).toMatchObject({ isFinal: true, startMs: 200, endMs: 700 });
    expect(log.transcripts[2]).toMatchObject({ startMs: 1100, endMs: 1400 });
    session.close();
  });

  it('holds the frames pushed during a flush and feeds them once the stream runs again', async () => {
    const { session, stream, log } = await open();
    session.pushAudio(frame(1000));
    const flushing = session.flush();
    session.pushAudio(frame(200));
    expect(stream.audio).toHaveLength(1);
    await flushing;
    expect(stream.audio).toHaveLength(2);
    stream.passes.push([line('c', 'Held', 0, 0.2)]);
    session.pushAudio(frame(100));
    await settle();
    expect(log.errors).toEqual([]);
    expect(log.transcripts[0]).toMatchObject({ itemId: 'c', startMs: 1000 });
    session.close();
  });

  it('retracts shown interim text with an empty final, and sends nothing for an empty line never shown', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('5', 'uh', 0, 0.2)]);
    stream.passes.push([line('5', '', 0, 0.3, true)]);
    stream.passes.push([line('6', '', 0.5, 0.1, true)]);
    for (let i = 0; i < 3; i++) session.pushAudio(frame(500));
    await settle();
    expect(log.events).toEqual(['interim 5 uh', 'final 5 ']);
    session.close();
  });

  it('closes at once with no last pass: an empty final retracts the open line, one close, and later frames dropped', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('d', 'Open line', 0, 0.4)]);
    session.pushAudio(frame(500));
    await settle();
    session.close();
    session.close();
    session.pushAudio(frame(100));
    await settle();
    expect(log.events).toEqual(['interim d Open line', 'final d ', 'close']);
    expect(log.transcripts[1]).toMatchObject({ text: '', isFinal: true, itemId: 'd', startMs: 0, endMs: 400 });
    expect(stream.stops).toBe(0);
    expect(stream.closed).toBe(true);
    expect(stream.audio).toHaveLength(1);
  });

  it('turns a failed pass into an error and then close, and pushAudio does not throw', async () => {
    const { session, stream, log } = await open();
    stream.failNextPass = new Error('ORT run failed: out of memory');
    expect(() => session.pushAudio(frame(100))).not.toThrow();
    await settle();
    expect(log.events).toEqual(['error', 'close']);
    expect(log.errors[0]).toBeInstanceOf(VoicePipelineError);
    expect(log.errors[0]).toMatchObject({
      kind: 'stt',
      provider: 'moonshine-browser',
      message: 'ORT run failed: out of memory',
    });
  });

  it('logs a failure that no error listener takes, and still closes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { session, stream, log } = await open({}, { errorListener: false });
    stream.failNextPass = new Error('boom');
    session.pushAudio(frame(100));
    await settle();
    expect(log.events).toEqual(['close']);
    expect(warn).toHaveBeenCalledWith('[moonshine-browser-stt] error (no listener attached):', 'boom');
    warn.mockRestore();
  });

  it('finishes closing when a listener throws on its last events: every listener still hears them, and each throw is warned of', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stt, session, stream, log } = await open();
    stream.passes.push([line('e', 'Open line', 0, 0.4)]);
    session.pushAudio(frame(500));
    await settle();
    session.prependListener('transcript', () => {
      throw new Error('display gone');
    });
    session.prependListener('close', () => {
      throw new Error('cleanup failed');
    });
    expect(() => session.close()).not.toThrow();
    expect(log.events).toEqual(['interim e Open line', 'final e ', 'close']);
    expect(stream.closed).toBe(true);
    expect(heldSessions(stt)).toBe(0);
    expect(warn.mock.calls).toEqual([
      ["[moonshine-browser-stt] a listener of 'transcript' threw:", 'display gone'],
      ["[moonshine-browser-stt] a listener of 'close' threw:", 'cleanup failed'],
    ]);
    warn.mockRestore();
  });

  it("ends on a failure though an 'error' listener throws: the error, the open line retracted, then close", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { stt, session, stream, log } = await open();
    stream.passes.push([line('f', 'Half a', 0, 0.3)]);
    session.pushAudio(frame(500));
    await settle();
    session.prependListener('error', () => {
      throw new Error('handler failed');
    });
    stream.failNextPass = new Error('ORT run failed: out of memory');
    expect(() => session.pushAudio(frame(100))).not.toThrow();
    await settle();
    expect(log.events).toEqual(['interim f Half a', 'error', 'final f ', 'close']);
    expect(stream.closed).toBe(true);
    expect(heldSessions(stt)).toBe(0);
    expect(warn.mock.calls).toEqual([["[moonshine-browser-stt] a listener of 'error' threw:", 'handler failed']]);
    warn.mockRestore();
  });

  it('completes a line once when a transcript listener flushes in the middle of a pass, and a flush from its final shares that flush', async () => {
    const { session, stream, log } = await open();
    stream.passes.push([line('g', 'Is it', 0, 0.3)]);
    stream.passes.push([line('g', 'Is it done?', 0, 0.6)]);
    const flushes: Array<Promise<void>> = [];
    // A listener that completes a line once it reads as a question, and asks again on the final.
    session.on('transcript', (event: TranscriptEvent) => {
      if (event.isFinal || event.text.endsWith('?')) flushes.push(session.flush());
    });
    session.pushAudio(frame(500));
    session.pushAudio(frame(500));
    await settle();
    await Promise.all(flushes);
    session.close();
    expect(log.events).toEqual(['interim g Is it', 'interim g Is it done?', 'final g Is it done?', 'close']);
    expect(stream.stops).toBe(1);
    expect(stream.starts).toBe(2);
  });

  it('takes the confidence from the timed words, and their offsets from the line start', async () => {
    const { session, stream, log } = await open();
    const words = [
      { text: 'Hello', start: 1.2, end: 1.5, confidence: 0.8 },
      { text: 'there', start: 1.6, end: 1.9, confidence: 0.6 },
    ];
    stream.passes.push([line('w', 'Hello there', 1.2, 0.7, true, words)]);
    session.pushAudio(frame(500));
    await settle();
    expect(log.transcripts[0].words).toEqual([
      { word: 'Hello', start: 0, end: 300, confidence: 0.8 },
      { word: 'there', start: 400, end: 700, confidence: 0.6 },
    ]);
    expect(log.transcripts[0].confidence).toBeCloseTo(0.7);
    session.close();
  });
});

describe('MoonshineBrowserSTT: the model, its loading and the provider', () => {
  it('loads once, and every session is a stream on the one model', async () => {
    const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), thread: 'calling', model: 'moonshine-small' });
    const [a, b] = await Promise.all([stt.startSession(), stt.startSession()]);
    expect(FakeTranscriber.loaded).toHaveLength(1);
    expect(FakeTranscriber.loaded[0].streams).toHaveLength(2);
    a.close();
    b.close();
  });

  it('runs in the package worker in a page, and on the calling thread elsewhere', async () => {
    const inPage = new MoonshineBrowserSTT({ moonshine: fakeMoonshine({ workerSupported: true }), model: 'moonshine-small' });
    await inPage.load();
    expect(inPage.thread).toBe('worker');
    expect(FakeWorkerHost.created).toHaveLength(1);
    const inWorker = new MoonshineBrowserSTT({ moonshine: fakeMoonshine({ workerSupported: false }), model: 'moonshine-small' });
    await inWorker.load();
    expect(inWorker.thread).toBe('calling');
    expect(FakeWorkerHost.created).toHaveLength(1);
    inPage.dispose();
    inWorker.dispose();
  });

  it('picks the size by device for auto, and loads its architecture', async () => {
    const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), device: { mobile: true, deviceMemoryGb: 2 } });
    expect(stt.model).toBe('moonshine-tiny');
    await stt.load();
    expect(FakeWorkerHost.created[0].loads[0]).toMatchObject({ modelArch: 2, source: { kind: 'catalog', language: 'en' } });
    stt.dispose();
  });

  it("loads from the package's CDN by default, and from the host's folder with modelBaseUrl", async () => {
    const cdn = new MoonshineBrowserSTT({ moonshine: fakeMoonshine({ workerSupported: false }), model: 'moonshine-small' });
    await cdn.load();
    expect(FakeTranscriber.loaded[0].source).toEqual({ kind: 'catalog', language: 'en' });
    const own = new MoonshineBrowserSTT({
      moonshine: async () => fakeMoonshine({ workerSupported: false }),
      model: 'moonshine-medium',
      modelBaseUrl: 'https://models.example.test/moonshine/',
    });
    await own.load();
    const folder = 'https://models.example.test/moonshine/medium-streaming-en';
    expect(FakeTranscriber.loaded[1].source).toEqual({
      kind: 'urls',
      files: {
        'adapter.ort': `${folder}/adapter.ort`,
        'cross_kv.ort': `${folder}/cross_kv.ort`,
        'decoder_kv.ort': `${folder}/decoder_kv.ort`,
        'encoder.ort': `${folder}/encoder.ort`,
        'frontend.ort': `${folder}/frontend.ort`,
        'streaming_config.json': `${folder}/streaming_config.json`,
        'tokenizer.bin': `${folder}/tokenizer.bin`,
      },
    });
    expect(FakeTranscriber.loaded[1].options.modelArch).toBe(5);
    cdn.dispose();
    own.dispose();
  });

  it('passes the key terms and the context as transcriber options, and refuses a term with a comma', async () => {
    const stt = new MoonshineBrowserSTT({
      moonshine: fakeMoonshine(),
      model: 'moonshine-small',
      keyterms: ['Anushka Sharma', 'Kubernetes'],
      context: 'Team offsite in Lisbon',
      contextMaxTerms: 50,
    });
    await stt.load();
    expect(FakeWorkerHost.created[0].loads[0].options).toEqual({
      keyterms: 'Anushka Sharma,Kubernetes',
      context: 'Team offsite in Lisbon',
      context_max_terms: '50',
    });
    expect(() => new MoonshineBrowserSTT({ keyterms: ['Smith, John'] })).toThrow(RangeError);
    stt.dispose();
  });

  it("reports progress with a fraction from the package's total, or from modelBytes for the host's files", async () => {
    const seen: MoonshineLoadProgress[] = [];
    const cdnFake = fakeMoonshine();
    cdnFake.progress = [
      [100, 400, 'encoder.ort'],
      [400, 400, 'decoder_kv.ort'],
    ];
    const cdn = new MoonshineBrowserSTT({ moonshine: cdnFake, model: 'moonshine-tiny', onProgress: (p) => seen.push(p) });
    await cdn.load();
    expect(seen).toEqual([
      { model: 'moonshine-tiny', loaded: 100, total: 400, fraction: 0.25, file: 'encoder.ort' },
      { model: 'moonshine-tiny', loaded: 400, total: 400, fraction: 1, file: 'decoder_kv.ort' },
    ]);
    seen.length = 0;
    const ownFake = fakeMoonshine();
    ownFake.progress = [[150, undefined, 'encoder.ort']];
    const own = new MoonshineBrowserSTT({
      moonshine: ownFake,
      model: 'moonshine-medium',
      modelBaseUrl: 'https://models.example.test',
      modelBytes: { 'moonshine-medium': 600 },
      onProgress: (p) => seen.push(p),
    });
    await own.load();
    expect(seen).toEqual([{ model: 'moonshine-medium', loaded: 150, total: 600, fraction: 0.25, file: 'encoder.ort' }]);
    seen.length = 0;
    const unsizedFake = fakeMoonshine();
    unsizedFake.progress = [[150, undefined, 'encoder.ort']];
    const unsized = new MoonshineBrowserSTT({
      moonshine: unsizedFake,
      model: 'moonshine-medium',
      modelBaseUrl: 'https://models.example.test',
      onProgress: (p) => seen.push(p),
    });
    await unsized.load();
    expect(seen).toEqual([{ model: 'moonshine-medium', loaded: 150, file: 'encoder.ort' }]);
    cdn.dispose();
    own.dispose();
    unsized.dispose();
  });

  it('refuses a session in a language the model does not stream, and takes a region of its own', async () => {
    const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), model: 'moonshine-small' });
    await expect(stt.startSession({ language: 'fr-FR' })).rejects.toThrow(/the model is for "en"/);
    const session = await stt.startSession({ language: 'en-US' });
    session.close();
    stt.dispose();
  });

  it('rejects the start when the model cannot load, releases the worker, and loads again on the next call', async () => {
    const fake = fakeMoonshine();
    fake.failLoad = new Error('Failed to download https://download.moonshine.ai/model/small-streaming-en/encoder.ort: 503');
    const stt = new MoonshineBrowserSTT({ moonshine: fake, model: 'moonshine-small' });
    await expect(stt.startSession()).rejects.toThrow(/503/);
    expect(FakeWorkerHost.created[0].closed).toBe(true);
    const session = await stt.startSession();
    expect(FakeWorkerHost.created).toHaveLength(2);
    session.close();
    stt.dispose();
  });

  it('lets a chain fall back to a smaller size when the larger one cannot load', async () => {
    const mediumFake = fakeMoonshine();
    mediumFake.failLoad = new Error('Out of memory while building the model');
    const chain = new StreamingSTTChain([
      new MoonshineBrowserSTT({ moonshine: mediumFake, model: 'moonshine-medium', priority: 0 }),
      new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), model: 'moonshine-small', priority: 1 }),
    ]);
    const session = await chain.startSession();
    expect(FakeWorkerHost.created).toHaveLength(2);
    expect(FakeWorkerHost.created[0].closed).toBe(true);
    expect(FakeWorkerHost.created[1].loads[0].modelArch).toBe(4);
    expect(FakeWorkerHost.created[1].streams.size).toBe(1);
    session.close();
  });

  it('closes its open sessions on dispose, releases the model, and opens no more', async () => {
    const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), model: 'moonshine-small' });
    const session = await stt.startSession();
    const log = record(session);
    stt.dispose();
    expect(log.events).toEqual(['close']);
    expect(FakeWorkerHost.created[0].closed).toBe(true);
    await expect(stt.startSession()).rejects.toThrow(/disposed/);
  });

  for (const thread of THREADS) {
    it(`rejects the start as disposed and closes its stream when dispose lands as the stream opens, on the ${thread} thread`, async () => {
      const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), thread, model: 'moonshine-small' });
      const starting = stt.startSession();
      // Lands once the model has loaded, before the stream starts.
      void stt.load().then(() => stt.dispose());
      await expect(starting).rejects.toThrow('MoonshineBrowserSTT: disposed');
      expect(newestStream().closed).toBe(true);
      expect(heldSessions(stt)).toBe(0);
    });
  }

  it("gives wasmBaseUrl one trailing slash, as the package's worker resolves its files against it", async () => {
    for (const wasmBaseUrl of [
      'https://cdn.example.com/moonshine/dist',
      'https://cdn.example.com/moonshine/dist/',
      'https://cdn.example.com/moonshine/dist//',
    ]) {
      const stt = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), model: 'moonshine-small', wasmBaseUrl });
      await stt.load();
      stt.dispose();
    }
    const packageFolder = new MoonshineBrowserSTT({ moonshine: fakeMoonshine(), model: 'moonshine-small' });
    await packageFolder.load();
    packageFolder.dispose();
    expect(FakeWorkerHost.created.map((host) => host.wasmBaseUrl)).toEqual([
      'https://cdn.example.com/moonshine/dist/',
      'https://cdn.example.com/moonshine/dist/',
      'https://cdn.example.com/moonshine/dist/',
      undefined,
    ]);
  });

  it('reports in its health check what this scope lacks, and nothing once a single-thread build is served', async () => {
    // Node 22 has WebAssembly SIMD and no cross-origin isolation.
    expect(await new MoonshineBrowserSTT().healthCheck()).toEqual({
      ok: false,
      latencyMs: 0,
      error: { class: 'unknown', message: 'MoonshineBrowserSTT: this page lacks cross-origin-isolation' },
    });
    expect(await new MoonshineBrowserSTT({ singleThreadBuild: true }).healthCheck()).toEqual({ ok: true, latencyMs: 0 });
  });
});
