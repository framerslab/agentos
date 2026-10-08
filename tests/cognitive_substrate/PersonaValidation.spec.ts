import { describe, it, expect } from 'vitest';
import { IPersonaDefinition, MetaPromptDefinition } from '../../src/cognition/substrate/personas/IPersonaDefinition.js';
import { validatePersona, validatePersonas, personaIsValid, allPersonasValid, formatAggregateReport } from '../../src/cognition/substrate/personas/PersonaValidation.js';
import { ALL_METAPROMPT_PRESETS } from '../../src/cognition/substrate/personas/metaprompt_presets.js';

function makeBasePersona(overrides: Partial<IPersonaDefinition> = {}): IPersonaDefinition {
  return {
    id: 'persona-alpha',
    name: 'Alpha',
    description: 'Test persona alpha',
    version: '1.0.0',
    baseSystemPrompt: 'You are helpful.',
    toolIds: ['searchWeb'],
    allowedOutputModalities: ['text'],
    ...overrides
  } as IPersonaDefinition;
}

describe('PersonaValidation', () => {
  it('flags missing required fields', async () => {
    const p = makeBasePersona({ name: '', description: '', version: '', baseSystemPrompt: '' as any });
    const res = await validatePersona(p);
    const errorCodes = res.issues.filter(issue => issue.severity === 'error').map(issue => issue.code);
    expect(errorCodes).toContain('missing_required_field');
    expect(res.summary.errorCount).toBeGreaterThan(0);
  });

  it('validates semver and language code', async () => {
    const p = makeBasePersona({ version: 'abc', defaultLanguage: 'english' });
    const res = await validatePersona(p);
    expect(res.issues.some(issue => issue.code === 'invalid_semver')).toBe(true);
    expect(res.issues.some(issue => issue.code === 'invalid_bcp47_language')).toBe(true);
  });

  it('detects duplicate and unknown toolIds', async () => {
    const known = new Set(['searchWeb', 'calc']);
    const p = makeBasePersona({ toolIds: ['searchWeb', 'searchWeb', 'unknownTool'] });
    const res = await validatePersona(p, { knownToolIds: known });
    const codes = res.issues.map(issue => issue.code);
    expect(codes).toContain('duplicate_tool_id');
    expect(codes).toContain('unknown_tool_id');
  });

  it('warns when voice config present without audio_tts modality', async () => {
    const p = makeBasePersona({ voiceConfig: { voiceId: 'v1' } });
    const res = await validatePersona(p);
    expect(res.issues.some(issue => issue.code === 'voice_config_without_audio_output')).toBe(true);
  });

  it('suggests costSavingStrategy when missing', async () => {
    const p = makeBasePersona({ costSavingStrategy: undefined });
    const res = await validatePersona(p);
    expect(res.issues.some(issue => issue.code === 'missing_cost_strategy')).toBe(true);
  });

  it('checks model preference duplication and over specification', async () => {
    const p = makeBasePersona({
      modelTargetPreferences: [
        { allowedModelIds: ['m1', 'm1'], modelFamily: 'gpt-4', modelId: 'gpt-4-32k' }
      ]
    });
    const res = await validatePersona(p);
    expect(res.issues.some(issue => issue.code === 'duplicate_allowed_model_ids')).toBe(true);
    expect(res.issues.some(issue => issue.code === 'over_specified_model_preference')).toBe(true);
  });

  it('validates RAG data source duplicate ids and summarization method presence', async () => {
    const p = makeBasePersona({
      memoryConfig: {
        enabled: true,
        ragConfig: {
          enabled: true,
          dataSources: [ { id: 'ds1', dataSourceNameOrId: 'A', isEnabled: true }, { id: 'ds1', dataSourceNameOrId: 'B', isEnabled: true } ],
          ingestionProcessing: { summarization: { enabled: true } }
        }
      }
    });
    const res = await validatePersona(p);
    expect(res.issues.some(issue => issue.code === 'duplicate_rag_datasource_ids')).toBe(true);
    expect(res.issues.some(issue => issue.code === 'rag_summarization_method_missing')).toBe(true);
  });

  it('aggregates activation keyword conflicts across personas', async () => {
    const p1 = makeBasePersona({ id: 'p1', activationKeywords: ['alpha', 'shared'] });
    const p2 = makeBasePersona({ id: 'p2', activationKeywords: ['beta', 'shared'] });
    const report = await validatePersonas([p1, p2]);
    expect(report.activationKeywordConflicts.length).toBe(1);
    expect(report.activationKeywordConflicts[0].keyword).toBe('shared');
    // Ensure warnings added
    const p1Issues = report.results.find((result) => result.personaId === 'p1')?.issues.map((issue) => issue.code) ?? [];
    expect(p1Issues).toContain('activation_keyword_conflict');
  });

  it('personaIsValid and allPersonasValid helpers behave', async () => {
    const good = makeBasePersona({ costSavingStrategy: 'balance_quality_cost' });
    const bad = makeBasePersona({ version: 'bad' });
    const goodRes = await validatePersona(good);
    const badRes = await validatePersona(bad);
    expect(personaIsValid(goodRes)).toBe(true);
    expect(personaIsValid(badRes)).toBe(false);
    const report = await validatePersonas([good, bad]);
    expect(allPersonasValid(report)).toBe(false);
  });

  it('formatAggregateReport produces readable output', async () => {
    const p = makeBasePersona({ version: 'bad' });
    const report = await validatePersonas([p]);
    const text = formatAggregateReport(report);
    expect(text).toMatch(/Persona Validation:/);
    expect(text).toMatch(/invalid_semver/);
  });

  it('adds token-based prompt length warning when estimator provided', async () => {
    const longPrompt = Array.from({ length: 3000 }, () => 'x').join('');
    const p = makeBasePersona({ baseSystemPrompt: longPrompt, version: '1.0.0' });
    const res = await validatePersona(p, {
      maxSystemPromptTokens: 100,
      tokenEstimator: (text: string) => Math.ceil(text.length / 10) // simplistic 10 chars per token
    });
    expect(res.issues.some(issue => issue.code === 'system_prompt_too_many_tokens')).toBe(true);
  });

  it.each([
    ['unsupported_metaprompt_trigger', { type: 'pre_response' }],
    ['invalid_metaprompt_interval', { type: 'turn_interval', intervalTurns: 0 }],
    ['unknown_metaprompt_event', { type: 'event_based', eventName: 'voice_command_received' }],
  ])('warns with %s about a metaprompt trigger that never fires', async (code, trigger) => {
    const p = makeBasePersona({
      metaPrompts: [{ id: 'mp', promptTemplate: 'x', trigger: trigger as unknown as MetaPromptDefinition['trigger'] }],
    });
    const res = await validatePersona(p);
    expect(res.issues.filter(issue => issue.field === 'metaPrompts[0].trigger')).toEqual([
      expect.objectContaining({ severity: 'warning', code }),
    ]);
  });

  it('accepts the supported metaprompt triggers, including every preset', async () => {
    const p = makeBasePersona({
      metaPrompts: [
        ...ALL_METAPROMPT_PRESETS,
        { id: 'periodic', promptTemplate: 'x', trigger: { type: 'turn_interval', intervalTurns: 5 } },
        { id: 'on_demand', promptTemplate: 'x', trigger: { type: 'manual' } },
      ],
    });
    const res = await validatePersona(p);
    expect(res.issues.filter(issue => issue.field?.startsWith('metaPrompts'))).toEqual([]);
  });
});
