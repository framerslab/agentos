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

/** Host calls (`fetch`, `fs.readFile`) one call may have in flight at once. */
export const MAX_PENDING_HOST_CALLS = 16;

const CORE_PACKAGE = 'quickjs-emscripten-core';
const VARIANT_PACKAGE = '@jitl/quickjs-wasmfile-release-sync';

/** The bindings that start host work and answer with a promise. */
const ASYNC_BINDINGS: ReadonlySet<string> = new Set(['fetch', 'fs_readFile']);

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

/** The pages of the call's memory: its `memoryMB`, held between the build's initial and maximum memory. */
function maximumPagesFor(memoryMB: number): number {
  const requested = Number.isFinite(memoryMB) && memoryMB > 0 ? Math.ceil((memoryMB * MIB) / PAGE_BYTES) : 0;
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
    return 4 * value.length + 64;
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
 * promises. Dispose drops every reference to the instance,
 * so host work still settling after the call holds none of the call's memory.
 */
class GuestRun {
  private context: QuickJSContext | undefined;
  private runtime: QuickJSRuntime | undefined;
  private allocate: QuickJSHandle | undefined;
  private exhausted = false;
  private interrupted = false;
  private nextDeferred = 1;
  private readonly deferreds = new Map<number, QuickJSDeferredPromise>();
  private readonly pending = new Set<Promise<void>>();

  constructor(
    runtime: QuickJSRuntime,
    private readonly memory: WebAssembly.Memory,
    private readonly deadline: number,
    private readonly signal: AbortSignal | undefined,
  ) {
    this.runtime = runtime;
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

    // The intrinsic ArrayBuffer, taken before any guest code runs: it
    // allocates through QuickJS's checked allocator.
    const allocator = context.evalCode('((AB) => (n) => new AB(n))(ArrayBuffer)', 'guest-allocator.js', {
      type: 'global',
    });
    if (allocator.error) {
      return this.failure(allocator.error, 'the guest allocator failed: ');
    }
    this.allocate = context.unwrapResult(allocator);

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
    if (this.allocate?.alive) {
      this.allocate.dispose();
    }
    this.allocate = undefined;
    const context = this.context;
    this.context = undefined;
    this.runtime = undefined;
    context?.dispose();
  }

  private memoryUsed(): number {
    return this.memory.buffer.byteLength;
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
   * QuickJS's allocator: binary data is written into the buffer it made, and
   * anything else is built in the room that buffer frees. A value that does
   * not fit marks the call out of memory; the guest gets undefined and is
   * stopped at its next interrupt check.
   */
  private deliver(value: unknown): QuickJSHandle {
    const { context } = this.live;
    const bytes = guestBytes(value);
    if (bytes > CHECKED_COPY_BYTES) {
      const room = this.allocateGuest(bytes);
      if (!room) {
        this.exhausted = true;
        return context.undefined;
      }
      if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
        const view = context.getArrayBuffer(room);
        try {
          view.value.set(value instanceof Uint8Array ? value : new Uint8Array(value));
        } finally {
          view.dispose();
        }
        return room;
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
        values = args.map((arg) => live.context.dump(arg) as unknown);
      } catch (error) {
        return { error: live.context.newError({ name: 'TypeError', message: `${name} takes data only: ${message(error)}` }) };
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
    if (typeof value === 'string') return context.newString(value);
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
        timer = setTimeout(resolve, Math.max(0, this.deadline - performance.now()) + 1);
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
    if (context.typeof(handle) !== 'string') {
      return this.success(context.dump(handle) as unknown);
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
        return { status: 'memory_exceeded', memoryUsedBytes: this.memoryUsed() };
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
    const memoryUsedBytes = this.memoryUsed();
    if (this.exhausted || this.interrupted) {
      if (errorHandle.alive) {
        errorHandle.dispose();
      }
      return this.exhausted ? { status: 'memory_exceeded', memoryUsedBytes } : { status: 'timeout', memoryUsedBytes };
    }
    let error: unknown;
    try {
      error = this.live.context.dump(errorHandle) as unknown;
    } catch (dumpError) {
      error = { message: `(the error could not be read: ${message(dumpError)})` };
    } finally {
      if (errorHandle.alive) {
        errorHandle.dispose();
      }
    }
    const shape = error !== null && typeof error === 'object' ? (error as { message?: unknown }) : undefined;
    if (shape?.message === 'out of memory') {
      return { status: 'memory_exceeded', memoryUsedBytes };
    }
    const text = typeof shape?.message === 'string' ? shape.message : String(error);
    return { status: 'error', error: `Execution error: ${prefix}${text}`, memoryUsedBytes };
  }
}
