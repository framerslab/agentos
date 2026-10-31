/**
 * @file gmi-runtime.learning.test.ts
 * agent({ runtime: 'gmi' }) and gmi() with the learning flag off and on, end to end over the real provider manager,
 * completion gateway, GMI, prompt engine and tool orchestrator; only the provider class is stubbed, at its module
 * boundary (helpers/stubProviders.ts). With the flag off the prompt is the one agent() builds, section included;
 * with it on the section is its own system prompt after the base prompt, in the same words, and each session is
 * bound to a learner or says why it has none.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import { agent, buildSystemPrompt, type AgentOptions } from '../agent';
import { gmi } from '../gmi';
import { buildSessionSeat } from '../runtime/agencyLaunch/sessionSeat';
import { renderPersonalitySection } from '../../cognition/substrate/personas/personalityPrompt';
import { reply, script } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';

let n = 0;
const key = () => `k-learning-${++n}`;
const TRAITS = { honesty: 0.9, extraversion: 0.8, agreeableness: 0.5 };
const HEADING = '## Personality & Communication Style';
const options = (apiKey: string, extra: Record<string, unknown> = {}) =>
  ({
    runtime: 'gmi',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    name: 'Tutor',
    instructions: 'You teach networking.',
    personality: TRAITS,
    ...extra,
  }) as unknown as AgentOptions;
/** The system text of one model call. */
const systemOf = (call: { messages: Array<{ role: string; content: unknown }> }): string =>
  call.messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
/** The layer logs its manifest once, at its first session. */
const quietManifest = () => vi.spyOn(console, 'log').mockImplementation(() => undefined);

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('with the learning flag off', () => {
  it('sends the prompt agent() builds, its personality section once, and has no learning member', async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Hi.'), reply.text('Hi again.')] });
    const unset = options(k);
    const off = options(k, { learning: false });
    const tutor = agent(unset);
    await tutor.session('s1', { userId: 'ana' }).send('Hello.');
    await agent(off).session('s1', { userId: 'ana' }).send('Hello.');
    expect(systemOf(s.seen[0])).toBe(buildSystemPrompt(unset));
    expect(systemOf(s.seen[0]).split(HEADING)).toHaveLength(2);
    expect(systemOf(s.seen[1])).toBe(systemOf(s.seen[0]));
    expect(tutor.learning).toBeUndefined();
  });
});

describe('with the learning flag on', () => {
  it("sends the section once, as its own system prompt after the base prompt, in agent()'s words", async () => {
    quietManifest();
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Hi.')] });
    const opts = options(k, { learning: true });
    await agent(opts).session('s1', { userId: 'ana' }).send('Hello.');
    const section = renderPersonalitySection(TRAITS)!;
    expect(section).toBe(buildSystemPrompt({ personality: TRAITS }));
    expect(systemOf(s.seen[0])).toBe(`${buildSystemPrompt({ ...opts, personality: undefined })}\n\n${section}`);
    expect(systemOf(s.seen[0]).split(HEADING)).toHaveLength(2);
  });

  it('sends no section for a persona whose traits are all moderate, and the authored one in mode off', async () => {
    quietManifest();
    const k = key();
    const s = script('openai', k, { replies: [reply.text('A.'), reply.text('B.')] });
    await gmi(options(k, { learning: true, personality: { openness: 0.5 } })).session('s1', { userId: 'ana' }).send('Hello.');
    expect(systemOf(s.seen[0])).not.toContain(HEADING);
    await gmi(options(k, { learning: { mode: 'off' } })).session('s2', { userId: 'ana' }).send('Hello.');
    expect(systemOf(s.seen[1]).endsWith(`\n\n${renderPersonalitySection(TRAITS)}`)).toBe(true);
  });

  it('binds a session opened with a user id, and has no learner for a session without one, a placeholder id or generate()', async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.text('1.'), reply.text('2.'), reply.text('3.'), reply.text('4.')] });
    const tutor = gmi(options(k, { learning: { traits: true } }));
    await tutor.session('s1', { userId: 'ana' }).send('Hello.');
    await tutor.session('s2').send('Hello.');
    await tutor.session('s3', { userId: 'anonymous' }).send('Hello.');
    await tutor.generate('Hello.');
    const manifest = await tutor.learning!.manifest();
    expect(manifest).toMatchObject({ surface: 'gmi', profile: 'light', mode: 'on' });
    expect(manifest.turns).toEqual({ prepared: 4, bound: 1, none: { no_user_id: 2, placeholder_user: 1 } });
    expect(manifest.loops.trait_changes).toEqual({ live: false, detail: 'asked for; this release changes no trait' });
    expect(manifest.loops.self_improvement_tools).toEqual({ live: false, detail: 'gmi() registers no self-improvement tool' });
  });

  it("has no learner for a seat's session, though its user binds outside the seat, and counts its turns as a seat's", async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.text('Seat.'), reply.text('Own.')] });
    const tutor = gmi(options(k, { learning: true }));
    // A seat that runs as the user, as a launch's seat runs as the parent turn's.
    await buildSessionSeat(tutor, { form: 'persistent', role: 'helper', userId: 'ana' }).generate('Hello.');
    // The same user binds in a session of the member's own.
    await tutor.session('s1', { userId: 'ana' }).send('Hello.');
    expect((await tutor.learning!.manifest()).turns).toEqual({ prepared: 2, bound: 1, none: { workflow_seat: 1 } });
  });

  it('has no learner for an agent with neither a name nor learning.agentKey, and binds one that has the key', async () => {
    quietManifest();
    const k = key();
    script('openai', k, { replies: [reply.text('1.'), reply.text('2.')] });
    const unnamed = gmi(options(k, { name: undefined, learning: true }));
    await unnamed.session('s1', { userId: 'ana' }).send('Hello.');
    expect((await unnamed.learning!.manifest()).turns.none).toEqual({ no_agent_key: 1 });
    const keyed = gmi(options(k, { name: undefined, learning: { agentKey: 'support-bot' } }));
    await keyed.session('s1', { userId: 'ana' }).send('Hello.');
    expect((await keyed.learning!.manifest()).turns.bound).toBe(1);
  });

  it('names the field of a learning option that is not valid, at construction', () => {
    expect(() => gmi(options(key(), { learning: { mode: 'sideways' } }))).toThrow(/learning\.mode: unknown mode 'sideways'/);
  });

  it("is ignored by the legacy runtime, whose prompt keeps agent()'s section", async () => {
    const k = key();
    const s = script('openai', k, { replies: [reply.text('Hi.')], whole: true });
    const legacy = agent(options(k, { runtime: undefined, learning: true }));
    await legacy.generate('Hello.');
    expect(systemOf(s.seen[0])).toContain(renderPersonalitySection(TRAITS)!);
    expect(systemOf(s.seen[0]).split(HEADING)).toHaveLength(2);
    expect(legacy.learning).toBeUndefined();
  });

  it('reports metaprompts off for an empty preset list, which runs none', async () => {
    quietManifest();
    const tutor = gmi(options(key(), { cognition: { sentiment: true, metaprompts: [] }, learning: true }));
    expect((await tutor.learning!.manifest()).loops.metaprompts).toEqual({ live: false, detail: 'no metaprompt preset' });
    const all = gmi(options(key(), { cognition: { sentiment: true, metaprompts: 'all' }, learning: true }));
    expect((await all.learning!.manifest()).loops.metaprompts).toEqual({ live: true });
  });
});
