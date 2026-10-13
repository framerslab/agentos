/**
 * @module voice-pipeline/providers/MoonshineBrowserSTT
 *
 * On-device streaming speech-to-text in the browser: Moonshine's streaming
 * models (MIT) run on the person's own processor through
 * `@moonshine-ai/moonshine-wasm`, so the audio stays on the device and no
 * service is paid per hour. {@link MoonshineBrowserSTT} implements
 * {@link IStreamingSTT} and {@link HealthyProvider}; this module imports no
 * Node built-in and is exported from `@framers/agentos/io/voice-pipeline/browser`.
 *
 * ## The package
 *
 * `@moonshine-ai/moonshine-wasm` is an optional peer dependency. The host
 * passes it (the module, or a function that imports it), or
 * {@link loadMoonshineWasm} imports it on first use. The package starts its
 * worker and loads its WebAssembly from files beside its own module, so a
 * page serves the package's `dist` folder whole and imports it from there.
 * The structural types below describe the parts this module uses, so neither
 * this module's typings nor a consumer's type check need the package.
 *
 * - **Where the model runs:** in the package's own Web Worker
 *   (`SttWorkerHost`) when the page can start one, so a transcription pass
 *   never blocks the page; on the calling thread (`Transcriber` and `Stream`)
 *   inside a worker, or when the host asks for it.
 * - **The model:** Moonshine streaming Medium, Small or Tiny, or `auto`,
 *   which {@link chooseMoonshineModel} picks for the device. The files come
 *   from the package's CDN, or from the host's own copy; the browser caches
 *   them with the Cache API.
 * - **What a page needs:** WebAssembly SIMD, and cross-origin isolation for
 *   the package's default build (SIMD with threads), or a single-thread build
 *   of the package. {@link checkMoonshineBrowserSupport} reports both before a
 *   host chooses the provider.
 *
 * ## Event mapping
 *
 * - a line's first text, and each change to it while it is open →
 *   `'transcript'` with `isFinal: false`
 * - a completed line → `'transcript'` with `isFinal: true`
 * - every event carries `itemId` (Moonshine's line id, a decimal string),
 *   `startMs` and `endMs` on the session's audio clock, and `language`
 * - a line still open when the session ends (`close()`, a failure or
 *   `dispose()`) → an empty final, which retracts its interim text
 * - a transcription failure → `'error'` (when a listener exists), then `'close'`
 */

/** The optional peer this module runs on. */
const MOONSHINE_WASM = '@moonshine-ai/moonshine-wasm';

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A Moonshine streaming model size. */
export type MoonshineModelSize = 'moonshine-medium' | 'moonshine-small' | 'moonshine-tiny';

/** A model size, or `'auto'` for the size {@link chooseMoonshineModel} picks for the device. */
export type MoonshineModelChoice = MoonshineModelSize | 'auto';

/**
 * The files of one streaming model in the build `@moonshine-ai/moonshine-wasm`
 * 0.1.5 loads (the CDN's `quantized_26_07_30` folders). A host that serves the
 * files itself puts these in each model's folder; a later build of the
 * package can name other files, passed as `modelFileNames`.
 */
export const MOONSHINE_STREAMING_MODEL_FILES: readonly string[] = [
  'adapter.ort',
  'cross_kv.ort',
  'decoder_kv.ort',
  'encoder.ort',
  'frontend.ort',
  'streaming_config.json',
  'tokenizer.bin',
];

// ---------------------------------------------------------------------------
// The parts of @moonshine-ai/moonshine-wasm this module uses
// ---------------------------------------------------------------------------

/** A word with its timing (`WordTiming`), in seconds from the start of the stream. */
export interface MoonshineWordLike {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly confidence: number;
}

