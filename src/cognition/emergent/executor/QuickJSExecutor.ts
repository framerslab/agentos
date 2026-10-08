/**
 * @fileoverview An executor that runs forged code in QuickJS compiled to
 * WebAssembly, one instance per call.
 *
 * QuickJS comes from two optional peer dependencies, `quickjs-emscripten-core`
 * and `@jitl/quickjs-wasmfile-release-sync`, both at {@link QUICKJS_VERSION},
 * imported when the executor loads. The variant's WebAssembly is compiled
 * once. Each call instantiates it on a fresh `WebAssembly.Memory` whose
 * maximum is the call's `memoryMB` (never below the build's initial 16 MiB,
 * never above its 2,048 MiB maximum), runs one QuickJS runtime and context in
 * it, and drops all of it when the call ends. Under Emscripten QuickJS's own
 * memory limit counts only each allocation's overhead, so the memory's
 * maximum is the bound. The granted functions reach the guest as host
 * functions that take and return data (guest-surface.ts), under a prelude
 * evaluated before the forged code (guest-prelude.ts).
 *
 * The binding layer copies a host value into the guest's memory without
 * checking its allocation, so a value of more than 4 KiB is copied only after
 * QuickJS's own allocator has found room for it: a host value that does not
 * fit ends the call `memory_exceeded`. Smaller values and the boxes of new
 * handles take the unchecked path; they fail only in a guest that has left
 * itself less free memory than their size, and then only that call's own
 * instance is affected.
 *
 * What the host copies out of the guest is bounded as well. A binding's
 * argument that is a string has its length read before it is copied, and any
 * other argument crosses as its JSON, made in the guest by a `JSON.stringify`
 * taken before any guest code ran; what one call hands the host counts
 * against its memory budget, two bytes a UTF-16 code unit. A thrown value is
 * reported by its message, cut in the guest at {@link THROWN_TEXT_CHARS}
 * characters, and a result is read only as the JSON text the wrapper makes.
 *
 * The guest runs on the host's thread: a guest that runs synchronously holds
 * the event loop until the interrupt handler stops it at the call's deadline.
 *
 * @module @framers/agentos/emergent/executor/QuickJSExecutor
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type {
  QuickJSContext,
  QuickJSDeferredPromise,
  QuickJSHandle,
  QuickJSRuntime,
  QuickJSSyncVariant,
} from 'quickjs-emscripten-core';
import { GUEST_PRELUDE } from './guest-prelude.js';
import { guestBindings, type Binding } from './guest-surface.js';
import type { ExecutorRunRequest, ExecutorRunResult, ForgedCodeExecutor } from './types.js';

/** The version of both QuickJS packages this release runs on. */
export const QUICKJS_VERSION = '0.32.0';

/** Host calls (`fetch` and the file functions) one call may have in flight at once. */
export const MAX_PENDING_HOST_CALLS = 16;

const CORE_PACKAGE = 'quickjs-emscripten-core';
const VARIANT_PACKAGE = '@jitl/quickjs-wasmfile-release-sync';

/** The bindings that start host work and answer with a promise. */
const ASYNC_BINDINGS: ReadonlySet<string> = new Set(['fetch', 'fs_readFile', 'fs_writeFile', 'fs_unlink']);

const PAGE_BYTES = 65_536;
const MIB = 1_048_576;
/** The variant's initial memory: Emscripten's default 16 MiB, 5 MiB of it the C stack. */
const INITIAL_PAGES = 256;
/** The variant's maximum memory: Emscripten's default 2,048 MiB with memory growth. */
const MAXIMUM_PAGES = 32_768;
/** QuickJS's stack limit. At 1 MiB, deep recursion exhausts the host's own stack first. */
const STACK_BYTES = 256 * 1024;
/** The result's limit after JSON, in UTF-8 bytes, as the in-process executor's output limit. */
const RESULT_LIMIT_BYTES = 1_048_576;
/** Host values larger than this are copied in only after QuickJS's allocator has found room for them. */
const CHECKED_COPY_BYTES = 4 * 1024;
/** How much of a thrown value's text a failed call reports; a longer text is cut in the guest before it is copied out. */
const THROWN_TEXT_CHARS = 16_384;
/** The longest delay Node's timers keep (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Made in each guest from its intrinsics before any guest code runs, so
 * nothing the forged code changes later reaches them: an allocation through
 * QuickJS's checked allocator, `JSON.stringify`, and a reader of what a
 * thrown value says, cut at a limit inside the guest.
 */
