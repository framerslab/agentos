import { describe, expect, it } from 'vitest';
import { agentStableIdOf, derivedSoulPersonaId, personaFromAgentOptions } from '../gmiPersona.js';
import { resolveCognition } from '../gmiCognition.js';
import { buildSystemPrompt, type AgentOptions } from '../../agent.js';
import { ALL_METAPROMPT_PRESETS } from '../../../cognition/substrate/personas/metaprompt_presets.js';
import { parseSoul } from '../../../cognition/substrate/personas/SoulLoader.js';

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
    // The persona has traits, so the GMI renders the personality section itself and the base prompt leaves it out.
    expect(p.baseSystemPrompt).toBe(buildSystemPrompt({ ...opts, personality: undefined }));
    expect(p.personalityTraits).toMatchObject({ openness: 0.9 });
    expect(p.defaultModelCompletionOptions).toEqual({ maxTokens: 300, effort: 'low', requestTimeout: 9000 });
    expect(p.metaPrompts).toEqual([]);
    expect(p.sentimentTracking).toEqual({ enabled: false });
  });

  it('leaves the chain-of-thought text out of the base prompt (gmi() adds it to each call that offers tools) and unions the tools\' capabilities', () => {
    const opts: AgentOptions = { name: 'A', instructions: 'Use tools.', provider: 'openai', model: 'gpt-4o' };
    const p = personaFromAgentOptions(opts, resolveCognition({}), [tool as never]);
    expect(p.baseSystemPrompt).toBe(buildSystemPrompt(opts));
    expect(p.allowedCapabilities).toEqual(['capability:web']);
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

describe('personaFromAgentOptions with a soul', () => {
  const base = { provider: 'openai', model: 'gpt-4o' } as const;
  const soul = parseSoul(
    '---\nname: Aria\nagentId: aria-1\nrole: Support for the clinic\nhexaco:\n  honestyHumility: 0.9\ndefaultMood: calm\nallowedMoods: [calm, warm]\n' +
      'hardLimits:\n  - Never name a diagnosis.\nreasoningTrace:\n  maxEntries: 7\nvoice:\n  provider: x\navatar:\n  type: y\nmetadata:\n  team: care\n---\nYou are Aria.',
  );

  it('takes the id, role, traits, mood, trace limits, hard limits and metadata from the soul, and never its voice or avatar', () => {
    const p = personaFromAgentOptions({ ...base, instructions: 'Answer briefly.' }, resolveCognition({}), [], soul) as unknown as Record<string, unknown>;
    expect(p).toMatchObject({
      id: 'aria-1',
      name: 'Aria',
      description: 'Support for the clinic',
      personalityTraits: { honesty: 0.9 },
      moodAdaptation: { enabled: true, defaultMood: 'calm', allowedMoods: ['calm', 'warm'] },
      reasoningTraceConfig: { maxEntries: 7 },
      hardLimits: ['Never name a diagnosis.'],
      metadata: { team: 'care' },
    });
    expect(p.voiceConfig).toBeUndefined();
    expect(p.avatarConfig).toBeUndefined();
    // The traits render in the GMI's own section, so the base prompt holds none, and it holds no limits block.
    expect(p.baseSystemPrompt).toBe(buildSystemPrompt({ ...base, instructions: 'Answer briefly.' }, soul, { personality: false }));
    expect(String(p.baseSystemPrompt)).not.toContain('## Hard limits');
  });

  it('lets the name and personality options win, and keeps the id from the soul', () => {
    const p = personaFromAgentOptions({ ...base, name: 'Support', personality: { openness: 0.2 } }, resolveCognition({}), [], soul);
    expect(p).toMatchObject({ id: 'aria-1', name: 'Support', personalityTraits: { openness: 0.2 } });
  });

  it('names a soul with a name and no agentId by the slug of that name', () => {
    expect(personaFromAgentOptions({ ...base, name: 'Support' }, resolveCognition({}), [], parseSoul('---\nname: Aria Stone\n---\nHi.')).id).toBe('aria-stone');
  });

  it('gives a soul with no agentId and no name, on an agent with no name, an id derived from its text', () => {
    const bare = parseSoul('---\nhardLimits:\n  - Never guess.\n---\nYou are terse.');
    const other = parseSoul('---\nhardLimits:\n  - Never guess.\n---\nYou are warm.');
    const id = personaFromAgentOptions(base, resolveCognition({}), [], bare).id;
    expect(id).toMatch(/^soul-[0-9a-f]{16}$/);
    expect(personaFromAgentOptions(base, resolveCognition({}), [], bare).id).toBe(id);
    expect(derivedSoulPersonaId(bare)).toBe(id);
    expect(personaFromAgentOptions(base, resolveCognition({}), [], other).id).not.toBe(id);
    expect(personaFromAgentOptions(base, resolveCognition({}), [], bare).hardLimits).toEqual(['Never guess.']);
    // The derived id is the persona's alone: the agent has no stable id.
    expect(agentStableIdOf(base, bare)).toBeUndefined();
    expect(agentStableIdOf({ name: 'Ops' }, null)).toBe('ops');
    expect(agentStableIdOf({ name: 'Ops' }, soul)).toBe('aria-1');
  });

  it('names a soul that gives no id by learning.agentKey when one is set, so editing its text keeps the id', () => {
    const bare = parseSoul('---\nrole: helper\n---\nBe kind.');
    const edited = parseSoul('---\nrole: helper\n---\nBe kind and brief.');
    const keyed = { ...base, learning: { agentKey: ' k ' } };
    expect(personaFromAgentOptions(keyed, resolveCognition({}), [], bare).id).toBe('k');
    expect(personaFromAgentOptions(keyed, resolveCognition({}), [], edited).id).toBe('k');
    // A blank key names nothing: the id is derived from the text, as with no key.
    expect(personaFromAgentOptions({ ...base, learning: { agentKey: '  ' } }, resolveCognition({}), [], bare).id).toBe(derivedSoulPersonaId(bare));
    expect(personaFromAgentOptions({ ...base, learning: true }, resolveCognition({}), [], bare).id).toBe(derivedSoulPersonaId(bare));
    // The soul's id, else the agent's name, still names the persona before the key does.
    expect(personaFromAgentOptions(keyed, resolveCognition({}), [], soul).id).toBe('aria-1');
    expect(personaFromAgentOptions({ ...keyed, name: 'Ops' }, resolveCognition({}), [], bare).id).toBe('ops');
  });

  it('names an unnamed agent with no soul by learning.agentKey when one is set', () => {
    const keyed = { ...base, learning: { agentKey: 'k' } };
    expect(personaFromAgentOptions(keyed, resolveCognition({}), []).id).toBe('k');
    expect(personaFromAgentOptions(keyed, resolveCognition({}), []).id).toBe('k');
    expect(personaFromAgentOptions({ ...keyed, name: 'Ops' }, resolveCognition({}), []).id).toBe('ops');
  });
});
