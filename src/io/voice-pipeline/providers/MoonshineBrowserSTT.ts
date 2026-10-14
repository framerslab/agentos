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

import { VoiceEventEmitter } from '../VoiceEventEmitter.js';
import type {
  AudioFrame,
  IStreamingSTT,
  StreamingSTTConfig,
  StreamingSTTSession,
  TranscriptEvent,
  TranscriptWord,
} from '../types.js';
import {
  defaultCapabilities,
  type HealthCheckResult,
  type HealthyProvider,
  type ProviderCapabilities,
} from '../HealthyProvider.js';
import { VoicePipelineError } from '../VoicePipelineError.js';

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

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Download progress of the model, for a progress bar. */
export interface MoonshineLoadProgress {
  /** The size being loaded. */
  model: MoonshineModelSize;
  /** Bytes fetched so far across the model's files; a file the browser had cached counts at once. */
  loaded: number;
  /**
   * The model's size in bytes: from the package's manifest for its CDN, from
   * `modelBytes` for the host's own files; absent when neither gives it.
   */
  total?: number;
  /** `loaded / total`, at most 1, when `total` is known. */
  fraction?: number;
  /** The file in flight. */
  file: string;
}

/** Configuration of {@link MoonshineBrowserSTT}. */
export interface MoonshineBrowserSTTConfig {
  /** The model size, or `'auto'` to pick it by device. @defaultValue 'auto' */
  model?: MoonshineModelChoice;
  /** The language of the model and its transcripts; Moonshine streams English in every size. @defaultValue 'en' */
  language?: string;
  /**
   * The base URL of the host's own copy of the model files, each size's at
   * `<modelBaseUrl>/<size>-streaming-<language>/<file>` (for example
   * `https://models.example.com/moonshine/medium-streaming-en/encoder.ort`).
   * When omitted, the package fetches them from its CDN.
   */
  modelBaseUrl?: string;
  /** The files in each model folder under `modelBaseUrl`. @defaultValue {@link MOONSHINE_STREAMING_MODEL_FILES} */
  modelFileNames?: readonly string[];
  /** Each size's total bytes under `modelBaseUrl`, so progress has a total and a fraction. */
  modelBytes?: Partial<Record<MoonshineModelSize, number>>;
  /** Terms to bias the transcription towards (names, jargon); no term may contain a comma. */
  keyterms?: readonly string[];
  /** A passage (titles, keywords) whose unusual words become key terms. */
  context?: string;
  /** The most terms taken from `context`. @defaultValue the package's 200 */
  contextMaxTerms?: number;
  /** Called as the model downloads. */
  onProgress?: (progress: MoonshineLoadProgress) => void;
  /** Where the model runs: the package's worker, the calling thread, or `'auto'` (the worker in a page). @defaultValue 'auto' */
  thread?: 'auto' | 'worker' | 'calling';
  /** Where the package's worker finds `moonshine.wasm`; the package's own folder when omitted. */
  wasmBaseUrl?: string;
  /** The page serves a single-thread build of the package, which needs no cross-origin isolation; `healthCheck()` reads it. */
  singleThreadBuild?: boolean;
  /**
   * The package, or a function that imports it. The package starts its
   * worker and loads its WebAssembly from files beside its own module, so a
   * page serves the package's `dist` folder whole and passes a function that
   * imports that folder's `index.js` by its URL, marked for the bundler to
   * leave as it is; when omitted, {@link loadMoonshineWasm} imports the
   * package by its name.
   */
  moonshine?: MoonshineWasmModule | (() => Promise<MoonshineWasmModule>);
  /** The signals `'auto'` picks by; read from the global scope when omitted. */
  device?: MoonshineDeviceSignals;
  /** The chain priority; lower is tried first. @defaultValue 0 */
  priority?: number;
}

// ---------------------------------------------------------------------------
// The provider
// ---------------------------------------------------------------------------

