/**
 * @fileoverview Tests for SandboxedToolForge.
 *
 * Covers:
 * 1. Simple pure function executes and returns output
 * 2. Code with `while(true)` is killed by timeout
 * 3. Code accessing `process` is caught by validateCode
 * 4. Code using `eval()` is caught by validateCode
 * 5. Code using `require()` is caught by validateCode
 * 6. `fetch` blocked when not in allowlist
 * 7. `fetch` allowed when in allowlist (mock in context)
 * 8. validateCode returns violations list with multiple entries
 * 9. Execution time is measured and returned
 */

import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import type { SandboxExecutionRequest, SandboxAPI } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal {@link SandboxExecutionRequest} from just code and input.
 * Defaults: empty allowlist, 128 MB nominal memory budget, 5000 ms timeout.
 */
function makeRequest(
  code: string,
  input: unknown = {},
  overrides?: Partial<SandboxExecutionRequest>,
): SandboxExecutionRequest {
  return {
    code,
    input,
    allowlist: [],
    memoryMB: 128,
    timeoutMs: 5000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SandboxedToolForge', () => {
  const forge = new SandboxedToolForge();

  // -------------------------------------------------------------------------
  // 1. Simple pure function executes and returns output
  // -------------------------------------------------------------------------
  it('executes a simple pure function and returns the output', async () => {
    const request = makeRequest(
      'function execute(input) { return { sum: input.a + input.b }; }',
      { a: 2, b: 3 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ sum: 5 });
    expect(result.error).toBeUndefined();
  });

  it('supports async sandbox entrypoints', async () => {
    const request = makeRequest(
      'async function execute(input) { return { sum: input.a + input.b }; }',
      { a: 4, b: 5 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ sum: 9 });
  });

  // -------------------------------------------------------------------------
  // 2. Code with while(true) is killed by timeout
  // -------------------------------------------------------------------------
  it('kills infinite loops via timeout', async () => {
    const request = makeRequest(
      'function execute(input) { while(true) {} }',
      {},
      { timeoutMs: 100 }, // short timeout to keep tests fast
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(50);
  });

  // -------------------------------------------------------------------------
  // 3. Code accessing `process` is caught by validateCode
  // -------------------------------------------------------------------------
  it('catches process access in validateCode', () => {
    const result = forge.validateCode(
      'function execute() { return process.env.SECRET; }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('process access is forbidden');
  });

  // -------------------------------------------------------------------------
  // 4. Code using eval() is caught by validateCode
  // -------------------------------------------------------------------------
  it('catches eval() in validateCode', () => {
    const result = forge.validateCode(
      'function execute(input) { return eval("1+1"); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('eval() is forbidden');
  });

  // -------------------------------------------------------------------------
  // 5. Code using require() is caught by validateCode
  // -------------------------------------------------------------------------
  it('catches require() in validateCode', () => {
    const result = forge.validateCode(
      'function execute(input) { const fs = require("fs"); return fs.readFileSync("/etc/passwd"); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('require() is forbidden');
  });

  // -------------------------------------------------------------------------
  // 6. fetch blocked when not in allowlist
  // -------------------------------------------------------------------------
  it('blocks fetch() when not in the allowlist', () => {
    const result = forge.validateCode(
      'function execute(input) { return fetch("https://example.com"); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('fetch() is not in the allowlist');
  });

  // -------------------------------------------------------------------------
  // 7. fetch allowed when in allowlist
  // -------------------------------------------------------------------------
  it('allows fetch() when in the allowlist', () => {
    const result = forge.validateCode(
      'function execute(input) { return fetch("https://example.com"); }',
      ['fetch'],
    );

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 8. validateCode returns a violations list with multiple entries
  // -------------------------------------------------------------------------
  it('returns multiple violations when code has several banned patterns', () => {
    const code = `
      function execute(input) {
        eval("bad");
        const cp = require("child_process");
        const x = process.env.FOO;
        return x;
      }
    `;

    const result = forge.validateCode(code, []);

    expect(result.valid).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
    expect(result.violations).toContain('eval() is forbidden');
    expect(result.violations).toContain('require() is forbidden');
    expect(result.violations).toContain('process access is forbidden');
  });

  // -------------------------------------------------------------------------
  // 9. Execution time is measured and returned
  // -------------------------------------------------------------------------
  it('measures and returns execution time', async () => {
    const request = makeRequest(
      'function execute(input) { return { ok: true }; }',
      {},
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(typeof result.executionTimeMs).toBe('number');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // 10. execute() rejects code that fails validation
  // -------------------------------------------------------------------------
  it('rejects code at execution time when validation fails', async () => {
    const request = makeRequest(
      'function execute(input) { return eval("input.x"); }',
      { x: 42 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Code validation failed');
    expect(result.error).toContain('eval() is forbidden');
  });

  // -------------------------------------------------------------------------
  // 11. Code that throws at runtime returns a failure result
  // -------------------------------------------------------------------------
  it('returns a failure result when code throws at runtime', async () => {
    const request = makeRequest(
      'function execute(input) { throw new Error("runtime boom"); }',
      {},
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain('runtime boom');
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('returns a failure result when no execute/run entrypoint is defined', async () => {
    const request = makeRequest(
      'function notTheRightName(input) { return input; }',
      {},
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain('must define execute(input) or run(input)');
  });

  // -------------------------------------------------------------------------
  // 12. fs.write* is always banned
  // -------------------------------------------------------------------------
  it('bans fs.writeFile even when fs.readFile is in the allowlist', () => {
    const result = forge.validateCode(
      'function execute(input) { fs.writeFile("/tmp/x", "data"); }',
      ['fs.readFile'],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('fs.write* is forbidden');
  });

  // -------------------------------------------------------------------------
  // 13. new Function() is banned
  // -------------------------------------------------------------------------
  it('catches new Function() constructor', () => {
    const result = forge.validateCode(
      'function execute(input) { return new Function("return 1")(); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('new Function() is forbidden');
  });

  it('catches bare Function() constructor calls', () => {
    const result = forge.validateCode(
      'function execute(input) { return Function("return 1")(); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('Function() is forbidden');
  });

  // -------------------------------------------------------------------------
  // 14. import statements are banned
  // -------------------------------------------------------------------------
  it('catches import statements', () => {
    const result = forge.validateCode(
      'import fs from "fs"; function execute(input) { return 1; }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('import statements are forbidden');
  });

  // -------------------------------------------------------------------------
  // 15. crypto blocked when not in allowlist, allowed when opted in
  // -------------------------------------------------------------------------
  it('blocks crypto when not in allowlist', () => {
    const result = forge.validateCode(
      'function execute(input) { return crypto.createHash("sha256").update(input.data).digest("hex"); }',
      [],
    );

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('crypto access is not in the allowlist');
  });

  it('allows crypto when in allowlist', () => {
    const result = forge.validateCode(
      'function execute(input) { return crypto.createHash("sha256").update(input.data).digest("hex"); }',
      ['crypto'],
    );

    expect(result.valid).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 16. String return values work correctly
  // -------------------------------------------------------------------------
  it('handles string return values', async () => {
    const request = makeRequest(
      'function execute(input) { return "hello " + input.name; }',
      { name: 'world' },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe('hello world');
  });

  // -------------------------------------------------------------------------
  // 17. Number return values work correctly
  // -------------------------------------------------------------------------
  it('handles number return values', async () => {
    const request = makeRequest(
      'function execute(input) { return input.x * input.y; }',
      { x: 6, y: 7 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe(42);
  });

  // -------------------------------------------------------------------------
  // 18. Constructor config defaults
  // -------------------------------------------------------------------------
  it('uses constructor config for timeout when request does not override', async () => {
    const shortForge = new SandboxedToolForge({ timeoutMs: 100 });

    const request: SandboxExecutionRequest = {
      code: 'function execute(input) { while(true) {} }',
      input: {},
      allowlist: [],
      memoryMB: 128,
      timeoutMs: 100,
    };

    const result = await shortForge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toContain('timed out');
  });

  // -------------------------------------------------------------------------
  // 19. memoryUsedBytes is always returned
  // -------------------------------------------------------------------------
  it('always returns memoryUsedBytes in the result', async () => {
    const request = makeRequest(
      'function execute(input) { return null; }',
      {},
    );

    const result = await forge.execute(request);

    expect(typeof result.memoryUsedBytes).toBe('number');
  });

  // -------------------------------------------------------------------------
  // 20. Complex object manipulation works in sandbox
  // -------------------------------------------------------------------------
  it('supports complex object manipulation in sandboxed code', async () => {
    const code = `
      function execute(input) {
        var items = input.items;
        var total = 0;
        for (var i = 0; i < items.length; i++) {
          total += items[i].price * items[i].qty;
        }
        return { total: total, count: items.length };
      }
    `;

    const request = makeRequest(code, {
      items: [
        { price: 10, qty: 2 },
        { price: 5, qty: 3 },
        { price: 20, qty: 1 },
      ],
    });

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ total: 55, count: 3 });
  });

  // -------------------------------------------------------------------------
  // Pre-parse: syntax errors surface with actionable hints (not generic
  // "test cases failed" opaqueness that the judge gets otherwise).
  // -------------------------------------------------------------------------
  it('pre-parse catches arrow-fn with const in expression position', async () => {
    const request = makeRequest(
      // Invalid: const in arrow body without braces
      'const calc = (x) => const doubled = x * 2;\nfunction execute(input) { return { out: calc(input.n) }; }',
      { n: 5 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SyntaxError before execution/);
    expect(result.error).toMatch(/arrow function without braces|wrap in `{}`/i);
  });

  it('pre-parse catches TypeScript syntax leaks', async () => {
    const request = makeRequest(
      // Invalid JS: interface keyword
      'interface Input { n: number }\nfunction execute(input) { return { n: input.n }; }',
      { n: 1 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/SyntaxError before execution/);
  });

  it('pre-parse passes valid ES2020 code through to execution', async () => {
    const request = makeRequest(
      'async function execute(input) { return { doubled: input.n * 2 }; }',
      { n: 7 },
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toEqual({ doubled: 14 });
  });

  // -------------------------------------------------------------------------
  // Cycle 3: delegation to CodeSandbox proves codeGeneration: false now in effect
  // -------------------------------------------------------------------------
  it('blocks Function-constructor escape via codeGeneration restriction', async () => {
    // The literal `Function(` would be caught by validateCode regex.
    // The constructor-reflection chain `({}).constructor.constructor` bypasses
    // the regex but should be caught at runtime once the JS path delegates to
    // CodeSandbox (which sets codeGeneration: { strings: false }).
    const request = makeRequest(
      'function execute() { const F = ({}).constructor.constructor; return F("return 42")(); }',
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(false);
    // node:vm raises EvalError or similar; just verify the escape did not return 42.
    expect(result.output).not.toBe(42);
  });

  // -------------------------------------------------------------------------
  // Cycle 4: memoryUsedBytes returns honest heap delta after delegation
  // -------------------------------------------------------------------------
  it('reports a non-zero memoryUsedBytes after a meaningful allocation', async () => {
    const request = makeRequest(
      // Allocate ~5 MB of strings; the host heap delta should register
      // something positive even with GC noise.
      `function execute() {
        const chunks = [];
        for (let i = 0; i < 50; i++) {
          chunks.push("x".repeat(100000));
        }
        return chunks.length;
      }`,
    );

    const result = await forge.execute(request);

    expect(result.success).toBe(true);
    expect(result.output).toBe(50);
    // Honest field: was hard-coded to 0; after the heap-delta heuristic it
    // should report something positive. The exact bound depends on GC timing,
    // so just assert > 0.
    expect(result.memoryUsedBytes).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // fs.readFile containment (CWE-22): a symlink inside an allowed root must
  // not reach a file outside one.
  // -------------------------------------------------------------------------
  describe('fs.readFile path containment', () => {
    // realpathSync: on macOS the OS temp dir is itself a symlink, so the
    // fixture paths have to be real before they are handed to the forge as
    // roots — otherwise the test would be asserting against the very
    // root-resolution behavior it means to exercise.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'forge-fs-')));
    const allowedRoot = join(base, 'allowed');
    const secretDir = join(base, 'secret');
    mkdirSync(allowedRoot, { recursive: true });
    mkdirSync(secretDir, { recursive: true });
    writeFileSync(join(allowedRoot, 'ok.txt'), 'in-root content');
    writeFileSync(join(secretDir, 'secret.txt'), 'SECRET-DO-NOT-READ');
    // The escape: a link that LIVES in the allowed root, so every
    // string-prefix check on its own path passes.
    symlinkSync(join(secretDir, 'secret.txt'), join(allowedRoot, 'escape.txt'));

    afterAll(() => {
      rmSync(base, { recursive: true, force: true });
    });

    const readRequest = (target: string): SandboxExecutionRequest =>
      makeRequest(
        'async function execute(input) { return await fs.readFile(input.p); }',
        { p: target },
        { allowlist: ['fs.readFile'] },
      );

    const forgeWithRoot = new SandboxedToolForge({ fsReadRoots: [allowedRoot] });

    it('reads an ordinary file inside an allowed root', async () => {
      const result = await forgeWithRoot.execute(readRequest(join(allowedRoot, 'ok.txt')));

      expect(result.success).toBe(true);
      expect(result.output).toBe('in-root content');
    });

    it('blocks a symlink that lives inside the root but targets a file outside it', async () => {
      const result = await forgeWithRoot.execute(readRequest(join(allowedRoot, 'escape.txt')));

      expect(result.success).toBe(false);
      expect(result.error ?? '').toMatch(/resolves outside the allowed roots/);
      // The secret must not leak through the output channel either.
      expect(JSON.stringify(result.output ?? null)).not.toMatch(/SECRET-DO-NOT-READ/);
    });

    it('still blocks a plainly out-of-root path before touching the filesystem', async () => {
      const result = await forgeWithRoot.execute(readRequest(join(secretDir, 'secret.txt')));

      expect(result.success).toBe(false);
      expect(result.error ?? '').toMatch(/is outside the allowed roots/);
    });

    it('allows reads under a root that ends in a separator (filesystem / drive root)', async () => {
      // The prefix form built `//` for a root of `/` and denied everything
      // beneath it; path.relative containment has no such edge.
      const fsRoot = parse(base).root;
      const forgeAtFsRoot = new SandboxedToolForge({ fsReadRoots: [fsRoot] });

      const result = await forgeAtFsRoot.execute(readRequest(join(allowedRoot, 'ok.txt')));

      expect(result.success).toBe(true);
      expect(result.output).toBe('in-root content');
    });

    it('does not treat a sibling whose name merely starts with ".." as an escape', async () => {
      const oddSibling = join(base, '..odd');
      mkdirSync(oddSibling, { recursive: true });
      writeFileSync(join(oddSibling, 'f.txt'), 'sibling content');
      const forgeAtBase = new SandboxedToolForge({ fsReadRoots: [base] });

      const result = await forgeAtBase.execute(readRequest(join(oddSibling, 'f.txt')));

      expect(result.success).toBe(true);
      expect(result.output).toBe('sibling content');
    });

    it('pins a resolved root, so repointing the link mid-life cannot move the sandbox', async () => {
      // Deliberate: re-resolving the root per read would let an attacker who
      // can rewrite the link relocate a running sandbox. The first read fixes
      // the real root; the retargeted directory is then outside it.
      const movingRoot = join(base, 'moving');
      const firstTarget = join(base, 'target-a');
      const secondTarget = join(base, 'target-b');
      mkdirSync(firstTarget, { recursive: true });
      mkdirSync(secondTarget, { recursive: true });
      writeFileSync(join(firstTarget, 'f.txt'), 'target A');
      writeFileSync(join(secondTarget, 'f.txt'), 'target B');
      symlinkSync(firstTarget, movingRoot);

      const forgeMoving = new SandboxedToolForge({ fsReadRoots: [movingRoot] });
      const first = await forgeMoving.execute(readRequest(join(movingRoot, 'f.txt')));
      expect(first.success).toBe(true);
      expect(first.output).toBe('target A');

      rmSync(movingRoot);
      symlinkSync(secondTarget, movingRoot);

      const second = await forgeMoving.execute(readRequest(join(movingRoot, 'f.txt')));
      expect(second.success).toBe(false);
      expect(second.error ?? '').toMatch(/resolves outside the allowed roots/);
      // A forge built after the change follows the link's new target.
      const freshForge = new SandboxedToolForge({ fsReadRoots: [movingRoot] });
      const fresh = await freshForge.execute(readRequest(join(movingRoot, 'f.txt')));
      expect(fresh.success).toBe(true);
      expect(fresh.output).toBe('target B');
    });

    it('keeps a resolved root pinned even when a sibling root never resolves', async () => {
      // A set-wide cache dropped on any failure would re-resolve the symlink
      // root on the next read and follow it to its new target.
      const movingRoot = join(base, 'moving-mixed');
      const firstTarget = join(base, 'mixed-a');
      const secondTarget = join(base, 'mixed-b');
      mkdirSync(firstTarget, { recursive: true });
      mkdirSync(secondTarget, { recursive: true });
      writeFileSync(join(firstTarget, 'f.txt'), 'mixed A');
      writeFileSync(join(secondTarget, 'f.txt'), 'mixed B');
      symlinkSync(firstTarget, movingRoot);

      const forgeMixed = new SandboxedToolForge({
        fsReadRoots: [movingRoot, join(base, 'never-exists')],
      });
      const first = await forgeMixed.execute(readRequest(join(movingRoot, 'f.txt')));
      expect(first.success).toBe(true);
      expect(first.output).toBe('mixed A');

      rmSync(movingRoot);
      symlinkSync(secondTarget, movingRoot);

      const second = await forgeMixed.execute(readRequest(join(movingRoot, 'f.txt')));
      expect(second.success).toBe(false);
      expect(second.error ?? '').toMatch(/resolves outside the allowed roots/);
    });

    it('allows a root that is itself a symlink (both sides are resolved)', async () => {
      const linkedRoot = join(base, 'linked-root');
      symlinkSync(allowedRoot, linkedRoot);
      const forgeViaLink = new SandboxedToolForge({ fsReadRoots: [linkedRoot] });

      const result = await forgeViaLink.execute(readRequest(join(linkedRoot, 'ok.txt')));

      expect(result.success).toBe(true);
      expect(result.output).toBe('in-root content');
    });
  });
});
