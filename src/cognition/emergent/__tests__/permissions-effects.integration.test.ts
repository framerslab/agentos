/**
 * @fileoverview Effect capabilities (spec test 9): fs.write, fs.delete and
 * state-changing requests on QuickJSExecutor, through forge_tool and
 * ToolOrchestrator.processToolCall, with a test-double judge and a real
 * SQLite store for the effect records.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { QuickJSExecutor } from '../executor/QuickJSExecutor.js';
import type { EmergentConfig, ForgedCapabilities } from '../types.js';
import { callTool, makeForgeHost, type ForgeHost } from './helpers/forge-host.js';
import { createSqliteAdapter, type SqliteTestAdapter } from './helpers/sqlite-adapter.js';

let executor: QuickJSExecutor;
const servers: http.Server[] = [];
const sockets: net.Server[] = [];

beforeAll(async () => {
  executor = await QuickJSExecutor.create();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
  await Promise.all(sockets.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

afterAll(() => undefined);

interface Seen {
  method: string;
  url: string;
  body: string;
}

/** A server that records each request; `/hold` never answers, `/moved` redirects, anything else answers JSON. */
async function serve(): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body });
      if (req.url === '/hold') {
        return;
      }
      if (req.url === '/moved') {
        res.statusCode = 302;
        res.setHeader('location', '/elsewhere');
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'created-1', got: body }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as AddressInfo).port, seen };
}

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'effects-')));
}

const ANY_OUT = { type: 'object', additionalProperties: true };
const ANY_IN = { type: 'object', additionalProperties: true };

function forgeArgs(
  name: string,
  code: string,
  allowlist: string[],
  testCases: Array<Record<string, unknown>>,
) {
  return {
    name,
    description: `Forged ${name}.`,
    inputSchema: ANY_IN,
    outputSchema: ANY_OUT,
    implementation: { mode: 'sandbox', code, allowlist },
    testCases,
  };
}

/** Writes each file in turn and reports each outcome by its code. */
const WRITE_EACH = `async function execute(input) {
  const out = [];
  for (const f of input.files) {
    try { await fs.writeFile(f.path, f.text); out.push('ok'); }
    catch (e) { out.push(String(e && e.message).split(':')[0]); }
  }
  return { out };
}`;

/** Starts every write at once. */
const WRITE_ALL_AT_ONCE = `async function execute(input) {
  const out = await Promise.all(input.files.map((f) =>
    fs.writeFile(f.path, f.text).then(() => 'ok', (e) => String(e && e.message).split(':')[0])));
  return { out };
}`;

const DELETE_EACH = `async function execute(input) {
  const out = [];
  for (const p of input.paths) {
    try { await fs.unlink(p); out.push('ok'); }
    catch (e) { out.push(String(e && e.message).split(':')[0]); }
  }
  return { out };
}`;

const POST_IT = `async function execute(input) {
  try {
    const r = await fetch(input.url, { method: input.method || 'POST', headers: { 'content-type': 'application/json' }, body: input.body });
    const text = await r.text();
    return { status: r.status, text, notSent: r.headers.get('x-agentos-forge-test') };
  } catch (e) { return { error: String(e && e.message).split(':')[0] }; }
}`;

const WRITE_CEILING = (root: string, overrides: Record<string, unknown> = {}): ForgedCapabilities['fs.write'] =>
  ({
    roots: [root],
    mode: 'create-only',
    maxBytesPerFile: 64,
    maxBytesPerCall: 128,
    maxFilesPerCall: 3,
    timeoutMs: 5000,
    approval: 'none',
    ...overrides,
  }) as ForgedCapabilities['fs.write'];

async function hostWith(
  capabilities: ForgedCapabilities,
  extra: Partial<EmergentConfig> = {},
  db: SqliteTestAdapter = createSqliteAdapter(),
): Promise<ForgeHost & { db: SqliteTestAdapter }> {
  const host = await makeForgeHost({
    db,
    config: { capabilities, executor, audit: { content: 'full' }, ...extra },
  });
  return { ...host, db };
}

function rows(db: SqliteTestAdapter): Array<Record<string, unknown>> {
  return db.raw
    .prepare('SELECT capability, target, decision, decided_by, outcome, code, bytes FROM agentos_emergent_effects ORDER BY intent_at, rowid')
    .all() as Array<Record<string, unknown>>;
}

/** The last element of a list (the repo's TypeScript lib predates Array.prototype.at). */
function last<T>(list: readonly T[] | undefined): T | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