const GUEST_HELPERS = [
  '((AB, S, P, Str, slice) => [',
  '  (n) => new AB(n),',
  '  (v) => S(v),',
  '  (e, limit) => {',
  '    let text;',
  '    try {',
  "      const m = e !== null && typeof e === 'object' ? e.message : undefined;",
  "      text = typeof m === 'string' ? m : Str(e);",
  '    } catch (x) {',
  "      text = '(the thrown value could not be read)';",
  '    }',
  "    return S(text.length > limit ? slice(text, 0, limit) + ' (cut at ' + limit + ' characters)' : text);",
  '  },',
  '  (t) => P(t),',
  '])(ArrayBuffer, JSON.stringify, JSON.parse, String, Function.prototype.call.bind(String.prototype.slice))',
].join('\n');

/**
 * A string the binding layer cannot copy whole: it copies a string as a C
 * string, so a U+0000 ends it, and it encodes a lone surrogate wrongly. Such
 * a string crosses as JSON, which escapes both.
 */
function needsJson(value: string): boolean {
  // A string, not a regular expression: eslint's no-control-regex refuses U+0000 in one.
  return value.includes('\u0000') || /[\uD800-\uDFFF]/.test(value);
}

/**
 * The QuickJS packages are missing, at another version, or failed to load.
 * {@link QuickJSExecutor.create} and `ready()` reject with it; a call on an
 * executor that could not load fails with its message.
 */
export class QuickJSUnavailableError extends Error {
  readonly code = 'quickjs_unavailable';

  constructor(detail: string) {
    super(
      `quickjs_unavailable: QuickJSExecutor needs ${CORE_PACKAGE} and ${VARIANT_PACKAGE}, both at ${QUICKJS_VERSION}, installed beside @framers/agentos (${detail})`,
    );
    this.name = 'QuickJSUnavailableError';
  }
}

interface QuickJSEngine {
  readonly core: typeof import('quickjs-emscripten-core');
  readonly variant: QuickJSSyncVariant;
  readonly compiled: WebAssembly.Module;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorShape(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

/** The version in the package.json of `name`, found above its resolved entry point. */
async function installedVersion(require: ReturnType<typeof createRequire>, name: string): Promise<string> {
  // The core's exports map does not export its package.json, so both are read
  // from the file system above the entry the resolver returns.
  let dir = path.dirname(require.resolve(name));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === name) {
        return String(manifest.version);
      }
    } catch {
      // Not this directory; look one up.
    }
    dir = path.dirname(dir);
  }
  throw new Error(`the version of ${name} could not be read`);
}

async function loadEngine(): Promise<QuickJSEngine> {
  const require = createRequire(import.meta.url);
  let core: typeof import('quickjs-emscripten-core');
  let variant: QuickJSSyncVariant;
  try {
    core = await import(/* webpackIgnore: true */ 'quickjs-emscripten-core');
    variant = (await import(/* webpackIgnore: true */ '@jitl/quickjs-wasmfile-release-sync')).default;
  } catch (error) {
    throw new QuickJSUnavailableError(`not installed: ${message(error)}`);
  }
  try {
    for (const name of [CORE_PACKAGE, VARIANT_PACKAGE]) {
      const version = await installedVersion(require, name);
      if (version !== QUICKJS_VERSION) {
        throw new Error(`${name} is ${version}`);
      }
    }
    const wasm = await readFile(require.resolve(`${VARIANT_PACKAGE}/wasm`));
    return { core, variant, compiled: await WebAssembly.compile(new Uint8Array(wasm)) };
  } catch (error) {
    throw new QuickJSUnavailableError(message(error));
  }
}

