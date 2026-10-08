/**
 * The forged-code executor evidence run. It answers five questions for QuickJS
 * compiled to WebAssembly against the library's in-process executor, runs
 * escape probes on QuickJS, and writes report.json and report.md to --out.
 * A question's verdict is evidence, not a gate: the run exits non-zero only
 * when the harness itself fails.
 *
 * From the repository root, after `pnpm run build` and with this folder's own
 * dependency installed:
 *   node --expose-gc --import tsx evidence/forge-executors/run.ts --out evidence/forge-executors/out
 */
import { spawn } from 'node:child_process';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SandboxedToolForge } from '../../dist/cognition/emergent/SandboxedToolForge.js';
import { CapabilityBroker } from '../../dist/cognition/emergent/broker/CapabilityBroker.js';
import { resolveCeiling } from '../../dist/cognition/emergent/ceiling.js';
import type { ForgedCodeExecutor } from '../../dist/cognition/emergent/executor/types.js';
import {
  checkExpectation,
  loadCorpus,
  startCorpusEnvironment,
  type CorpusEnvironment,
  type CorpusFixture,
} from '../../tests/fixtures/forged-tools/environment.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const outFlag = process.argv.indexOf('--out');
const outDir = resolve(outFlag >= 0 && process.argv[outFlag + 1] ? process.argv[outFlag + 1] : join(here, 'out'));

type Verdict = 'PASS' | 'FAIL' | 'HARNESS_ERROR';

interface Section {
  id: string;
  title: string;
  criterion: string;
  verdict: Verdict;
  summary: string;
  rows: Array<Record<string, unknown>>;
}

interface Outcome {
  success: boolean;
  output?: unknown;
  error?: string;
  elapsedMs: number;
  memoryUsedBytes?: number;
}

interface ForgeSet {
  name: string;
  run(code: string, input: unknown, allowlist: string[], timeoutMs?: number, memoryMB?: number): Promise<Outcome>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** A result shortened for a report cell. */
function brief(outcome: Outcome): Record<string, unknown> {
  const output = outcome.output === undefined ? undefined : JSON.stringify(outcome.output);
  return {
    success: outcome.success,
    output: output !== undefined && output.length > 200 ? `${output.slice(0, 200)}...` : output,
    error: outcome.error,
    elapsedMs: round(outcome.elapsedMs),
  };
}

function withLabel(id: string, label: string): string {
  return label ? `${id}-${label}` : id;
}

function titled(title: string, label: string): string {
  return label ? `${title} [${label}]` : title;
}

function stats(times: number[]): { n: number; median: number; p95: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), max: round(sorted[sorted.length - 1] ?? 0) };
}

// Q3's first half: the cold start, timed before anything else touches QuickJS.
const coldStartedAt = performance.now();
const { QuickJSExecutor } = await import('./quickjs-executor.js');
const quickjs = new QuickJSExecutor();
await quickjs.load();
const coldStartMs = round(performance.now() - coldStartedAt);

// The candidates beside the shared module: an instance per call, from a module
// compiled once, on a memory capped at the call's memoryMB; and a shared module
// on a memory capped at 256 MB.
const perCallStartedAt = performance.now();
const quickjsPerCall = new QuickJSExecutor({ instance: 'per-call' });
await quickjsPerCall.load();
const perCallLoadMs = round(performance.now() - perCallStartedAt);
const quickjsCapped = new QuickJSExecutor({ sharedMemoryCapMB: 256, label: 'quickjs-wasm (shared, 256 MB cap)' });
const gc = (globalThis as { gc?: () => void }).gc;