/** A model loaded in the package's worker, or on the calling thread. */
type LoadedModel =
  | { thread: 'worker'; model: MoonshineModelSize; host: MoonshineWorkerHostLike }
  | { thread: 'calling'; model: MoonshineModelSize; transcriber: MoonshineTranscriberLike };

/** What a session drives: one stream, in the package's worker or on the calling thread. */
interface MoonshineEngine {
  /** Starts the stream, or starts it again after `stop()`; a run's line times start at 0. */
  start(): Promise<void>;
  /** Feeds audio; throws when the stream refuses it. */
  addAudio(samples: Float32Array, sampleRate: number): void;
  /** Stops the stream: a last pass completes every open line, whose events arrive before this resolves. */
  stop(): Promise<void>;
  /** Closes the stream with no last pass. */
  close(): void;
}

/** The transcriber's id in the package's worker; a provider loads one. */
const TRANSCRIBER_ID = 'moonshine';

/** Each size's folder name, as the package's CDN names them (`<size>-streaming-<language>`). */
const SIZE_FOLDER: Record<MoonshineModelSize, string> = {
  'moonshine-tiny': 'tiny',
  'moonshine-small': 'small',
  'moonshine-medium': 'medium',
};

/**
 * On-device streaming speech-to-text in the browser with Moonshine (see the
 * module notes). One provider loads one model, once; every session is a
 * stream on it.
 *
 * @example
 * ```typescript
 * if (checkMoonshineBrowserSupport().supported) {
 *   const stt = new MoonshineBrowserSTT({
 *     moonshine: importServedMoonshine, // imports index.js from the package's dist folder, served whole
 *     context: noteTitles.join('\n'),
 *     onProgress: ({ fraction }) => showProgress(fraction),
 *   });
 *   await stt.load(); // downloads once; the browser caches the files
 *   const session = await stt.startSession();
 *   session.on('transcript', (event) => showLine(event.itemId, event.text, event.isFinal));
 *   session.pushAudio(frame); // mono Float32 at any sample rate
 *   await session.flush(); // completes the open line
 *   session.close();
 * }
 * ```
 */
export class MoonshineBrowserSTT implements IStreamingSTT, HealthyProvider {
  readonly providerId = 'moonshine-browser';
  readonly isStreaming = true;
  readonly priority: number;
  readonly capabilities: ProviderCapabilities;
  private readonly language: string;
  private readonly sessions = new Set<MoonshineBrowserSession>();
  private loading: Promise<LoadedModel> | undefined;
  private loaded: LoadedModel | undefined;
  private disposed = false;
  private streamCount = 0;

  /** @throws {RangeError} When a key term contains a comma: the package joins the terms with commas. */
  constructor(private readonly config: MoonshineBrowserSTTConfig = {}) {
    for (const term of config.keyterms ?? []) {
      if (term.includes(',')) {
        throw new RangeError(`MoonshineBrowserSTT: a key term cannot contain a comma: ${term}`);
      }
    }
    this.language = baseLanguage(config.language ?? 'en');
    this.priority = config.priority ?? 0;
    this.capabilities = defaultCapabilities({
      languages: [this.language],
      streaming: true,
      costTier: 'cheap',
      latencyClass: 'realtime',
    });
  }

  /** The model size this provider loads: the configured one, or the one `'auto'` picks for this device. */
  get model(): MoonshineModelSize {
    return this.loaded?.model ?? this.chooseModel();
  }

  /** Where the loaded model runs; `undefined` until {@link MoonshineBrowserSTT.load} resolves. */
  get thread(): 'worker' | 'calling' | undefined {
    return this.loaded?.thread;
  }

