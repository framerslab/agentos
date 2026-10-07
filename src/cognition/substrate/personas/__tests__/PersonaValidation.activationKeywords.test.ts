import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../IPersonaDefinition';
import { validatePersona, validatePersonas } from '../PersonaValidation';

const good: IPersonaDefinition = { id: 'ok', name: 'Ok', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi', activationKeywords: ['hello'] };
const bad = { ...good, id: 'bad', activationKeywords: {} } as unknown as IPersonaDefinition;

describe('activationKeywords validation', () => {
  it('reports invalid_field_type for a non-array activationKeywords', async () => {
    const result = await validatePersona(bad, {});
    expect(result.issues.some((i) => i.code === 'invalid_field_type' && i.field === 'activationKeywords' && i.severity === 'error')).toBe(true);
  });
  it('validatePersonas does not throw on it and still validates the rest of the batch', async () => {
    const report = await validatePersonas([good, bad], {});
    expect(report.results.length).toBe(2);
    expect(report.totals.errors).toBeGreaterThanOrEqual(1);
  });
});
