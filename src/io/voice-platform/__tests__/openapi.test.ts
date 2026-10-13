import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import {
  buildVoicePlatformOpenApi, serializeVoicePlatformOpenApi, VOICE_HTTP_EXAMPLES,
  VOICE_HTTP_SCHEMAS, VOICE_CONTRACT_SCHEMAS, CallEndedPayloadSchema,
  ConnectWebCallSchema, CreateWebCallSchema, MediaAuthenticationSchema, ReasoningConfigSchema,
} from '../contracts/index.js';
import { contractExamples, createAgent, ended, reasoning, voiceCall } from './contractFixtures.js';

const artifact = fileURLToPath(new URL('../../../../docs/api/voice-platform.openapi.json', import.meta.url));
type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function visit(value: unknown, fn: (object: Record<string, unknown>) => void): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) { value.forEach((item) => visit(item, fn)); return; }
  fn(value as Record<string, unknown>);
  Object.values(value).forEach((item) => visit(item, fn));
}

function resolvePointer(root: unknown, pointer: string): unknown {
  return pointer.slice(2).split('/').reduce<unknown>((current, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
  }, root);
}

const proof = {
  publicKey: { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) },
  signature: 'c'.repeat(86), issuedAt: 1000, nonce: 'proof-a',
};

/** One valid example per HTTP object; proof bytes are shape fixtures, never authentic signatures. */
const httpExamples = {
  VoiceApiError: { kind: 'not_found', message: 'Resource not found.', requestId: 'request-a', retryable: false, retryAfterMs: null },
  ListQuery: { limit: 50, cursor: 'cursor_a' },
  AgentList: { items: [contractExamples.VoiceAgent], nextCursor: null },
  CallList: { items: [voiceCall], nextCursor: null },
  UsageList: { items: [contractExamples.UsageRecord], nextCursor: null },
  BrowserProof: proof,
  CallControlCredential: contractExamples.WebCallConnection.controlCredential,

  CallGrant: { kind: 'call_grant', grantId: 'grant-a', callId: 'call-a', agentId: 'agent-a', agentRevision: 1, transport: 'websocket', token: 'not-a-real-grant', expiresAt: 121000 },
  RenewCallGrant: { clientOrigin: 'https://client.example.test', proofKeyThumbprint: 'a'.repeat(43), idempotencyKey: 'renew-a' },
  ConnectWebCall: { exchangeKey: 'exchange-a', requestHash: 'a'.repeat(64), proof },
  StopCall: { idempotencyKey: 'stop-a', proof },
  StopReceipt: { callId: 'call-a', stopId: 'stop-a', state: 'ending' },
  RenewCallControl: { idempotencyKey: 'renew-control-a', proof },
  PurgeCall: { idempotencyKey: 'purge-a' },
  PurgeReceipt: { callId: 'call-a', operationId: 'purge-a', state: 'pending' },
  ArchiveAgent: { expectedRevision: 1 },
  TranscriptResult: { callId: 'call-a', transcript: ended.transcript },
  MediaAuthentication: { type: 'authenticate', callId: 'call-a', token: 'not-a-real-media-token', transportEpoch: 1 },
};

