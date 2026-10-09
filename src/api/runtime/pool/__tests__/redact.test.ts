import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectCallSecrets, maskError, redactText, createErrorMask, redactStrings } from '../redact.js';
import { setDefaultProvider, clearDefaultProvider } from '../../global-default.js';
import { OpenAIProviderError } from '../../../../core/llm/providers/errors/OpenAIProviderError.js';
import type { AgencyOptions } from '../../../types.js';

afterEach(() => { vi.unstubAllEnvs(); clearDefaultProvider(); });
const K1 = 'sk-secret-one-0001', K2 = 'sk-secret-two-0002';

describe('collectCallSecrets', () => {
  it('unions seating keys, agency-level credentials, every default and every provider variable; splits comma pools; drops short values; longest first', () => {
    vi.stubEnv('OPENAI_API_KEY', `${K1},${K2}`); vi.stubEnv('GEMINI_API_KEY', 'gem-env-00000003'); vi.stubEnv('OPENAI_BASE_URL', 'https://u:pw-env-0004@proxy.local/v1');
    setDefaultProvider({ apiKey: 'sk-nameless-00000005', baseUrl: 'https://d:pw-default-06@d.local' });
    const agency = { agents: {}, apiKey: 'sk-agency-00000007', baseUrl: 'https://a:pw-agency-0008@a.local' } as AgencyOptions;
    const list = collectCallSecrets(agency, ['sk-seated-0009', 'short']);
    expect(list).toEqual(expect.arrayContaining([K1, K2, 'gem-env-00000003', 'u:pw-env-0004', 'sk-nameless-00000005', 'd:pw-default-06', 'sk-agency-00000007', 'a:pw-agency-0008', 'sk-seated-0009']));
    expect(list).not.toContain('short');
    expect(list).not.toContain('k1');
    for (let i = 1; i < list.length; i++) expect(list[i - 1].length).toBeGreaterThanOrEqual(list[i].length);
  });

  it('lists what the config writes whether or not the call seats it: the pool, the seats, their hops and the chair', () => {
    const agency = {
      modelPool: { opus: { provider: 'anthropic', model: 'claude-opus-5-5', apiKey: 'sk-pool-entry-0011', baseUrl: 'https://p:pw-pool-0012@pool.local' } },
      agents: {
        fixed: { provider: 'openai', model: 'gpt-4.1', apiKey: 'sk-fixed-seat-0013', fallbackProviders: [{ provider: 'mistral', apiKey: 'sk-hop-00000014', baseUrl: 'https://h:pw-hop-00015@hop.local' }] },
        prebuilt: { generate: async () => ({}), stream: () => ({}), session: () => ({}), usage: async () => ({}), close: async () => {} },
      },
      chair: { provider: 'gemini', apiKey: 'gem-chair-000016' },
    } as unknown as AgencyOptions;
    // Seating listed nothing: every entry was skipped, as when each provider's breaker is open.
    expect(collectCallSecrets(agency, [])).toEqual(expect.arrayContaining(['sk-pool-entry-0011', 'p:pw-pool-0012', 'sk-fixed-seat-0013', 'sk-hop-00000014', 'h:pw-hop-00015', 'gem-chair-000016']));
    expect(() => collectCallSecrets({ agents: {}, chair: false } as AgencyOptions, [])).not.toThrow();
  });

  it('keeps a comma-separated value whole beside its parts, so a short part and URL credentials with a comma are still masked', () => {
    const list = collectCallSecrets({ agents: {}, apiKey: 'abc, defghijkl', baseUrl: 'https://user:pa,ss-word@h.local' } as AgencyOptions, []);
    expect(list).toEqual(expect.arrayContaining(['abc, defghijkl', 'defghijkl', 'user:pa,ss-word']));
    expect(list).not.toContain('abc');
    expect(redactText('sent abc, defghijkl to https://user:pa,ss-word@h.local', list)).toBe('sent [redacted] to https://[redacted]@h.local');
  });
});

