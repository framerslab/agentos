import { describe, expect, it } from 'vitest';
import type { IPersonaDefinition } from '../IPersonaDefinition';
import { normalizePersonaDefinition } from '../personaNormalization';

const base: IPersonaDefinition = {
  id: 'p1', name: 'P1', description: 'd', version: '1.0.0', baseSystemPrompt: 'hi',
};
const withSentiment = (enabled: boolean, presets: string[]): IPersonaDefinition =>
  ({ ...base, sentimentTracking: { enabled, presets } }) as unknown as IPersonaDefinition;

describe('normalizePersonaDefinition', () => {
  it('returns the same object when sentiment tracking is off or has no presets', () => {
    expect(normalizePersonaDefinition(base)).toBe(base);
    const off = withSentiment(false, ['all']);
    expect(normalizePersonaDefinition(off)).toBe(off);
    const none = withSentiment(true, []);
    expect(normalizePersonaDefinition(none)).toBe(none);
  });

  it('merges the named presets into metaPrompts without mutating the input', () => {
    const input = withSentiment(true, ['frustration_recovery']);
    const out = normalizePersonaDefinition(input);
    expect(out).not.toBe(input);
    expect(input.metaPrompts).toBeUndefined();
    expect(out.metaPrompts?.map((m) => m.id)).toEqual(['gmi_frustration_recovery']);
  });

  it('merges every preset for "all" and keeps the persona\'s own metaprompts', () => {
    const own = { id: 'mine', promptTemplate: 'x', triggerType: 'manual' } as unknown as NonNullable<IPersonaDefinition['metaPrompts']>[number];
    const input = { ...withSentiment(true, ['all']), metaPrompts: [own] };
    const ids = normalizePersonaDefinition(input).metaPrompts?.map((m) => m.id) ?? [];
    expect(ids).toContain('mine');
    expect(ids).toContain('gmi_frustration_recovery');
    expect(ids).toContain('gmi_engagement_boost');
  });
});