  /**
   * Loads the package and the model, once: later calls share the load, and a
   * failed load is tried again by the next call. `startSession()` calls it,
   * so a host calls it first only to download before the person starts.
   *
   * @throws {Error} When the package cannot be imported, the model cannot be
   *   downloaded or built, or the provider was disposed.
   */
  load(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('MoonshineBrowserSTT: disposed'));
    if (!this.loading) {
      this.loading = this.loadModel().then(
        (loaded) => {
          if (this.disposed) {
            releaseModel(loaded);
            throw new Error('MoonshineBrowserSTT: disposed while loading');
          }
          this.loaded = loaded;
          return loaded;
        },
        (err: unknown) => {
          this.loading = undefined;
          throw err;
        }
      );
    }
    return this.loading.then(() => undefined);
  }

  /**
   * Opens a session: a stream on the loaded model, loading it first when
   * needed.
   *
   * @param config - `language`, when given, must be the model's (a region
   *   such as `en-US` is accepted); the other fields do not apply.
   * @throws {Error} When the language differs, or the model or the stream
   *   cannot be opened, so a `StreamingSTTChain` can fall back; with
   *   `MoonshineBrowserSTT: disposed` when `dispose()` lands before the
   *   stream runs, which closes the stream.
   */
  async startSession(config?: StreamingSTTConfig): Promise<StreamingSTTSession> {
    if (config?.language && baseLanguage(config.language) !== this.language) {
      throw new Error(
        `MoonshineBrowserSTT: the model is for "${this.language}", the session asks for "${config.language}"`
      );
    }
    await this.load();
    const loaded = this.loaded;
    if (!loaded) throw new Error('MoonshineBrowserSTT: disposed');
    const session = new MoonshineBrowserSession(this.providerId, this.language);
    // dispose() may land while the stream opens or starts. It has released the
    // model, so the stream is closed and the start rejects as disposed,
    // whatever the package says of the released model.
    const engine = await this.openEngine(loaded, session.listener).catch((err: unknown) => {
      throw this.disposed ? new Error('MoonshineBrowserSTT: disposed') : err;
    });
    try {
      if (this.disposed) throw new Error('MoonshineBrowserSTT: disposed');
      await engine.start();
      if (this.disposed) throw new Error('MoonshineBrowserSTT: disposed');
    } catch (err) {
      engine.close();
      throw this.disposed ? new Error('MoonshineBrowserSTT: disposed') : err;
    }
    session.attach(engine);
    this.sessions.add(session);
    session.once('close', () => this.sessions.delete(session));
    return session;
  }

  /** Whether this page can run the provider, by {@link checkMoonshineBrowserSupport}; downloads nothing. */
  async healthCheck(): Promise<HealthCheckResult> {
    const support = checkMoonshineBrowserSupport({ singleThreadBuild: this.config.singleThreadBuild });
    if (support.supported) return { ok: true, latencyMs: 0 };
    return {
      ok: false,
      latencyMs: 0,
      error: { class: 'unknown', message: `MoonshineBrowserSTT: this page lacks ${support.missing.join(' and ')}` },
    };
  }

  /** Closes every open session and releases the model and the package's worker. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const session of [...this.sessions]) session.close();
    const loaded = this.loaded;
    this.loaded = undefined;
    if (loaded) releaseModel(loaded);
  }

  private chooseModel(): MoonshineModelSize {
    const model = this.config.model ?? 'auto';
    return model === 'auto' ? chooseMoonshineModel(this.config.device ?? readMoonshineDeviceSignals()) : model;
  }

  private async moonshine(): Promise<MoonshineWasmModule> {
    const given = this.config.moonshine;
    if (typeof given === 'function') return given();
    return given ?? loadMoonshineWasm();
  }

  private async loadModel(): Promise<LoadedModel> {
    const moonshine = await this.moonshine();
    const model = this.chooseModel();
    const modelArch = modelArchOf(moonshine, model);
    const source = this.modelSource(model);
    const options = this.transcriberOptions();
    const onProgress = this.config.onProgress ? this.progressReporter(model, source.kind === 'urls') : undefined;
    const wanted = this.config.thread ?? 'auto';
    const thread = wanted === 'auto' ? (moonshine.sttWorkerSupported() ? 'worker' : 'calling') : wanted;
    if (thread === 'worker') {
      const host = new moonshine.SttWorkerHost(this.config.wasmBaseUrl);
      if (onProgress) {
        const report = onProgress;
        host.onProgress = (_transcriberId, loaded, total, file) => report(loaded, total, file);
      }
      try {
        await host.loadTranscriber({ transcriberId: TRANSCRIBER_ID, modelArch, source, ...(options ? { options } : {}) });
      } catch (err) {
        host.close();
        throw err;
      }
      return { thread, model, host };
    }
    const loadOptions: MoonshineLoadOptionsLike = {
      modelArch,
      ...(onProgress ? { onProgress } : {}),
      ...(options ? { options } : {}),
    };
    const transcriber =
      source.kind === 'urls'
        ? await moonshine.Transcriber.loadFromUrls(source.files, loadOptions)
        : await moonshine.Transcriber.load({ ...loadOptions, language: source.language });
    return { thread, model, transcriber };
  }

  private modelSource(model: MoonshineModelSize): MoonshineModelSource {
    const base = this.config.modelBaseUrl;
    if (!base) return { kind: 'catalog', language: this.language };
    const folder = `${base.replace(/\/+$/, '')}/${SIZE_FOLDER[model]}-streaming-${this.language}`;
    const files: Record<string, string> = {};
    for (const name of this.config.modelFileNames ?? MOONSHINE_STREAMING_MODEL_FILES) {
      files[name] = `${folder}/${name}`;
    }
    return { kind: 'urls', files };
  }

  private transcriberOptions(): Record<string, string> | undefined {
    const options: Record<string, string> = {};
    const keyterms = this.config.keyterms ?? [];
    if (keyterms.length > 0) options.keyterms = keyterms.join(',');
    if (this.config.context) options.context = this.config.context;
    if (this.config.contextMaxTerms !== undefined) options.context_max_terms = String(this.config.contextMaxTerms);
    return Object.keys(options).length > 0 ? options : undefined;
  }

  private progressReporter(model: MoonshineModelSize, hostFiles: boolean): MoonshineProgressReport {
    return (loaded, total, file) => {
      const size = total ?? (hostFiles ? this.config.modelBytes?.[model] : undefined);
      this.config.onProgress?.({
        model,
        loaded,
        file,
        ...(size !== undefined && size > 0 ? { total: size, fraction: Math.min(1, loaded / size) } : {}),
      });
    };
  }

  private async openEngine(loaded: LoadedModel, listener: MoonshineLineListener): Promise<MoonshineEngine> {
    if (loaded.thread === 'worker') {
      const host = loaded.host;
      const streamId = `stream-${++this.streamCount}`;
      await host.createStream(TRANSCRIBER_ID, streamId);
      host.setListener(streamId, listener);
      return {
        start: () => host.start(streamId),
        addAudio: (samples, sampleRate) => host.addAudio(streamId, samples, sampleRate),
        stop: () => host.stop(streamId),
        close: () => {
          host.closeStream(streamId).catch(() => {
            // The worker or the stream is already gone: nothing is left to release.
          });
        },
      };
    }
    const stream = loaded.transcriber.createStream();
    stream.addListener(listener);
    return {
      start: async () => stream.start(),
      addAudio: (samples, sampleRate) => {
        stream.addAudio(samples, sampleRate);
        stream.transcribe();
      },
      stop: async () => stream.stop(),
      close: () => stream.close(),
    };
  }
}

/** The package's architecture number for a size. */
function modelArchOf(moonshine: MoonshineWasmModule, model: MoonshineModelSize): number {
  const arch: Record<MoonshineModelSize, number> = {
    'moonshine-tiny': moonshine.ModelArch.TinyStreaming,
    'moonshine-small': moonshine.ModelArch.SmallStreaming,
    'moonshine-medium': moonshine.ModelArch.MediumStreaming,
  };
  return arch[model];
}

