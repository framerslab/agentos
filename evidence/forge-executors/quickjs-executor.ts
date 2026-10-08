/**
 * A prototype ForgedCodeExecutor on QuickJS compiled to WebAssembly
 * (quickjs-emscripten 0.32.0, its default release-sync variant), written for
 * the evidence run. Each call gets its own runtime and context with a memory
 * limit, a stack limit and an interrupt at the deadline; the granted functions
 * reach the guest only as the data-only bindings of guestSurface(). The library
 * ships none of this; the evidence run decides whether an executor like it is
 * built.
 */
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import type {
  ExecutorRunRequest,
  ExecutorRunResult,
  ForgedCodeExecutor,
} from '../../dist/cognition/emergent/executor/types.js';
import { guestSurface, type Binding } from './guest-surface.js';

const STACK_BYTES = 1024 * 1024;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorShape(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) };
}

export class QuickJSExecutor implements ForgedCodeExecutor {
  readonly name = 'quickjs-wasm';
  readonly isolates = true;
  /** Teardowns that failed, each followed by a fresh module. */
  moduleReloads = 0;
  private module: QuickJSWASMModule | undefined;

  /** Loads and compiles the WebAssembly module; the evidence run times the first load as start-up. */
  async load(): Promise<void> {
    this.module ??= await newQuickJSWASMModule();
  }

  async run(request: ExecutorRunRequest): Promise<ExecutorRunResult> {
    await this.load();
    const runtime = (this.module as QuickJSWASMModule).newRuntime();
    runtime.setMemoryLimit(Math.max(1024 * 1024, Math.floor(request.memoryMB * 1024 * 1024)));
    runtime.setMaxStackSize(STACK_BYTES);
    const deadline = Date.now() + request.timeoutMs;
    let interrupted = false;
    runtime.setInterruptHandler(() => {
      if (Date.now() > deadline || request.signal?.aborted === true) {
        interrupted = true;
        return true;
      }
      return false;
    });
    const context = runtime.newContext();
    const guest = new GuestRun(context, runtime);
    let result: ExecutorRunResult;
    try {
      result = await guest.execute(request, deadline, () => interrupted);
    } catch (error) {
      result = { status: 'error', error: `Execution error: the executor failed: ${message(error)}`, memoryUsedBytes: 0 };
    }
    try {
      guest.dispose();
      context.dispose();
      runtime.dispose();
    } catch {
      // A teardown that fails can leave the module unusable: load a fresh one for the next call.
      this.module = undefined;
      this.moduleReloads += 1;
    }
    return result;
  }
}

/** One call's guest: its bindings, the host operations it started, its deferred promises. */
class GuestRun {
  private alive = true;
  private readonly pending = new Set<Promise<void>>();
  private readonly deferreds = new Set<QuickJSDeferredPromise>();

  constructor(
    private readonly context: QuickJSContext,
    private readonly runtime: QuickJSRuntime,
  ) {}