function forgeSet(name: string, executor: ForgedCodeExecutor | undefined, env: CorpusEnvironment): ForgeSet {
  const options = executor ? { executor } : {};
  const plain = new SandboxedToolForge(options);
  const brokered = new SandboxedToolForge(options);
  const broker = new CapabilityBroker(
    resolveCeiling(
      { fetch: { domains: ['127.0.0.1'] }, 'fs.read': { roots: [env.root] }, crypto: {} },
      { store: 'none' },
      { hasStorage: false },
    ),
  );
  brokered.attachBroker(broker);
  return {
    name,
    async run(code, input, allowlist, timeoutMs = 5000, memoryMB = 128) {
      const request = { code, input, allowlist: allowlist as never[], memoryMB, timeoutMs };
      const startedAt = performance.now();
      if (allowlist.length === 0) {
        const result = await plain.execute(request);
        return { ...result, elapsedMs: performance.now() - startedAt };
      }
      // As the engine runs a call: the handle's signal aborts at the deadline, and the run is ended.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const call = { id: randomUUID(), toolId: 'evidence', agentId: 'evidence', signal: controller.signal };
      try {
        const result = await brokered.execute({ ...request, call });
        return { ...result, elapsedMs: performance.now() - startedAt };
      } finally {
        clearTimeout(timer);
        controller.abort();
        await broker.endCall(call.id);
      }
    },
  };
}

/** Runs work while timing the host event loop's longest gap. */
async function withLoopGap<T>(work: () => Promise<T>): Promise<{ value: T; maxGapMs: number }> {
  let last = performance.now();
  let maxGapMs = 0;
  const tick = () => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - last);
    last = now;
  };
  const timer = setInterval(tick, 5);
  try {
    const value = await work();
    tick();
    return { value, maxGapMs: round(maxGapMs) };
  } finally {
    clearInterval(timer);
  }
}

/** One in-process case in a process of its own, killed at `killAfterMs`. */
function child(caseName: string, killAfterMs: number): Promise<Record<string, unknown>> {
  return new Promise((resolveChild) => {
    const startedAt = performance.now();
    const proc = spawn(
      process.execPath,
      ['--max-old-space-size=256', '--import', 'tsx', join(here, 'in-process-child.ts'), caseName],
      { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, killAfterMs);
    proc.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      const lastLine = stdout.trim().split('\n').pop();
      let line: unknown = lastLine;
      try {
        line = lastLine ? JSON.parse(lastLine) : undefined;
      } catch {
        // keep the raw line
      }
      resolveChild({
        case: caseName,
        endedOnItsOwn: !killed,
        wallMs: Math.round(performance.now() - startedAt),
        exitCode,
        signal,
        printed: line,
        stderrTail: stderr.slice(-400),
      });
    });
  });
}

async function questionAwait(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment, label = ''): Promise<Section> {
  const cases = [
    {
      id: 'await-fetch',
      code: 'async function execute(input) { const r = await fetch(input.url); return { status: r.status, text: await r.text() }; }',
      input: { url: `${env.server}/ok` },
      allowlist: ['fetch'],
      expected: { status: 200, text: 'ok' } as unknown,
    },
    {
      id: 'await-read',
      code: 'async function execute(input) { return await fs.readFile(input.path); }',
      input: { path: join(env.root, 'notes.txt') },
      allowlist: ['fs.read'],
      expected: 'alpha\nbeta\ngamma\n',
    },
    {
      id: 'parallel',
      code: 'async function execute(input) { const rs = await Promise.all([1, 2, 3].map(() => fetch(input.url))); return rs.map((r) => r.status); }',
      input: { url: `${env.server}/ok` },
      allowlist: ['fetch'],
      expected: [200, 200, 200],
    },
    {
      id: 'rejection',
      code: "async function execute(input) { try { await fetch(input.url); return 'no error'; } catch (e) { return String(e.message).split(':')[0]; } }",
      input: { url: `${env.otherServer}/ok` },
      allowlist: ['fetch'],
      expected: 'host_not_allowed',
    },
    {
      id: 'sequential-20',
      code: 'async function execute(input) { let n = 0; for (let i = 0; i < 20; i++) { const r = await fetch(input.url); if (r.ok) n++; } return n; }',
      input: { url: `${env.server}/ok` },
      allowlist: ['fetch'],
      expected: 20,
    },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const inProcess = await sets.inProcess.run(c.code, c.input, c.allowlist);
    const onQuickJS = await sets.quickjs.run(c.code, c.input, c.allowlist);
    rows.push({
      case: c.id,
      expected: JSON.stringify(c.expected),
      inProcess: brief(inProcess),
      quickjs: brief(onQuickJS),
      pass: onQuickJS.success && isDeepStrictEqual(onQuickJS.output, c.expected),
    });
  }
  const failed = rows.filter((row) => !row.pass).map((row) => row.case);
  return {
    id: withLabel('Q1', label),
    title: titled('Can guest code await an asynchronous host function?', label),
    criterion: 'every case returns its expected value on QuickJS',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? `${rows.length} of ${rows.length} cases returned the expected value` : `failed: ${failed.join(', ')}`,
    rows,
  };
}

