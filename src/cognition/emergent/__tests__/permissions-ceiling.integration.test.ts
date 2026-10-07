/**
 * @fileoverview The ceiling for code-forged tools, through forge_tool,
 * ToolOrchestrator.processToolCall, the library's loader and a directly built
 * engine, with a test-double judge.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { ComposableToolBuilder } from '../ComposableToolBuilder.js';
import { EmergentCapabilityEngine } from '../EmergentCapabilityEngine.js';
import { EmergentJudge } from '../EmergentJudge.js';
import { EmergentToolRegistry } from '../EmergentToolRegistry.js';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import { DEFAULT_EMERGENT_CONFIG, type EmergentConfig } from '../types.js';
import { APPROVED_VERDICT, callTool, makeForgeHost } from './helpers/forge-host.js';
import { createSqliteAdapter, readStateRow } from './helpers/sqlite-adapter.js';
import { seedStateRow, seedToolRow } from './helpers/seed-rows.js';

const servers: http.Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    }),
  );
});

/** A server on every interface: 127.0.0.1 and localhost are two origins on it. `seen` lists request paths. */
async function serve(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, port: number) => void,
): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  let port = 0;
  const server = http.createServer((req, res) => {
    seen.push(req.url ?? '');
    handler(req, res, port);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
  return { port, seen };
}

/** `/big` answers 4 KiB; `/away` redirects to localhost; anything else answers "ok". */
function routes(req: http.IncomingMessage, res: http.ServerResponse, port: number): void {
  if (req.url === '/big') {
    res.end('x'.repeat(4096));
    return;
  }
  if (req.url === '/away') {
    res.statusCode = 302;
    res.setHeader('location', `http://localhost:${port}/ok`);
    res.end();
    return;
  }
  res.end('ok');
}

function tempRoot(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ceiling-')));
}

const ANY_OUT = { type: 'object', additionalProperties: true };
const URL_IN = { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] };
const PATH_IN = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] };
const FETCH_CODE =
  'async function execute(input) { const r = await fetch(input.url); return { status: r.status, body: await r.text() }; }';
const READ_CODE = 'async function execute(input) { return { text: await fs.readFile(input.path) }; }';

function forgeArgs(
  name: string,
  code: string,
  allowlist: string[],
  inputSchema: Record<string, unknown>,
  testInput: Record<string, unknown>,
) {
  return {
    name,
    description: `Forged ${name}.`,
    inputSchema,
    outputSchema: ANY_OUT,
    implementation: { mode: 'sandbox', code, allowlist },
    testCases: [{ input: testInput }],
  };
}

/** The engine's start-up lines about running without a ceiling. */
function legacyLines(warn: { mock: { calls: unknown[][] } }): string[] {
  return warn.mock.calls.map((args) => String(args[0])).filter((line) => line.includes('without a ceiling'));
}

