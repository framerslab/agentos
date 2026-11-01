/**
 * @file markerCapture.ts
 * @description Runs one path while standard output, standard error and a handed-over pino logger are captured, and
 * fails when a marker reached any of them. The test runner's console forwards to its reporter without writing either
 * stream, so for the run the global console is a Node console over the two streams, as in a process outside the
 * runner. The capture then holds however a line is written: a console call, a direct stream write or the logger.
 */

import { Console } from 'node:console';
import pino from 'pino';
import { expect, vi } from 'vitest';
import { setLogger, resetLoggerFactory } from '../../src/core/logging/loggerFactory.js';
import type { ILogger } from '../../src/core/logging/ILogger.js';

/**
 * Runs `run` with both standard streams and an injected pino sink captured, then asserts that `marker` reached none
 * of them. A probe on each channel, the console included, proves the capture was live, so the check cannot pass
 * vacuously. No console method is replaced: console calls reach the captured streams as they would in production.
 *
 * @param marker - Text that must reach no output channel.
 * @param run - The path under test. It receives an `ILogger` that writes to the injected sink, for a component that takes one.
 */
export async function markerCapture(marker: string, run: (legacy: ILogger) => Promise<void>): Promise<void> {
  const output: string[] = []; const errors: string[] = []; const json: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { output.push(String(chunk)); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { errors.push(String(chunk)); return true; });
  const log = pino({ level: 'debug', base: undefined }, { write(line: string) { json.push(line); } });
  const legacy: ILogger = {
    debug: (event, fields) => log.debug({ event, ...fields }),
    info: (event, fields) => log.info({ event, ...fields }),
    warn: (event, fields) => log.warn({ event, ...fields }),
    error: (event, fields) => log.error({ event, ...fields }),
  };
  const runnerConsole = globalThis.console;
  try {
    globalThis.console = new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false });
    setLogger(log);
    process.stdout.write('stdout-probe'); process.stderr.write('stderr-probe'); console.log('console-probe'); log.info({ event: 'sink-probe' });
    await run(legacy);
    expect(output.join('')).toContain('stdout-probe'); expect(errors.join('')).toContain('stderr-probe'); expect(output.join('')).toContain('console-probe'); expect(json.join('')).toContain('sink-probe');
    expect([...output, ...errors, ...json].join('')).not.toContain(marker);
  } finally { globalThis.console = runnerConsole; out.mockRestore(); err.mockRestore(); resetLoggerFactory(); }
}
