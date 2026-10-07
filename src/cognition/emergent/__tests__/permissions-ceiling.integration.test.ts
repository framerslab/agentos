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
