import { describe, expect, it, vi } from 'vitest';
import * as memory from '../../index.js';

// Keep the test-only commit compilable against the public entry point.
const resolve = Reflect.get(memory, 'resolveExtractionPolicy');

const invoker = { invoke: vi.fn(async () => '{"facts":[]}') };
const stageInvoker = vi.fn(async () => '{"facts":[]}');

describe('conversational extraction policy', () => {
  it('resolves enclosing vetoes and preserves legacy omission', () => {
    expect(resolve).toBeTypeOf('function');
    const mode = (...args: unknown[]) => resolve(...args).path;
    const omitted = {};
    const runtimeTrue = { extraction: true };
    const personaFalse = { extraction: false };

    expect([mode(omitted), mode(runtimeTrue), mode({ extraction: {} })]).toEqual([
      'legacy',
      'auto',
      'auto',
    ]);
    expect(mode(runtimeTrue, personaFalse)).toBe('off');
    expect(mode({ extraction: false }, runtimeTrue)).toBe('off');
    expect(mode(runtimeTrue, {}, { extraction: false })).toBe('off');
    expect(mode(runtimeTrue, {}, {}, { mode: 'raw' })).toBe('off');
    expect(mode(runtimeTrue, {}, {}, { forgotten: true })).toBe('off');
    expect(mode({}, {}, {}, { mode: 'off' })).toBe('off');
  });

  it('cuts the reflection handoff, queue and typed-bank writes at their stage switches', () => {
    const observerOff = resolve({
      extraction: { observer: false },
      observer: { llmInvoker: stageInvoker },
    });
    expect(observerOff.observer).toBe(false);
    expect(observerOff.reflectionHandoff).toBe(false);
    expect(observerOff.extractAtEncode).toBe(true);

    const reflectorOff = resolve({
      extraction: { reflector: false },
      reflector: { llmInvoker: stageInvoker },
    });
    expect(reflectorOff.reflector).toBe(false);
    expect(reflectorOff.reflectionHandoff).toBe(false);
    expect(reflectorOff.observer).not.toBe(false);

    const typedOff = resolve({
      extraction: { typedNetwork: false },
      typedNetwork: { variant: 'full', extractAtEncode: true, observerLLM: invoker },
    });
    expect(typedOff.typedNetwork).toBe(false);
    expect(typedOff.extractAtEncode).toBe(false);
    expect(typedOff.bankWrites).toBe(false);
    expect(typedOff.observer).not.toBe(false);
    expect(typedOff.invoker).toBeUndefined();
  });

  it('overlays stage tuning and keeps an explicit encode trigger veto local to encode', () => {
    const policy = resolve(
      {
        extraction: {
          observer: { activationThresholdMessages: 3 },
          timeoutMs: 750,
        },
        observer: { activationThresholdTokens: 900, modelId: 'legacy' },
        typedNetwork: { variant: 'full', extractAtEncode: false, observerLLM: invoker },
      },
      {
        extraction: {
          mode: 'auto',
          observer: { activationThresholdTokens: 640, modelId: 'stage' },
          reflector: { activationThresholdNotes: 8 },
          maxCallsPerTurn: 1,
        },
      },
    );

    expect(policy.path).toBe('auto');
    expect(policy.observer).toMatchObject({
      activationThresholdMessages: 3,
      activationThresholdTokens: 640,
      modelId: 'stage',
    });
    expect(policy.reflector).toMatchObject({ activationThresholdNotes: 8 });
    expect(policy.typedNetwork).toMatchObject({ variant: 'full', observerLLM: invoker });
    expect(policy.extractAtEncode).toBe(false);
    expect(policy.bankWrites).toBe(true);
    expect(policy.maxCallsPerTurn).toBe(1);
    expect(policy.timeoutMs).toBe(750);

    const defaults = resolve({ extraction: true });
    expect(defaults.typedNetwork).toMatchObject({ variant: 'minimal' });
    expect(defaults.observer).toMatchObject({
      activationThresholdMessages: 1,
      activationThresholdTokens: 512,
    });
    expect(defaults.reflector).toMatchObject({
      activationThresholdNotes: 4,
      activationThresholdTokens: 1024,
    });
    expect(defaults.maxCallsPerTurn).toBe(2);
    expect(defaults.timeoutMs).toBe(3000);
  });

  it('keeps callbacks out of local-only and vetoed policies', () => {
    const runtime = {
      extraction: { invoker },
      observer: { llmInvoker: stageInvoker },
      reflector: { llmInvoker: stageInvoker },
      typedNetwork: { variant: 'full', observerLLM: invoker },
    };
    for (const policy of [
      resolve({ ...runtime, extraction: { invoker, mode: 'classical' } }),
      resolve(runtime, {}, { role: 'assistant' }),
      resolve(runtime, {}, {}, { mode: 'compiled', allowExternalProcessing: false }),
    ]) {
      expect(policy.path).toBe('classical');
      expect(policy.invoker).toBeUndefined();
      expect(policy.observer.llmInvoker).toBeUndefined();
      expect(policy.reflector.llmInvoker).toBeUndefined();
      expect(policy.typedNetwork.observerLLM).toBeUndefined();
    }

    const off = resolve(runtime, { extraction: false });
    expect(off).toMatchObject({
      path: 'off',
      observer: false,
      reflector: false,
      typedNetwork: false,
      extractAtEncode: false,
      bankWrites: false,
      reflectionHandoff: false,
    });
    expect(off.invoker).toBeUndefined();
    expect(invoker.invoke).not.toHaveBeenCalled();
    expect(stageInvoker).not.toHaveBeenCalled();
  });

  it('resolves caller intent from the original options before filing defaults', () => {
    const runtime = { extraction: true };
    const conversation = { inputKind: 'conversation', type: 'episodic', tags: ['chat'] };
    expect(resolve(runtime, {}, conversation).path).toBe('auto');
    expect(resolve(runtime, {}, { tags: ['topic'] }).path).toBe('auto');
    for (const options of [
      { type: 'episodic', tags: ['chat'] },
      { inputKind: 'record', tags: ['chat'] },
      { ...conversation, id: 'preassigned-trace' },
      { ...conversation, createdAt: 1 },
      { ...conversation, sourceType: 'retrieved_document' },
      { ...conversation, sourceType: 'reflection' },
      { ...conversation, sourceType: 'external' },
      { ...conversation, sourceType: 'tool_result' },
      { ...conversation, role: 'system' },
      { ...conversation, role: 'tool' },
    ]) {
      expect(resolve(runtime, {}, options).path).toBe('off');
    }
  });

  it('keeps omitted standalone extraction literal and observe unsupported', async () => {
    const instance = await memory.AgentMemory.sqlite({ path: ':memory:' });
    const text = 'I prefer matte paper.';
    try {
      const result = await instance.remember(text);
      expect(result.success).toBe(true);
      expect(result.trace?.content).toBe(text);
      expect(result.trace?.type).toBe('episodic');
      expect((await instance.recall('matte paper')).memories.map((trace) => trace.id)).toEqual([
        result.trace?.id,
      ]);
      await expect(instance.observe('user', text)).rejects.toThrow(
        'requires a CognitiveMemoryManager-backed instance',
      );
    } finally {
      await instance.shutdown();
    }
  });

  it('keeps the manual typed-network observer available under omission', async () => {
    const manager = new memory.CognitiveMemoryManager();
    const invoke = vi.fn(async () => '{"facts":[]}');
    try {
      await manager.initialize({
        agentId: 'memory-policy-test',
        traits: {},
        moodProvider: () => ({ valence: 0, arousal: 0, dominance: 0 }),
        graph: { disabled: true },
        workingMemory: {} as memory.CognitiveMemoryConfig['workingMemory'],
        embeddingManager: {} as memory.CognitiveMemoryConfig['embeddingManager'],
        knowledgeGraph: {} as memory.CognitiveMemoryConfig['knowledgeGraph'],
        vectorStore: {} as memory.CognitiveMemoryConfig['vectorStore'],
        typedNetwork: { variant: 'minimal', observerLLM: { invoke } },
      });
      expect(invoke).not.toHaveBeenCalled();
      const observer = manager.getTypedNetworkObserver();
      expect(observer).not.toBeNull();
      expect(await observer?.extract('I prefer matte paper.', 'trace-1')).toEqual([]);
      expect(invoke).toHaveBeenCalledOnce();
    } finally {
      await manager.shutdown();
    }
  });
});
