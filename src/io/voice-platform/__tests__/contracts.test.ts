import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import {
  CallEventSchema, CreateAgentSchema, CreateWebCallSchema, ReasoningConfigSchema,
  UpdateAgentSchema, VoiceCallSchema, VOICE_CONTRACT_SCHEMAS,
  type CreateWebCall, type VoiceCall,
} from '../contracts/index.js';
import { contractExamples, createAgent, ended, reasoning, voiceCall } from './contractFixtures.js';

function objects(value: unknown, path: Array<string | number> = []): Array<Array<string | number>> {
  if (Array.isArray(value)) return value.flatMap((item, index) => objects(item, [...path, index]));
  if (value === null || typeof value !== 'object') return [];
  return [path, ...Object.entries(value).flatMap(([key, item]) => objects(item, [...path, key]))];
}

function withExtra(value: unknown, path: Array<string | number>): unknown {
  const copy = structuredClone(value);
  let target = copy as Record<string | number, unknown>;
  for (const key of path) target = target[key] as Record<string | number, unknown>;
  target.unrecognizedField = true;
  return copy;
}

describe('closed voice contracts', () => {
  for (const [name, example] of Object.entries(contractExamples)) {
    const schema = VOICE_CONTRACT_SCHEMAS[name as keyof typeof contractExamples];
    it(`${name} round trips through JSON without coercion or dropped fields`, () => {
      const parsed = schema.parse(example);
      expect(parsed).toEqual(example);
      expect(schema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    });
    it(`${name} rejects an unknown key at every populated object boundary`, () => {
      for (const path of objects(example)) {
        expect(schema.safeParse(withExtra(example, path)).success, `${name}.${path.join('.')}`).toBe(false);
      }
    });
  }

  it('infers public types from the canonical schemas', () => {
    expectTypeOf<CreateWebCall>().toEqualTypeOf<z.infer<typeof CreateWebCallSchema>>();
    expectTypeOf<VoiceCall>().toEqualTypeOf<z.infer<typeof VoiceCallSchema>>();
  });

  it('never accepts caller-selected scope, principal, rates or reservations on creation', () => {
    for (const key of ['scopeId', 'initiatingPrincipal', 'rateVersion', 'reservationId']) {
      expect(CreateWebCallSchema.safeParse({ ...contractExamples.CreateWebCall, [key]: 'forged' }).success).toBe(false);
      expect(CreateAgentSchema.safeParse({ ...createAgent, [key]: 'forged' }).success).toBe(false);
    }
    for (const key of ['agentId', 'scopeId', 'revision', 'createdAt']) {
      expect(UpdateAgentSchema.safeParse({ expectedRevision: 1, changes: { [key]: 'forged' } }).success).toBe(false);
    }
    expect(UpdateAgentSchema.safeParse({ changes: { name: 'x' } }).success).toBe(false);
    expect(UpdateAgentSchema.safeParse({ expectedRevision: 0, changes: {} }).success).toBe(false);
  });

  it('bounds UTF-8 prompt bytes and rejects nonfinite, fractional and negative counts', () => {
    expect(CreateAgentSchema.safeParse({ ...createAgent, prompt: 'a'.repeat(16384) }).success).toBe(true);
    expect(CreateAgentSchema.safeParse({ ...createAgent, prompt: 'é'.repeat(8192) }).success).toBe(true);
    expect(CreateAgentSchema.safeParse({ ...createAgent, prompt: 'é'.repeat(8193) }).success).toBe(false);
    for (const maxDurationSeconds of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '60']) {
      expect(CreateWebCallSchema.safeParse({ ...contractExamples.CreateWebCall, maxDurationSeconds }).success).toBe(false);
    }
    for (const clientOrigin of ['null', 'https://x.test/path', 'https://x.test/?token=x', 'https://u:p@x.test', 'file:///tmp']) {
      expect(CreateWebCallSchema.safeParse({ ...contractExamples.CreateWebCall, clientOrigin }).success).toBe(false);
    }
  });

  it('keeps principal kinds and issuer tombstones explicit', () => {
    for (const kind of ['member', 'service_key', 'demo']) {
      const parsed = VoiceCallSchema.parse({ ...voiceCall, initiatingPrincipal: { kind, principalId: 'principal-a', issuerRef: 'deleted-issuer-a' } });
      expect(parsed.initiatingPrincipal.kind).toBe(kind);
      expect(parsed.initiatingPrincipal.issuerRef).toBe('deleted-issuer-a');
    }
    expect(VoiceCallSchema.safeParse({ ...voiceCall, initiatingPrincipal: undefined }).success).toBe(false);
    expect(VoiceCallSchema.safeParse({ ...voiceCall, initiatingPrincipal: { kind: 'member', principalId: '' } }).success).toBe(false);
  });

  it('accepts local reasoning with a manifest reference and rejects inline secrets and URLs in either branch', () => {
    const { endpointRef: _endpoint, endpointRevision: _revision, credentialRef: _credential, ...common } = reasoning;
    const local = { ...common, provider: 'local', manifestDigest: 'sha256:local-a' };
    expect(ReasoningConfigSchema.safeParse(local).success).toBe(true);
    for (const config of [reasoning, local]) {
      for (const key of ['apiKey', 'baseUrl', 'url', 'scopeId']) {
        expect(ReasoningConfigSchema.safeParse({ ...config, [key]: 'not-a-real-secret' }).success).toBe(false);
      }
      expect(ReasoningConfigSchema.safeParse({ ...config, fallbacks: [{ ...local, apiKey: 'not-a-real-secret' }] }).success).toBe(false);
    }
    expect(CreateAgentSchema.safeParse({ ...createAgent, providerPolicy: { ...createAgent.providerPolicy, mode: 'legacy' } }).success).toBe(false);
  });

  it('binds event payloads to their discriminator and preserves quantity-only usage', () => {
    const started = contractExamples.CallEvent;
    for (const type of ['call.ended', 'call.failed']) {
      expect(CallEventSchema.safeParse({ ...started, type, payload: ended }).success).toBe(true);
      expect(CallEventSchema.safeParse({ ...started, type }).success).toBe(false);
    }
    expect(CallEventSchema.safeParse({ ...started, type: 'transcript.final' }).success).toBe(false);
    const usage = contractExamples.UsageRecord;
    for (const key of ['cost', 'currency', 'customerMicro', 'supplierMicro']) {
      expect(VOICE_CONTRACT_SCHEMAS.UsageRecord.safeParse({ ...usage, [key]: 1 }).success).toBe(false);
    }
  });
});
