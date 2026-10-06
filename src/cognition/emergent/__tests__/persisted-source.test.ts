import { describe, it, expect } from 'vitest';
import { normalizeAllowlist, toSandboxApis } from '../capabilities.js';
import {
  inferRequestFromCode,
  parsePersistedSource,
  parseStoredRequest,
  requestFromImplementation,
} from '../persisted-source.js';

describe('normalizeAllowlist', () => {
  it('maps the alias onto the catalogue name and drops duplicates', () => {
    expect(normalizeAllowlist(['fs.readFile', 'fs.read', 'fetch'])).toEqual({
      capabilities: ['fs.read', 'fetch'],
      unknown: [],
    });
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
  it('finds the three capabilities by the same text scan validateCode uses', () => {
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
    ).toEqual({ kind: 'sandbox', capabilities: ['fs.read', 'fetch'], inferred: true });
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
