/**
 * QuickJSExecutor through the forge and called directly. The forged-tool
 * corpus meets the expectations it meets in-process; a guest past its memory
 * ends `memory_exceeded` at the call's cap; every guest that spins ends at its
 * deadline; deep recursion ends inside the guest; the escape probes find
 * nothing of the host; the bindings keep their per-call bounds; Intl formats
 * as the in-process context formats.
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SandboxedToolForge } from '../../src/cognition/emergent/SandboxedToolForge.js';
import { CapabilityBroker } from '../../src/cognition/emergent/broker/CapabilityBroker.js';
import { resolveCeiling } from '../../src/cognition/emergent/ceiling.js';
import { MAX_PENDING_HOST_CALLS, QuickJSExecutor } from '../../src/cognition/emergent/executor/QuickJSExecutor.js';
import { MAX_OPEN_DIGESTS } from '../../src/cognition/emergent/executor/guest-surface.js';
import type { ExecutorRunRequest } from '../../src/cognition/emergent/executor/types.js';
import type { AllowlistName, SandboxExecutionResult } from '../../src/cognition/emergent/types.js';
import {
  checkExpectation,
  loadCorpus,
  startCorpusEnvironment,
  usesCapabilities,
  type CorpusEnvironment,
  type CorpusFixture,
} from '../fixtures/forged-tools/environment.js';

const MIB = 1_048_576;
const { library, written } = loadCorpus();

let env: CorpusEnvironment;
let executor: QuickJSExecutor;
let plain: SandboxedToolForge;
let brokered: SandboxedToolForge;
let broker: CapabilityBroker;

beforeAll(async () => {
  env = await startCorpusEnvironment();
  executor = await QuickJSExecutor.create();
  plain = new SandboxedToolForge({ executor });
  brokered = new SandboxedToolForge({ executor });
  broker = new CapabilityBroker(
    resolveCeiling(
      { fetch: { domains: ['127.0.0.1'] }, 'fs.read': { roots: [env.root] }, crypto: {} },
      { store: 'none' },
      { hasStorage: false },
    ),
  );
  brokered.attachBroker(broker);
});

afterAll(async () => {
  await env.close();
});

/** A run of the forge, under the corpus's ceiling when the code names a capability, ended as the engine ends one. */
async function forgeRun(
  code: string,
  input: unknown,
  allowlist: AllowlistName[],
  limits: { timeoutMs?: number; memoryMB?: number } = {},
): Promise<SandboxExecutionResult> {
  const request = { code, input, allowlist, memoryMB: limits.memoryMB ?? 128, timeoutMs: limits.timeoutMs ?? 5000 };
  if (allowlist.length === 0) {
    return plain.execute(request);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  const call = { id: randomUUID(), toolId: 'quickjs-spec', agentId: 'quickjs-spec', signal: controller.signal };
  try {
    return await brokered.execute({ ...request, call });
  } finally {
    clearTimeout(timer);
    controller.abort();
    await broker.endCall(call.id);
  }
}

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

/**
 * A server on 127.0.0.1: `/bytes/<n>` answers n bytes; `/hold` never answers,
 * and `closed` lists the held requests whose connection closed; `/when-held`
 * answers once a `/hold` request has arrived.
 */
async function bytesServer(): Promise<{ base: string; closed: string[] }> {
  const closed: string[] = [];
  let holdArrived!: () => void;
  const held = new Promise<void>((resolve) => {
    holdArrived = resolve;
  });
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith('/hold')) {
      req.socket.on('close', () => closed.push(url));
      holdArrived();
      return;
    }
    if (url.startsWith('/when-held')) {
      void held.then(() => res.end('held'));
      return;
    }
    res.end(Buffer.alloc(Number(url.split('/')[2] ?? 0), 120));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, closed };
}

/** A call made on the executor directly, past the forge's validation. */
function direct(code: string, input: unknown = {}, overrides: Partial<ExecutorRunRequest> = {}): ExecutorRunRequest {
  return { code, input, globals: {}, timeoutMs: 2000, memoryMB: 64, ...overrides };
}

