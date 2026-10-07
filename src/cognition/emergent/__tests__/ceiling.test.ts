import { describe, it, expect } from 'vitest';
import { checkRequest, narrowToForge, resolveCeiling } from '../ceiling.js';

const storage = { hasStorage: true };

describe('resolveCeiling', () => {
  it('applies the defaults and keeps only the keys given', () => {
    const ceiling = resolveCeiling({ fetch: { domains: ['API.example.com'] }, crypto: {} }, undefined, storage);
    expect(ceiling.fetch).toEqual({
      domains: ['api.example.com'],
      methods: ['GET', 'HEAD'],
      maxResponseBytes: 5 * 1024 * 1024,
      maxRedirects: 5,
      timeoutMs: 30_000,
    });
    expect(ceiling['fs.read']).toBeUndefined();
    expect(ceiling.crypto).toBe(true);
    expect(ceiling.audit).toEqual({ store: 'storage', content: 'digest' });
  });

  it('an empty list grants nothing', () => {
    const ceiling = resolveCeiling({ fetch: { domains: [] }, 'fs.read': { roots: [] } }, undefined, storage);
    expect(ceiling.fetch).toBeUndefined();
    expect(ceiling['fs.read']).toBeUndefined();
  });

  it('names each failure with its key', () => {
    const cases: Array<[unknown, string]> = [
      [{ 'fs.write': { roots: ['/tmp'] } }, 'unknown_capability: capabilities.fs.write'],
      [{ 'fs.read': { roots: ['relative/dir'] } }, 'root_not_absolute: capabilities.fs.read.roots'],
      [{ fetch: { domains: '*', methods: ['POST'] } }, 'method_not_allowed: capabilities.fetch.methods'],
      [{ fetch: { domains: ['https://a.example/'] } }, 'invalid_domain: capabilities.fetch.domains'],
      [{ fetch: { domains: '*', maxRedirects: -1 } }, 'invalid_bound: capabilities.fetch.maxRedirects'],
    ];
    for (const [capabilities, message] of cases) {
      expect(() => resolveCeiling(capabilities as never, undefined, storage)).toThrow(message);
    }
  });

  it('a ceiling that records needs storage, and one that does not, does not', () => {
    expect(() => resolveCeiling({ crypto: {} }, undefined, { hasStorage: false })).toThrow(
      'audit_needs_storage: audit.store',
    );
    expect(resolveCeiling({ crypto: {} }, { store: 'none' }, { hasStorage: false }).audit.store).toBe('none');
  });
});

describe('checkRequest', () => {
  const ceiling = resolveCeiling({ 'fs.read': { roots: ['/srv/data'] }, crypto: {} }, undefined, storage);

  it('allows a request inside the ceiling', () => {
    expect(checkRequest(['fs.read', 'crypto'], ceiling)).toEqual({ ok: true });
  });

  it('refuses a request outside it, naming what the ceiling allows', () => {
    expect(checkRequest(['fetch', 'crypto'], ceiling)).toEqual({
      ok: false,
      refused: ['fetch'],
      allowed: ['fs.read', 'crypto'],
    });
  });
});

describe('narrowToForge', () => {
  const ceiling = resolveCeiling(
    { fetch: { domains: ['a.example', 'b.example'] }, 'fs.read': { roots: ['/srv/data'] } },
    undefined,
    storage,
  );

  it('a forge with every domain is wider than a list', () => {
    expect(() => narrowToForge(ceiling, { fetchDomainAllowlist: [], fsReadRoots: ['/srv/data'] })).toThrow(
      'forge_wider_than_ceiling: sandboxForge.fetchDomainAllowlist',
    );
  });

  it('a narrower forge narrows the ceiling', () => {
    const narrowed = narrowToForge(ceiling, { fetchDomainAllowlist: ['a.example'], fsReadRoots: ['/srv/data/sub'] });
    expect(narrowed.fetch?.domains).toEqual(['a.example']);
    expect(narrowed['fs.read']?.roots).toEqual(['/srv/data/sub']);
  });

  it('disjoint lists never widen', () => {
    expect(() => narrowToForge(ceiling, { fetchDomainAllowlist: ['c.example'], fsReadRoots: ['/srv/data'] })).toThrow(
      'forge_wider_than_ceiling',
    );
    expect(() => narrowToForge(ceiling, { fetchDomainAllowlist: ['a.example'], fsReadRoots: ['/etc'] })).toThrow(
      'forge_wider_than_ceiling: sandboxForge.fsReadRoots',
    );
  });

  it('a forge with no read roots removes fs.read: an empty intersection grants nothing', () => {
    const narrowed = narrowToForge(ceiling, { fetchDomainAllowlist: ['a.example'], fsReadRoots: [] });
    expect(narrowed['fs.read']).toBeUndefined();
    expect(checkRequest(['fs.read'], narrowed)).toEqual({ ok: false, refused: ['fs.read'], allowed: ['fetch'] });
  });

  it('the forge options of a capability the ceiling does not grant are not compared', () => {
    const cryptoOnly = resolveCeiling({ crypto: {} }, undefined, storage);
    expect(narrowToForge(cryptoOnly, { fetchDomainAllowlist: [], fsReadRoots: [process.cwd()] }).crypto).toBe(true);
  });
});