/** One line of a transcript (`TranscriptLine`): a phrase or a sentence. */
export interface MoonshineLineLike {
  /** Opaque 64-bit id as a decimal string, unique within a transcriber. */
  readonly id: string;
  readonly text: string;
  /** Seconds from the start of the stream's current run. */
  readonly startTime: number;
  /** Seconds. */
  readonly duration: number;
  readonly isComplete: boolean;
  /** Filled when the transcriber was loaded with word timestamps. */
  readonly words: readonly MoonshineWordLike[];
}

/** A line event (`LineStarted`, `LineTextChanged`, `LineUpdated` or `LineCompleted`). */
export interface MoonshineLineEvent {
  readonly line: MoonshineLineLike;
}

/** A transcript listener (`TranscriptEventListener`); every callback is optional. */
export interface MoonshineLineListener {
  onLineStarted?(event: MoonshineLineEvent): void;
  onLineUpdated?(event: MoonshineLineEvent): void;
  onLineTextChanged?(event: MoonshineLineEvent): void;
  onLineCompleted?(event: MoonshineLineEvent): void;
  onError?(event: { readonly error: Error }): void;
}

/** A streaming session on a transcriber (`Stream`). */
export interface MoonshineStreamLike {
  addListener(listener: MoonshineLineListener): void;
  start(): void;
  stop(): void;
  addAudio(audio: Float32Array, sampleRate: number, flags?: number): void;
  transcribe(flags?: number): unknown;
  close(): void;
}

/** A loaded model (`Transcriber`). */
export interface MoonshineTranscriberLike {
  createStream(options?: { flags?: number; updateInterval?: number }): MoonshineStreamLike;
  close(): void;
}

/**
 * Download progress as the package reports it: the bytes fetched so far
 * across the model's files, the model's size when known, and the file in
 * flight.
 */
export type MoonshineProgressReport = (loaded: number, total: number | undefined, file: string) => void;

/** The options of `Transcriber.load` and `Transcriber.loadFromUrls` this module sets. */
export interface MoonshineLoadOptionsLike {
  modelArch?: number;
  onProgress?: MoonshineProgressReport;
  /** Native transcriber options (`keyterms`, `context`, `context_max_terms`). */
  options?: Record<string, string>;
}

/** Where the package's worker loads a model from (`SttLoadSource`). */
export type MoonshineModelSource =
  | { kind: 'urls'; files: Record<string, string> }
  | { kind: 'catalog'; language: string };

/** The package's worker host (`SttWorkerHost`): a transcriber and its streams in a module Web Worker. */
export interface MoonshineWorkerHostLike {
  onProgress?: (transcriberId: string, loaded: number, total: number | undefined, file: string) => void;
  loadTranscriber(config: {
    transcriberId: string;
    modelArch: number;
    options?: Record<string, string>;
    source: MoonshineModelSource;
  }): Promise<void>;
  createStream(
    transcriberId: string,
    streamId: string,
    options?: { flags?: number; updateInterval?: number }
  ): Promise<void>;
  setListener(streamId: string, listener: MoonshineLineListener): void;
  start(streamId: string): Promise<void>;
  addAudio(streamId: string, audio: Float32Array, sampleRate: number): void;
  stop(streamId: string): Promise<void>;
  closeStream(streamId: string): Promise<void>;
  close(): void;
}

/** The parts of the `@moonshine-ai/moonshine-wasm` module this library uses. */
export interface MoonshineWasmModule {
  readonly ModelArch: {
    readonly TinyStreaming: number;
    readonly SmallStreaming: number;
    readonly MediumStreaming: number;
  };
  readonly Transcriber: {
    load(options: MoonshineLoadOptionsLike & { language: string }): Promise<MoonshineTranscriberLike>;
    loadFromUrls(files: Record<string, string>, options?: MoonshineLoadOptionsLike): Promise<MoonshineTranscriberLike>;
  };
  readonly SttWorkerHost: new (wasmBaseUrl?: string) => MoonshineWorkerHostLike;
  sttWorkerSupported(): boolean;
}