describe('the forged-tool corpus on QuickJSExecutor', () => {
  describe.each([
    ['library', library],
    ['written', written],
  ] as const)('the %s set', (_set, fixtures) => {
    it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))('%s', async (_id, fixture: CorpusFixture) => {
      const result = await forgeRun(
        fixture.code,
        env.fill(fixture.input),
        usesCapabilities(fixture) ? (fixture.allowlist as AllowlistName[]) : [],
        { timeoutMs: fixture.timeoutMs ?? 5000 },
      );
      expect(checkExpectation(fixture.expect, result)).toBeNull();
    });
  });
});

describe('the memory bound', () => {
  const grow = "function execute() { const a = []; for (;;) { a.push('x'.repeat(65536)); } }";

  it("ends a guest past its memory at the call's cap, and the next call runs", async () => {
    const started = performance.now();
    const ran = await executor.run(direct(grow, {}, { memoryMB: 16, timeoutMs: 10_000 }));
    expect(ran.status).toBe('memory_exceeded');
    expect(ran.memoryUsedBytes).toBeLessThanOrEqual(16 * MIB);
    expect(performance.now() - started).toBeLessThan(5000);
    const next = await executor.run(direct('function execute(input) { return input.a + input.b; }', { a: 2, b: 3 }));
    expect(next).toMatchObject({ status: 'ok', output: 5 });
  });

  it("grows the guest's memory up to its budget and no further", async () => {
    const ran = await executor.run(direct(grow, {}, { memoryMB: 48, timeoutMs: 10_000 }));
    expect(ran.status).toBe('memory_exceeded');
    expect(ran.memoryUsedBytes).toBeGreaterThan(16 * MIB);
    expect(ran.memoryUsedBytes).toBeLessThanOrEqual(48 * MIB);
  });

  it("runs a budget below the build's 16 MiB at that floor", async () => {
    const ran = await executor.run(direct(grow, {}, { memoryMB: 4, timeoutMs: 10_000 }));
    expect(ran).toMatchObject({ status: 'memory_exceeded', memoryUsedBytes: 16 * MIB });
  });

  it('reads through the forge as the memory limit', async () => {
    const result = await forgeRun(grow, {}, [], { memoryMB: 16, timeoutMs: 10_000 });
    expect(result).toMatchObject({ success: false, error: 'Execution exceeded its memory limit of 16 MB' });
  });

  it('ends the call out of memory when a host value does not fit what the guest has left', async () => {
    const { base } = await bytesServer();
    const result = await plain.execute({
      code: `async function execute(input) {
        const hold = [];
        try { for (;;) hold.push('x'.repeat(65536)); } catch (e) {}
        hold.length -= 16;
        const response = await fetch(input.url);
        return (await response.arrayBuffer()).byteLength;
      }`,
      input: { url: `${base}/bytes/${4 * MIB}` },
      allowlist: ['fetch'],
      memoryMB: 16,
      timeoutMs: 10_000,
    });
    expect(result).toMatchObject({ success: false, error: 'Execution exceeded its memory limit of 16 MB' });
  });

  it('lets a guest that catches the error answer within its memory', async () => {
    const ran = await executor.run(
      direct(
        "function execute() { const a = []; try { for (;;) { a.push('x'.repeat(65536)); } } catch (e) { a.length = 0; return String(e && e.message); } }",
        {},
        { memoryMB: 16, timeoutMs: 10_000 },
      ),
    );
    expect(ran).toMatchObject({ status: 'ok', output: 'out of memory' });
  });
});