async function questionCorpus(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment, label = ''): Promise<Section> {
  const { library, written } = loadCorpus();
  const rows: Array<Record<string, unknown>> = [];
  const run = async (set: string, fixture: CorpusFixture) => {
    const input = env.fill(fixture.input);
    const timeoutMs = fixture.timeoutMs ?? 5000;
    const inProcess = await sets.inProcess.run(fixture.code, input, fixture.allowlist, timeoutMs);
    const onQuickJS = await sets.quickjs.run(fixture.code, input, fixture.allowlist, timeoutMs);
    rows.push({
      set,
      fixture: fixture.id,
      inProcess: checkExpectation(fixture.expect, inProcess) ?? 'meets',
      quickjs: checkExpectation(fixture.expect, onQuickJS) ?? 'meets',
      quickjsResult: brief(onQuickJS),
    });
  };
  for (const fixture of library) {
    await run('library', fixture);
  }
  for (const fixture of written) {
    await run('written', fixture);
  }
  const differing = rows.filter((row) => row.quickjs !== 'meets').map((row) => row.fixture);
  const inProcessMisses = rows.filter((row) => row.inProcess !== 'meets').map((row) => row.fixture);
  const notes = [`${rows.length - differing.length} of ${rows.length} fixtures meet their expectation on QuickJS`];
  if (differing.length > 0) notes.push(`differing on QuickJS: ${differing.join(', ')}`);
  if (inProcessMisses.length > 0) notes.push(`missing on in-process (the environment, not QuickJS): ${inProcessMisses.join(', ')}`);
  return {
    id: withLabel('Q2', label),
    title: titled("Do the library's forge fixtures and the written corpus run on it?", label),
    criterion: 'every fixture meets its expectation on both executors; each difference is explained in the decision record',
    verdict: differing.length === 0 && inProcessMisses.length === 0 ? 'PASS' : 'FAIL',
    summary: notes.join('; '),
    rows,
  };
}

