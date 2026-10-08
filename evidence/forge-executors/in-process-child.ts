/**
 * Runs one case on the in-process executor in a process of its own: the cases
 * that can stall or exhaust the process that runs them (a guest that spins
 * after a yield, an allocation without a limit). Prints one JSON line with the
 * result. The parent kills it at its own deadline and records that it did.
 */
import { SandboxedToolForge } from '../../dist/cognition/emergent/SandboxedToolForge.js';

const CASES: Record<string, { code: string; timeoutMs: number }> = {
  'yield-then-spin': { code: 'async function execute() { await Promise.resolve(); while (true) {} }', timeoutMs: 500 },
  'never-settles': { code: 'async function execute() { await new Promise(() => {}); }', timeoutMs: 500 },
  'sync-spin': { code: 'function execute() { while (true) {} }', timeoutMs: 500 },
  'grow-uncaught': { code: "function execute() { const a = []; for (;;) { a.push('x'.repeat(65536)); } }", timeoutMs: 10000 },
};

const name = process.argv[2] ?? '';
const chosen = CASES[name];
if (!chosen) {
  console.log(JSON.stringify({ case: name, harnessError: 'unknown case' }));
  process.exit(2);
}
const started = performance.now();
const result = await new SandboxedToolForge().execute({
  code: chosen.code,
  input: {},
  allowlist: [],
  memoryMB: 16,
  timeoutMs: chosen.timeoutMs,
});
console.log(JSON.stringify({ case: name, elapsedMs: Math.round(performance.now() - started), result }));
process.exit(0);