describe('a ceiling for code-forged tools', () => {
  it('1. without a ceiling a forged fetch tool behaves as before, and the engine says once what runs unscoped', async () => {
    const warn = vi.spyOn(console, 'warn');
    const { port, seen } = await serve(routes);
    const host = await makeForgeHost();
    expect(legacyLines(warn)).toHaveLength(1);
    expect(legacyLines(warn)[0]).toContain("capabilities: { fetch: { domains: '*' }");

    const forged = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `http://127.0.0.1:${port}/ok` }),
    );
    expect(forged.isError).toBeFalsy();
    // The legacy fetch follows a redirect to any host.
    const away = await callTool(host.orchestrator, 'get_it', { url: `http://127.0.0.1:${port}/away` });
    expect(away.output).toEqual({ status: 200, body: 'ok' });
    expect(seen).toContain('/away');
  });

  it('2. a request outside the ceiling is refused before any test runs, naming what the host grants; fs.read and fs.readFile both forge a reading tool', async () => {
    const warn = vi.spyOn(console, 'warn');
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    const { port, seen } = await serve(routes);
    const host = await makeForgeHost({
      config: { capabilities: { 'fs.read': { roots: [root] }, crypto: {} }, audit: { store: 'none' } },
    });
    expect(legacyLines(warn)).toHaveLength(0);

    const refused = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `http://127.0.0.1:${port}/ok` }),
    );
    expect(refused.isError).toBe(true);
    expect(String(refused.errorDetails?.message)).toContain(
      'capability_not_granted: fetch; this host grants fs.read, crypto',
    );
    expect(seen).toEqual([]);
    expect(host.judge).not.toHaveBeenCalled();

    for (const [name, list] of [
      ['read_alias', ['fs.readFile']],
      ['read_named', ['fs.read']],
    ] as const) {
      const forged = await callTool(
        host.orchestrator,
        'forge_tool',
        forgeArgs(name, READ_CODE, [...list], PATH_IN, { path: path.join(root, 'note.txt') }),
      );
      expect(forged.isError).toBeFalsy();
      const read = await callTool(host.orchestrator, name, { path: path.join(root, 'note.txt') });
      expect(read.output).toEqual({ text: 'hello' });
    }
  });

  it('3. under a ceiling a redirect to an unlisted host is refused at the hop, and bodies and files past their limits are refused', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'small.txt'), 'small');
    fs.writeFileSync(path.join(root, 'big.txt'), 'y'.repeat(4096));
    const { port, seen } = await serve(routes);
    const host = await makeForgeHost({
      config: {
        capabilities: {
          fetch: { domains: ['127.0.0.1'], maxResponseBytes: 1024 },
          'fs.read': { roots: [root], maxBytesPerRead: 1024 },
        },
        audit: { store: 'none' },
      },
    });
    const fetching = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `http://127.0.0.1:${port}/ok` }),
    );
    expect(fetching.isError).toBeFalsy();
    const reading = await callTool(
      host.orchestrator,
      'forge_tool',
      forgeArgs('read_it', READ_CODE, ['fs.read'], PATH_IN, { path: path.join(root, 'small.txt') }),
    );
    expect(reading.isError).toBeFalsy();

    const away = await callTool(host.orchestrator, 'get_it', { url: `http://127.0.0.1:${port}/away` });
    expect(away.isError).toBe(true);
    expect(String(away.errorDetails?.message)).toContain('host_not_allowed: localhost');
    // The hop was never sent: /ok was reached once, by the forge's test case.
    expect(seen.filter((url) => url === '/ok')).toHaveLength(1);

    const big = await callTool(host.orchestrator, 'get_it', { url: `http://127.0.0.1:${port}/big` });
    expect(String(big.errorDetails?.message)).toContain('response_too_large');

    const file = await callTool(host.orchestrator, 'read_it', { path: path.join(root, 'big.txt') });
    expect(String(file.errorDetails?.message)).toContain('file_too_large');
  });

  it('4. a host-built forge wider than the ceiling fails construction, disjoint lists never widen, and each failure names its key', () => {
    const judge = new EmergentJudge({
      judgeModel: 'judge',
      promotionModel: 'judge',
      generateText: async () => APPROVED_VERDICT,
    });
    const build = (config: EmergentConfig, sandboxForge?: SandboxedToolForge) =>
      new EmergentCapabilityEngine({
        config,
        composableBuilder: new ComposableToolBuilder(async () => ({ success: true, output: {} })),
        ...(sandboxForge ? { sandboxForge } : {}),
        judge,
        registry: new EmergentToolRegistry(config),
      });
    const withCeiling = (capabilities: EmergentConfig['capabilities'], audit?: EmergentConfig['audit']): EmergentConfig => ({
      ...DEFAULT_EMERGENT_CONFIG,
      enabled: true,
      allowSandboxTools: true,
      capabilities,
      audit: audit ?? { store: 'none' },
    });
    const ceiling = withCeiling({ fetch: { domains: ['api.example.com'] }, 'fs.read': { roots: ['/srv/data'] } });

    expect(() => build(ceiling, new SandboxedToolForge())).toThrow(
      'forge_wider_than_ceiling: sandboxForge.fetchDomainAllowlist',
    );
    expect(() =>
      build(ceiling, new SandboxedToolForge({ fetchDomainAllowlist: ['other.example.com'], fsReadRoots: ['/srv/data'] })),
    ).toThrow('forge_wider_than_ceiling');
    expect(() =>
      build(ceiling, new SandboxedToolForge({ fetchDomainAllowlist: ['api.example.com'], fsReadRoots: ['/etc'] })),
    ).toThrow('forge_wider_than_ceiling: sandboxForge.fsReadRoots');
    expect(
      build(ceiling, new SandboxedToolForge({ fetchDomainAllowlist: ['api.example.com'], fsReadRoots: ['/srv/data/sub'] })),
    ).toBeInstanceOf(EmergentCapabilityEngine);
    // Without a forge of its own the engine builds one from the ceiling.
    expect(build(ceiling)).toBeInstanceOf(EmergentCapabilityEngine);

    expect(() => build(withCeiling({ 'fs.write': { roots: ['/tmp'] } } as never))).toThrow(
      'unknown_capability: capabilities.fs.write',
    );
    expect(() => build(withCeiling({ crypto: {} }, {}))).toThrow('audit_needs_storage: audit.store');
  });
});