/**
 * The pages of the call's memory: its `memoryMB`, held between the build's
 * initial and maximum memory. A budget past the maximum, `Infinity` included,
 * runs at the maximum; one that is not a positive number runs at the initial.
 */
function maximumPagesFor(memoryMB: number): number {
  const requested =
    memoryMB === Number.POSITIVE_INFINITY
      ? MAXIMUM_PAGES
      : Number.isFinite(memoryMB) && memoryMB > 0
        ? Math.ceil((memoryMB * MIB) / PAGE_BYTES)
        : 0;
  return Math.min(MAXIMUM_PAGES, Math.max(INITIAL_PAGES, requested));
}

/** An allocation failure the WebAssembly module reported to the host rather than to QuickJS. */
function isHostOutOfMemory(error: unknown): boolean {
  return /out of memory|Aborted\(OOM\)|Cannot enlarge memory/i.test(message(error));
}

/**
 * About how many bytes of guest memory a host value takes once copied in,
 * with room for the boxes and temporary copies the binding layer makes;
 * anything that is not data throws.
 */
function guestBytes(value: unknown): number {
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') {
    return 32;
  }
  if (typeof value === 'string') {
    // A string that crosses as JSON takes its escaped text and the parsed copy.
    return (needsJson(value) ? 9 : 4) * value.length + 64;
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return value.byteLength + 64;
  }
  if (Array.isArray(value)) {
    return value.reduce<number>((total, item) => total + guestBytes(item), 128);
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto === Object.prototype || proto === null) {
      return Object.entries(value as Record<string, unknown>).reduce<number>(
        (total, [key, item]) => total + 4 * key.length + 128 + guestBytes(item),
        128,
      );
    }
  }
  throw new TypeError(`${Object.prototype.toString.call(value)} cannot cross into the guest`);
}

/**
 * Runs forged code in QuickJS compiled to WebAssembly, an instance per call.
 * Declares `isolates: true`: the guest's heap is the call's own WebAssembly
 * memory, and only data crosses between the host and the guest.
 */
export class QuickJSExecutor implements ForgedCodeExecutor {
  readonly name = 'quickjs-wasm';
  readonly isolates = true;
  private engine: Promise<QuickJSEngine> | undefined;

  /** An executor whose engine has loaded; rejects with {@link QuickJSUnavailableError} when it cannot load. */
  static async create(): Promise<QuickJSExecutor> {
    const executor = new QuickJSExecutor();
    await executor.ready();
    return executor;
  }

  /**
   * Imports the two packages, checks their versions and compiles the
   * variant's WebAssembly, once; rejects with {@link QuickJSUnavailableError}.
   * A failure is kept: later calls fail with it. The engine awaits this
   * before a forge's test cases.
   */
  async ready(): Promise<void> {
    await (this.engine ??= loadEngine());
  }

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    // The interrupt handler compares the clock with the deadline, which a
    // timeout that is not a positive finite number never brings.
    if (!(typeof request.timeoutMs === 'number' && Number.isFinite(request.timeoutMs) && request.timeoutMs > 0)) {
      return {
        status: 'error',
        error: `Execution error: timeoutMs must be a positive finite number of milliseconds, got ${String(request.timeoutMs)}`,
        memoryUsedBytes: 0,
      };
    }
    let engine: QuickJSEngine;
    try {
      engine = await (this.engine ??= loadEngine());
    } catch (error) {
      return { status: 'error', error: `Execution error: ${message(error)}`, memoryUsedBytes: 0 };
    }

