import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../IPersonaDefinition';
import { validatePersona } from '../PersonaValidation';

const good: IPersonaDefinition = { id: 'ok', name: 'Ok', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi' };

describe('reasoningTraceConfig validation', () => {
  it('accepts positive integers', async () => {
    const result = await validatePersona({ ...good, reasoningTraceConfig: { maxEntries: 50, maxMessageLength: 200 } }, {});
    expect(result.issues.some((i) => i.field?.startsWith('reasoningTraceConfig'))).toBe(false);
  });
  it('warns on a value that is not a positive integer', async () => {
    const result = await validatePersona({ ...good, reasoningTraceConfig: { maxEntries: 0 } }, {});
    expect(result.issues.some((i) => i.code === 'invalid_reasoning_trace_config' && i.field === 'reasoningTraceConfig.maxEntries' && i.severity === 'warning')).toBe(true);
  });
  it('warns above the ceiling', async () => {
    const result = await validatePersona({ ...good, reasoningTraceConfig: { maxEntries: 50_000 } }, {});
    expect(result.issues.some((i) => i.code === 'invalid_reasoning_trace_config' && i.message.includes('ceiling'))).toBe(true);
  });
  it('errors when the field is not an object', async () => {
    const result = await validatePersona({ ...good, reasoningTraceConfig: 5 as unknown as IPersonaDefinition['reasoningTraceConfig'] }, {});
    expect(result.issues.some((i) => i.code === 'invalid_field_type' && i.field === 'reasoningTraceConfig')).toBe(true);
  });
});