async function questionTime(sets: { inProcess: ForgeSet; quickjs: ForgeSet; perCall: ForgeSet }): Promise<Section> {
  const { library, written } = loadCorpus();
  const small = library.find((fixture) => fixture.id === 'lib-sum');
  const medium = written.find((fixture) => fixture.id === 'w-json-groupby');
  if (!small || !medium) {
    throw new Error('the timing fixtures lib-sum and w-json-groupby are missing from the corpus');
  }
  const measure = async (set: ForgeSet, fixture: CorpusFixture, n: number) => {
    const times: number[] = [];
    for (let i = 0; i < n + 10; i++) {
      const outcome = await set.run(fixture.code, fixture.input, fixture.allowlist);
      if (!outcome.success) {
        throw new Error(`${set.name} failed ${fixture.id}: ${outcome.error ?? ''}`);
      }
      if (i >= 10) {
        times.push(outcome.elapsedMs); // the first ten are warm-up
      }
    }
    return stats(times);
  };
  const emptyCalls = async (executor: ForgedCodeExecutor) => {
    const times: number[] = [];
    for (let i = 0; i < 110; i++) {
      const startedAt = performance.now();
      await executor.run({ code: 'function execute() { return 1; }', input: {}, globals: {}, timeoutMs: 5000, memoryMB: 128 });
      if (i >= 10) times.push(performance.now() - startedAt);
    }
    return stats(times);
  };
  const smallIn = await measure(sets.inProcess, small, 200);
  const smallQ = await measure(sets.quickjs, small, 200);
  const smallP = await measure(sets.perCall, small, 200);
  const mediumIn = await measure(sets.inProcess, medium, 100);
  const mediumQ = await measure(sets.quickjs, medium, 100);
  const mediumP = await measure(sets.perCall, medium, 100);
  const setupShared = await emptyCalls(quickjs);
  const setupPerCall = await emptyCalls(quickjsPerCall);
  const overhead = (q: { median: number; p95: number }) => ({ median: round(q.median - smallIn.median), p95: round(q.p95 - smallIn.p95) });
  const shared = overhead(smallQ);
  const perCall = overhead(smallP);
  const meets = (o: { median: number; p95: number }, startMs: number) => startMs <= 1000 && o.median <= 20 && o.p95 <= 50;
  const sharedMeets = meets(shared, coldStartMs);
  const perCallMeets = meets(perCall, perCallLoadMs);
  return {
    id: 'Q3',
    title: 'What do start-up and each call cost?',
    criterion: 'per candidate: start-up <= 1000 ms; on lib-sum, median overhead over in-process <= 20 ms and p95 overhead <= 50 ms',
    verdict: sharedMeets && perCallMeets ? 'PASS' : 'FAIL',
    summary: `shared: start-up ${coldStartMs} ms, overhead median ${shared.median} ms, p95 ${shared.p95} ms (${sharedMeets ? 'meets' : 'misses'}); per call: start-up ${perCallLoadMs} ms, overhead median ${perCall.median} ms, p95 ${perCall.p95} ms (${perCallMeets ? 'meets' : 'misses'})`,
    rows: [
      { measure: 'start-up: import and module load (shared); compile once (per call)', inProcess: '-', quickjs: `${coldStartMs} ms`, perCall: `${perCallLoadMs} ms` },
      { measure: 'lib-sum through the forge (n=200)', inProcess: smallIn, quickjs: smallQ, perCall: smallP },
      { measure: 'w-json-groupby through the forge (n=100)', inProcess: mediumIn, quickjs: mediumQ, perCall: mediumP },
      { measure: 'the executor alone, an empty call (n=100)', inProcess: '-', quickjs: setupShared, perCall: setupPerCall },
    ],
  };
}