    const maximumPages = maximumPagesFor(request.memoryMB);
    const memory = new WebAssembly.Memory({ initial: INITIAL_PAGES, maximum: maximumPages });
    // Ended with the call: host work the call started (a request on the path
    // without a ceiling) stops with it.
    const ended = new AbortController();
    let runtime: QuickJSRuntime | undefined;
    let guest: GuestRun | undefined;
    let result: ExecutorRunResult;
    try {
      const module = await engine.core.newQuickJSWASMModuleFromVariant(
        engine.core.newVariant(engine.variant, { wasmModule: engine.compiled, wasmMemory: memory }),
      );
      runtime = module.newRuntime();
      runtime.setMemoryLimit(maximumPages * PAGE_BYTES);
      runtime.setMaxStackSize(STACK_BYTES);
      guest = new GuestRun(runtime, memory, performance.now() + request.timeoutMs, request.signal);
      result = await guest.execute(request, maximumPages * PAGE_BYTES, ended.signal);
    } catch (error) {
      const memoryUsedBytes = memory.buffer.byteLength;
      result = isHostOutOfMemory(error)
        ? { status: 'memory_exceeded', memoryUsedBytes }
        : { status: 'error', error: `Execution error: the executor failed: ${message(error)}`, memoryUsedBytes };
    }
    ended.abort();
    try {
      guest?.dispose();
      runtime?.dispose();
    } catch {
      // The instance is this call's alone and is dropped either way.
    }
    return result;
  }
}

/**
 * One call's guest: its context, the host work it started and its open
 * promises. Dispose drops every reference to the instance, its memory
 * included, so host work still settling after the call holds none of the
 * call's memory.
 */
