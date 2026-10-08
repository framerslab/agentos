/**
 * @file SelfImprovementSessionManager.session-scope.test.ts
 * The self-improvement hooks act on the GMI that made the tool call. They
 * used to act on whichever GMI was registered first, changed the persona
 * definition every session of that persona shares, and wrote self-evaluation
 * traces (which quote the user) into another session's memory.
 *
 * Runs the real AdaptPersonalityTool over the hooks SelfImprovementSessionManager
 * builds, against two real GMIs that share one persona definition and are
 * registered the way GMIManager registers them.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  SelfImprovementSessionManager,
  resolveGMIForToolContext,
  type GMISessionRegistry,
} from '../SelfImprovementSessionManager';
import { AdaptPersonalityTool } from '../../../cognition/emergent/AdaptPersonalityTool';
import { CognitiveMemoryBridge } from '../../../cognition/substrate/CognitiveMemoryBridge';
import { GMI } from '../../../cognition/substrate/GMI';
import { GMIMood, type IGMI } from '../../../cognition/substrate/IGMI';
import { InMemoryWorkingMemory } from '../../../cognition/substrate/memory/InMemoryWorkingMemory';
import type { IPersonaDefinition } from '../../../cognition/substrate/personas/IPersonaDefinition';
import type { ICognitiveMemoryManager } from '../../../cognition/memory/CognitiveMemoryManager';
import type { IPromptEngine } from '../../../core/llm/IPromptEngine';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';
import type { IUtilityAI } from '../../../cognition/nlp/ai_utilities/IUtilityAI';
import type { IToolOrchestrator } from '../../../core/tools/IToolOrchestrator';
import type { ToolExecutionContext } from '../../../core/tools/ITool';
import type { ILogger } from '../../../core/logging/ILogger';

const logger: ILogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

/** A cognitive memory stub that records what the hooks write and ask for. */
function memoryStub() {
  return {
    encode: vi.fn(async () => ({})),
    assembleForPrompt: vi.fn(async () => ({
      contextText: '',
      tokensUsed: 0,
      allocation: {},
      includedMemoryIds: [],
    })),
  };
}

async function initializedGmi(
  id: string,
  persona: IPersonaDefinition,
  memory: ReturnType<typeof memoryStub>,
): Promise<GMI> {
  const gmi = new GMI(id);
  await gmi.initialize(persona, {
    workingMemory: new InMemoryWorkingMemory(),
    promptEngine: {} as unknown as IPromptEngine,
    llmProviderManager: {
      getProvider: vi.fn(),
      getProviderForModel: vi.fn(),
      getDefaultProvider: vi.fn(),
      getModelInfo: vi.fn(),
    } as unknown as AIModelProviderManager,
    utilityAI: {} as unknown as IUtilityAI,
    toolOrchestrator: {
      listAvailableTools: vi.fn(async () => []),
      processToolCall: vi.fn(),
    } as unknown as IToolOrchestrator,
    cognitiveMemory: memory as unknown as ICognitiveMemoryManager,
  });
  return gmi;
}

/**
 * Two sessions on one persona definition, registered in GMIManager's two
 * maps with session A first, plus the hooks and tool bound to them.
 */
async function twoSessions() {
  const shared = {
    id: 'scoped-persona',
    name: 'Scoped Persona',
    version: '1.0.0',
    baseSystemPrompt: 'You are a helpful assistant.',
    personalityTraits: { openness: 0.5, honestyHumility: 0.8 },
    metaPrompts: [],
  } as unknown as IPersonaDefinition;
  const memoryA = memoryStub();
  const memoryB = memoryStub();
  const gmiA = await initializedGmi('gmi-A', shared, memoryA);
  const gmiB = await initializedGmi('gmi-B', shared, memoryB);
  const registry: GMISessionRegistry = {
    activeGMIs: new Map<string, IGMI>([
      ['gmi-A', gmiA],
      ['gmi-B', gmiB],
    ]),
    gmiSessionMap: new Map([
      ['session-A', 'gmi-A'],
      ['session-B', 'gmi-B'],
    ]),
  };
  const deps = new SelfImprovementSessionManager(logger).buildToolDeps(undefined, {
    getGMIForContext: (context) => resolveGMIForToolContext(registry, context),
    getToolOrchestrator: () => ({}) as unknown as IToolOrchestrator,
  });
  const tool = new AdaptPersonalityTool({
    config: { maxDeltaPerSession: 0.5 },
    getPersonality: deps.getPersonality,
    setPersonality: deps.setPersonality,
  });
  return { shared, gmiA, gmiB, memoryA, memoryB, deps, tool };
}

