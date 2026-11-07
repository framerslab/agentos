/**
 * @file agent-draft-with-reasons.e2e.test.ts
 * An agent builder drafts an agent from a person's description in one generate() call. The agent's responseSchema
 * holds the draft (the name, what it does, how it talks, the six traits, the skills, tools and channels, the safety
 * tier) with a reason beside every choice, so the draft and its reasons come back in one answer. The schema rides the
 * system prompt; a reply that matches comes back parsed from that one provider call; a reply that leaves a choice
 * without its reason is asked for once more with the issue named, and with `maxValidationRetries: 0` it throws after
 * the one call. Runs over the real provider manager and generateText; only the OpenAI provider class is stubbed
 * (helpers/stubProviders.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, type AgentOptions } from '../agent';
import { ObjectGenerationError } from '../generateObject';
import { SCHEMA_INSTRUCTION_LEAD } from '../runtime/structuredReply';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

const Reason = z.string().min(1);
const Trait = z.number().min(0).max(1);
const Chip = z.object({ id: z.string().min(1), reason: Reason });

/** The draft a builder asks for: every choice a person decides, each with the reason it was drafted. */
const DraftWithReasons = z.object({
  name: z.object({ value: z.string().min(1), reason: Reason }),
  whatItDoes: z.object({ value: z.string().min(1), reason: Reason }),
  howItTalks: z.object({ value: z.string().min(1), reason: Reason }),
  character: z.object({
    traits: z.object({
      honesty: Trait,
      emotionality: Trait,
      extraversion: Trait,
      agreeableness: Trait,
      conscientiousness: Trait,
      openness: Trait,
    }),
    reason: Reason,
  }),
  skills: z.array(Chip),
  tools: z.array(Chip),
  channels: z.array(z.object({ id: z.enum(['telegram', 'slack', 'discord']), reason: Reason })),
  safety: z.object({ tier: z.enum(['dangerous', 'permissive', 'balanced', 'strict', 'paranoid']), reason: Reason }),
});

const DESCRIPTION = 'An agent for our Discord that argues the other side of any plan before we decide, and backs it with sources.';

const DRAFT: z.infer<typeof DraftWithReasons> = {
  name: { value: 'Athena', reason: 'Named for the argument it brings to a decision.' },
  whatItDoes: {
    value: 'Argues the other side of a plan before the team decides, with sources.',
    reason: 'The description asks for the other side of any plan.',
  },
  howItTalks: { value: 'Direct and polite; names its sources.', reason: 'A challenger the team keeps listening to.' },
  character: {
    traits: { honesty: 0.9, emotionality: 0.4, extraversion: 0.5, agreeableness: 0.2, conscientiousness: 0.8, openness: 0.7 },
    reason: 'Low agreeableness pushes back; high conscientiousness checks the sources.',
  },
  skills: [{ id: 'summarize', reason: 'Sums up the plan it argues against.' }],
  tools: [{ id: 'web-search', reason: 'Checks an answer against the web before it replies.' }],
  channels: [{ id: 'discord', reason: "The description names the team's Discord." }],
  safety: { tier: 'balanced', reason: 'It reads the web and answers in a team channel.' },
};

/** The draft with the reason of its one tool left out. */
const WITHOUT_A_TOOL_REASON = { ...DRAFT, tools: [{ id: 'web-search' }] };

let n = 0;
const key = () => `k-draft-with-reasons-${++n}`;

const builder = (apiKey: string, extra: Partial<AgentOptions> = {}) =>
  agent({
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    instructions: 'Draft an agent from the description. Give the reason for every choice.',
    responseSchema: DraftWithReasons,
    ...extra,
  } as unknown as AgentOptions);

type Seen = ReturnType<typeof script>['seen'][number];