async function forge(host: ForgeHost, args: Record<string, unknown>): Promise<void> {
  const forged = await callTool(host.orchestrator, 'forge_tool', args);
  expect(forged.isError, String(forged.errorDetails?.message ?? '')).toBeFalsy();
}

describe('effect capabilities on the isolating executor (test 9)', () => {
  it('writes under the roots, records the target as written, and the forge test changes nothing', async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, 'real'));
    fs.symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    const host = await hostWith({ 'fs.write': WRITE_CEILING(root) });
    await forge(
      host,
      forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [{ path: path.join(root, 'test.txt'), text: 't' }] } }]),
    );
    // The forge test ran as a dry run: nothing under the root.
    expect(fs.existsSync(path.join(root, 'test.txt'))).toBe(false);

    const called = await callTool(host.orchestrator, 'write_each', {
      files: [{ path: path.join(root, 'alias', 'out.txt'), text: 'hello' }],
    });
    expect(called.output).toEqual({ out: ['ok'] });
    expect(fs.readFileSync(path.join(root, 'real', 'out.txt'), 'utf8')).toBe('hello');
    expect(rows(host.db)).toEqual([
      expect.objectContaining({ capability: 'fs.write', target: path.join(root, 'test.txt'), outcome: 'ok', code: 'dry_run' }),
      // The parent's real path and the last component: what was written.
      expect.objectContaining({ capability: 'fs.write', target: path.join(root, 'real', 'out.txt'), outcome: 'ok', bytes: 5, code: null }),
    ]);
  });

  it('refuses and records a write outside the roots, through a link, into a missing directory, onto a directory or an existing file, and past each bound', async () => {
    const root = tempRoot();
    const outside = tempRoot();
    fs.symlinkSync(outside, path.join(root, 'out-link'));
    fs.mkdirSync(path.join(root, 'a-dir'));
    fs.writeFileSync(path.join(root, 'exists.txt'), 'old');
    const host = await hostWith({ 'fs.write': WRITE_CEILING(root) });
    await forge(host, forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]));

    const one = (p: string, text = 'x') => callTool(host.orchestrator, 'write_each', { files: [{ path: p, text }] });
    expect((await one(path.join(outside, 'x.txt'))).output).toEqual({ out: ['path_not_allowed'] });
    expect((await one(path.join(root, 'out-link', 'x.txt'))).output).toEqual({ out: ['path_not_allowed'] });
    expect((await one(path.join(root, 'missing', 'x.txt'))).output).toEqual({ out: ['no_such_directory'] });
    expect((await one(path.join(root, 'a-dir'))).output).toEqual({ out: ['not_a_file'] });
    expect((await one(path.join(root, 'exists.txt'))).output).toEqual({ out: ['file_exists'] });
    expect((await one(path.join(root, 'big.txt'), 'y'.repeat(65))).output).toEqual({ out: ['file_too_large'] });
    expect(fs.readFileSync(path.join(root, 'exists.txt'), 'utf8')).toBe('old');
    expect(fs.readdirSync(outside)).toEqual([]);

    // Four files against maxFilesPerCall 3; then bytes against maxBytesPerCall 128.
    const four = await callTool(host.orchestrator, 'write_each', {
      files: [1, 2, 3, 4].map((n) => ({ path: path.join(root, `n${n}.txt`), text: 'z' })),
    });
    expect(four.output).toEqual({ out: ['ok', 'ok', 'ok', 'call_quota_exceeded'] });
    const heavy = await callTool(host.orchestrator, 'write_each', {
      files: [1, 2, 3].map((n) => ({ path: path.join(root, `h${n}.txt`), text: 'w'.repeat(60) })),
    });
    expect(heavy.output).toEqual({ out: ['ok', 'ok', 'call_quota_exceeded'] });

    const refusedCodes = rows(host.db)
      .filter((row) => row.decision === 'refused')
      .map((row) => row.code);
    expect(refusedCodes).toEqual([
      'path_not_allowed',
      'path_not_allowed',
      'no_such_directory',
      'not_a_file',
      'file_exists',
      'file_too_large',
      'call_quota_exceeded',
      'call_quota_exceeded',
    ]);
  });

  it('writes no more files than maxFilesPerCall when the writes start together', async () => {
    const root = tempRoot();
    const host = await hostWith({ 'fs.write': WRITE_CEILING(root, { maxFilesPerCall: 2 }) });
    await forge(host, forgeArgs('write_all', WRITE_ALL_AT_ONCE, ['fs.write'], [{ input: { files: [] } }]));
    const called = await callTool(host.orchestrator, 'write_all', {
      files: [1, 2, 3, 4, 5].map((n) => ({ path: path.join(root, `p${n}.txt`), text: 'q' })),
    });
    const out = (called.output as { out: string[] }).out;
    expect(out.filter((code) => code === 'ok')).toHaveLength(2);
    expect(out.filter((code) => code === 'call_quota_exceeded')).toHaveLength(3);
    expect(fs.readdirSync(root)).toHaveLength(2);
  });

  it('replaces a file whole under create-or-replace, leaving no temporary file', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'doc.txt'), 'old contents');
    const host = await hostWith({ 'fs.write': WRITE_CEILING(root, { mode: 'create-or-replace' }) });
    await forge(host, forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]));
    const called = await callTool(host.orchestrator, 'write_each', { files: [{ path: path.join(root, 'doc.txt'), text: 'new' }] });
    expect(called.output).toEqual({ out: ['ok'] });
    expect(fs.readFileSync(path.join(root, 'doc.txt'), 'utf8')).toBe('new');
    expect(fs.readdirSync(root)).toEqual(['doc.txt']);
  });

  it('deletes one regular file at a time, refuses a directory, a socket and a missing file, and the delete past the limit removes nothing', async () => {
    const root = tempRoot();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      fs.writeFileSync(path.join(root, name), name);
    }
    fs.mkdirSync(path.join(root, 'a-dir'));
    const socketPath = path.join(root, 's.sock');
    const socketServer = net.createServer();
    sockets.push(socketServer);
    await new Promise<void>((resolve) => socketServer.listen(socketPath, resolve));
    const host = await hostWith({
      'fs.delete': { roots: [root], maxFilesPerCall: 2, timeoutMs: 5000, approval: 'none' },
    });
    await forge(host, forgeArgs('delete_each', DELETE_EACH, ['fs.delete'], [{ input: { paths: [] } }]));

    const kinds = await callTool(host.orchestrator, 'delete_each', {
      paths: [path.join(root, 'a-dir'), socketPath, path.join(root, 'nope.txt')],
    });
    expect(kinds.output).toEqual({ out: ['not_a_file', 'not_a_file', 'no_such_file'] });
    expect(fs.existsSync(socketPath)).toBe(true);

    const three = await callTool(host.orchestrator, 'delete_each', {
      paths: ['a.txt', 'b.txt', 'c.txt'].map((name) => path.join(root, name)),
    });
    expect(three.output).toEqual({ out: ['ok', 'ok', 'call_quota_exceeded'] });
    expect(fs.existsSync(path.join(root, 'c.txt'))).toBe(true);
  });

  it('sends a POST with its body to a listed host, records its method, and refuses a large body, an unlisted method and an unlisted host; a redirect comes back unfollowed', async () => {
    const { port, seen } = await serve();
    const host = await hostWith({
      fetch: { domains: ['127.0.0.1'], methods: ['GET', 'POST'], maxRequestBytes: 32, approval: 'none' },
    });
    await forge(host, forgeArgs('post_it', POST_IT, ['fetch'], [{ input: { url: `http://127.0.0.1:${port}/items`, body: '{}' } }]));
    // The forge test sent nothing.
    expect(seen).toEqual([]);

    const sent = await callTool(host.orchestrator, 'post_it', { url: `http://127.0.0.1:${port}/items`, body: '{"a":1}' });
    expect(sent.output).toMatchObject({ status: 200 });
    expect(seen).toEqual([{ method: 'POST', url: '/items', body: '{"a":1}' }]);
    expect(last(rows(host.db))).toMatchObject({ capability: 'fetch', target: `POST http://127.0.0.1:${port}/items`, outcome: 'ok' });

    const large = await callTool(host.orchestrator, 'post_it', { url: `http://127.0.0.1:${port}/items`, body: 'x'.repeat(33) });
    expect(large.output).toEqual({ error: 'request_too_large' });
    const put = await callTool(host.orchestrator, 'post_it', { url: `http://127.0.0.1:${port}/items`, method: 'PUT', body: '{}' });
    expect(put.output).toEqual({ error: 'method_not_allowed' });
    const other = await callTool(host.orchestrator, 'post_it', { url: 'http://localhost:9/items', body: '{}' });
    expect(other.output).toEqual({ error: 'host_not_allowed' });
    const moved = await callTool(host.orchestrator, 'post_it', { url: `http://127.0.0.1:${port}/moved`, body: '{}' });
    expect(moved.output).toMatchObject({ status: 302 });
    expect(seen.map((request) => request.url)).toEqual(['/items', '/moved']);
  });

  it('makes no write whose intent record cannot be written', async () => {
    const root = tempRoot();
    const host = await hostWith({ 'fs.write': WRITE_CEILING(root) });
    await forge(host, forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]));
    host.db.failNext('INSERT INTO agentos_emergent_effects');
    const called = await callTool(host.orchestrator, 'write_each', { files: [{ path: path.join(root, 'x.txt'), text: 'x' }] });
    expect(called.output).toEqual({ out: ['audit_unavailable'] });
    expect(fs.existsSync(path.join(root, 'x.txt'))).toBe(false);
  });

  it('leaves no file for a write cut by its time bound, and records a POST cut after it was sent as unknown', async () => {
    const root = tempRoot();
    const { port, seen } = await serve();
    const host = await hostWith(
      {
        'fs.write': WRITE_CEILING(root, { timeoutMs: 20 }),
        fetch: { domains: ['127.0.0.1'], methods: ['POST'], maxRequestBytes: 64, approval: 'none', timeoutMs: 300 },
      },
      {
        // The write's bound starts when it is admitted; the policy holds it past the bound.
        effectPolicy: async (effect) => {
          if (effect.capability === 'fs.write' && !effect.dryRun) {
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        },
      },
    );
    await forge(host, forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]));
    const cut = await callTool(host.orchestrator, 'write_each', { files: [{ path: path.join(root, 'slow.txt'), text: 'x' }] });
    expect(cut.output).toEqual({ out: ['timed_out'] });
    expect(fs.existsSync(path.join(root, 'slow.txt'))).toBe(false);
    expect(last(rows(host.db))).toMatchObject({ capability: 'fs.write', outcome: 'timed_out', code: 'timed_out' });

    await forge(host, forgeArgs('post_it', POST_IT, ['fetch'], [{ input: { url: `http://127.0.0.1:${port}/hold`, body: '{}' } }]));
    const held = await callTool(host.orchestrator, 'post_it', { url: `http://127.0.0.1:${port}/hold`, body: '{}' });
    expect(held.output).toEqual({ error: 'cut_in_flight' });
    expect(seen.map((request) => request.url)).toEqual(['/hold']);
    expect(last(rows(host.db))).toMatchObject({ capability: 'fetch', outcome: null, code: 'cut_in_flight' });
    expect(last(held.effects)).toMatchObject({ outcome: 'unknown', code: 'cut_in_flight' });
  });

  it('runs forge tests against an overlay: reads see the run, deletes and create-only checks match a real call, POSTs take the test answers, and the judge sees full targets marked as dry runs', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'exists.txt'), 'real');
    const { port, seen } = await serve();
    const host = await hostWith(
      {
        'fs.read': { roots: [root] },
        'fs.write': WRITE_CEILING(root),
        'fs.delete': { roots: [root], maxFilesPerCall: 2, timeoutMs: 5000, approval: 'none' },
        fetch: { domains: ['127.0.0.1'], methods: ['POST'], maxRequestBytes: 64, approval: 'none' },
      },
      { audit: { content: 'digest' } },
    );
    const ROUND_TRIP = `async function execute(input) {
      await fs.writeFile(input.path, input.text);
      const back = await fs.readFile(input.path);
      await fs.unlink(input.path);
      let gone = false;
      try { await fs.readFile(input.path); } catch (e) { gone = String(e && e.message).startsWith('no_such_file'); }
      const r = await fetch(input.url, { method: 'POST', body: back });
      const answer = await r.json();
      return { back, gone, id: answer.id };
    }`;
    await forge(
      host,
      forgeArgs('round_trip', ROUND_TRIP, ['fs.read', 'fs.write', 'fs.delete', 'fetch'], [
        {
          input: { path: path.join(root, 'tmp.txt'), text: 'draft', url: `http://127.0.0.1:${port}/items` },
          responses: [{ method: 'POST', url: `http://127.0.0.1:${port}/items`, status: 201, body: '{"id":"from-test"}' }],
        },
      ]),
    );
    expect(fs.existsSync(path.join(root, 'tmp.txt'))).toBe(false);
    expect(seen).toEqual([]);
    const prompt = String(last(host.judge.mock.calls)?.[1]);
    expect(prompt).toContain('output={"back":"draft","gone":true,"id":"from-test"}');
    expect(prompt).toContain(`"target":"${path.join(root, 'tmp.txt')}"`);
    expect(prompt).toContain('"dryRun":true');
    expect(prompt).toContain('Effects marked "dryRun": true were checked as a real call checks them and not carried out');

    // A create-only write onto an existing real file is refused in a forge test as in a call.
    const refusedInTest = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [{ path: path.join(root, 'exists.txt'), text: 'x' }] } }]),
    );
    expect(refusedInTest.isError).toBeFalsy();
    expect(String(last(host.judge.mock.calls)?.[1])).toContain('output={"out":["file_exists"]}');
    expect(fs.readFileSync(path.join(root, 'exists.txt'), 'utf8')).toBe('real');
  });

  it('lets effectPolicy refuse with its reason and return the share, and refuses when it throws or does not answer', async () => {
    const root = tempRoot();
    const host = await hostWith(
      { 'fs.write': WRITE_CEILING(root, { maxFilesPerCall: 1 }) },
      {
        effectPolicy: (effect) => {
          const name = path.basename(effect.target);
          if (effect.dryRun || name.startsWith('ok')) {
            return undefined;
          }
          if (name === 'deny.txt') {
            return { deny: 'no writes here' };
          }
          if (name === 'throw.txt') {
            throw new Error('policy store offline');
          }
          return new Promise<undefined>(() => undefined);
        },
      },
    );
    await forge(host, forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]));
    // In one call with maxFilesPerCall 1: the refused write returns its share, so the next one lands.
    const denied = await callTool(host.orchestrator, 'write_each', {
      files: [
        { path: path.join(root, 'deny.txt'), text: 'a' },
        { path: path.join(root, 'ok-1.txt'), text: 'b' },
      ],
    });
    expect(denied.output).toEqual({ out: ['policy_denied', 'ok'] });
    expect(rows(host.db).find((row) => row.code === 'policy_denied')).toMatchObject({
      decision: 'refused',
      target: path.join(root, 'deny.txt'),
    });
    for (const name of ['throw.txt', 'silent.txt']) {
      const refused = await callTool(host.orchestrator, 'write_each', { files: [{ path: path.join(root, name), text: 'c' }] });
      expect(refused.output).toEqual({ out: ['policy_denied'] });
    }
    expect(fs.readdirSync(root)).toEqual(['ok-1.txt']);
  });

  it('refuses fs.writeSync beside fs.read, and a host with no ceiling refuses fs.write', async () => {
    const root = tempRoot();
    const host = await hostWith({ 'fs.read': { roots: [root] }, 'fs.write': WRITE_CEILING(root) });
    const sync = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('sync_write', 'async function execute(input) { fs.writeSync(1, "x"); return { r: await fs.readFile(input.p) }; }', ['fs.read'], [
        { input: { p: path.join(root, 'x') } },
      ]),
    );
    expect(String(sync.errorDetails?.message ?? JSON.stringify(sync.output))).toContain('fs.write* other than fs.writeFile is forbidden');

    const legacy = await makeForgeHost();
    const refused = await callTool(
      legacy.orchestrator,
      'forge_tool',
      forgeArgs('write_each', WRITE_EACH, ['fs.write'], [{ input: { files: [] } }]),
    );
    expect(String(refused.errorDetails?.message ?? JSON.stringify(refused.output))).toContain('effects_need_ceiling: fs.write');
    expect(legacy.judge).not.toHaveBeenCalled();
  });

  it('fails construction for an effect grant on the in-process executor, a protected root, and an approval not yet available', async () => {
    const root = tempRoot();
    await expect(
      makeForgeHost({ db: createSqliteAdapter(), config: { capabilities: { 'fs.write': WRITE_CEILING(root) } } }),
    ).rejects.toThrow('executor_does_not_isolate');
    fs.mkdirSync(path.join(root, 'sub'));
    await expect(
      makeForgeHost({
        db: createSqliteAdapter(),
        config: {
          capabilities: { 'fs.write': WRITE_CEILING(path.join(root, 'sub')) },
          executor,
          protectedPaths: [root],
        },
      }),
    ).rejects.toThrow('protected_path');
    await expect(
      makeForgeHost({
        db: createSqliteAdapter(),
        config: { capabilities: { 'fs.write': WRITE_CEILING(root, { approval: 'per-call' }) }, executor },
      }),
    ).rejects.toThrow('approval_not_available');
  });
});