  async execute(request: ExecutorRunRequest, deadline: number, interrupted: () => boolean): Promise<ExecutorRunResult> {
    const { context, runtime } = this;
    const surface = guestSurface(request.globals);
    for (const [name, binding] of Object.entries(surface.bindings)) {
      this.install(`__host_${name}`, binding);
    }
    const prelude = context.evalCode(surface.prelude, 'guest-prelude.js', { type: 'global' });
    if (prelude.error) {
      return this.failure(prelude.error, false, 'the guest prelude failed: ');
    }
    prelude.value.dispose();

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
      return this.failure(evaluated.error, interrupted());
    }
    const promise = evaluated.value;
    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          return this.failure(jobs.error, interrupted());
        }
        if (interrupted()) {
          return { status: 'timeout', memoryUsedBytes: this.memoryUsed() };
        }
        const state = context.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          const value: unknown = context.dump(state.value);
          if (!state.notAPromise && state.value.alive) {
            state.value.dispose();
          }
          return this.success(value);
        }
        if (state.type === 'rejected') {
          return this.failure(state.error, interrupted());
        }
        if (Date.now() > deadline || request.signal?.aborted === true) {
          return { status: 'timeout', memoryUsedBytes: this.memoryUsed() };
        }
        await this.progress(deadline, request.signal);
      }
    } finally {
      if (promise.alive) {
        promise.dispose();
      }
    }
  }

  /** Stops resolving into the guest and frees the deferred promises still open. */
  dispose(): void {
    this.alive = false;
    for (const deferred of this.deferreds) {
      if (deferred.alive) {
        deferred.dispose();
      }
    }
    this.deferreds.clear();
  }

  private install(name: string, binding: Binding): void {
    const { context } = this;
    const fn = context.newFunction(name, (...args: QuickJSHandle[]) => {
      let values: unknown[];
      try {
        values = args.map((arg) => context.dump(arg) as unknown);
      } catch (error) {
        return { error: context.newError({ name: 'TypeError', message: `${name} takes data only: ${message(error)}` }) };
      }
      let result: unknown;
      try {
        result = binding(...values);
      } catch (error) {
        return { error: context.newError(errorShape(error)) };
      }
      if (result instanceof Promise) {
        return this.bridge(result);
      }
      try {
        return this.toHandle(result);
      } catch (error) {
        return {
          error: context.newError({ name: 'TypeError', message: `${name} returned a value that is not data: ${message(error)}` }),
        };
      }
    });
    context.setProp(context.global, name, fn);
    fn.dispose();
  }

  /** A guest promise settled by a host promise; the guest's continuation runs at the next pump. */
  private bridge(result: Promise<unknown>): QuickJSHandle {
    const { context } = this;
    const deferred = context.newPromise();
    this.deferreds.add(deferred);
    const settled: Promise<void> = result
      .then(
        (value) => {
          if (!this.alive) {
            return;
          }
          let handle: QuickJSHandle;
          try {
            handle = this.toHandle(value);
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
          handle.dispose();
        },
        (error: unknown) => {
          if (!this.alive) {
            return;
          }
          const rejection = context.newError(errorShape(error));
          deferred.reject(rejection);
          rejection.dispose();
        },
      )
      .catch(() => undefined)
      .finally(() => {
        this.deferreds.delete(deferred);
        this.pending.delete(settled);
      });
    this.pending.add(settled);
    return deferred.handle;
  }

  /** Host data into a new guest value; anything that is not data throws. */
  private toHandle(value: unknown): QuickJSHandle {
    const { context } = this;
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
  private async progress(deadline: number, signal: AbortSignal | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const waits: Promise<unknown>[] = [...this.pending];
    waits.push(
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()) + 1);
      }),
    );
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

  private success(value: unknown): ExecutorRunResult {
    const memoryUsedBytes = this.memoryUsed();
    if (typeof value !== 'string') {
      return { status: 'ok', output: value, memoryUsedBytes };
    }
    try {
      return { status: 'ok', output: JSON.parse(value) as unknown, memoryUsedBytes };
    } catch {
      return { status: 'ok', output: value, memoryUsedBytes };
    }
  }

  private failure(errorHandle: QuickJSHandle, interrupted: boolean, prefix = ''): ExecutorRunResult {
    let error: unknown;
    try {
      error = this.context.dump(errorHandle);
    } catch (dumpError) {
      error = { message: `(the error could not be read: ${message(dumpError)})` };
    } finally {
      if (errorHandle.alive) {
        errorHandle.dispose();
      }
    }
    const memoryUsedBytes = this.memoryUsed();
    if (interrupted) {
      return { status: 'timeout', memoryUsedBytes };
    }
    const shape = error !== null && typeof error === 'object' ? (error as { message?: unknown }) : undefined;
    if (shape?.message === 'out of memory') {
      return { status: 'memory_exceeded', memoryUsedBytes };
    }
    const text = typeof shape?.message === 'string' ? shape.message : String(error);
    return { status: 'error', error: `Execution error: ${prefix}${text}`, memoryUsedBytes };
  }

  private memoryUsed(): number {
    let handle: QuickJSHandle | undefined;
    try {
      handle = this.runtime.computeMemoryUsage();
      const usage = this.context.dump(handle) as { memory_used_size?: unknown } | undefined;
      return typeof usage?.memory_used_size === 'number' ? usage.memory_used_size : 0;
    } catch {
      return 0;
    } finally {
      if (handle?.alive) {
        handle.dispose();
      }
    }
  }
}