async function questionMemory(sets: { inProcess: ForgeSet; quickjs: ForgeSet; perCall: ForgeSet; capped: ForgeSet }): Promise<Section> {
  const grow = "function execute() { const a = []; for (;;) { a.push('x'.repeat(65536)); } }";
  const growCaught =
    "function execute() { const a = []; try { for (;;) { a.push('x'.repeat(65536)); } } catch (e) { a.length = 0; return { caught: String(e && e.message) }; } }";
  const mb = (bytes: number) => round(bytes / 1048576);
  const settle = () => {
    gc?.();
    gc?.();
  };
  // The host's own bound: what the guest's 16 MB limit may cost the process, with room for the module itself.
  const boundMB = Math.max(64, 4 * 16);
  const configs = [
    { name: "shared module, the build's own maximum", set: sets.quickjs, executor: quickjs },
    { name: 'shared module, memory capped at 256 MB', set: sets.capped, executor: quickjsCapped },
    { name: "an instance per call, memory capped at the call's 16 MB", set: sets.perCall, executor: quickjsPerCall },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const config of configs) {
    settle();
    const before = process.memoryUsage().rss;
    const uncaught = await config.set.run(grow, {}, [], 10000, 16);
    const rssAfterUncaught = process.memoryUsage().rss;
    const wasmAfterUncaught = config.executor.lastWasmBytes;
    const supplied = config.executor.lastMemoryWasSupplied;
    const caught = await config.set.run(growCaught, {}, [], 10000, 16);
    const next = await config.set.run('function execute(input) { return { sum: input.a + input.b }; }', { a: 2, b: 3 }, []);
    settle();
    const retained = process.memoryUsage().rss - before;
    const growthMB = mb(rssAfterUncaught - before);
    const pass =
      !uncaught.success &&
      (uncaught.error ?? '').toLowerCase().includes('memory') &&
      uncaught.elapsedMs < 10000 &&
      next.success &&
      isDeepStrictEqual(next.output, { sum: 5 }) &&
      growthMB <= boundMB;
    rows.push({
      config: config.name,
      uncaught: brief(uncaught),
      caught: brief(caught),
      next: next.success ? 'ok' : brief(next),
      wasmMBAfterUncaught: mb(wasmAfterUncaught),
      suppliedMemoryUsed: supplied,
      rssGrowthMB: growthMB,
      rssRetainedAfterGcMB: mb(retained),
      pass,
    });
  }
  rows.push({
    config: 'in-process, own process, --max-old-space-size=256, killed after 20 s',
    uncaught: await child('grow-uncaught', 20000),
    caught: '-',
    next: '-',
    wasmMBAfterUncaught: '-',
    suppliedMemoryUsed: '-',
    rssGrowthMB: '-',
    rssRetainedAfterGcMB: '-',
    pass: '-',
  });
  const holding = rows.filter((row) => row.pass === true).map((row) => String(row.config));
  return {
    id: 'Q4',
    title: 'What does the memory limit do when a guest exceeds it?',
    criterion: `per configuration: the guest ends with a memory error before its deadline, the next call succeeds, and the host's RSS grows by at most ${boundMB} MB across the call (garbage collection ${gc ? 'forced' : 'not available'})`,
    verdict: holding.length > 0 ? 'PASS' : 'FAIL',
    summary: holding.length > 0 ? `holds for: ${holding.join('; ')}` : 'no configuration bounds the guest',
    rows,
  };
}

async function questionSpin(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment, label = ''): Promise<Section> {
  const timeoutMs = 500;
  const cases = [
    { id: 'yield-then-spin', code: 'async function execute() { await Promise.resolve(); while (true) {} }', input: {}, allowlist: [] as string[] },
    { id: 'host-then-spin', code: 'async function execute(input) { await fetch(input.url); for (;;) {} }', input: { url: `${env.server}/ok` }, allowlist: ['fetch'] },
    { id: 'read-then-spin', code: 'async function execute(input) { await fs.readFile(input.path); for (;;) {} }', input: { path: join(env.root, 'notes.txt') }, allowlist: ['fs.read'] },
    { id: 'microtask-flood', code: 'async function execute() { for (;;) { await null; } }', input: {}, allowlist: [] },
    { id: 'never-settles', code: 'async function execute() { await new Promise(() => {}); }', input: {}, allowlist: [] },
    { id: 'sync-spin', code: 'function execute() { while (true) {} }', input: {}, allowlist: [] },
  ];
  const rows: Array<Record<string, unknown>> = [];
  for (const c of cases) {
    const { value, maxGapMs } = await withLoopGap(() => sets.quickjs.run(c.code, c.input, c.allowlist, timeoutMs));
    rows.push({
      executor: 'quickjs',
      case: c.id,
      result: brief(value),
      hostLoopMaxGapMs: maxGapMs,
      pass: !value.success && (value.error ?? '').includes('timed out') && value.elapsedMs <= timeoutMs + 250,
    });
  }
  for (const id of label ? [] : ['yield-then-spin', 'never-settles', 'sync-spin']) {
    rows.push({ executor: 'in-process (own process, killed after 5 s)', case: id, result: await child(id, 5000), hostLoopMaxGapMs: '-', pass: '-' });
  }
  const failed = rows.filter((row) => row.pass === false).map((row) => row.case);
  return {
    id: withLabel('Q5', label),
    title: titled('Does it stop a guest that yields once and then spins (T7)?', label),
    criterion: `every QuickJS case ends "timed out" within ${timeoutMs} + 250 ms`,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? 'every QuickJS case ended at its deadline' : `not stopped in time: ${failed.join(', ')}`,
    rows,
  };
}

