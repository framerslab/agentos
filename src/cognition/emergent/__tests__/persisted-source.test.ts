import { describe, it, expect } from 'vitest';
import { normalizeAllowlist, toSandboxApis } from '../capabilities.js';
import {
  inferRequestFromCode,
  parsePersistedSource,
  parseStoredRequest,
  requestFromImplementation,
  requestFromSource,
  sourceFromImplementation,
  toolFromRow,
} from '../persisted-source.js';
import { SandboxedToolForge } from '../SandboxedToolForge.js';
import type { PersistedToolRow, SandboxedToolSpec } from '../types.js';

describe('normalizeAllowlist', () => {
  it('maps the alias onto the catalogue name and drops duplicates', () => {
    expect(normalizeAllowlist(['fs.readFile', 'fs.read', 'fetch'])).toEqual({
      capabilities: ['fetch', 'fs.read'],
      unknown: [],
    });
  });

  it('returns the names in catalogue order, whatever order the request wrote them in', () => {
    expect(normalizeAllowlist(['crypto', 'fetch']).capabilities).toEqual(['fetch', 'crypto']);
  });

  it('reports names outside the catalogue instead of dropping them', () => {
    expect(normalizeAllowlist(['fetch', 'process.spawn'])).toEqual({
      capabilities: ['fetch'],
      unknown: ['process.spawn'],
    });
  });

  it('maps catalogue names back to the names injected into forged code', () => {
    expect(toSandboxApis(['fs.read', 'crypto'])).toEqual(['fs.readFile', 'crypto']);
  });
});

describe('inferRequestFromCode', () => {
  it('finds each capability the code uses', () => {
    const code = `async function execute(i) {
      const r = await fetch(i.url);
      const t = await fs.readFile(i.path);
      return { id: crypto.randomUUID(), r: r.status, t };
    }`;
    expect(inferRequestFromCode(code)).toEqual(['fetch', 'fs.read', 'crypto']);
  });

  it('returns nothing for code that uses none of them', () => {
    expect(inferRequestFromCode('function execute(i) { return { n: i.n * 2 }; }')).toEqual([]);
  });

  // A stored code tool is checked by validateCode at every call against the
  // list inferred here, so the two scans must ask for the same capabilities:
  // the inferred list passes, and a list missing any one of them does not.
  const forge = new SandboxedToolForge();
  it.each([
    ['fetch alone', 'async function execute(i) { return (await fetch(i.url)).status; }'],
    ['fs.read alone', 'async function execute(i) { return await fs.readFile(i.path); }'],
    ['crypto alone', 'function execute(i) { return { id: crypto.randomUUID() }; }'],
    [
      'all three',
      'async function execute(i) { const r = await fetch(i.url); const t = await fs.readFile(i.path); ' +
        'return { id: crypto.randomUUID(), r: r.status, t }; }',
    ],
    ['none of them', 'function execute(i) { return { n: i.n * 2 }; }'],
    [
      'fetch called as a property',
      'async function execute(i) { return (await globalThis.fetch(i.url)).ok; }',
    ],
    ['a space before the dot', 'async function execute(i) { return await fs .readFile(i.path); }'],
    ['an fs member other than readFile', 'async function execute(i) { return await fs.stat(i.path); }'],
    [
      'a name only in a comment',
      'function execute(i) {\n  // crypto.randomUUID() would also do\n  return { id: i.n + 1 };\n}',
    ],
    ['a name with no call or member', 'function execute(i) { const crypto = i.c; return { c: crypto }; }'],
    [
      'names that only contain a capability',
      'function execute(i) { return { a: i.refetch(1), b: i.fsx.size, c: i.fetcher }; }',
    ],
  ])('agrees with validateCode on %s', (_label, code) => {
    const inferred = inferRequestFromCode(code);
    expect(forge.validateCode(code, toSandboxApis(inferred))).toEqual({ valid: true, violations: [] });
    for (const dropped of inferred) {
      const narrower = inferred.filter((name) => name !== dropped);
      expect(forge.validateCode(code, toSandboxApis(narrower)).valid).toBe(false);
    }
  });
});

