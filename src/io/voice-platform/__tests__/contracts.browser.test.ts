import { describe, expect, it } from 'vitest';
import {
  buildVoicePlatformOpenApi, CreateWebCallSchema, VoiceCallSchema, VOICE_CONTRACT_SCHEMAS,
} from '../contracts/index.js';
import { contractExamples } from './contractFixtures.js';

describe('voice contracts in a browser', () => {
  it('imports and parses every public contract without Node or native runtime shims', () => {
    for (const [name, value] of Object.entries(contractExamples)) {
      expect(VOICE_CONTRACT_SCHEMAS[name as keyof typeof contractExamples].parse(value)).toEqual(value);
    }
    expect(CreateWebCallSchema.safeParse({ ...contractExamples.CreateWebCall, scopeId: 'forged' }).success).toBe(false);
    expect(VoiceCallSchema.parse(contractExamples.VoiceCall).initiatingPrincipal.kind).toBe('service_key');
  });
  it('builds the same OpenAPI contract using browser globals only', () => {
    const document = buildVoicePlatformOpenApi();
    expect(document.openapi).toBe('3.1.1');
    expect(document.components.schemas.CreateWebCall).toBeDefined();
    expect(document.paths['/web-calls'].post.operationId).toBe('createWebCall');
  });
});