/** Releases a loaded model and, in the worker, the worker itself. */
function releaseModel(loaded: LoadedModel): void {
  try {
    if (loaded.thread === 'worker') loaded.host.close();
    else loaded.transcriber.close();
  } catch {
    // Already released.
  }
}

/** `en` for `en`, `en-US` or `EN_us`. */
function baseLanguage(tag: string): string {
  return tag.trim().toLowerCase().split(/[-_]/)[0];
}

// ---------------------------------------------------------------------------
// The session
// ---------------------------------------------------------------------------

/**
 * One stream on the loaded model, as a {@link StreamingSTTSession}.
 *
 * ## Events emitted
 *
 * | Event          | Payload                    | Description                                         |
 * |----------------|----------------------------|-----------------------------------------------------|
 * | `'transcript'` | {@link TranscriptEvent}    | A line's text while open (`isFinal: false`) and once complete (`isFinal: true`); an empty final retracts an open line's text, as when the session ends. |
 * | `'error'`      | {@link VoicePipelineError} | Transcription failed; `'close'` follows. Emitted only when a listener exists. |
 * | `'close'`      | *(none)*                   | The session ended.                                  |
 */
class MoonshineBrowserSession extends VoiceEventEmitter implements StreamingSTTSession {
  /** Receives the stream's line events. */
  readonly listener: MoonshineLineListener = {
    onLineStarted: (event) => this.onOpenLine(event.line),
    onLineTextChanged: (event) => this.onOpenLine(event.line),
    onLineUpdated: (event) => this.onOpenLine(event.line),
    onLineCompleted: (event) => this.onCompletedLine(event.line),
    onError: (event) => this.fail(event.error),
  };
  private engine: MoonshineEngine | undefined;
  private closed = false;
  private restarting = false;
  private flushing: Promise<void> | undefined;
  /** Milliseconds of audio pushed into the session so far. */
  private pushedMs = 0;
  /** Where the stream's current run starts on the session's clock, in milliseconds. */
  private runStartMs = 0;
  /** Frames pushed while a flush restarts the stream, fed once it runs again. */
  private held: AudioFrame[] = [];
  /** Each open line whose text was emitted, as last emitted, by line id. */
  private readonly shown = new Map<string, MoonshineLineLike>();