describe('the generated voice HTTP contract', () => {
  it('matches the committed document byte for byte, printing the CI-generated replacement on mismatch', () => {
    const expected = serializeVoicePlatformOpenApi();
    const actual = existsSync(artifact) ? readFileSync(artifact, 'utf8') : '';
    if (actual !== expected) {
      // These lines contain public schema data and fake examples only. Each line has its own extraction marker.
      for (const line of expected.trimEnd().split('\n')) process.stdout.write(`VOICE_OPENAPI_JSON ${line}\n`);
    }
    expect(actual, 'voice OpenAPI artifact is missing or differs; copy VOICE_OPENAPI_JSON lines from this CI commit').toBe(expected);
  });

  it('emits every named component directly from the runtime schema registry', () => {
    const document = buildVoicePlatformOpenApi();
    const registry = z.registry<{ id: string }>();
    for (const [name, schema] of Object.entries({ ...VOICE_CONTRACT_SCHEMAS, ...VOICE_HTTP_SCHEMAS })) registry.add(schema, { id: name });
    const generated = z.toJSONSchema(registry, { target: 'draft-2020-12', io: 'input', cycles: 'throw', reused: 'inline', uri: (name) => `#/components/schemas/${name}` });
    for (const schema of Object.values(generated.schemas)) delete schema.$id;

    expect(document.components.schemas).toEqual(generated.schemas);
    expect(document.openapi).toBe('3.1.1');
    expect(document.jsonSchemaDialect).toBe('https://json-schema.org/draft/2020-12/schema');
    visit(document.components.schemas, (object) => {
      expect(object.$id).toBeUndefined();

      if (object.type === 'object') expect(object.additionalProperties).toBe(false);
    });
    expect(JSON.stringify(document.components.schemas)).toContain('x-maxUtf8Bytes');
    expect(JSON.stringify(document.components.schemas)).toContain('x-canonicalOrigin');
    expect(JSON.stringify(document.components.schemas)).toContain('x-mediaUrl');
  });

  it('resolves every component reference and declares every path parameter', () => {
    const document = buildVoicePlatformOpenApi();
    visit(document, (object) => {
      if (typeof object.$ref === 'string') {
        expect(object.$ref.startsWith('#/')).toBe(true);
        expect(resolvePointer(document, object.$ref), object.$ref).toBeDefined();
      }
    });
    for (const [path, item] of Object.entries(document.paths)) {
      if (!path.includes('{id}')) continue;
      const parameters = (item as { parameters: Array<{ name: string; in: string; required: boolean }> }).parameters;
      expect(parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'id', in: 'path', required: true })]));
    }
  });

  it('describes account, grant, control and media authentication without sharing their authority', () => {
    const doc = buildVoicePlatformOpenApi();
    expect(doc.security).toEqual([{ serverKey: [] }]);
    expect(doc.paths['/web-calls/{id}/connect'].post.security).toEqual([{ callGrant: [] }]);
    expect(doc.paths['/calls/{id}/stop'].post.security).toEqual([{ serverKey: [] }, { callControl: [] }]);
    expect(doc.paths['/calls/{id}/control-token'].post.security).toEqual([{ callControl: [] }]);
    const media = doc.paths['/web-calls/{id}/media'].get;
    expect(media.security).toEqual([]);
    expect(media['x-first-frame-auth']).toMatchObject({ deadlineMs: 5000, maxBytes: 16384, workBeforeAuthentication: false });
    expect(JSON.stringify(media.parameters)).not.toContain('token');
    for (const path of Object.values(doc.paths)) {
      for (const method of ['get', 'post', 'patch', 'delete']) {
        const operation = (path as Record<string, unknown>)[method] as { responses: Record<string, unknown> } | undefined;
        if (!operation) continue;
        for (const code of ['400', '401', '403', '404', '409', '410', '413', '422', '429', '500', '503']) expect(operation.responses[code]).toBeDefined();
      }
    }
    expect(doc.webhooks.callEvent.post.requestBody.content['application/json'].schema).toEqual({ $ref: '#/components/schemas/CallEvent' });
  });

  for (const [name, example] of Object.entries(httpExamples)) {
    it(`${name} round trips and refuses unknown fields at every populated object`, () => {
      const schema = VOICE_HTTP_SCHEMAS[name as keyof typeof httpExamples];
      expect(schema.parse(JSON.parse(JSON.stringify(example)))).toEqual(example);
      const paths: Array<Array<string | number>> = [];
      const gather = (value: unknown, path: Array<string | number>): void => {
        if (Array.isArray(value)) { value.forEach((child, index) => gather(child, [...path, index])); return; }
        if (!value || typeof value !== 'object') return;
        paths.push(path);
        for (const [key, child] of Object.entries(value)) gather(child, [...path, key]);
      };
      gather(example, []);
      for (const path of paths) {
        const copy = structuredClone(example);
        let cursor = copy as unknown as Record<string | number, unknown>;
        for (const key of path) cursor = cursor[key] as Record<string | number, unknown>;
        cursor.unrecognizedField = true;
        expect(schema.safeParse(copy).success, `${name}.${path.join('.')}`).toBe(false);
      }
    });
  }

  it('checks alternate closed branches and nonempty nested objects', () => {
    const segment = { turnId: 'turn-a', role: 'user', text: 'Fixture text.', startedAt: 1000, endedAt: 2000, interrupted: false };
    const cost = { currency: 'USD', rateVersion: 'rates-a', customerMicro: 10, supplierMicro: 5, components: [{ component: 'media_second', customerMicro: 10, supplierMicro: 5 }] };
    const delivery = { ...ended, transcript: { availability: 'delivery', segments: [segment] }, cost };
    expect(CallEndedPayloadSchema.parse(delivery)).toEqual(delivery);
    expect(CallEndedPayloadSchema.safeParse({ ...delivery, cost: { ...cost, hidden: true } }).success).toBe(false);
    expect(CallEndedPayloadSchema.safeParse({ ...delivery, transcript: { availability: 'delivery', segments: [{ ...segment, hidden: true }] } }).success).toBe(false);
    expect(CallEndedPayloadSchema.safeParse({ ...ended, transcript: { availability: 'retained', transcriptRef: 'transcript-a', expiresAt: 10000, hidden: true } }).success).toBe(false);
    const { fallbacks: _fallbacks, ...fallback } = reasoning;
    expect(ReasoningConfigSchema.safeParse({ ...reasoning, fallbacks: [fallback] }).success).toBe(true);
    expect(ReasoningConfigSchema.safeParse({ ...reasoning, fallbacks: [{ ...fallback, hidden: true }] }).success).toBe(false);
    for (const transcriptPolicy of [{ mode: 'delivery', deliveryTtlSeconds: 60 }, { mode: 'retained', retentionSeconds: 60 }]) {
      expect(VOICE_CONTRACT_SCHEMAS.CreateAgent.safeParse({ ...createAgent, transcriptPolicy }).success).toBe(true);
      expect(VOICE_CONTRACT_SCHEMAS.CreateAgent.safeParse({ ...createAgent, transcriptPolicy: { ...transcriptPolicy, hidden: true } }).success).toBe(false);
    }
    expect(VOICE_CONTRACT_SCHEMAS.UsageRecord.safeParse({ ...contractExamples.UsageRecord, productKind: 'meeting_bot' }).success).toBe(true);
    expect(VOICE_CONTRACT_SCHEMAS.UsageRecord.safeParse({ ...contractExamples.UsageRecord, productKind: 'meeting_run' }).success).toBe(false);

    const interval = { intervalId: 'interval-a', workerGeneration: 1, transportEpoch: 1, startedAt: 1000, endedAt: 2000 };
    expect(VOICE_CONTRACT_SCHEMAS.VoiceCall.safeParse({ ...voiceCall, connectionTimeline: [interval] }).success).toBe(true);
    expect(VOICE_CONTRACT_SCHEMAS.VoiceCall.safeParse({ ...voiceCall, connectionTimeline: [{ ...interval, hidden: true }] }).success).toBe(false);
  });

  it('refuses private JWK material, malformed proof sizes, bearer query fields and oversized cursors', () => {
    const input = httpExamples.ConnectWebCall;
    expect(ConnectWebCallSchema.safeParse({ ...input, proof: { ...proof, publicKey: { ...proof.publicKey, d: 'not-a-real-key' } } }).success).toBe(false);
    expect(ConnectWebCallSchema.safeParse({ ...input, proof: { ...proof, signature: 'short' } }).success).toBe(false);
    expect(MediaAuthenticationSchema.safeParse({ ...httpExamples.MediaAuthentication, scopeId: 'foreign' }).success).toBe(false);
    expect(VOICE_HTTP_SCHEMAS.ListQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(VOICE_HTTP_SCHEMAS.ListQuery.safeParse({ limit: 1, cursor: 'a'.repeat(1025) }).success).toBe(false);
    expect(VOICE_HTTP_SCHEMAS.ListQuery.safeParse({ limit: 1, token: 'not-a-real-secret' }).success).toBe(false);
  });

  it('executes both documented TypeScript HTTP examples against a recording fetch', async () => {
    for (const example of VOICE_HTTP_EXAMPLES) {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const fetchFixture: typeof fetch = async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return new Response(JSON.stringify({ accepted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const compiled = ts.transpileModule(example.source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None }, reportDiagnostics: true });
      expect((compiled.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
      // Only the repository's constant documentation example runs here, never external or user code.
      const run = new Function('fetch', 'baseUrl', 'bearer', `${compiled.outputText}\nreturn result;`) as (f: typeof fetch, base: string, bearer: string) => Promise<Json>;
      await expect(run(fetchFixture, 'https://api.example.test/api/v1', 'not-a-real-bearer')).resolves.toEqual({ accepted: true });
      expect(requests).toHaveLength(1);
      expect(requests[0]!.init.headers).toMatchObject({ authorization: 'Bearer not-a-real-bearer' });
      expect(requests[0]!.url).toBe(`https://api.example.test/api/v1${example.path}`);
      const body = JSON.parse(requests[0]!.init.body as string);
      if (example.operationId === 'createWebCall') expect(CreateWebCallSchema.parse(body)).toEqual(body);
      else expect(VOICE_HTTP_SCHEMAS.StopCall.parse(body)).toEqual(body);
    }
  });
});
