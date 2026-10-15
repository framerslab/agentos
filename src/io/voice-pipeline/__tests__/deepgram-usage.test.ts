import { describe, expect, it, vi } from 'vitest';
import {
  DeepgramUsageReadError,
  readDeepgramUsage,
  type DeepgramUsageContract,
  type DeepgramUsageReadOptions,
  type DeepgramUsageFetch,
} from '../providers/DeepgramUsage.js';

// Synthetic records in the shape of Deepgram's published request-list examples; none is an account response.
const project = '00000000-0000-4000-8000-000000000001';
const fromMs = Date.UTC(2026, 9, 14, 0);
const throughMs = fromMs + 3_600_000;
const nowMs = throughMs + 120_000;
const dayMs = 86_400_000;
const contract: DeepgramUsageContract = {
  version: 'synthetic-cost-contract',
  verifiedAtMs: fromMs - 1,
  validUntilMs: nowMs + dayMs,
  maxReportingLagMs: 120_000,
};

function options(change: Partial<DeepgramUsageReadOptions> = {}): DeepgramUsageReadOptions {
  return { projectId: project, apiKey: 'fixture', fromMs, throughMs, nowMs, contract, pageSize: 2, ...change };
}
function request(id: string, usd: number, createdMs = fromMs + 1000) {
  return {
    request_id: id,
    project_uuid: project,
    created: new Date(createdMs).toISOString(),
    path: '/v1/listen',
    response: {
      code: 200,
      completed: new Date(createdMs + 1000).toISOString(),
      details: { usd, total_audio: 60, method: 'streaming', channels: 1 },
    },
  };
}
function scripted(bodies: unknown[]) {
  let position = 0;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher: DeepgramUsageFetch = async (url, init) => {
    calls.push({ url, init });
    if (position >= bodies.length) throw new Error('unexpected fetch');
    return new Response(JSON.stringify(bodies[position++]), { status: 200 });
  };
  return { calls, fetcher };
}
function page(pageNumber: number, requests: unknown[]) { return { page: pageNumber, limit: 2, requests }; }