  constructor(
    private readonly providerId: string,
    private readonly language: string
  ) {
    super();
  }

  /** Gives the session its stream, once the stream runs. */
  attach(engine: MoonshineEngine): void {
    this.engine = engine;
  }

  /**
   * Feeds a mono frame at any sample rate to the stream (the package
   * resamples it). A frame pushed while a flush restarts the stream is held
   * and fed once the stream runs again.
   */
  pushAudio(frame: AudioFrame): void {
    if (this.closed || frame.samples.length === 0 || !(frame.sampleRate > 0)) return;
    this.pushedMs += (frame.samples.length / frame.sampleRate) * 1000;
    if (this.restarting) {
      this.held.push(frame);
      return;
    }
    this.feed(frame);
  }

  /**
   * Completes the open line: stops the stream, whose last pass emits the
   * final of every open line, then starts it again for what follows. Frames
   * pushed meanwhile are held and fed after the restart. Resolves once the
   * stream runs again, or the session has closed; a call during a flush
   * shares it.
   */
  flush(): Promise<void> {
    if (this.closed || !this.engine) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = this.restart(this.engine).finally(() => {
        this.flushing = undefined;
      });
    }
    return this.flushing;
  }

  /**
   * Ends the session at once, with no last pass: each line still open gets
   * an empty final, which retracts its interim text (call `flush()` first to
   * keep it), then `'close'`. Idempotent. The session has closed before
   * these events go out, and a listener that throws on one is written as a
   * console warning: the listeners after it still run, and `'close'` still
   * comes, so the provider lets go of the session.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.held = [];
    this.engine?.close();
    const open = [...this.shown.values()];
    this.shown.clear();
    for (const line of open) this.emitEach('transcript', this.toEvent({ ...line, text: '', words: [] }, true));
    this.emitEach('close');
  }

  private async restart(engine: MoonshineEngine): Promise<void> {
    this.restarting = true;
    const nextRunStartMs = this.pushedMs;
    try {
      await engine.stop();
      if (this.closed) return;
      this.runStartMs = nextRunStartMs;
      await engine.start();
    } catch (err) {
      this.fail(err);
      return;
    } finally {
      this.restarting = false;
    }
    const held = this.held;
    this.held = [];
    for (const frame of held) {
      if (this.closed) return;
      this.feed(frame);
    }
  }

  private feed(frame: AudioFrame): void {
    try {
      this.engine?.addAudio(frame.samples, frame.sampleRate);
    } catch (err) {
      this.fail(err);
    }
  }

  private onOpenLine(line: MoonshineLineLike): void {
    if (this.closed || line.isComplete || line.text.trim().length === 0) return;
    if (this.shown.get(line.id)?.text === line.text) return;
    this.shown.set(line.id, line);
    this.emit('transcript', this.toEvent(line, false));
  }

  private onCompletedLine(line: MoonshineLineLike): void {
    if (this.closed) return;
    const wasShown = this.shown.delete(line.id);
    // An empty final goes out only to retract interim text a display shows.
    if (line.text.trim().length === 0 && !wasShown) return;
    this.emit('transcript', this.toEvent(line, true));
  }

  private toEvent(line: MoonshineLineLike, isFinal: boolean): TranscriptEvent {
    const words: TranscriptWord[] = line.words.map((word) => ({
      word: word.text,
      start: Math.max(0, Math.round((word.start - line.startTime) * 1000)),
      end: Math.max(0, Math.round((word.end - line.startTime) * 1000)),
      confidence: word.confidence,
    }));
    return {
      text: line.text,
      // Moonshine scores words, not lines: the timed words' mean, otherwise 1,
      // as providers report for a service that gives no score.
      confidence: words.length > 0 ? words.reduce((sum, word) => sum + word.confidence, 0) / words.length : 1,
      words,
      isFinal,
      ...(isFinal ? { durationMs: Math.round(line.duration * 1000) } : {}),
      itemId: line.id,
      startMs: Math.round(this.runStartMs + line.startTime * 1000),
      endMs: Math.round(this.runStartMs + (line.startTime + line.duration) * 1000),
      language: this.language,
    };
  }

  /**
   * A transcription failure ends the session: `'error'` (when a listener
   * exists), then `close()`, which runs though an `'error'` listener throws.
   */
  private fail(err: unknown): void {
    if (this.closed) return;
    const error = VoicePipelineError.classifyError(err, { kind: 'stt', provider: this.providerId });
    if (this.listenerCount('error') > 0) {
      this.emitEach('error', error);
    } else {
      console.warn('[moonshine-browser-stt] error (no listener attached):', error.message);
    }
    this.close();
  }

  /**
   * Hands an event to each of its listeners in order, as `emit()` does,
   * except that a listener that throws is written as a console warning and
   * the listeners after it still run. `emit()` stops at a throw and throws
   * into its caller, which would leave the session's last events unsent: the
   * rest of a close, or the close that follows a failure.
   *
   * @param eventName - One of the session's last events.
   * @param args - What each listener is handed.
   */
  private emitEach(eventName: 'transcript' | 'error' | 'close', ...args: unknown[]): void {
    for (const listener of this.rawListeners(eventName)) {
      try {
        (listener as (...values: unknown[]) => unknown).apply(this, args);
      } catch (thrown) {
        console.warn(
          `[moonshine-browser-stt] a listener of '${eventName}' threw:`,
          thrown instanceof Error ? thrown.message : String(thrown)
        );
      }
    }
  }
}