describe('the deadline', () => {
  const cases: Array<[string, string, Record<string, unknown>, AllowlistName[]]> = [
    ['yield then spin', 'async function execute() { await Promise.resolve(); while (true) {} }', {}, []],
    ['spin after a host call', 'async function execute(input) { await fetch(input.url); for (;;) {} }', { url: '{{server}}/ok' }, ['fetch']],
    ['spin after a read', 'async function execute(input) { await fs.readFile(input.path); for (;;) {} }', { path: '{{root}}/notes.txt' }, ['fs.read']],
    ['a flood of microtasks', 'async function execute() { for (;;) { await null; } }', {}, []],
    ['a promise that never settles', 'async function execute() { await new Promise(() => {}); }', {}, []],
    ['a synchronous spin', 'function execute() { while (true) {} }', {}, []],
  ];

  it.each(cases)('stops %s at the deadline', async (_name, code, input, allowlist) => {
    const started = performance.now();
    const result = await forgeRun(code, env.fill(input), allowlist, { timeoutMs: 500 });
    const elapsed = performance.now() - started;
    expect(result).toMatchObject({ success: false, error: 'Execution timed out after 500ms' });
    expect(elapsed).toBeGreaterThanOrEqual(490);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('the stack', () => {
  it('ends deep recursion inside the guest, and recursion 1,000 deep runs', async () => {
    const deep = await executor.run(direct('function execute() { const f = (n) => f(n + 1) + 1; return f(0); }'));
    expect(deep).toMatchObject({ status: 'error', error: 'Execution error: stack overflow' });
    const ordinary = await executor.run(
      direct('function execute() { const f = (n) => (n === 0 ? 0 : 1 + f(n - 1)); return f(1000); }'),
    );
    expect(ordinary).toMatchObject({ status: 'ok', output: 1000 });
  });

  it('ends recursion inside a built-in as an error, and the next call runs', async () => {
    const nested = await executor.run(
      direct('function execute() { let v = []; for (let i = 0; i < 200000; i += 1) v = [v]; return JSON.stringify(v).length; }'),
    );
    expect(nested.status).toBe('error');
    const next = await executor.run(direct('function execute() { return 1; }'));
    expect(next).toMatchObject({ status: 'ok', output: 1 });
  });
});

describe('escape probes, on the executor past the forge validation', () => {
  const cryptoGlobals = {
    crypto: {
      randomUUID: () => randomUUID(),
      createHash: (algorithm: string) => createHash(algorithm),
      createHmac: (algorithm: string, key: string) => createHmac(algorithm, key),
    },
  };

  it('finds no host global, and no binding left behind by the prelude', async () => {
    const ran = await executor.run(
      direct(
        "function execute() { return [typeof process, typeof require, typeof globalThis, typeof Buffer, typeof module, typeof __host_utf8_encode, typeof __host_fetch].join(','); }",
      ),
    );
    expect(ran).toMatchObject({ status: 'ok', output: 'undefined,undefined,undefined,undefined,undefined,undefined,undefined' });
  });

  it.each([
    ['the Function constructor', "function execute() { const F = ({}).constructor.constructor; return F('return 42')(); }"],
    ['the global Function', "function execute() { return Function('return 42')(); }"],
    ['new Function', "function execute() { return new Function('return 42')(); }"],
    ['the async function constructor', "async function execute() { const A = (async () => {}).constructor; return await A('return 42')(); }"],
    ['the generator function constructor', "function execute() { const G = Object.getPrototypeOf(function* () {}).constructor; return G('yield 42')().next().value; }"],
    ['the async generator constructor', "async function execute() { const G = Object.getPrototypeOf(async function* () {}).constructor; return (await G('yield 42')().next()).value; }"],
    ['eval', "function execute() { return eval('40 + 2'); }"],
    ['a constructor reached through a granted function', "function execute() { return crypto.randomUUID.constructor('return 42')(); }"],
    ['a constructor put back', "function execute() { try { Function.prototype.constructor = function () { return () => 42; }; } catch (e) {} return ({}).constructor.constructor('return 42')(); }"],
  ])('refuses string code generation through %s', async (_name, code) => {
    const ran = await executor.run(direct(code, {}, { globals: cryptoGlobals }));
    expect(ran.status).toBe('error');
    expect(ran.status === 'error' ? ran.error : '').toContain('Code generation from strings disallowed for this context');
  });

  it("keeps functions what they were: instanceof Function, a function's constructor, eval of a non-string", async () => {
    const ran = await executor.run(
      direct(
        'function execute() { const f = () => 1; return [f instanceof Function, f.constructor === Function, typeof Function, eval(7)]; }',
      ),
    );
    expect(ran).toMatchObject({ status: 'ok', output: [true, true, 'function', 7] });
  });

  it("keeps the guest's prototype changes out of the host", async () => {
    const ran = await executor.run(
      direct("function execute() { Object.prototype.pollutedByGuest = 1; Array.prototype.pollutedByGuest = 1; return 'done'; }"),
    );
    expect(ran).toMatchObject({ status: 'ok', output: 'done' });
    expect(({} as Record<string, unknown>).pollutedByGuest).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).pollutedByGuest).toBeUndefined();
  });

  it('hands the guest a copy of its input', async () => {
    const input = { list: [1, 2, 3] };
    const ran = await executor.run(direct('function execute(input) { input.list.push(4); return input.list.length; }', input));
    expect(ran).toMatchObject({ status: 'ok', output: 4 });
    expect(input.list).toEqual([1, 2, 3]);
  });

  it('settles the call whatever the guest does to Promise', async () => {
    const ran = await executor.run(
      direct("async function execute() { Promise.prototype.then = function () { return 1; }; return 'kept'; }"),
    );
    expect(ran).toMatchObject({ status: 'ok', output: 'kept' });
  });

  it('removes the intrinsics the in-process context removes', async () => {
    const ran = await executor.run(
      direct(
        "function execute() { return [typeof Reflect, typeof Proxy, typeof WebAssembly, typeof SharedArrayBuffer, typeof Atomics, typeof setTimeout, typeof queueMicrotask].join(','); }",
      ),
    );
    expect(ran).toMatchObject({ status: 'ok', output: 'undefined,undefined,undefined,undefined,undefined,undefined,undefined' });
  });

  it('starts every call on a fresh guest', async () => {
    await executor.run(direct("this.leakedAcrossRuns = 'secret'; function execute() { return 1; }"));
    const ran = await executor.run(direct('function execute() { return typeof leakedAcrossRuns; }'));
    expect(ran).toMatchObject({ status: 'ok', output: 'undefined' });
  });

  it('refuses a result past 1 MB, as the in-process executor does', async () => {
    const limit = "Execution error: the result passed the QuickJS executor's output limit of 1 MB";
    // Past the limit in UTF-8 bytes, and past it in characters.
    expect(await executor.run(direct("function execute() { return 'é'.repeat(600000); }"))).toMatchObject({
      status: 'error',
      error: limit,
    });
    expect(await executor.run(direct("function execute() { return 'x'.repeat(2000000); }"))).toMatchObject({
      status: 'error',
      error: limit,
    });
  });
});

describe("the bindings' bounds", () => {
  // The legacy fetch (no ceiling) reads a body of any size; the call's memory budget bounds what the host
  // reads for the guest, across all of the call's fetches.
  const FETCH_SIZES =
    'async function execute(input) { const out = []; for (const url of input.urls) { try { const r = await fetch(url); out.push((await r.arrayBuffer()).byteLength); } catch (e) { out.push(String(e && e.message)); } } return out; }';

  it("fails a fetch once the call's response bodies pass its memory budget, counting them together", async () => {
    const { base: server } = await bytesServer();
    const base = `${server}/bytes`;
    const run = (urls: string[]) =>
      plain.execute({ code: FETCH_SIZES, input: { urls }, allowlist: ['fetch'], memoryMB: 32, timeoutMs: 10_000 });
    const limit = 'fetch: the response bodies of this call passed its limit of 32 MB';
    const fiveOfEight = Array.from({ length: 5 }, () => `${base}/${8 * MIB}`);
    expect((await run(fiveOfEight)).output).toEqual([8 * MIB, 8 * MIB, 8 * MIB, 8 * MIB, limit]);
    expect((await run([`${base}/${40 * MIB}`])).output).toEqual([limit]);
  });

  it('copies a large host buffer and a large host string into the guest exactly', async () => {
    const ran = await executor.run(
      direct(
        "function execute() { const text = 'ab'.repeat(40000); const bytes = new TextEncoder().encode(text); return [bytes.length, bytes[0], bytes[79999], new TextDecoder().decode(bytes) === text]; }",
      ),
    );
    expect(ran).toMatchObject({ status: 'ok', output: [80000, 97, 98, true] });
  });

  it('refuses a host call past the ones a call may have in flight', async () => {
    const { base } = await bytesServer();
    const result = await plain.execute({
      code: `async function execute(input) {
        const calls = [];
        for (let i = 0; i < ${MAX_PENDING_HOST_CALLS + 1}; i += 1) {
          calls.push(fetch(input.url).then((r) => r.status, (e) => String(e && e.message)));
        }
        return await Promise.all(calls);
      }`,
      input: { url: `${base}/bytes/16` },
      allowlist: ['fetch'],
      memoryMB: 64,
      timeoutMs: 10_000,
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual([
      ...Array.from({ length: MAX_PENDING_HOST_CALLS }, () => 200),
      `fetch: ${MAX_PENDING_HOST_CALLS} host calls are in flight in this call; await one before starting another`,
    ]);
  });

  it('aborts a request still running when the call ends, on the path without a ceiling', async () => {
    const { base, closed } = await bytesServer();
    // The call ends only once the server holds the first request: a request
    // started and abandoned in one turn is aborted before it is ever sent.
    const result = await plain.execute({
      code: "async function execute(input) { fetch(input.hold).catch(() => undefined); return (await fetch(input.whenHeld)).text(); }",
      input: { hold: `${base}/hold`, whenHeld: `${base}/when-held` },
      allowlist: ['fetch'],
      memoryMB: 64,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ success: true, output: 'held' });
    await expect.poll(() => closed, { timeout: 2000 }).toEqual(['/hold']);
  });

  it("holds open hashes to the call's limit and frees one when it is digested", async () => {
    const result = await plain.execute({
      code: `function execute() {
        const open = [];
        for (let i = 0; i < ${MAX_OPEN_DIGESTS}; i += 1) open.push(crypto.createHash('sha256'));
        let refused = '';
        try { crypto.createHash('sha256'); } catch (e) { refused = String(e && e.message); }
        const digest = open[0].update('x').digest('hex');
        crypto.createHash('sha256');
        return { refused, digest };
      }`,
      input: {},
      allowlist: ['crypto'],
      memoryMB: 64,
      timeoutMs: 5000,
    });
    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      refused: `crypto: ${MAX_OPEN_DIGESTS} hashes are open in this call; call digest() on one before starting another`,
      digest: createHash('sha256').update('x').digest('hex'),
    });
  });
});

describe('Intl, formatted through the host', () => {
  const INTL_TOOL = `function execute() {
    const date = new Date(Date.UTC(2026, 9, 7, 15, 30));
    const names = ['zebra', 'Apple', 'éclair', 'apple', 'Zulu'];
    return {
      dateTime: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'short' }).format(date),
      parts: new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric' }).formatToParts(date),
      currency: new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(1234.5),
      compact: new Intl.NumberFormat('en', { notation: 'compact' }).format(1234567),
      sorted: [...names].sort(new Intl.Collator('en').compare),
      byLocaleCompare: [...names].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' })),
      plural: [0, 1, 2, 3].map((n) => new Intl.PluralRules('en', { type: 'ordinal' }).select(n)),
      relative: new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-1, 'day'),
      list: new Intl.ListFormat('en', { type: 'conjunction' }).format(['a', 'b', 'c']),
      region: new Intl.DisplayNames(['en'], { type: 'region' }).of('DE'),
      dateLocale: date.toLocaleString('en-US', { timeZone: 'UTC' }),
      dateOnly: date.toLocaleDateString('ja-JP', { timeZone: 'UTC' }),
      timeOnly: date.toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false }),
      number: (1234567.891).toLocaleString('en-IN'),
      big: (12345678901234567890n).toLocaleString('en-US'),
      array: [1234.5, 6789.25].toLocaleString('de-DE'),
      locale: new Intl.NumberFormat('en-US').resolvedOptions().locale,
      supported: Intl.DateTimeFormat.supportedLocalesOf(['en-US', 'tlh']),
    };
  }`;

  it('gives what the in-process context gives', async () => {
    const onQuickJS = await plain.execute({ code: INTL_TOOL, input: {}, allowlist: [], memoryMB: 64, timeoutMs: 5000 });
    const inProcess = await new SandboxedToolForge().execute({
      code: INTL_TOOL,
      input: {},
      allowlist: [],
      memoryMB: 64,
      timeoutMs: 5000,
    });
    expect(inProcess.success).toBe(true);
    expect(onQuickJS.success).toBe(true);
    expect(onQuickJS.output).toEqual(inProcess.output);
  });

  it('throws for a locale or an option the host refuses, as the host does', async () => {
    const result = await plain.execute({
      code: "function execute() { try { new Intl.NumberFormat('en', { style: 'currency' }); return 'built'; } catch (e) { return e.name; } }",
      input: {},
      allowlist: [],
      memoryMB: 64,
      timeoutMs: 5000,
    });
    expect(result).toMatchObject({ success: true, output: 'TypeError' });
  });
});