describe('readDeepgramUsage', () => {
  it('reads every page twice and sums actual request costs without model filters', async () => {
    const a = request('request-a', 0.0048);
    const b = request('request-b', 0.0077);
    const c = { ...request('request-c', 0.0000001), path: '/v1/speak' };
    const wire = scripted([page(0, [a, b]), page(1, [c]), page(0, [a, b]), page(1, [c])]);
    const evidence = await readDeepgramUsage(options(), wire.fetcher);
    expect(evidence.costMicro).toBe(12_501);
    expect(evidence.requests.map((row) => [row.requestId, row.costMicro])).toEqual([
      ['request-a', 4800], ['request-b', 7700], ['request-c', 1],
    ]);
    expect(evidence).toMatchObject({
      projectId: project, fromMs, throughMs, checkedAtMs: nowMs, contractVersion: contract.version,
    });
    expect(wire.calls).toHaveLength(4);
    for (const call of wire.calls) {
      const url = new URL(call.url);
      expect(url.origin).toBe('https://api.deepgram.com');
      expect(url.pathname).toBe(`/v1/projects/${project}/requests`);
      expect([...url.searchParams.keys()].sort()).toEqual(['end', 'limit', 'page', 'start']);
      // The documented YYYY-MM-DDTHH:MM:SS+HH:MM form, with the offset's plus sign encoded.
      expect(url.searchParams.get('start')).toBe('2026-10-14T00:00:00+00:00');
      expect(url.searchParams.get('end')).toBe('2026-10-14T01:00:00+00:00');
      expect(url.search).toContain('start=2026-10-14T00%3A00%3A00%2B00%3A00');
      expect(call.init.redirect).toBe('error');
      expect(new Headers(call.init.headers).get('Authorization')).toBe('Token fixture');
    }
    expect(JSON.stringify(evidence)).not.toContain('fixture');
    expect(JSON.stringify(evidence)).not.toContain('path');
    expect(Object.isFrozen(evidence.requests)).toBe(true);
  });

  it('reads the published record shapes, microsecond times and every endpoint', async () => {
    // The List Project Requests example and the per-request pricing example of the Logs & Usage guide, read
    // 15 October 2026, moved into the interval; their identifiers are the documents' placeholders.
    const listed = {
      request_id: 'a3f1c9d2-4b7e-4f9a-8c3d-2e5f7b9a1c0d',
      project_uuid: project,
      created: '2026-10-14T00:48:20.000Z',
      path: '/v1/listen?',
      api_key_id: 'b1e2c3d4-5678-90ab-cdef-1234567890ab',
      response: {
        code: 200,
        completed: '2026-10-14T00:48:21.000Z',
        deployment: 'hosted:us',
        details: {
          channels: 1, config: {}, duration: 30, features: [], metadata: {}, method: 'sync',
          models: ['1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d'], streams: 1, tags: [], tier: 'base',
          total_audio: 30, usd: 0.0075,
        },
        token_details: [],
      },
      callback: null,
    };
    const priced = {
      request_id: 'fe02656d-e751-4000-8000-000000000002',
      project_uuid: project,
      created: '2026-10-14T00:55:40.714012Z',
      path: '/v1/speak?model=aura-2-thalia-en&encoding=linear16&sample_rate=24000&container=none',
      api_key_id: '64381456-6a91-4000-8000-000000000003',
      response: {
        details: {
          usd: 0.0102, models: '0bb159e1-5c0a-48fb-aa29-ed7c0401f116', method: 'sync', tags: '', features: '', config: '',
        },
        token_details: [],
        tts_details: { audio_metadata: '', speech_segments: '' },
        code: 200,
        completed: '2026-10-14T00:55:40.776543Z',
        deployment: 'hosted',
      },
      callback: null,
    };
    const body = { page: 0, limit: 10, requests: [priced, listed] };
    const wire = scripted([body, body]);
    const evidence = await readDeepgramUsage(options({ pageSize: 10 }), wire.fetcher);
    expect(evidence.costMicro).toBe(17_700);
    expect(evidence.requests).toEqual([
      {
        requestId: listed.request_id,
        createdAtMs: Date.UTC(2026, 9, 14, 0, 48, 20),
        completedAtMs: Date.UTC(2026, 9, 14, 0, 48, 21),
        costMicro: 7_500,
      },
      {
        requestId: priced.request_id,
        createdAtMs: Date.UTC(2026, 9, 14, 0, 55, 40, 714),
        completedAtMs: Date.UTC(2026, 9, 14, 0, 55, 40, 776),
        costMicro: 10_200,
      },
    ]);
    const stored = JSON.stringify(evidence);
    for (const hidden of ['/v1/', listed.api_key_id, priced.api_key_id, 'aura-2', 'hosted']) {
      expect(stored).not.toContain(hidden);
    }
  });

  it('accepts two explicit empty traversals, never an absent requests field', async () => {
    const wire = scripted([page(0, []), page(0, [])]);
    expect((await readDeepgramUsage(options(), wire.fetcher)).costMicro).toBe(0);
    const missing = scripted([{ page: 0, limit: 2 }]);
    await expect(readDeepgramUsage(options(), missing.fetcher)).rejects.toMatchObject({ code: 'shape' });
  });

  it('requires an extra empty page when the final data page is full', async () => {
    const full = page(0, [request('a', 0), request('b', 0.003)]);
    const wire = scripted([full, page(1, []), full, page(1, [])]);
    expect((await readDeepgramUsage(options(), wire.fetcher)).costMicro).toBe(3000);
    expect(wire.calls.map((call) => new URL(call.url).searchParams.get('page'))).toEqual(['0', '1', '0', '1']);
  });

  it.each([
    ['missing cost', { usd: undefined }],
    ['null cost', { usd: null }],
    ['negative cost', { usd: -1 }],
    ['string cost', { usd: '0.003' }],
    ['unsafe cost', { usd: Number.MAX_SAFE_INTEGER }],
  ])('rejects %s instead of treating it as free', async (_name, details) => {
    const bad = request('a', 0);
    const body = { ...bad, response: { ...bad.response, details } };
    await expect(readDeepgramUsage(options(), scripted([page(0, [body])]).fetcher)).rejects.toBeInstanceOf(DeepgramUsageReadError);
  });

  it('includes failed-request dollars when the evidence supplies a total', async () => {
    const failed = request('failed', 0.0004);
    failed.response.code = 500;
    const wire = scripted([page(0, [failed]), page(0, [failed])]);
    expect((await readDeepgramUsage(options(), wire.fetcher)).costMicro).toBe(400);
  });

  it.each([
    ['another project', { project_uuid: '00000000-0000-4000-8000-000000000002' }],
    ['before baseline', { created: new Date(fromMs - 1).toISOString() }],
    ['after interval', { created: new Date(throughMs + 1).toISOString() }],
    ['without timezone', { created: '2026-10-14T00:00:01' }],
    ['missing response', { response: undefined }],
    ['response not yet recorded', { response: null }],
    ['still incomplete', { response: { details: { usd: 0.003 } } }],
  ])('refuses %s', async (_name, change) => {
    const wire = scripted([page(0, [{ ...request('a', 0.003), ...change }])]);
    await expect(readDeepgramUsage(options(), wire.fetcher)).rejects.toBeInstanceOf(DeepgramUsageReadError);
  });

  it('refuses duplicate ids, page mismatch, excess rows and page exhaustion', async () => {
    const a = request('a', 0.003);
    for (const bodies of [
      [page(0, [a, a])],
      [page(1, [])],
      [page(0, [a, request('b', 0), request('c', 0)])],
    ]) await expect(readDeepgramUsage(options(), scripted(bodies).fetcher)).rejects.toBeInstanceOf(DeepgramUsageReadError);
    const full = scripted([page(0, [a, request('b', 0)])]);
    await expect(readDeepgramUsage(options({ maxPages: 1 }), full.fetcher)).rejects.toMatchObject({ code: 'page_limit' });
  });

  it('refuses a cost change between complete traversals', async () => {
    const wire = scripted([page(0, [request('a', 0.003)]), page(0, [request('a', 0.0048)])]);
    await expect(readDeepgramUsage(options(), wire.fetcher)).rejects.toMatchObject({ code: 'unstable' });
  });

  it('refuses balances, quantity aggregates and unknown response envelopes', async () => {
    for (const body of [{ balances: null }, { total_hours: 1 }, { results: [] }, null]) {
      await expect(readDeepgramUsage(options(), scripted([body]).fetcher)).rejects.toMatchObject({ code: 'shape' });
    }
  });

  it('requires a current verified contract, whole-second bounds inside the log retention and a reporting-safe end', async () => {
    const wire = scripted([]);
    for (const change of [
      { contract: { ...contract, version: '' } },
      { contract: { ...contract, validUntilMs: nowMs } },
      { contract: { ...contract, verifiedAtMs: nowMs + 1 } },
      { throughMs: throughMs + 1 },
      { fromMs: fromMs + 1 },
      { throughMs: throughMs - 1 },
      { fromMs: nowMs - 90 * dayMs },
    ]) await expect(readDeepgramUsage(options(change), wire.fetcher)).rejects.toMatchObject({ code: 'contract' });
    expect(wire.calls).toHaveLength(0);
    const recent = scripted([page(0, []), page(0, [])]);
    await expect(readDeepgramUsage(options({ fromMs: nowMs - 90 * dayMs + 1000 }), recent.fetcher))
      .resolves.toMatchObject({ costMicro: 0 });
  });

  it('redacts HTTP, timeout and response-size failures', async () => {
    const denied: DeepgramUsageFetch = async () => new Response('private provider detail', { status: 403 });
    await expect(readDeepgramUsage(options(), denied)).rejects.toMatchObject({ code: 'http', message: 'Deepgram usage read failed: http' });
    const large: DeepgramUsageFetch = async () => new Response('x'.repeat(2_000_001), { status: 200 });
    await expect(readDeepgramUsage(options(), large)).rejects.toMatchObject({ code: 'body_limit' });
    vi.useFakeTimers();
    try {
      const never: DeepgramUsageFetch = async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => reject(new Error('private detail')), { once: true });
      });
      const pending = readDeepgramUsage(options({ timeoutMs: 20 }), never);
      const failure = expect(pending).rejects.toMatchObject({ code: 'transport' });
      await vi.advanceTimersByTimeAsync(20);
      await failure;
    } finally { vi.useRealTimers(); }
  });
});