async function escapeProbes(executor: ForgedCodeExecutor = quickjs, label = ''): Promise<Section> {
  const cryptoGlobals = {
    crypto: {
      randomUUID: () => randomUUID(),
      createHash: (algorithm: string) => createHash(algorithm),
      createHmac: (algorithm: string, key: string) => createHmac(algorithm, key),
    },
  };
  const rows: Array<Record<string, unknown>> = [];
  const probe = async (
    id: string,
    code: string,
    check: (status: string, output: unknown) => boolean,
    globals: Record<string, unknown> = {},
    input: unknown = {},
  ) => {
    const outcome = await executor.run({ code, input, globals, timeoutMs: 2000, memoryMB: 64 });
    const output = outcome.status === 'ok' ? outcome.output : undefined;
    rows.push({
      probe: id,
      status: outcome.status,
      output: outcome.status === 'ok' ? JSON.stringify(output) : outcome.status === 'error' ? outcome.error : '',
      pass: check(outcome.status, output),
    });
  };
  const allUndefined = (n: number) => Array.from({ length: n }, () => 'undefined').join(',');
  await probe(
    'host-globals',
    "function execute() { return [typeof process, typeof require, typeof globalThis, typeof Buffer, typeof module, typeof __host_utf8_encode].join(','); }",
    (status, output) => status === 'ok' && output === allUndefined(6),
  );
  await probe(
    'function-constructor',
    "function execute() { const F = Object.constructor; return F('return [typeof process, typeof require].join()')(); }",
    (status, output) => status === 'ok' && output === 'undefined,undefined',
  );
  await probe(
    'binding-constructor',
    "function execute() { return crypto.randomUUID.constructor('return typeof process')(); }",
    (status, output) => status === 'ok' && output === 'undefined',
    cryptoGlobals,
  );
  await probe(
    'prototype-pollution',
    "function execute() { Object.prototype.pollutedByGuest = 1; Array.prototype.pollutedByGuest = 1; return 'done'; }",
    (status, output) =>
      status === 'ok' &&
      output === 'done' &&
      (({}) as Record<string, unknown>).pollutedByGuest === undefined &&
      ([] as unknown as Record<string, unknown>).pollutedByGuest === undefined,
  );
  const input = { list: [1, 2, 3] };
  await probe(
    'input-copied',
    'function execute(input) { input.list.push(4); return input.list.length; }',
    (status, output) => status === 'ok' && output === 4 && input.list.length === 3,
    {},
    input,
  );
  await probe(
    'stack-overflow',
    'function execute() { const f = (n) => f(n + 1) + 1; return f(0); }',
    (status) => status === 'error',
  );
  await probe(
    'then-override',
    "async function execute() { Promise.prototype.then = function () { return 1; }; return 'kept'; }",
    (status, output) => status === 'ok' && output === 'kept',
  );
  await probe(
    'removed-intrinsics',
    "function execute() { return [typeof Reflect, typeof Proxy, typeof WebAssembly, typeof SharedArrayBuffer, typeof Atomics, typeof setTimeout].join(','); }",
    (status, output) => status === 'ok' && output === allUndefined(6),
  );
  await executor.run({
    code: "this.leakedAcrossRuns = 'secret'; function execute() { return 1; }",
    input: {},
    globals: {},
    timeoutMs: 2000,
    memoryMB: 64,
  });
  await probe(
    'cross-run',
    'function execute() { return typeof leakedAcrossRuns; }',
    (status, output) => status === 'ok' && output === 'undefined',
  );
  const failed = rows.filter((row) => !row.pass).map((row) => row.probe);
  return {
    id: withLabel('P', label),
    title: titled('Escape probes on QuickJS (the executor called directly, past the forge validation)', label),
    criterion: 'every probe returns its contained value',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? `${rows.length} of ${rows.length} contained` : `not contained: ${failed.join(', ')}`,
    rows,
  };
}