/**
 * Loads `@moonshine-ai/moonshine-wasm`, the optional peer the Moonshine
 * browser provider runs on, by a dynamic import of a variable specifier, so a
 * build without the package succeeds and a bundler leaves the import as it
 * is. A bare specifier resolves in Node and on a page with an import map; a
 * bundled page passes the provider's `moonshine` option instead.
 *
 * @param importer - How to import a module; the default is a dynamic `import()`.
 * @returns The module.
 * @throws {Error} Naming the package and how to install it when the import
 *   fails; the import's own error is its `cause`.
 */
export async function loadMoonshineWasm(
  importer: (specifier: string) => Promise<unknown> = (specifier) =>
    import(/* webpackIgnore: true */ /* @vite-ignore */ specifier)
): Promise<MoonshineWasmModule> {
  try {
    return (await importer(MOONSHINE_WASM)) as MoonshineWasmModule;
  } catch (err) {
    throw Object.assign(
      new Error(
        `${MOONSHINE_WASM} is required for the Moonshine browser speech-to-text provider. Install it: npm install ${MOONSHINE_WASM}`
      ),
      { cause: err }
    );
  }
}

// ---------------------------------------------------------------------------
// The device, the model it runs, and what the page offers
// ---------------------------------------------------------------------------

/**
 * The globals the capability check and the device signals read, as a
 * structural type, so they can be read from any scope (a page, a worker, a
 * test) and the library needs no DOM typings.
 */
export interface MoonshineBrowserScope {
  readonly navigator?: {
    readonly userAgent?: string;
    readonly hardwareConcurrency?: number;
    readonly deviceMemory?: number;
    readonly userAgentData?: { readonly mobile?: boolean };
  };
  readonly crossOriginIsolated?: boolean;
  readonly WebAssembly?: { validate(bytes: Uint8Array): boolean };
  readonly window?: unknown;
  readonly document?: unknown;
  readonly Worker?: unknown;
  readonly URL?: unknown;
}

/** What {@link chooseMoonshineModel} decides by. */
export interface MoonshineDeviceSignals {
  /**
   * A phone: `navigator.userAgentData.mobile` where the browser has it
   * (Chromium), otherwise a user agent that names one (`Mobi`, `Android`,
   * `iPhone` or `iPod`).
   */
  mobile: boolean;
  /** `navigator.deviceMemory` in gigabytes, as the browser rounds it (Chromium only). */
  deviceMemoryGb?: number;
  /** `navigator.hardwareConcurrency`; Safari reports 4 or 8 whatever the device has. */
  logicalCores?: number;
}

/** Reads {@link MoonshineDeviceSignals} from a scope (the global scope by default). */
export function readMoonshineDeviceSignals(
  scope: MoonshineBrowserScope = globalThis as unknown as MoonshineBrowserScope
): MoonshineDeviceSignals {
  const navigator = scope.navigator;
  const reported = navigator?.userAgentData?.mobile;
  const mobile =
    typeof reported === 'boolean' ? reported : /Mobi|Android|iPhone|iPod/i.test(navigator?.userAgent ?? '');
  const signals: MoonshineDeviceSignals = { mobile };
  const memory = navigator?.deviceMemory;
  if (typeof memory === 'number' && memory > 0) signals.deviceMemoryGb = memory;
  const cores = navigator?.hardwareConcurrency;
  if (typeof cores === 'number' && cores > 0) signals.logicalCores = cores;
  return signals;
}

/**
 * The model size for a device: Medium on a laptop or desktop, Small on a
 * phone, each one size down when the browser reports under 4 GB of memory or,
 * on a laptop or desktop, fewer than 4 logical cores. A signal the browser
 * does not report counts as no constraint.
 */
