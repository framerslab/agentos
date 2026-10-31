/**
 * @file agentos-learning.e2e.test.ts
 * The full runtime with the learning flag off and on. Off (unset or false): no layer, and the runtime's GMIs send
 * no personality section, as before. On: every GMI sends its persona's section after the base prompt, in the words
 * agent() sends; each session is bound to the user and the resolved organization of its first turn; and
 * getLearningLayer() returns the layer, built from `learning` or passed in `gmiManagerConfig`. AgentOS.create() over
 * inline personas; only the OpenAI provider class is stubbed, at its module boundary.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  seenMessages: [] as Array<Array<{ role: string; content: unknown }>>,
}));

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize() { this.isInitialized = true; }
    async generateCompletion() { return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' }; }
    async *generateCompletionStream(_modelId: string, messages: Array<{ role: string; content: unknown }>) {
      provider.seenMessages.push(messages);
      yield { responseTextDelta: 'Noted.' };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Noted.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { createAgentOSConfig } from '../../core/config/AgentOSConfig';
import { createLearningLayer } from '../../cognition/learning/LearningLayer';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { renderPersonalitySection } from '../../cognition/substrate/personas/personalityPrompt';

const HEADING = '## Personality & Communication Style';
const TRAITS = { honesty: 0.9, extraversion: 0.8 };
const tutor = {
  id: 'tutor', name: 'Tutor', description: 'A tutor.', version: '1.0.0',
  baseSystemPrompt: 'You teach networking.', personalityTraits: TRAITS,
} as unknown as IPersonaDefinition;
const calm = {
  id: 'calm', name: 'Calm', description: 'A persona with moderate traits.', version: '1.0.0',
  baseSystemPrompt: 'You answer plainly.', personalityTraits: { openness: 0.5 },
} as unknown as IPersonaDefinition;

async function boot(extra: Record<string, unknown> = {}): Promise<AgentOS> {
  return AgentOS.create({
    modelProviderManagerConfig: { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] },
    turnPlanning: { enabled: false },
    personas: [tutor, calm],
    ...extra,
  } as any);
}
const systemTextOf = (messages: Array<{ role: string; content: unknown }>): string =>
  messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n\n');
/** Runs one turn and returns the system text the provider received for it. */
async function send(os: AgentOS, input: Record<string, unknown>): Promise<string> {
  for await (const _chunk of os.processRequest({ textInput: 'Hello.', ...input } as any)) { /* drain */ }
  return systemTextOf(provider.seenMessages.at(-1) ?? []);
}

let booted: AgentOS | undefined;
afterEach(async () => {
  if (booted) await booted.shutdown();
  booted = undefined;
  provider.seenMessages.length = 0;
  vi.restoreAllMocks();
});

describe('the full runtime with the learning flag off', () => {
  it('sends no personality section, as before, and has no learning layer', async () => {
    booted = await boot();
    const unset = await send(booted, { userId: 'u', sessionId: 's-1', selectedPersonaId: 'tutor' });
    expect(unset).toContain('You teach networking.');
    expect(unset).not.toContain(HEADING);
    expect(booted.getLearningLayer()).toBeUndefined();
    await booted.shutdown();
    booted = await boot({ learning: false });
    expect(await send(booted, { userId: 'u', sessionId: 's-1', selectedPersonaId: 'tutor' })).toBe(unset);
    expect(booted.getLearningLayer()).toBeUndefined();
  });
});

