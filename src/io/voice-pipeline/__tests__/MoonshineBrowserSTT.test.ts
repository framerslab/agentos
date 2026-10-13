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

import { describe, it, expect } from 'vitest';
import type * as Moonshine from '@moonshine-ai/moonshine-wasm';
import {
  checkMoonshineBrowserSupport,
  chooseMoonshineModel,
  loadMoonshineWasm,
  readMoonshineDeviceSignals,
  type MoonshineBrowserScope,
  type MoonshineDeviceSignals,
  type MoonshineModelSize,
  type MoonshineWasmModule,
} from '../providers/MoonshineBrowserSTT.js';

// Checked by the type check: the real package satisfies the structural type
// the provider accepts, so a host passes its import as it is.
type Expect<T extends true> = T;
type ModuleFits = Expect<typeof Moonshine extends MoonshineWasmModule ? true : false>;
const conformance: ModuleFits = true;

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