async function stackLimits(): Promise<Section> {
  const rows: Array<Record<string, unknown>> = [];
  for (const bytes of [1024 * 1024, 256 * 1024, 64 * 1024]) {
    const executor = new QuickJSExecutor({ instance: 'per-call', maxStackBytes: bytes, label: `per call, stack ${bytes / 1024} KiB` });
    const deep = await executor.run({
      code: 'function execute() { const f = (n) => f(n + 1) + 1; return f(0); }',
      input: {},
      globals: {},
      timeoutMs: 5000,
      memoryMB: 64,
    });
    const ordinary = await executor.run({
      code: 'function execute() { const f = (n) => (n === 0 ? 0 : 1 + f(n - 1)); return f(1000); }',
      input: {},
      globals: {},
      timeoutMs: 5000,
      memoryMB: 64,
    });
    const deepError = deep.status === 'error' ? deep.error : deep.status;
    const endedInGuest = deep.status === 'error' && !deep.error.includes('the executor failed');
    rows.push({
      stackKiB: bytes / 1024,
      deepRecursion: deepError,
      endedInGuest,
      depth1000: ordinary.status === 'ok' ? ordinary.output : ordinary.status === 'error' ? ordinary.error : ordinary.status,
      teardownsFailed: executor.moduleReloads,
      pass: endedInGuest && ordinary.status === 'ok' && ordinary.output === 1000,
    });
  }
  const holding = rows.filter((row) => row.pass === true).map((row) => `${String(row.stackKiB)} KiB`);
  return {
    id: 'S',
    title: 'At which QuickJS stack limit does deep recursion end as a guest error?',
    criterion: "deep recursion ends as the guest's own error (not a host RangeError), and a recursion 1000 deep still succeeds",
    verdict: holding.length > 0 ? 'PASS' : 'FAIL',
    summary: holding.length > 0 ? `holds at: ${holding.join(', ')}` : 'no tested limit ends deep recursion inside the guest',
    rows,
  };
}

async function packageVersion(name: string): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(join(here, 'node_modules', name, 'package.json'), 'utf8')) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'not found';
  }
}

function cell(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (text ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 220);
}

function table(rows: Array<Record<string, unknown>>): string[] {
  if (rows.length === 0) {
    return ['(none)'];
  }
  const keys = Object.keys(rows[0]);
  return [
    `| ${keys.join(' | ')} |`,
    `|${keys.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${keys.map((key) => cell(row[key])).join(' | ')} |`),
  ];
}

function markdown(report: {
  environment: Record<string, unknown>;
  coldStartMs: number;
  moduleReloads: Record<string, number>;
  sections: Section[];
}): string {
  const e = report.environment;
  const lines = [
    '# Forged-code executor evidence: QuickJS in WebAssembly',
    '',
    `Commit ${String(e.commit)}, run ${String(e.run)}. Node ${String(e.node)} on ${String(e.platform)} (${String(e.cpu)}, ${String(e.cpus)} CPUs). quickjs-emscripten ${String(e.quickjsEmscripten)}, variant ${String(e.variant)}. @framers/agentos ${String(e.agentos)}. Start-up: shared ${report.coldStartMs} ms, per call ${String(e.perCallLoadMs)} ms (compile once). Garbage collection forced: ${String(e.gcForced)}. Teardowns that failed: ${JSON.stringify(report.moduleReloads)}.`,
    '',
    '| Question | Verdict | Criterion | Summary |',
    '|---|---|---|---|',
    ...report.sections.map((s) => `| ${s.id}: ${cell(s.title)} | ${s.verdict} | ${cell(s.criterion)} | ${cell(s.summary)} |`),
    '',
  ];
  for (const section of report.sections) {
    lines.push(`## ${section.id}: ${section.title}`, '', `Verdict: ${section.verdict}. ${section.summary}`, '', ...table(section.rows), '');
  }
  return lines.join('\n');
}