describe('parsePersistedSource', () => {
  it('reads a raw-code row and infers its request from the code', () => {
    const source = 'function execute(i) { return { id: crypto.randomUUID() }; }';
    expect(parsePersistedSource('sandbox', source)).toEqual({
      format: 'raw-code',
      implementation: { mode: 'sandbox', code: source, allowlist: ['crypto'] },
      capabilities: ['crypto'],
      inferred: true,
    });
  });

  it('reads a JSON row with mode, code and allowlist and takes its request from the stored list', () => {
    const code = 'async function execute(i) { return { t: await fs.readFile(i.p) }; }';
    const source = JSON.stringify({ mode: 'sandbox', code, allowlist: ['fs.readFile'] });
    expect(parsePersistedSource('sandbox', source)).toEqual({
      format: 'code-with-list',
      implementation: { mode: 'sandbox', code, allowlist: ['fs.readFile'] },
      capabilities: ['fs.read'],
      inferred: false,
    });
  });

  it('reads a redacted record as a source that cannot be rebuilt', () => {
    const source = JSON.stringify({
      redacted: true,
      reason: 'sandbox-source-not-persisted',
      allowlist: ['fetch'],
      codeBytes: 64,
    });
    expect(parsePersistedSource('sandbox', source)).toEqual({
      format: 'redacted',
      capabilities: ['fetch'],
    });
  });

  it('reports a code row that is JSON of neither stored shape', () => {
    const unknownShapes = [
      '{"mode":"sandbox","allowlist":["fetch"]}',
      '{"code":"function execute(i){return i}","allowlist":[]}',
      JSON.stringify('function execute(i) { return i; }'),
    ];
    for (const source of unknownShapes) {
      expect(parsePersistedSource('sandbox', source).format).toBe('unreadable');
    }
  });

  it('reads a compose row', () => {
    const spec = {
      mode: 'compose',
      steps: [{ name: 's1', tool: 'echo', inputMapping: { text: '$input.text' } }],
    };
    expect(parsePersistedSource('compose', JSON.stringify(spec))).toEqual({
      format: 'compose',
      implementation: spec,
    });
  });

  it("keeps a step's condition and nothing a step does not have", () => {
    const source = JSON.stringify({
      mode: 'compose',
      steps: [{ name: 's1', tool: 'echo', inputMapping: {}, condition: '$prev.ok', note: 'x' }],
    });
    expect(parsePersistedSource('compose', source)).toEqual({
      format: 'compose',
      implementation: {
        mode: 'compose',
        steps: [{ name: 's1', tool: 'echo', inputMapping: {}, condition: '$prev.ok' }],
      },
    });
  });

  it('reports a compose row whose steps the builder cannot run, and stores no request for it', () => {
    const unrunnable = [
      '{"mode":"compose","steps":[null]}',
      '{"mode":"compose","steps":[{"name":"s1"}]}',
      '{"mode":"compose","steps":[]}',
      '{"mode":"compose","steps":[{"name":"s1","tool":" ","inputMapping":{}}]}',
      '{"mode":"compose","steps":[{"name":"s1","tool":"echo","inputMapping":[]}]}',
    ];
    for (const source of unrunnable) {
      const parsed = parsePersistedSource('compose', source);
      expect(parsed.format).toBe('unreadable');
      expect(requestFromSource(parsed)).toBeNull();
    }
    // The same rules hold for a composition held in memory.
    expect(sourceFromImplementation({ mode: 'compose', steps: [] }).format).toBe('unreadable');
  });

  it('reports a compose row that is not JSON, and an unknown mode', () => {
    expect(parsePersistedSource('compose', 'not json').format).toBe('unreadable');
    expect(parsePersistedSource('wasm', '{}').format).toBe('unreadable');
  });
});