export function chooseMoonshineModel(signals: MoonshineDeviceSignals): MoonshineModelSize {
  const lowMemory = signals.deviceMemoryGb !== undefined && signals.deviceMemoryGb < 4;
  if (signals.mobile) return lowMemory ? 'moonshine-tiny' : 'moonshine-small';
  const fewCores = signals.logicalCores !== undefined && signals.logicalCores < 4;
  return lowMemory || fewCores ? 'moonshine-small' : 'moonshine-medium';
}

/**
 * A WebAssembly module whose one function uses SIMD (`i32.const 0`,
 * `i8x16.splat`, `i8x16.popcnt`): `WebAssembly.validate` accepts it only where
 * fixed-width SIMD is supported. The bytes are wasm-feature-detect 1.9.0's
 * SIMD probe.
 */
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** A requirement the device or the page does not meet. */
export type MoonshineBrowserRequirement = 'webassembly-simd' | 'cross-origin-isolation';

/** What {@link checkMoonshineBrowserSupport} found. */
export interface MoonshineBrowserSupport {
  /** `true` when the provider can run here. */
  supported: boolean;
  /** The requirements not met; empty when supported. */
  missing: MoonshineBrowserRequirement[];
  /** WebAssembly validates a module that uses SIMD. */
  webAssemblySimd: boolean;
  /** The scope is cross-origin isolated (`crossOriginIsolated`), so `SharedArrayBuffer` and threads exist. */
  crossOriginIsolated: boolean;
  /** Where the model would run: the package's worker in a page, the calling thread elsewhere. */
  thread: 'worker' | 'calling';
  /** The size `auto` picks here. */
  model: MoonshineModelSize;
  /** The signals the size was picked by. */
  signals: MoonshineDeviceSignals;
}

/** Options of {@link checkMoonshineBrowserSupport}. */
export interface MoonshineBrowserSupportOptions {
  /** The page serves a single-thread build of the package, which needs no cross-origin isolation. */
  singleThreadBuild?: boolean;
  /** The scope to read; the global scope by default. */
  scope?: MoonshineBrowserScope;
}

/**
 * Whether the Moonshine browser provider can run in this page or worker,
 * read before choosing it. The package's default build needs WebAssembly
 * SIMD and threads, and threads need cross-origin isolation (the page served
 * with `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp`); a single-thread build needs
 * SIMD only. Every engine with WebAssembly SIMD has WebAssembly threads
 * (Chrome 91 and 74, Firefox 89 and 79, Safari 16.4 and 15.2), so SIMD and
 * isolation stand for both. It loads no package and reads no network.
 */
export function checkMoonshineBrowserSupport(options: MoonshineBrowserSupportOptions = {}): MoonshineBrowserSupport {
  const scope = options.scope ?? (globalThis as unknown as MoonshineBrowserScope);
  let webAssemblySimd = false;
  try {
    webAssemblySimd = scope.WebAssembly?.validate(SIMD_PROBE) === true;
  } catch {
    webAssemblySimd = false;
  }
  const crossOriginIsolated = scope.crossOriginIsolated === true;
  const missing: MoonshineBrowserRequirement[] = [];
  if (!webAssemblySimd) missing.push('webassembly-simd');
  if (!crossOriginIsolated && !options.singleThreadBuild) missing.push('cross-origin-isolation');
  const signals = readMoonshineDeviceSignals(scope);
  return {
    supported: missing.length === 0,
    missing,
    webAssemblySimd,
    crossOriginIsolated,
    thread: pageCanStartWorker(scope) ? 'worker' : 'calling',
    model: chooseMoonshineModel(signals),
    signals,
  };
}

/** The package's own rule for its worker host (`sttWorkerSupported()`): a page that has Web Workers. */
function pageCanStartWorker(scope: MoonshineBrowserScope): boolean {
  return (
    typeof scope.window !== 'undefined' &&
    typeof scope.document !== 'undefined' &&
    typeof scope.Worker !== 'undefined' &&
    typeof scope.URL !== 'undefined'
  );
}
