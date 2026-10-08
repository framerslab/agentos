import { describe, expect, it } from 'vitest';
import { personaFromAgentOptions } from '../gmiPersona.js';
import { resolveCognition } from '../gmiCognition.js';
import { buildSystemPrompt, type AgentOptions } from '../../agent.js';
import { resolveChainOfThought } from '../../generateText.js';
import { ALL_METAPROMPT_PRESETS } from '../../../cognition/substrate/personas/metaprompt_presets.js';

const tool = {
  id: 'lookup-tool',
  name: 'lookup',
  description: 'Look up.',
  inputSchema: { type: 'object' },
  requiredCapabilities: ['capability:web'],
  execute: async () => ({ success: true }),
};

describe('personaFromAgentOptions', () => {
  it('maps name, instructions, personality, model and completion options', () => {
    const opts: AgentOptions = {
      name: 'Ops Helper',
      instructions: 'Answer briefly.\nNever guess.',
      personality: { openness: 0.9 },
      provider: 'openai',
      model: 'gpt-4o',
      maxTokens: 300,
      effort: 'low',
      controls: { maxDurationMs: 9000 },
    };
    const p = personaFromAgentOptions(opts, resolveCognition({}), []);
    expect(p).toMatchObject({ id: 'ops-helper', name: 'Ops Helper', description: 'Answer briefly.', version: '1.0.0', defaultProviderId: 'openai', defaultModelId: 'gpt-4o' });
    expect(p.baseSystemPrompt).toBe(buildSystemPrompt(opts));
    expect(p.personalityTraits).toMatchObject({ openness: 0.9 });
    expect(p.defaultModelCompletionOptions).toEqual({ maxTokens: 300, effort: 'low', requestTimeout: 9000 });
    expect(p.metaPrompts).toEqual([]);
    expect(p.sentimentTracking).toEqual({ enabled: false });
  });

  it('puts the chain-of-thought text first when tools exist, as generateText does, and unions the tools\' capabilities', () => {
    const opts: AgentOptions = { name: 'A', instructions: 'Use tools.', provider: 'openai', model: 'gpt-4o' };
    const p = personaFromAgentOptions(opts, resolveCognition({}), [tool as never]);
    expect(p.baseSystemPrompt).toBe(`${resolveChainOfThought(true)}\n\n${buildSystemPrompt(opts)}`);
    expect(p.allowedCapabilities).toEqual(['capability:web']);
    const withoutCot = personaFromAgentOptions({ ...opts, chainOfThought: false }, resolveCognition({}), [tool as never]);
    expect(withoutCot.baseSystemPrompt).toBe(buildSystemPrompt(opts));
  });

  it('full profile turns on sentiment with every preset, and the persona carries the preset metaprompts the GMI runs', () => {
    const p = personaFromAgentOptions({ name: 'A', provider: 'openai', model: 'gpt-4o', cognition: 'full' }, resolveCognition({ cognition: 'full' }), []);
    expect(p.sentimentTracking).toEqual({ enabled: true, presets: ['all'] });
    expect(p.metaPrompts?.map((m) => m.id)).toEqual(ALL_METAPROMPT_PRESETS.map((m) => m.id));
    const picked = personaFromAgentOptions(
      { provider: 'openai', model: 'gpt-4o' },
      resolveCognition({ cognition: { sentiment: true, metaprompts: ['frustration_recovery'] } }),
      [],
    );
    expect(picked.metaPrompts?.map((m) => m.id)).toEqual(['gmi_frustration_recovery']);
  });

  it('an unnamed agent gets a unique id; systemBlocks become the base prompt text', () => {
    const a = personaFromAgentOptions({ provider: 'openai', model: 'gpt-4o', systemBlocks: [{ text: 'Block one.' }, { text: 'Block two.', cacheBreakpoint: true }] }, resolveCognition({}), []);
    const b = personaFromAgentOptions({ provider: 'openai', model: 'gpt-4o' }, resolveCognition({}), []);
    expect(a.id).toMatch(/^agent-/);
    expect(a.id).not.toBe(b.id);
    expect(a.baseSystemPrompt).toBe('Block one.\n\nBlock two.');
  });

  it('a name with no Latin letters gets a stable id made from the name', () => {
    const idOf = (name: string) => personaFromAgentOptions({ name, provider: 'openai', model: 'gpt-4o' }, resolveCognition({}), []).id;
    expect(idOf('Ária')).toBe('aria');
    expect(idOf('助手')).toMatch(/^agent-[0-9a-f]{12}$/);
    expect(idOf('助手')).toBe(idOf('助手'));
    expect(idOf('助手')).not.toBe(idOf('秘書'));
  });
});