describe('the ceiling at load', () => {
  /** A stored reading tool, as a host or an earlier process wrote it. */
  function seedReader(db: ReturnType<typeof createSqliteAdapter>): void {
    seedToolRow(db, {
      id: 'reader-1',
      name: 'read_it',
      mode: 'sandbox',
      source: JSON.stringify({ mode: 'sandbox', code: READ_CODE, allowlist: ['fs.read'] }),
      inputSchema: PATH_IN,
      outputSchema: ANY_OUT,
    });
  }

  it('lowering the ceiling suspends a stored tool at the next load, and restoring it brings the tool back', async () => {
    const root = tempRoot();
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    const db = createSqliteAdapter();
    const wide = { capabilities: { 'fs.read': { roots: [root] }, crypto: {} } };

    const first = await makeForgeHost({ db, config: wide });
    seedReader(db);
    expect((await first.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'reader-1', name: 'read_it', state: 'active', reason: null },
    ]);
    expect((await callTool(first.orchestrator, 'read_it', { path: path.join(root, 'note.txt') })).output).toEqual({
      text: 'hello',
    });

    const narrow = await makeForgeHost({ db, config: { capabilities: { crypto: {} } } });
    expect((await narrow.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'reader-1', name: 'read_it', state: 'suspended', reason: 'capability_not_granted' },
    ]);
    expect(readStateRow(db, 'reader-1')).toMatchObject({
      state: 'suspended',
      state_reason: 'capability_not_granted',
      set_by: 'library',
    });
    expect(await narrow.orchestrator.getTool('read_it')).toBeUndefined();

    const restored = await makeForgeHost({ db, config: wide });
    expect((await restored.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'reader-1', name: 'read_it', state: 'active', reason: null },
    ]);
    expect(
      (await callTool(restored.orchestrator, 'read_it', { path: path.join(root, 'note.txt') })).output,
    ).toEqual({ text: 'hello' });
  });

  it('a stored request this release cannot read is suspended under a ceiling, and left as it was', async () => {
    const root = tempRoot();
    const db = createSqliteAdapter();
    const host = await makeForgeHost({ db, config: { capabilities: { 'fs.read': { roots: [root] } } } });
    seedReader(db);
    // A later release wrote a capability this one does not know.
    const foreign = '{"kind":"sandbox","capabilities":["fs.read","fs.write"]}';
    seedStateRow(db, { toolId: 'reader-1', state: 'active', requestJson: foreign });

    expect((await host.engine.loadPersistedTools({ tiers: ['shared'] })).outcomes).toEqual([
      { toolId: 'reader-1', name: 'read_it', state: 'suspended', reason: 'request_unreadable' },
    ]);
    expect(readStateRow(db, 'reader-1')).toMatchObject({
      state: 'suspended',
      state_reason: 'request_unreadable',
      request_json: foreign,
    });
    // The host's reactivation meets the same check.
    expect(await host.engine.reactivateTool('reader-1')).toMatchObject({
      state: 'suspended',
      reason: 'request_unreadable',
    });
  });
});

