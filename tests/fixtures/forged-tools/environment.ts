/**
 * The forged-tool corpus and what its capability fixtures call: an HTTP server
 * on every interface (so 127.0.0.1 and localhost are two hosts on one server)
 * and a directory of files. Shared by the corpus tests of both executors; it
 * imports nothing from the library.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

/** What a fixture's call must come back as. */
export type FixtureExpectation =
  | { success: true; output: unknown }
  | { success: true; outputMatches: Record<string, string> }
  | { success: false; errorIncludes?: string };

export interface CorpusFixture {
  id: string;
  /** For a library fixture: the test file (and test) it was copied from. */
  from?: string;
  note?: string;
  code: string;
  input: unknown;
  allowlist: string[];
  /** The call's deadline; 5000 when absent. */
  timeoutMs?: number;
  expect: FixtureExpectation;
}

export interface CorpusEnvironment {
  /** `http://127.0.0.1:<port>` */
  server: string;
  /** `http://localhost:<port>`: the same server under another host. */
  otherServer: string;
  /** A directory holding `notes.txt` and `data.json`. */
  root: string;
  /** The value with every placeholder string filled in. */
  fill<T>(value: T): T;
  close(): Promise<void>;
}

const here = dirname(fileURLToPath(import.meta.url));

export function loadCorpus(): { library: CorpusFixture[]; written: CorpusFixture[] } {
  const read = (name: string): CorpusFixture[] =>
    JSON.parse(readFileSync(join(here, name), 'utf8')) as CorpusFixture[];
  return { library: read('library.json'), written: read('written.json') };
}

/** Whether a fixture names a capability, and so runs under the ceiling. */
export function usesCapabilities(fixture: CorpusFixture): boolean {
  return fixture.allowlist.length > 0;
}

/** Null when the result meets the expectation; otherwise what differs. */
export function checkExpectation(
  expectation: FixtureExpectation,
  result: { success: boolean; output?: unknown; error?: string },
): string | null {
  if (expectation.success !== result.success) {
    return `success ${String(result.success)}, expected ${String(expectation.success)}${result.error ? ` (${result.error})` : ''}`;
  }
  if (expectation.success === false) {
    if (expectation.errorIncludes !== undefined && !(result.error ?? '').includes(expectation.errorIncludes)) {
      return `error "${result.error ?? ''}" does not contain "${expectation.errorIncludes}"`;
    }
    return null;
  }
  if ('output' in expectation) {
    return isDeepStrictEqual(result.output, expectation.output)
      ? null
      : `output ${JSON.stringify(result.output)}, expected ${JSON.stringify(expectation.output)}`;
  }
  const output = (result.output ?? {}) as Record<string, unknown>;
  for (const [key, pattern] of Object.entries(expectation.outputMatches)) {
    const value = output[key];
    if (typeof value !== 'string' || !new RegExp(pattern).test(value)) {
      return `output.${key} ${JSON.stringify(value)} does not match /${pattern}/`;
    }
  }
  return null;
}

export async function startCorpusEnvironment(): Promise<CorpusEnvironment> {
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url === '/json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [1, 2, 3], source: 'fixture' }));
      return;
    }
    if (url === '/status/404') {
      res.statusCode = 404;
      res.setHeader('content-type', 'text/plain');
      res.end('missing');
      return;
    }
    if (url === '/headers') {
      res.setHeader('x-fixture', 'yes');
      const echoed = req.headers['x-request'];
      if (typeof echoed === 'string') {
        res.setHeader('x-echo', echoed);
      }
      res.end('h');
      return;
    }
    res.setHeader('content-type', 'text/plain');
    res.end('ok');
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  const root = await mkdtemp(join(tmpdir(), 'forged-corpus-'));
  await writeFile(join(root, 'notes.txt'), 'alpha\nbeta\ngamma\n');
  await writeFile(join(root, 'data.json'), JSON.stringify({ n: 7, tags: ['x', 'y'] }));

  const values: Record<string, string> = {
    '{{server}}': `http://127.0.0.1:${port}`,
    '{{otherServer}}': `http://localhost:${port}`,
    '{{root}}': root,
  };
  const fillValue = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return Object.entries(values).reduce((text, [placeholder, actual]) => text.split(placeholder).join(actual), value);
    }
    if (Array.isArray(value)) {
      return value.map(fillValue);
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fillValue(item)]));
    }
    return value;
  };

  return {
    server: values['{{server}}'],
    otherServer: values['{{otherServer}}'],
    root,
    fill<T>(value: T): T {
      return fillValue(value) as T;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