describe('redactText and maskError', () => {
  const secrets = [K1, K2, 'u:pw-0010'];
  it('masks keys, each comma part and URL credentials in text and stacks', () => {
    expect(redactText(`bad ${K1} and ${K2} at https://u:pw-0010@h/x`, secrets)).toBe('bad [redacted] and [redacted] at https://[redacted]@h/x');
  });
  it('writes own strings in place, keeps the class, and copies only the referenced objects that hold a secret', () => {
    class ProviderErr extends Error { code = 'X'; details: unknown; shared = { headers: { Authorization: `Bearer ${K1}` } }; clean = { ok: true }; constructor(m: string) { super(m); this.name = 'ProviderErr'; } }
    const e = new ProviderErr(`rejected ${K1}`);
    const sharedBefore = e.shared, cleanBefore = e.clean;
    e.details = { request: { headers: { Authorization: `Bearer ${K2}` } }, note: 'fine' };
    const out = maskError(e, secrets) as ProviderErr;
    expect(out).toBe(e);
    expect(out.message).toBe('rejected [redacted]');
    expect(out.stack).not.toContain(K1);
    expect(out.clean).toBe(cleanBefore);
    expect(out.shared).not.toBe(sharedBefore);
    expect(sharedBefore.headers.Authorization).toContain(K1);
    expect((out.details as { request: { headers: { Authorization: string } } }).request.headers.Authorization).toBe('Bearer [redacted]');
    expect(JSON.stringify(out)).not.toContain(K1);
  });
  it('masks a provider error in place, and writes a stack that is an accessor through its setter', () => {
    const abort = new DOMException('aborted', 'AbortError');
    const e = new OpenAIProviderError(`rejected ${K1}`, 'REQUEST_TIMEOUT', undefined, undefined, 401, abort);
    expect(maskError(e, secrets)).toBe(e);
    expect(e).toBeInstanceOf(OpenAIProviderError);
    expect(e.message).toBe('rejected [redacted]');
    expect(e.stack).not.toContain(K1);
    expect(e.code).toBe('REQUEST_TIMEOUT');
    expect(e.httpStatus).toBe(401);
    expect(e.details).toBe(abort);
    // The shape Error.captureStackTrace gives a stack on some engines: a getter and a setter, no value.
    const boxed = new Error(`denied ${K1}`);
    let kept = `Error: denied ${K1}\n    at somewhere`;
    Object.defineProperty(boxed, 'stack', { get: () => kept, set: (v: string) => { kept = v; }, configurable: true });
    expect(maskError(boxed, secrets)).toBe(boxed);
    expect(boxed.stack).toBe('Error: denied [redacted]\n    at somewhere');
    expect(boxed.message).toBe('denied [redacted]');
  });
  it('handles a cycle, a cause and nested errors', () => {
    const inner = new Error(`inner ${K2}`);
    const e = Object.assign(new Error(`outer ${K1}`), { cause: inner, self: undefined as unknown });
    (e as { self: unknown }).self = e;
    const out = maskError(e, secrets) as typeof e;
    expect(out.message).toBe('outer [redacted]');
    expect((out.cause as Error).message).toBe('inner [redacted]');
    expect(out.cause).not.toBe(inner);
    expect(inner.message).toContain(K2);
    expect(out.self).toBe(e);
    // An object that only refers back to the error holds no secret once the error is masked: it is not copied.
    const back = { error: undefined as unknown };
    const looped = Object.assign(new Error(`looped ${K1}`), { response: back });
    back.error = looped;
    expect(maskError(looped, secrets)).toBe(looped);
    expect(looped.response).toBe(back);
    expect(looped.message).toBe('looped [redacted]');
  });
  it('replaces a frozen error and an accessor-only message with a plain Error that keeps name, code and httpStatus', () => {
    const frozen = Object.freeze(Object.assign(new Error(`frozen ${K1}`), { code: 'FROZEN', httpStatus: 500 }));
    const f = maskError(frozen, secrets) as Error & { code?: string; httpStatus?: number };
    expect(f).not.toBe(frozen);
    expect(Object.getPrototypeOf(f)).toBe(Error.prototype);
    expect(f.message).toBe('frozen [redacted]'); expect(f.code).toBe('FROZEN'); expect(f.httpStatus).toBe(500); expect(f.name).toBe('Error');
    expect(String(f.stack)).not.toContain(K1);
    const accessor = new Error('x'); Object.defineProperty(accessor, 'message', { get: () => `leak ${K2}` });
    const a = maskError(accessor, secrets) as Error;
    expect(a).not.toBe(accessor); expect(a.message).toBe('leak [redacted]');
    // A setter that keeps the old value is found by the check after the write.
    const stubborn = new Error('x'); Object.defineProperty(stubborn, 'message', { get: () => `kept ${K1}`, set: () => {}, configurable: true });
    const s = maskError(stubborn, secrets) as Error;
    expect(s).not.toBe(stubborn); expect(s.message).toBe('kept [redacted]');
  });
  it('replaces an error whose message its prototype serves by a plain Error that keeps the name, at the top and where it is referenced', () => {
    const dom = new DOMException(`aborted holding ${K1}`, 'AbortError');
    const out = maskError(dom, secrets) as Error;
    expect(out).not.toBe(dom);
    expect(Object.getPrototypeOf(out)).toBe(Error.prototype);
    expect(out.name).toBe('AbortError');
    expect(out.message).toBe('aborted holding [redacted]');
    expect(String(out.stack)).not.toContain(K1);
    const e = Object.assign(new Error('timed out'), { details: new DOMException(`aborted holding ${K2}`, 'AbortError') });
    const masked = maskError(e, secrets) as typeof e;
    expect(masked).toBe(e);
    expect(Object.getPrototypeOf(masked.details)).toBe(Error.prototype);
    expect(masked.details.name).toBe('AbortError');
    expect(masked.details.message).toBe('aborted holding [redacted]');
  });
  it('keeps a referenced host object that holds no secret by reference, and never throws', () => {
    const abort = new DOMException('aborted', 'AbortError');
    const e = Object.assign(new Error(`t ${K1}`), { details: abort });
    const out = maskError(e, secrets) as Error & { details: DOMException };
    expect(out.details).toBe(abort);
    expect(out.details.name).toBe('AbortError');
    expect(() => maskError(Object.freeze({ toString() { throw new Error('nope'); } }), secrets)).not.toThrow();
    const trapped = new Proxy({}, { ownKeys() { throw new Error('no keys'); }, get() { throw new Error('no reads'); } });
    expect(() => maskError(trapped, secrets)).not.toThrow();
    expect(maskError(`plain ${K1}`, secrets)).toBe('plain [redacted]');
    expect(maskError(42, secrets)).toBe(42);
    expect(maskError(undefined, secrets)).toBeUndefined();
  });
  it('finds a secret under a symbol key, in a non-enumerable property, in a Map and far below the surface', () => {
    const mark = Symbol('raw');
    const e = Object.assign(new Error('failed'), { [mark]: `raw ${K1}`, headers: new Map([['authorization', `Bearer ${K2}`]]), request: {} as Record<string, unknown> });
    Object.defineProperty(e.request, 'header', { value: `Authorization: Bearer ${K1}`, enumerable: false });
    let deep: Record<string, unknown> = { key: `deep ${K2}` };
    for (let i = 0; i < 5000; i++) deep = { next: deep };
    const withDeep = Object.assign(e, { body: deep });
    expect(maskError(withDeep, secrets)).toBe(e);
    expect(e[mark]).toBe('raw [redacted]');
    // A Map is neither a plain object nor an array: a plain Error stands in for it.
    expect(e.headers).toBeInstanceOf(Error);
    expect(Object.getOwnPropertyNames(e.request)).toEqual([]);
    let node = withDeep.body;
    expect(node).not.toBe(deep);
    while (node.next) node = node.next as Record<string, unknown>;
    expect(node.key).toBe('deep [redacted]');
    let original = deep;
    while (original.next) original = original.next as Record<string, unknown>;
    expect(original.key).toBe(`deep ${K2}`);
  });
  it('copies a nested plain Error with its own properties, and a member array with its holes', () => {
    const sparse: unknown[] = [`first ${K1}`]; sparse[3] = 'last';
    const nested = Object.assign(new Error(`nested ${K1}`), { attempts: sparse, status: 502 });
    const e = Object.assign(new Error('outer'), { errors: [nested] });
    maskError(e, secrets);
    const copy = e.errors[0];
    expect(copy).not.toBe(nested);
    expect(Object.getPrototypeOf(copy)).toBe(Error.prototype);
    expect(copy.message).toBe('nested [redacted]');
    expect(copy.status).toBe(502);
    expect(copy.attempts).toHaveLength(4);
    expect(copy.attempts[0]).toBe('first [redacted]');
    expect(1 in copy.attempts).toBe(false);
    expect(copy.attempts[3]).toBe('last');
    expect(nested.attempts).toBe(sparse);
  });
  it('gives a plain Error for a graph too large to walk', () => {
    const e = Object.assign(new Error(`huge ${K1}`), { code: 'HUGE', rows: Array.from({ length: 100_001 }, () => ({})) });
    const out = maskError(e, secrets) as Error & { code?: string; rows?: unknown };
    expect(out).not.toBe(e);
    expect(out.message).toBe('huge [redacted]');
    expect(out.code).toBe('HUGE');
    expect(out.rows).toBeUndefined();
  });
  it('a mask reads the holder at call time', () => {
    const holder = { list: [] as string[] };
    const mask = createErrorMask(holder);
    expect((mask(new Error(`a ${K1}`)) as Error).message).toContain(K1);
    holder.list = [K1];
    expect((mask(new Error(`a ${K1}`)) as Error).message).toBe('a [redacted]');
  });
  it('redactStrings masks every string of a conversation delta and a tool-call list, at any depth, and copies', () => {
    const delta = [{ role: 'assistant', content: [{ type: 'text', text: `I saw ${K1}` }], tool_calls: [{ id: 'c1', function: { name: 'x', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ error: `tool saw ${K1}` }) }];
    const out = redactStrings(delta, [K1]);
    expect(JSON.stringify(out)).not.toContain(K1);
    expect(JSON.stringify(out)).toContain('[redacted]');
    expect(JSON.stringify(delta)).toContain(K1);
    expect(redactStrings([{ name: 'x', args: {}, error: `e ${K2}` }], [K2])[0].error).toBe('e [redacted]');
    expect(redactStrings(42, [K1])).toBe(42);
  });
  it('redactStrings keeps a __proto__ key a key, follows a cycle, has no depth limit and leaves a class instance as it is', () => {
    // What a model can put in tool arguments: JSON.parse makes `__proto__` an own key, and an assignment would make it the copy's prototype.
    const parsed = JSON.parse(`{"__proto__":{"admin":true},"text":"saw ${K1}"}`) as Record<string, unknown>;
    const out = redactStrings(parsed, [K1]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['__proto__', 'text']);
    expect((out as { admin?: unknown }).admin).toBeUndefined();
    expect(out.text).toBe('saw [redacted]');
    const loop: Record<string, unknown> = { text: `again ${K1}` }; loop.self = loop;
    const unlooped = redactStrings(loop, [K1]);
    expect(unlooped.self).toBe(unlooped);
    expect(unlooped.text).toBe('again [redacted]');
    let deep: unknown = `bottom ${K1}`;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    let node: unknown = redactStrings(deep, [K1]);
    while (Array.isArray(node)) node = node[0];
    expect(node).toBe('bottom [redacted]');
    const bytes = new Uint8Array([1, 2, 3]), when = new Date(0);
    const mixed = redactStrings({ bytes, when, list: ['a', undefined, 3] }, [K1]);
    expect(mixed.bytes).toBe(bytes);
    expect(mixed.when).toBe(when);
    expect(mixed.list).toEqual(['a', undefined, 3]);
  });
});