describe('the full runtime with the learning flag on', () => {
  it("sends each persona's section after its base prompt, in agent()'s words", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: true });
    const system = await send(booted, { userId: 'u', sessionId: 's-1', selectedPersonaId: 'tutor' });
    expect(system).toContain(`You teach networking.\n\n${renderPersonalitySection(TRAITS)}`);
    expect(system.split(HEADING)).toHaveLength(2);
    expect(await send(booted, { userId: 'u', sessionId: 's-2', selectedPersonaId: 'calm' })).not.toContain(HEADING);
  });

  it("returns its layer, whose manifest counts a learner's turn and a placeholder user's turn, and renders the authored traits in mode off", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: { mode: 'off' } });
    await send(booted, { userId: 'ana', sessionId: 's-1', selectedPersonaId: 'tutor' });
    const placeholder = await send(booted, { userId: 'anonymous_user', sessionId: 's-2', selectedPersonaId: 'tutor' });
    expect(placeholder).toContain(renderPersonalitySection(TRAITS)!);
    const manifest = await booted.getLearningLayer()!.manifest();
    expect(manifest).toMatchObject({ surface: 'runtime', profile: 'custom', mode: 'off' });
    expect(manifest.turns).toEqual({ prepared: 2, bound: 1, none: { placeholder_user: 1 } });
  });

  it('closes a layer it built at shutdown, and leaves open a layer the host passed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: true });
    const built = booted.getLearningLayer()!;
    const closeBuilt = vi.spyOn(built, 'close');
    await booted.shutdown();
    expect(closeBuilt).toHaveBeenCalledTimes(1);

    const passed = createLearningLayer({ surface: 'runtime' });
    const closePassed = vi.spyOn(passed, 'close');
    const base = await createAgentOSConfig();
    booted = await boot({ gmiManagerConfig: { ...base.gmiManagerConfig, learningLayer: passed } });
    expect(booted.getLearningLayer()).toBe(passed);
    expect(await send(booted, { userId: 'u', sessionId: 's-1', selectedPersonaId: 'tutor' })).toContain(HEADING);
    await booted.shutdown();
    booted = undefined;
    expect(closePassed).not.toHaveBeenCalled();
  });

  it('refuses learning.namespace, learning beside a passed layer, and an unknown mode, before any service starts', async () => {
    await expect(boot({ learning: { namespace: 'acme' } })).rejects.toThrow(/learning\.namespace/);
    await expect(boot({ learning: true, gmiManagerConfig: { personaLoaderConfig: {}, learningLayer: createLearningLayer() } })).rejects.toThrow(/gmiManagerConfig\.learningLayer/);
    await expect(boot({ learning: { mode: 'sideways' } })).rejects.toThrow(/learning\.mode: unknown mode 'sideways'/);
  });

  it("has no learner on a turn of tenant B's user 42 on the session tenant A's user 42 opened, nor on the turns after it", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    booted = await boot({ learning: true });
    await send(booted, { userId: '42', organizationId: 'A', sessionId: 'shared', selectedPersonaId: 'tutor' });
    await send(booted, { userId: '42', organizationId: 'B', sessionId: 'shared', selectedPersonaId: 'tutor' });
    await send(booted, { userId: '42', organizationId: 'A', sessionId: 'shared', selectedPersonaId: 'tutor' });
    const manifest = await booted.getLearningLayer()!.manifest();
    expect(manifest.turns).toEqual({ prepared: 3, bound: 1, none: { other_namespace: 2 } });
  });

  it('reports the approval gate and the tool-policy switch off where the configuration leaves them nothing to do', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const base = await createAgentOSConfig();
    const loopsOf = async (extra: Record<string, unknown>) => {
      booted = await boot({ learning: true, ...extra });
      const { loops } = await booted.getLearningLayer()!.manifest();
      await booted.shutdown();
      booted = undefined;
      return loops;
    };
    // This file's boot plans no turn, so the switch has no turn plan to change.
    expect((await loopsOf({})).tool_policy).toEqual({ live: false, detail: 'no turn planner: the switch has no turn plan to change' });
    const planned = { turnPlanning: { enabled: true, discovery: { enabled: false } } };
    expect((await loopsOf(planned)).tool_policy).toEqual({ live: true });
    const noTelemetry = { ...planned, orchestratorConfig: { ...base.orchestratorConfig, taskOutcomeTelemetry: { enabled: false } } };
    expect((await loopsOf(noTelemetry)).tool_policy).toEqual({
      live: false,
      detail: 'orchestratorConfig.taskOutcomeTelemetry is off: the switch reads no success rate',
    });

    const hitl = (settings: Record<string, unknown>) => ({
      toolOrchestratorConfig: { ...base.toolOrchestratorConfig, hitl: { ...base.toolOrchestratorConfig?.hitl, enabled: true, ...settings } },
    });
    expect((await loopsOf(hitl({ requireApprovalForSideEffects: false }))).hitl).toEqual({
      live: false,
      detail: 'toolOrchestratorConfig.hitl.requireApprovalForSideEffects is off: the gate asks for no tool',
    });
    expect((await loopsOf(hitl({ autoApproveWhenNoManager: true }))).hitl).toEqual({
      live: false,
      detail: 'no hitlManager, and hitl.autoApproveWhenNoManager approves every call',
    });
    expect((await loopsOf(hitl({}))).hitl).toEqual({ live: true, detail: 'no hitlManager: side-effect tools are refused' });
  });
});
