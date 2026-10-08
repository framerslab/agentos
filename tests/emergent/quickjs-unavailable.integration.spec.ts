/**
 * A host that builds QuickJSExecutor without the QuickJS packages gets
 * `quickjs_unavailable` naming both and the version, from `create()` and
 * from every call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('quickjs-emscripten-core');
  vi.resetModules();
});

describe('QuickJSExecutor without its packages', () => {
  it('names both packages and the version, from create() and from a call', async () => {
    vi.doMock('quickjs-emscripten-core', () => {
      throw new Error("Cannot find package 'quickjs-emscripten-core'");
    });
    const { QuickJSExecutor, QuickJSUnavailableError } = await import(
      '../../src/cognition/emergent/executor/QuickJSExecutor.js'
    );
    const expected =
      'quickjs_unavailable: QuickJSExecutor needs quickjs-emscripten-core and @jitl/quickjs-wasmfile-release-sync, both at 0.32.0';

    await expect(QuickJSExecutor.create()).rejects.toBeInstanceOf(QuickJSUnavailableError);
    await expect(QuickJSExecutor.create()).rejects.toThrow(expected);

    const ran = await new QuickJSExecutor().run({
      code: 'function execute() { return 1; }',
      input: {},
      globals: {},
      timeoutMs: 1000,
      memoryMB: 16,
    });
    expect(ran.status).toBe('error');
    expect(ran.status === 'error' ? ran.error : '').toContain(expected);
  });
});