/** The JSON Schema a request's system messages carry, read back from the schema instructions. */
function schemaSent(seen: Seen): Record<string, any> {
  const instruction = seen.messages
    .filter((m) => m.role === 'system' && typeof m.content === 'string')
    .map((m) => m.content as string)
    .find((text) => text.includes(SCHEMA_INSTRUCTION_LEAD));
  expect(instruction).toBeDefined();
  return JSON.parse(instruction!.slice(instruction!.indexOf(SCHEMA_INSTRUCTION_LEAD) + SCHEMA_INSTRUCTION_LEAD.length));
}

beforeEach(() => globalLLMProviderHealth.reset());

describe('agent().generate() with a responseSchema of the draft and a reason per choice', () => {
  it('returns the draft and its reasons parsed from one provider call', async () => {
    const apiKey = key();
    const openai = script('openai', apiKey, { whole: true, replies: [reply.text(JSON.stringify(DRAFT))] });

    const result = await builder(apiKey).generate(DESCRIPTION);

    expect(openai.seen).toHaveLength(1);
    expect(result.parsed).toEqual(DRAFT);
    const draft = DraftWithReasons.parse(result.parsed);
    expect([draft.name, draft.whatItDoes, draft.howItTalks, draft.character, draft.safety, ...draft.skills, ...draft.tools, ...draft.channels]
      .every((choice) => choice.reason.length > 0)).toBe(true);
    expect(openai.seen[0].messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('argues the other side'))).toBe(true);
  });

  it('sends the schema with every choice and its reason required', async () => {
    const apiKey = key();
    const openai = script('openai', apiKey, { whole: true, replies: [reply.text(JSON.stringify(DRAFT))] });

    await builder(apiKey).generate(DESCRIPTION);

    const schema = schemaSent(openai.seen[0]);
    expect(schema.required).toEqual(['name', 'whatItDoes', 'howItTalks', 'character', 'skills', 'tools', 'channels', 'safety']);
    for (const field of ['name', 'whatItDoes', 'howItTalks']) {
      expect(schema.properties[field].required).toEqual(['value', 'reason']);
    }
    expect(schema.properties.character.required).toEqual(['traits', 'reason']);
    expect(schema.properties.character.properties.traits.required).toEqual([
      'honesty',
      'emotionality',
      'extraversion',
      'agreeableness',
      'conscientiousness',
      'openness',
    ]);
    for (const list of ['skills', 'tools', 'channels']) {
      expect(schema.properties[list].type).toBe('array');
      expect(schema.properties[list].items.required).toEqual(['id', 'reason']);
    }
    expect(schema.properties.channels.items.properties.id.enum).toEqual(['telegram', 'slack', 'discord']);
    expect(schema.properties.safety.properties.tier.enum).toEqual(['dangerous', 'permissive', 'balanced', 'strict', 'paranoid']);
    expect(schema.properties.safety.required).toEqual(['tier', 'reason']);
  });

  it('asks once more, naming the issue, when a choice comes back without its reason', async () => {
    const apiKey = key();
    const openai = script('openai', apiKey, {
      whole: true,
      replies: [reply.text(JSON.stringify(WITHOUT_A_TOOL_REASON)), reply.text(JSON.stringify(DRAFT))],
    });

    const result = await builder(apiKey).generate(DESCRIPTION);

    expect(result.parsed).toEqual(DRAFT);
    expect(openai.seen).toHaveLength(2);
    const repair = openai.seen[1].messages[openai.seen[1].messages.length - 1];
    expect(repair.role).toBe('user');
    expect(String(repair.content)).toMatch(/^Your reply did not match the schema: /);
    expect(String(repair.content)).toContain('tools');
  });

  it('throws after the one call when the agent allows no second attempt', async () => {
    const apiKey = key();
    const openai = script('openai', apiKey, { whole: true, replies: [reply.text(JSON.stringify(WITHOUT_A_TOOL_REASON))] });

    await expect(
      builder(apiKey, { controls: { maxValidationRetries: 0 } } as Partial<AgentOptions>).generate(DESCRIPTION),
    ).rejects.toBeInstanceOf(ObjectGenerationError);
    expect(openai.seen).toHaveLength(1);
  });
});