class GuestRun {
  private context: QuickJSContext | undefined;
  private runtime: QuickJSRuntime | undefined;
  private memory: WebAssembly.Memory | undefined;
  private allocate: QuickJSHandle | undefined;
  private stringify: QuickJSHandle | undefined;
  private describe: QuickJSHandle | undefined;
  private parse: QuickJSHandle | undefined;
  /** What the call has handed the host so far, in bytes, and how much it may. */
  private handed = 0;
  private handLimit = 0;
  private exhausted = false;
  private interrupted = false;
  private nextDeferred = 1;
  private readonly deferreds = new Map<number, QuickJSDeferredPromise>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    runtime: QuickJSRuntime,
    memory: WebAssembly.Memory,
    private readonly deadline: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.runtime = runtime;
    this.memory = memory;
    runtime.setInterruptHandler(() => {
      if (performance.now() > this.deadline || this.signal?.aborted === true) {
        this.interrupted = true;
      }
      return this.interrupted || this.exhausted;
    });
    this.context = runtime.newContext();
  }

  private get live(): { context: QuickJSContext; runtime: QuickJSRuntime } {
    if (!this.context || !this.runtime) {
      throw new Error('the call has ended');
    }
    return { context: this.context, runtime: this.runtime };
  }

  async execute(request: ExecutorRunRequest, memoryBytes: number, ended: AbortSignal): Promise<ExecutorRunResult> {
    const { context, runtime } = this.live;

    const helpers = context.evalCode(GUEST_HELPERS, 'guest-helpers.js', { type: 'global' });
    if (helpers.error) {
      return this.failure(helpers.error, 'the guest helpers failed: ');
    }
    const made = context.unwrapResult(helpers);
    this.allocate = context.getProp(made, 0);
    this.stringify = context.getProp(made, 1);
    this.describe = context.getProp(made, 2);
    this.parse = context.getProp(made, 3);
    made.dispose();
    this.handLimit = memoryBytes;

    const bindings = guestBindings(request.globals, {
      bodyBytes: memoryBytes,
      // Under a ceiling the broker ends the call's requests; without one, this does.
      ...(request.signal ? {} : { signal: ended }),
    });
    for (const [name, binding] of Object.entries(bindings)) {
      this.install(name, binding);
    }
    const prelude = context.evalCode(GUEST_PRELUDE, 'guest-prelude.js', { type: 'global' });
    if (prelude.error) {
      return this.failure(prelude.error, 'the guest prelude failed: ');
    }
    context.unwrapResult(prelude).dispose();

    // The in-process wrapper's contract: the code runs inside an async
    // function, so top-level await and return behave as they do there.
    const wrapped = [
      '(async () => {',
      `${request.code};`,
      "const __entry = typeof execute === 'function' ? execute : (typeof run === 'function' ? run : null);",
      'if (!__entry) {',
      "  throw new Error('Sandboxed tool must define execute(input) or run(input).');",
      '}',
      `const __out = await __entry(${JSON.stringify(request.input)});`,
      'return __out === undefined ? undefined : JSON.stringify(__out);',
      '})()',
    ].join('\n');
    // The source and its input are copied in unchecked, like any host value.
    if (4 * wrapped.length > CHECKED_COPY_BYTES) {
      const room = this.allocateGuest(4 * wrapped.length + 64);
      if (!room) {
        return this.noRoom();
      }
      room.dispose();
    }
    const evaluated = context.evalCode(wrapped, 'forged.js', { type: 'global' });
    if (evaluated.error) {
      return this.failure(evaluated.error);
    }
    const promise = context.unwrapResult(evaluated);
    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          return this.failure(jobs.error);
        }
        if (this.exhausted) {
          return { status: 'memory_exceeded', memoryUsedBytes: this.memoryUsed() };
        }
        if (this.interrupted) {
          return { status: 'timeout', memoryUsedBytes: this.memoryUsed() };
        }
        const state = context.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          try {
            return this.readResult(state.value);
          } finally {
            if (!state.notAPromise && state.value.alive) {
              state.value.dispose();
            }
          }
        }
        if (state.type === 'rejected') {
          return this.failure(state.error);
        }
        if (performance.now() > this.deadline || this.signal?.aborted === true) {
          return { status: 'timeout', memoryUsedBytes: this.memoryUsed() };
        }
        await this.progress();
      }
    } finally {
      if (promise.alive) {
        promise.dispose();
      }
    }
  }

  /** Frees what the call holds in the guest and drops every reference to the instance. */
  dispose(): void {
    for (const deferred of this.deferreds.values()) {
      if (deferred.alive) {
        deferred.dispose();
      }
    }
    this.deferreds.clear();
    for (const helper of [this.allocate, this.stringify, this.describe, this.parse]) {
      if (helper?.alive) {
        helper.dispose();
      }
    }
    this.allocate = undefined;
    this.stringify = undefined;
    this.describe = undefined;
    this.parse = undefined;
    const context = this.context;
    this.context = undefined;
    this.runtime = undefined;
    this.memory = undefined;
    context?.dispose();
  }

  private memoryUsed(): number {
    return this.memory?.buffer.byteLength ?? 0;
  }

  /**
   * How a probe that found no room ends the call. The probe runs guest code,
   * so the interrupt handler can stop it at the deadline or on the call's
   * signal; the handler marks that first, and the call then ends as timed
   * out, not out of memory.
   */
  private noRoom(): ExecutorRunResult {
    const memoryUsedBytes = this.memoryUsed();
    if (this.interrupted) {
      return { status: 'timeout', memoryUsedBytes };
    }
    this.exhausted = true;
    return { status: 'memory_exceeded', memoryUsedBytes };
  }

  /** An ArrayBuffer of `bytes` made by QuickJS's checked allocator, or undefined when the guest's memory cannot hold it. */
  private allocateGuest(bytes: number): QuickJSHandle | undefined {
    const { context } = this.live;
    if (!this.allocate) {
      return undefined;
    }
    const size = context.newNumber(bytes);
    try {
      const made = context.callFunction(this.allocate, context.undefined, size);
      if (made.error) {
        made.error.dispose();
        return undefined;
      }
      return context.unwrapResult(made);
    } finally {
      size.dispose();
    }
  }

  /**
   * Host data into a new guest value, when the guest's memory can hold it.
   * A value of more than {@link CHECKED_COPY_BYTES} is checked first by
   * QuickJS's allocator: a buffer of the value's size is made and freed, and
   * the value is built in the room that leaves. (The binding layer offers no
   * write into a guest buffer: `getArrayBuffer` hands back a copy.) A value
   * that does not fit marks the call out of memory; the guest gets undefined
   * and is stopped at its next interrupt check.
   */
  private deliver(value: unknown): QuickJSHandle {
    const { context } = this.live;
    const bytes = guestBytes(value);
    if (bytes > CHECKED_COPY_BYTES) {
      const room = this.allocateGuest(bytes);
      if (!room) {
        this.noRoom();
        return context.undefined;
      }
      room.dispose();
    }
    return this.toHandle(value);
  }

  private install(name: string, binding: Binding): void {
    const { context } = this.live;
    const fn = context.newFunction(`__host_${name}`, (...args: QuickJSHandle[]) => {
      const live = this.live;
      if (ASYNC_BINDINGS.has(name) && this.pending.size >= MAX_PENDING_HOST_CALLS) {
        return {
          error: live.context.newError({
            name: 'RangeError',
            message: `${name}: ${MAX_PENDING_HOST_CALLS} host calls are in flight in this call; await one before starting another`,
          }),
        };
      }
      let values: unknown[];
      try {
        values = args.map((arg) => this.take(arg));
      } catch (error) {
        return {
          error: live.context.newError(
            error instanceof RangeError
              ? { name: 'RangeError', message: `${name}: ${message(error)}` }
              : { name: 'TypeError', message: `${name} takes data only: ${message(error)}` },
          ),
        };
      }
      let result: unknown;
      try {
        result = binding(...values);
      } catch (error) {
        return { error: live.context.newError(errorShape(error)) };
      }
      if (result instanceof Promise) {
        return this.bridge(result);
      }
      try {
        return this.deliver(result);
      } catch (error) {
        return {
          error: live.context.newError({ name: 'TypeError', message: `${name} returned a value that is not data: ${message(error)}` }),
        };
      }
    });
    context.setProp(context.global, `__host_${name}`, fn);
    fn.dispose();
  }

  /**
   * A binding's argument as host data, read with a bound. A string's length
   * is read before it is copied: a primitive string's length is its own,
   * whatever the guest has done to `String.prototype`. Any other value
   * crosses as its JSON, made in the guest by the `JSON.stringify` taken
   * before any guest code ran. A symbol, a function or a bigint is not data.
   */
  private take(handle: QuickJSHandle): unknown {
    const { context } = this.live;
    const type = context.typeof(handle);
    if (type === 'undefined') {
      return undefined;
    }
    if (type === 'number') {
      return context.getNumber(handle);
    }
    if (type === 'boolean') {
      return context.dump(handle) as boolean;
    }
    // A string crosses as its JSON too: the binding layer copies a string as
    // a C string, which a U+0000 would end.
    if ((type === 'string' || type === 'object') && this.stringify) {
      const made = context.callFunction(this.stringify, context.undefined, handle);
      if (made.error) {
        made.error.dispose();
        throw new TypeError('the value could not be turned into JSON');
      }
      const json = context.unwrapResult(made);
      try {
        return context.typeof(json) === 'string' ? (JSON.parse(this.readString(json)) as unknown) : undefined;
      } finally {
        json.dispose();
      }
    }
    throw new TypeError(`${type} values are not data`);
  }

  /**
   * A guest string, copied out once its length is known. A binding's
   * argument counts against what the call may hand the host (two bytes a
   * UTF-16 code unit, the call's memory budget in all), and a long string is
   * copied only once QuickJS's allocator has found room in the guest for the
   * UTF-8 copy the binding layer makes on the way out.
   */
  private readString(handle: QuickJSHandle, counted = true): string {
    const { context } = this.live;
    const lengthHandle = context.getProp(handle, 'length');
    const length = context.getNumber(lengthHandle);
    lengthHandle.dispose();
    const bytes = counted ? 2 * length : 0;
    if (bytes > this.handLimit - this.handed) {
      throw new RangeError(`the data this call handed the host passed its limit of ${Math.round(this.handLimit / MIB)} MB`);
    }
    if (3 * length > CHECKED_COPY_BYTES) {
      const room = this.allocateGuest(3 * length + 64);
      if (!room) {
        throw new RangeError(this.noRoom().status === 'timeout' ? 'interrupted' : 'out of memory');
      }
      room.dispose();
    }
    this.handed += bytes;
    return context.getString(handle);
  }

  /**
   * A guest promise settled by a host promise; the guest's continuation runs
   * at the next pump. The host promise's reactions hold this run and the
   * promise's id only, so after the call they reach nothing of the instance.
   */
  private bridge(result: Promise<unknown>): QuickJSHandle {
    const { context } = this.live;
    const deferred = context.newPromise();
    const id = this.nextDeferred;
    this.nextDeferred += 1;
    this.deferreds.set(id, deferred);
    const settled: Promise<void> = result
      .then(
        (value) => this.settle(id, { value }),
        (error: unknown) => this.settle(id, { error }),
      )
      .catch(() => undefined)
      .finally(() => {
        this.pending.delete(settled);
      });
    this.pending.add(settled);
    return deferred.handle;
  }

  private settle(id: number, outcome: { value: unknown } | { error: unknown }): void {
    const deferred = this.deferreds.get(id);
    this.deferreds.delete(id);
    if (!deferred || !deferred.alive || !this.context) {
      return;
    }
    const context = this.context;
    try {
      if ('value' in outcome) {
        let handle: QuickJSHandle;
        try {
          handle = this.deliver(outcome.value);
        } catch (error) {
          const rejection = context.newError({
            name: 'TypeError',
            message: `the host returned a value that is not data: ${message(error)}`,
          });
          deferred.reject(rejection);
          rejection.dispose();
          return;
        }
        deferred.resolve(handle);
        if (handle.alive) {
          handle.dispose();
        }
        return;
      }
      const rejection = context.newError(errorShape(outcome.error));
      deferred.reject(rejection);
      rejection.dispose();
    } finally {
      if (deferred.alive) {
        deferred.dispose();
      }
    }
  }

  /** Host data into a new guest value, built through the binding layer; anything that is not data throws. */
  private toHandle(value: unknown): QuickJSHandle {
    const { context } = this.live;
    if (value === undefined) return context.undefined;
    if (value === null) return context.null;
    if (typeof value === 'boolean') return value ? context.true : context.false;
    if (typeof value === 'number') return context.newNumber(value);
    if (typeof value === 'string') {
      if (!needsJson(value) || !this.parse) {
        return context.newString(value);
      }
      // JSON escapes what the binding layer's C-string copy would lose.
      const json = context.newString(JSON.stringify(value));
      try {
        const made = context.callFunction(this.parse, context.undefined, json);
        if (made.error) {
          made.error.dispose();
          throw new TypeError('a string could not be copied into the guest');
        }
        return context.unwrapResult(made);
      } finally {
        json.dispose();
      }
    }
    if (value instanceof Uint8Array) {
      return context.newArrayBuffer(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    }
    if (value instanceof ArrayBuffer) return context.newArrayBuffer(value.slice(0));
    if (Array.isArray(value)) {
      const array = context.newArray();
      try {
        value.forEach((item, index) => {
          const handle = this.toHandle(item);
          context.setProp(array, index, handle);
          handle.dispose();
        });
      } catch (error) {
        array.dispose();
        throw error;
      }
      return array;
    }
    if (typeof value === 'object') {
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto === Object.prototype || proto === null) {
        const object = context.newObject();
        try {
          for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            const handle = this.toHandle(item);
            context.setProp(object, key, handle);
            handle.dispose();
          }
        } catch (error) {
          object.dispose();
          throw error;
        }
        return object;
      }
    }
    throw new TypeError(`${Object.prototype.toString.call(value)} cannot cross into the guest`);
  }

  /** Waits for a host operation to settle, the deadline, or the call's signal. */
  private async progress(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const waits: Promise<unknown>[] = [...this.pending];
    waits.push(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.min(MAX_TIMER_MS, Math.max(0, this.deadline - performance.now()) + 1));
      }),
    );
    const signal = this.signal;
    if (signal) {
      waits.push(
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      );
    }
    try {
      await Promise.race(waits);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (signal && onAbort) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * The call's result: undefined, or the JSON text the wrapper made. The
   * text is copied out through an allocation the binding layer does not
   * check, so its length is read first: past the output limit it is not
   * copied, and a long text is copied only once QuickJS's allocator has found
   * room for the copy.
   */
  private readResult(handle: QuickJSHandle): ExecutorRunResult {
    const { context } = this.live;
    const type = context.typeof(handle);
    if (type === 'undefined') {
      return this.success(undefined);
    }
    if (type !== 'string') {
      // The wrapper returns JSON text or undefined; anything else means the
      // forged code replaced JSON.stringify, and the value is not read.
      return { status: 'error', error: 'Execution error: the result was not JSON text', memoryUsedBytes: this.memoryUsed() };
    }
    const lengthHandle = context.getProp(handle, 'length');
    const length = context.getNumber(lengthHandle);
    lengthHandle.dispose();
    // More characters than the limit's bytes is past the limit in UTF-8 too.
    if (length > RESULT_LIMIT_BYTES) {
      return this.overLimit();
    }
    if (3 * length > CHECKED_COPY_BYTES) {
      const room = this.allocateGuest(3 * length + 64);
      if (!room) {
        return this.noRoom();
      }
      room.dispose();
    }
    return this.success(context.getString(handle));
  }

  private success(value: unknown): ExecutorRunResult {
    const memoryUsedBytes = this.memoryUsed();
    if (typeof value !== 'string') {
      return { status: 'ok', output: value, memoryUsedBytes };
    }
    if (Buffer.byteLength(value, 'utf8') > RESULT_LIMIT_BYTES) {
      return this.overLimit();
    }
    try {
      return { status: 'ok', output: JSON.parse(value) as unknown, memoryUsedBytes };
    } catch {
      return { status: 'ok', output: value, memoryUsedBytes };
    }
  }

  private overLimit(): ExecutorRunResult {
    return {
      status: 'error',
      error: "Execution error: the result passed the QuickJS executor's output limit of 1 MB",
      memoryUsedBytes: this.memoryUsed(),
    };
  }

  /** How a call that threw ended: out of memory or past its deadline before anything the error says. */
  private failure(errorHandle: QuickJSHandle, prefix = ''): ExecutorRunResult {
    let text = '';
    if (!this.exhausted && !this.interrupted) {
      try {
        text = this.thrownText(errorHandle);
      } catch (readError) {
        text = `(the error could not be read: ${message(readError)})`;
      }
    }
    if (errorHandle.alive) {
      errorHandle.dispose();
    }
    // Reading the text runs guest code (a message getter, a toString), which
    // can itself pass the deadline or the memory.
    const memoryUsedBytes = this.memoryUsed();
    if (this.exhausted || this.interrupted) {
      return this.exhausted ? { status: 'memory_exceeded', memoryUsedBytes } : { status: 'timeout', memoryUsedBytes };
    }
    if (text === 'out of memory') {
      return { status: 'memory_exceeded', memoryUsedBytes };
    }
    return { status: 'error', error: `Execution error: ${prefix}${text}`, memoryUsedBytes };
  }

  /**
   * What a thrown value says: its message when it has a string one, the value
   * as text otherwise, cut in the guest at {@link THROWN_TEXT_CHARS}
   * characters so no long text is copied out.
   */
  private thrownText(errorHandle: QuickJSHandle): string {
    const { context } = this.live;
    if (!this.describe) {
      // The helpers failed to build: only the executor's own code has run.
      const error = context.dump(errorHandle) as unknown;
      const shape = error !== null && typeof error === 'object' ? (error as { message?: unknown }) : undefined;
      return typeof shape?.message === 'string' ? shape.message : String(error);
    }
    const limit = context.newNumber(THROWN_TEXT_CHARS);
    try {
      const made = context.callFunction(this.describe, context.undefined, errorHandle, limit);
      if (made.error) {
        made.error.dispose();
        return '(the thrown value could not be read)';
      }
      const text = context.unwrapResult(made);
      try {
        return context.typeof(text) === 'string'
          ? (JSON.parse(this.readString(text, false)) as string)
          : '(the thrown value could not be read)';
      } finally {
        text.dispose();
      }
    } finally {
      limit.dispose();
    }
  }
}