describe('the call deadline and effect records', () => {
  it('7. a run that times out mid-request starts nothing new, aborts the request and returns within about a second of its deadline; a run beside it keeps its request', async () => {
    let releaseSlow!: () => void;
    const slowReleased = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowArrived!: () => void;
    const slowSeen = new Promise<void>((resolve) => {
      slowArrived = resolve;
    });
    const { port, seen } = await serve((req, res) => {
      if (req.url === '/hang') {
        return; // never answers
      }
      if (req.url === '/slow') {
        slowArrived();
        void slowReleased.then(() => res.end('slow'));
        return;
      }
      res.end('ok');
    });
    const db = createSqliteAdapter();
    const host = await makeForgeHost({
      db,
      config: { sandboxTimeoutMs: 1000, capabilities: { fetch: { domains: ['127.0.0.1'] } } },
    });
    const base = `http://127.0.0.1:${port}`;
    const TWO_STEP =
      'async function execute(input) { try { await fetch(input.first); } catch (e) {} await fetch(input.then); return { done: true }; }';
    const FIRE = 'async function execute(input) { fetch(input.url).catch(() => undefined); return { started: true }; }';
    const TWO_IN = {
      type: 'object',
      properties: { first: { type: 'string' }, then: { type: 'string' } },
      required: ['first', 'then'],
    };
    for (const args of [
      forgeArgs('two_step', TWO_STEP, ['fetch'], TWO_IN, { first: `${base}/ok`, then: `${base}/ok` }),
      forgeArgs('fire', FIRE, ['fetch'], URL_IN, { url: `${base}/ok` }),
      forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `${base}/ok` }),
    ]) {
      expect((await callTool(host.orchestrator, 'forge_tool', args)).isError).toBeFalsy();
    }

    // A run that times out while its request is in flight.
    const started = Date.now();
    const timedOut = await callTool(host.orchestrator, 'two_step', { first: `${base}/hang`, then: `${base}/after` });
    expect(timedOut.isError).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000 + 1000 + 500);
    expect(timedOut.effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'capability',
          capability: 'fetch',
          outcome: expect.stringMatching(/^(aborted|pending)$/),
        }),
      ]),
    );
    // Its code went on to a second request after the run ended: refused and recorded, never sent.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).not.toContain('/after');
    expect(
      db.raw
        .prepare("SELECT decision, decided_by FROM agentos_emergent_effects WHERE decided_by = 'call_ended'")
        .all(),
    ).toEqual([{ decision: 'refused', decided_by: 'call_ended' }]);

    // A run that ends while another run has a request in flight.
    const slow = callTool(host.orchestrator, 'get_it', { url: `${base}/slow` });
    await slowSeen;
    const fired = await callTool(host.orchestrator, 'fire', { url: `${base}/hang` });
    expect(fired.output).toEqual({ started: true });
    // Its request was either never sent (the run had ended when its intent
    // record landed: code call_ended) or aborted in flight (code aborted).
    expect(fired.effects).toEqual([expect.objectContaining({ capability: 'fetch', outcome: 'aborted' })]);
    releaseSlow();
    const slowResult = await slow;
    expect(slowResult.output).toEqual({ status: 200, body: 'slow' });
    expect(slowResult.effects).toEqual([
      expect.objectContaining({ capability: 'fetch', outcome: 'ok', record: 'written' }),
    ]);
  });

  it("8. without a ceiling no effect record is written; with one, a failed record write refuses the call; a composed result carries its steps' effects", async () => {
    const { port, seen } = await serve(routes);
    const base = `http://127.0.0.1:${port}`;

    // Without a ceiling.
    const plainDb = createSqliteAdapter();
    const plain = await makeForgeHost({ db: plainDb });
    expect(
      (await callTool(plain.orchestrator, 'forge_tool', forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `${base}/ok` })))
        .isError,
    ).toBeFalsy();
    const unrecorded = await callTool(plain.orchestrator, 'get_it', { url: `${base}/ok` });
    expect(unrecorded.output).toEqual({ status: 200, body: 'ok' });
    expect(unrecorded.effects).toBeUndefined();
    expect(plainDb.raw.prepare('SELECT COUNT(*) AS n FROM agentos_emergent_effects').get()).toEqual({ n: 0 });

    // With a ceiling: each capability call is recorded before it runs and after.
    const db = createSqliteAdapter();
    const host = await makeForgeHost({
      db,
      config: {
        capabilities: { fetch: { domains: ['127.0.0.1'] } },
        compose: { sideEffectingTools: ['get_it'] },
      },
    });
    expect(
      (await callTool(host.orchestrator, 'forge_tool', forgeArgs('get_it', FETCH_CODE, ['fetch'], URL_IN, { url: `${base}/ok` })))
        .isError,
    ).toBeFalsy();
    const recorded = await callTool(host.orchestrator, 'get_it', { url: `${base}/ok` });
    expect(recorded.effects).toEqual([
      expect.objectContaining({
        kind: 'capability',
        capability: 'fetch',
        decision: 'allowed',
        decidedBy: 'ceiling',
        outcome: 'ok',
        record: 'written',
      }),
    ]);
    expect(
      db.raw.prepare('SELECT capability, decision, outcome, target_form FROM agentos_emergent_effects').all(),
    ).toEqual(
      expect.arrayContaining([{ capability: 'fetch', decision: 'allowed', outcome: 'ok', target_form: 'digest' }]),
    );

    // A failed intent write refuses the call before it is sent.
    const sentBefore = seen.length;
    db.failNext('INSERT INTO agentos_emergent_effects');
    const refused = await callTool(host.orchestrator, 'get_it', { url: `${base}/ok` });
    expect(refused.isError).toBe(true);
    expect(String(refused.errorDetails?.message)).toContain('audit_unavailable');
    expect(refused.effects).toEqual([
      expect.objectContaining({ decision: 'refused', decidedBy: 'audit_unavailable', record: 'none' }),
    ]);
    expect(seen.length).toBe(sentBefore);

    // A composition over the forged tool carries the step's effects.
    const composed = await callTool(host.orchestrator, 'forge_tool', {
      name: 'get_through',
      description: 'Fetches through get_it.',
      inputSchema: URL_IN,
      outputSchema: ANY_OUT,
      implementation: {
        mode: 'compose',
        steps: [{ name: 'fetch', tool: 'get_it', inputMapping: { url: '$input.url' } }],
      },
      testCases: [{ input: { url: `${base}/ok` }, stepOutputs: { fetch: { status: 200, body: 'ok' } } }],
    });
    expect(composed.isError).toBeFalsy();
    const through = await callTool(host.orchestrator, 'get_through', { url: `${base}/ok` });
    expect(through.output).toEqual({ status: 200, body: 'ok' });
    expect(through.effects).toEqual([
      expect.objectContaining({ kind: 'capability', capability: 'fetch', outcome: 'ok', record: 'written' }),
    ]);
  });
});