/** The execution context ToolExecutor builds for a call from session B. */
function sessionBContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    gmiId: 'gmi-B',
    personaId: 'scoped-persona',
    userContext: { userId: 'user-b' },
    correlationId: 'turn-b-1',
    sessionData: { sessionId: 'session-B' },
    ...overrides,
  } as ToolExecutionContext;
}

describe('self-improvement hooks act on the calling session', () => {
  it('adapt_personality changes the calling GMI only, never the shared persona', async () => {
    const { shared, gmiA, gmiB, tool } = await twoSessions();

    const result = await tool.execute(
      { trait: 'openness', delta: 0.2, reasoning: 'The user asked for more creative framing.' },
      sessionBContext(),
    );

    expect(result.success).toBe(true);
    expect(gmiB.getPersona().personalityTraits?.openness).toBeCloseTo(0.7);
    expect(gmiA.getPersona().personalityTraits?.openness).toBe(0.5);
    expect(shared.personalityTraits?.openness).toBe(0.5);
  });

  it('resolves the caller by session id when the context names no known GMI', async () => {
    const { gmiA, gmiB, tool } = await twoSessions();

    const result = await tool.execute(
      { trait: 'openness', delta: -0.1, reasoning: 'Keep answers conventional.' },
      sessionBContext({ gmiId: 'generateText:tool-run' }),
    );

    expect(result.success).toBe(true);
    expect(gmiB.getPersona().personalityTraits?.openness).toBeCloseTo(0.4);
    expect(gmiA.getPersona().personalityTraits?.openness).toBe(0.5);
  });

  it('reads Honesty-Humility authored as honestyHumility as the honesty trait', async () => {
    const { tool } = await twoSessions();

    const result = await tool.execute(
      { trait: 'honesty', delta: 0.1, reasoning: 'State uncertainty plainly.' },
      sessionBContext(),
    );

    expect(result.success).toBe(true);
    expect(result.output?.previousValue).toBe(0.8);
    expect(result.output?.newValue).toBeCloseTo(0.9);
  });

  it('fails without changing anything when no session matches the caller', async () => {
    const { shared, gmiA, gmiB, tool } = await twoSessions();

    const result = await tool.execute(
      { trait: 'openness', delta: 0.2, reasoning: 'No caller to change.' },
      { gmiId: 'gmi-unknown' } as ToolExecutionContext,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('could not resolve the calling agent instance');
    expect(gmiA.getPersona().personalityTraits?.openness).toBe(0.5);
    expect(gmiB.getPersona().personalityTraits?.openness).toBe(0.5);
    expect(shared.personalityTraits?.openness).toBe(0.5);
  });

  it('reserves the session budget before waiting on decay, so overlapping calls share it', async () => {
    const { deps } = await twoSessions();
    let releaseDecay!: () => void;
    const decayHeld = new Promise<void>((resolve) => {
      releaseDecay = resolve;
    });
    const tool = new AdaptPersonalityTool({
      config: { maxDeltaPerSession: 0.3, persistWithDecay: true, decayRate: 0.05 },
      getPersonality: deps.getPersonality,
      setPersonality: deps.setPersonality,
      mutationStore: { decayForAgent: vi.fn(() => decayHeld), record: vi.fn(async () => undefined) } as never,
    });
    const args = { trait: 'openness', delta: 0.2, reasoning: 'More creative framing.' };

    const first = tool.execute(args, sessionBContext());
    const second = tool.execute(args, sessionBContext());
    releaseDecay();
    const [a, b] = await Promise.all([first, second]);

    expect(a.output?.delta).toBeCloseTo(0.2);
    expect(b.output?.delta).toBeCloseTo(0.1);
    expect(b.output?.sessionTotal).toBeCloseTo(0.3);
  });

  it('stores a self-evaluation trace in the calling session\'s memory and thread', async () => {
    const { deps, memoryA, memoryB } = await twoSessions();

    await deps.storeMemory?.(
      { type: 'self_evaluation', content: 'User B asked about their invoice.', scope: 'session', tags: ['eval'] },
      sessionBContext(),
    );

    expect(memoryA.encode).not.toHaveBeenCalled();
    expect(memoryB.encode).toHaveBeenCalledTimes(1);
    expect(memoryB.encode.mock.calls[0]).toEqual([
      '[self-improvement:self_evaluation] User B asked about their invoice.',
      { valence: 0, arousal: 0, dominance: 0.5 },
      'neutral',
      { type: 'semantic', scope: 'thread', scopeId: 'session-B', tags: ['eval'] },
    ]);
  });
});

describe('cognitive memory recall stays within the turn\'s scopes', () => {
  it('asks the shared memory backend only for this user, session and conversation', async () => {
    const memory = memoryStub();
    const bridge = new CognitiveMemoryBridge(
      memory as unknown as ICognitiveMemoryManager,
      () => GMIMood.NEUTRAL,
      () => ({ userId: 'user-b' }),
      () => 'scoped-persona',
      () => 'gmi-B',
      () => undefined,
    );

    await bridge.assembleContext('What did I ask about?', { sessionId: 'session-B', conversationId: 'conv-B' });

    expect(memory.assembleForPrompt).toHaveBeenCalledTimes(1);
    const options = (memory.assembleForPrompt.mock.calls[0] as unknown[])[3] as {
      scopes: Array<{ scope: string; scopeId: string }>;
    };
    expect(options.scopes).toEqual([
      { scope: 'user', scopeId: 'user-b' },
      { scope: 'user', scopeId: 'session-B' },
      { scope: 'user', scopeId: 'gmi-B' },
      { scope: 'thread', scopeId: 'conv-B' },
      { scope: 'thread', scopeId: 'session-B' },
      { scope: 'persona', scopeId: 'scoped-persona' },
      { scope: 'persona', scopeId: 'user-b::scoped-persona' },
    ]);
  });

  it('also recalls the memory owner\'s scope and the user context\'s organization', async () => {
    const memory = { ...memoryStub(), getConfig: () => ({ agentId: 'memory-owner' }) };
    const bridge = new CognitiveMemoryBridge(
      memory as unknown as ICognitiveMemoryManager,
      () => GMIMood.NEUTRAL,
      () => ({ userId: 'user-b', organizationId: 'org-9' }),
      () => 'scoped-persona',
      () => 'gmi-B',
      () => undefined,
    );

    await bridge.assembleContext('What did I ask about?', { sessionId: 'session-B' });

    const options = (memory.assembleForPrompt.mock.calls[0] as unknown[])[3] as {
      scopes: Array<{ scope: string; scopeId: string }>;
    };
    for (const scope of ['user', 'thread', 'persona', 'organization']) {
      expect(options.scopes).toContainEqual({ scope, scopeId: 'memory-owner' });
    }
    expect(options.scopes).toContainEqual({ scope: 'organization', scopeId: 'org-9' });
  });

  it('does not search every scope when the turn has no identity to scope by', async () => {
    const memory = memoryStub();
    const bridge = new CognitiveMemoryBridge(
      memory as unknown as ICognitiveMemoryManager,
      () => GMIMood.NEUTRAL,
      () => ({ userId: '' }),
      () => '',
      () => '',
      () => undefined,
    );

    expect(await bridge.assembleContext('Anything?')).toBeNull();
    expect(memory.assembleForPrompt).not.toHaveBeenCalled();
  });
});
