/**
 * The forged-code executor evidence run. It answers five questions for QuickJS
 * compiled to WebAssembly against the library's in-process executor, runs
 * escape probes on QuickJS, and writes report.json and report.md to --out.
 * A question's verdict is evidence, not a gate: the run exits non-zero only
 * when the harness itself fails.
 *
 * From the repository root, after `pnpm run build` and with this folder's own
 * dependency installed:
 *   pnpm exec tsx evidence/forge-executors/run.ts --out evidence/forge-executors/out
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

async function questionAwait(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment): Promise<Section> {
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
    id: 'Q1',
    title: 'Can guest code await an asynchronous host function?',
    criterion: 'every case returns its expected value on QuickJS',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? `${rows.length} of ${rows.length} cases returned the expected value` : `failed: ${failed.join(', ')}`,
    rows,
  };
}

async function questionCorpus(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment): Promise<Section> {
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
    id: 'Q2',
    title: "Do the library's forge fixtures and the written corpus run on it?",
    criterion: 'every fixture meets its expectation on both executors; each difference is explained in the decision record',
    verdict: differing.length === 0 && inProcessMisses.length === 0 ? 'PASS' : 'FAIL',
    summary: notes.join('; '),
    rows,
  };
}

async function questionTime(sets: { inProcess: ForgeSet; quickjs: ForgeSet }): Promise<Section> {
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
  const smallIn = await measure(sets.inProcess, small, 200);
  const smallQ = await measure(sets.quickjs, small, 200);
  const mediumIn = await measure(sets.inProcess, medium, 100);
  const mediumQ = await measure(sets.quickjs, medium, 100);
  const setupTimes: number[] = [];
  for (let i = 0; i < 110; i++) {
    const startedAt = performance.now();
    await quickjs.run({ code: 'function execute() { return 1; }', input: {}, globals: {}, timeoutMs: 5000, memoryMB: 128 });
    if (i >= 10) setupTimes.push(performance.now() - startedAt);
  }
  const setup = stats(setupTimes);
  const overheadMedian = round(smallQ.median - smallIn.median);
  const overheadP95 = round(smallQ.p95 - smallIn.p95);
  const pass = coldStartMs <= 1000 && overheadMedian <= 20 && overheadP95 <= 50;
  return {
    id: 'Q3',
    title: 'What do start-up and each call cost?',
    criterion: 'cold start <= 1000 ms; on lib-sum, median overhead over in-process <= 20 ms and p95 overhead <= 50 ms',
    verdict: pass ? 'PASS' : 'FAIL',
    summary: `cold start ${coldStartMs} ms; lib-sum overhead median ${overheadMedian} ms, p95 ${overheadP95} ms`,
    rows: [
      { measure: 'cold start: import + WebAssembly module load', inProcess: '-', quickjs: `${coldStartMs} ms` },
      { measure: 'lib-sum through the forge (n=200)', inProcess: smallIn, quickjs: smallQ },
      { measure: 'w-json-groupby through the forge (n=100)', inProcess: mediumIn, quickjs: mediumQ },
      { measure: 'QuickJS executor alone, empty call: runtime, context, prelude, teardown (n=100)', inProcess: '-', quickjs: setup },
    ],
  };
}

async function questionMemory(sets: { inProcess: ForgeSet; quickjs: ForgeSet }): Promise<Section> {
  const grow = "function execute() { const a = []; for (;;) { a.push('x'.repeat(65536)); } }";
  const growCaught =
    "function execute() { const a = []; try { for (;;) { a.push('x'.repeat(65536)); } } catch (e) { a.length = 0; return { caught: String(e && e.message) }; } }";
  const hostBefore = process.memoryUsage();
  const uncaught = await sets.quickjs.run(grow, {}, [], 10000, 16);
  const caught = await sets.quickjs.run(growCaught, {}, [], 10000, 16);
  const next = await sets.quickjs.run('function execute(input) { return { sum: input.a + input.b }; }', { a: 2, b: 3 }, []);
  const hostAfter = process.memoryUsage();
  const inProcess = await child('grow-uncaught', 20000);
  const pass =
    !uncaught.success &&
    (uncaught.error ?? '').toLowerCase().includes('memory') &&
    uncaught.elapsedMs < 10000 &&
    next.success &&
    isDeepStrictEqual(next.output, { sum: 5 });
  const mb = (bytes: number) => `${round(bytes / 1048576)} MB`;
  return {
    id: 'Q4',
    title: 'What does the memory limit do when a guest exceeds it?',
    criterion: 'the guest ends with a memory error before its deadline, the host keeps running, and the next call succeeds',
    verdict: pass ? 'PASS' : 'FAIL',
    summary: `uncaught: ${uncaught.error ?? 'no error'} after ${round(uncaught.elapsedMs)} ms; next call ${next.success ? 'succeeded' : 'failed'}`,
    rows: [
      { case: 'QuickJS, 16 MB, allocation not caught', result: brief(uncaught), memoryUsedBytes: uncaught.memoryUsedBytes },
      { case: 'QuickJS, 16 MB, allocation caught by the guest', result: brief(caught), memoryUsedBytes: caught.memoryUsedBytes },
      { case: 'QuickJS, the next call on the same executor', result: brief(next), memoryUsedBytes: next.memoryUsedBytes },
      {
        case: 'host process around the QuickJS cases',
        result: `heapUsed ${mb(hostBefore.heapUsed)} -> ${mb(hostAfter.heapUsed)}; rss ${mb(hostBefore.rss)} -> ${mb(hostAfter.rss)}`,
        memoryUsedBytes: '-',
      },
      { case: 'in-process, own process, --max-old-space-size=256, killed after 20 s', result: inProcess, memoryUsedBytes: '-' },
    ],
  };
}

async function questionSpin(sets: { inProcess: ForgeSet; quickjs: ForgeSet }, env: CorpusEnvironment): Promise<Section> {
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
  for (const id of ['yield-then-spin', 'never-settles', 'sync-spin']) {
    rows.push({ executor: 'in-process (own process, killed after 5 s)', case: id, result: await child(id, 5000), hostLoopMaxGapMs: '-', pass: '-' });
  }
  const failed = rows.filter((row) => row.pass === false).map((row) => row.case);
  return {
    id: 'Q5',
    title: 'Does it stop a guest that yields once and then spins (T7)?',
    criterion: `every QuickJS case ends "timed out" within ${timeoutMs} + 250 ms`,
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? 'every QuickJS case ended at its deadline' : `not stopped in time: ${failed.join(', ')}`,
    rows,
  };
}

async function escapeProbes(): Promise<Section> {
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
    const outcome = await quickjs.run({ code, input, globals, timeoutMs: 2000, memoryMB: 64 });
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
  await quickjs.run({
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
    id: 'P',
    title: 'Escape probes on QuickJS (the executor called directly, past the forge validation)',
    criterion: 'every probe returns its contained value',
    verdict: failed.length === 0 ? 'PASS' : 'FAIL',
    summary: failed.length === 0 ? `${rows.length} of ${rows.length} contained` : `not contained: ${failed.join(', ')}`,
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
  moduleReloads: number;
  sections: Section[];
}): string {
  const e = report.environment;
  const lines = [
    '# Forged-code executor evidence: QuickJS in WebAssembly',
    '',
    `Commit ${String(e.commit)}, run ${String(e.run)}. Node ${String(e.node)} on ${String(e.platform)} (${String(e.cpu)}, ${String(e.cpus)} CPUs). quickjs-emscripten ${String(e.quickjsEmscripten)}, variant ${String(e.variant)}. @framers/agentos ${String(e.agentos)}. Module reloads after a failed teardown: ${report.moduleReloads}.`,
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
  const guard = async (id: string, title: string, work: () => Promise<Section>) => {
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
  };
  try {
    const sets = { inProcess: forgeSet('in-process', undefined, env), quickjs: forgeSet('quickjs', quickjs, env) };
    await guard('Q1', 'Can guest code await an asynchronous host function?', () => questionAwait(sets, env));
    await guard('Q2', "Do the library's forge fixtures and the written corpus run on it?", () => questionCorpus(sets, env));
    await guard('Q3', 'What do start-up and each call cost?', () => questionTime(sets));
    await guard('Q4', 'What does the memory limit do when a guest exceeds it?', () => questionMemory(sets));
    await guard('Q5', 'Does it stop a guest that yields once and then spins (T7)?', () => questionSpin(sets, env));
    await guard('P', 'Escape probes on QuickJS', () => escapeProbes());
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
    commit: process.env.GITHUB_SHA ?? 'local',
    run: process.env.GITHUB_RUN_ID ?? 'local',
  };
  const report = { environment, coldStartMs, moduleReloads: quickjs.moduleReloads, sections };
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const text = markdown(report);
  await writeFile(join(outDir, 'report.md'), `${text}\n`);
  console.log(text);
  return harnessErrors === 0 ? 0 : 1;
}

process.exit(await main());