describe('stored requests', () => {
  it('stores catalogue names for a code tool and the step list for a composition', () => {
    expect(
      requestFromImplementation({ mode: 'sandbox', code: 'x', allowlist: ['fs.readFile', 'crypto'] }),
    ).toEqual({ kind: 'sandbox', capabilities: ['fs.read', 'crypto'] });
    expect(
      requestFromImplementation({
        mode: 'compose',
        steps: [{ name: 's1', tool: 'echo', inputMapping: { text: '$input.text' } }],
      }),
    ).toEqual({ kind: 'compose', steps: [{ name: 's1', tool: 'echo' }] });
  });

  it('treats an unreadable request column as no stored request', () => {
    expect(parseStoredRequest('{"kind":"sandbox","capabilities":["fetch"]}')).toEqual({
      kind: 'sandbox',
      capabilities: ['fetch'],
    });
    expect(parseStoredRequest('not json')).toBeNull();
    expect(parseStoredRequest('{"kind":"other"}')).toBeNull();
    expect(parseStoredRequest(null)).toBeNull();
  });

  it('returns catalogue names and only the fields of a request', () => {
    expect(
      parseStoredRequest(
        '{"kind":"sandbox","capabilities":["fs.readFile","fetch","fs.read"],"inferred":true,"extra":1}',
      ),
    ).toEqual({ kind: 'sandbox', capabilities: ['fetch', 'fs.read'], inferred: true });
    expect(
      parseStoredRequest('{"kind":"compose","steps":[{"name":"s1","tool":"echo","inputMapping":{}}]}'),
    ).toEqual({ kind: 'compose', steps: [{ name: 's1', tool: 'echo' }] });
  });

  it('treats a request without its list, or with a name outside the catalogue, as no stored request', () => {
    expect(parseStoredRequest('{"kind":"sandbox"}')).toBeNull();
    expect(parseStoredRequest('{"kind":"sandbox","capabilities":"fetch"}')).toBeNull();
    expect(parseStoredRequest('{"kind":"sandbox","capabilities":["fetch",7]}')).toBeNull();
    expect(parseStoredRequest('{"kind":"sandbox","capabilities":["fetch","process.spawn"]}')).toBeNull();
    expect(parseStoredRequest('{"kind":"compose"}')).toBeNull();
    expect(parseStoredRequest('{"kind":"compose","steps":[{"name":"s1"}]}')).toBeNull();
    expect(parseStoredRequest('{"kind":"compose","steps":[null]}')).toBeNull();
    expect(parseStoredRequest('["sandbox"]')).toBeNull();
  });
});

describe('toolFromRow', () => {
  it('reads BIGINT times stored as numbers or as strings, and a blank one as no time', () => {
    const implementation: SandboxedToolSpec = {
      mode: 'sandbox',
      code: 'function execute(i) { return { doubled: i.n * 2 }; }',
      allowlist: [],
    };
    // Postgres returns a BIGINT column as a string.
    const row: PersistedToolRow = {
      id: 'emergent_1',
      name: 'double_it',
      description: 'Doubles a number.',
      input_schema: '{"type":"object","properties":{"n":{"type":"number"}}}',
      output_schema: null,
      implementation_mode: 'sandbox',
      implementation_source: implementation.code,
      tier: 'shared',
      created_by_agent: 'agent-1',
      created_by_session: 'sess-1',
      created_at: '1696000000000',
      judge_verdicts: null,
      confidence_score: null,
      total_uses: null,
      success_count: null,
      failure_count: null,
      avg_execution_ms: null,
      last_used_at: '1696000000500',
      is_active: 1,
      state: null,
      state_reason: null,
      state_at: null,
      request_json: null,
    };

    const tool = toolFromRow(row, implementation);
    expect(tool.createdAt).toBe('2023-09-29T15:06:40.000Z');
    expect(tool.usageStats.lastUsedAt).toBe('2023-09-29T15:06:40.500Z');

    // SQLite returns it as a number.
    const fromNumbers = toolFromRow(
      { ...row, created_at: 1696000000000, last_used_at: 1696000000500 },
      implementation,
    );
    expect(fromNumbers.createdAt).toBe('2023-09-29T15:06:40.000Z');
    expect(fromNumbers.usageStats.lastUsedAt).toBe('2023-09-29T15:06:40.500Z');

    expect(toolFromRow({ ...row, last_used_at: '' }, implementation).usageStats.lastUsedAt).toBeNull();
    expect(toolFromRow({ ...row, last_used_at: null }, implementation).usageStats.lastUsedAt).toBeNull();
  });
});