async function main(): Promise<number> {
  const env = await startCorpusEnvironment();
  const sections: Section[] = [];
  let harnessErrors = 0;
  const reloads = () => [quickjs.moduleReloads, quickjsPerCall.moduleReloads, quickjsCapped.moduleReloads];
  const guard = async (id: string, title: string, work: () => Promise<Section>) => {
    const before = reloads();
    try {
      sections.push(await work());
    } catch (error) {
      harnessErrors += 1;
      sections.push({
        id,
        title,
        criterion: '-',
        verdict: 'HARNESS_ERROR',
        summary: message(error),
        rows: [{ stack: error instanceof Error ? error.stack ?? error.message : String(error) }],
      });
    }
    const failed = reloads().map((n, i) => n - before[i]);
    if (failed.some((n) => n > 0)) {
      const last = sections[sections.length - 1];
      last.summary += ` (teardowns that failed in this section: shared ${failed[0]}, per call ${failed[1]}, capped ${failed[2]})`;
    }
  };
  try {
    const sets = {
      inProcess: forgeSet('in-process', undefined, env),
      quickjs: forgeSet('quickjs', quickjs, env),
      perCall: forgeSet('quickjs per call', quickjsPerCall, env),
      capped: forgeSet('quickjs capped', quickjsCapped, env),
    };
    const perCallSets = { inProcess: sets.inProcess, quickjs: sets.perCall };
    await guard('Q1', 'Can guest code await an asynchronous host function?', () => questionAwait(sets, env));
    await guard('Q1-per-call', 'Can guest code await an asynchronous host function? [per-call]', () => questionAwait(perCallSets, env, 'per-call'));
    await guard('Q2', "Do the library's forge fixtures and the written corpus run on it?", () => questionCorpus(sets, env));
    await guard('Q2-per-call', "Do the library's forge fixtures and the written corpus run on it? [per-call]", () => questionCorpus(perCallSets, env, 'per-call'));
    await guard('Q3', 'What do start-up and each call cost?', () => questionTime(sets));
    await guard('Q4', 'What does the memory limit do when a guest exceeds it?', () => questionMemory(sets));
    await guard('Q5', 'Does it stop a guest that yields once and then spins (T7)?', () => questionSpin(sets, env));
    await guard('Q5-per-call', 'Does it stop a guest that yields once and then spins (T7)? [per-call]', () => questionSpin(perCallSets, env, 'per-call'));
    await guard('P', 'Escape probes on QuickJS', () => escapeProbes(quickjs));
    await guard('P-per-call', 'Escape probes on QuickJS [per-call]', () => escapeProbes(quickjsPerCall, 'per-call'));
    await guard('S', 'At which QuickJS stack limit does deep recursion end as a guest error?', () => stackLimits());
  } finally {
    await env.close();
  }
  const environment = {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    cpus: cpus().length,
    quickjsEmscripten: await packageVersion('quickjs-emscripten'),
    variant: await packageVersion('@jitl/quickjs-wasmfile-release-sync'),
    agentos: (JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown',
    perCallLoadMs,
    gcForced: Boolean(gc),
    commit: process.env.GITHUB_SHA ?? 'local',
    run: process.env.GITHUB_RUN_ID ?? 'local',
  };
  const report = {
    environment,
    coldStartMs,
    moduleReloads: { shared: quickjs.moduleReloads, perCall: quickjsPerCall.moduleReloads, capped: quickjsCapped.moduleReloads },
    sections,
  };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const text = markdown(report);
  await writeFile(join(outDir, 'report.md'), `${text}\n`);
  console.log(text);
  return harnessErrors === 0 ? 0 : 1;
}

process.exit(await main());
