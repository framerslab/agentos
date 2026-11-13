/**
 * The construction rules of `memory.recall` (`resolveRecallOptions`): where the setting goes with cognitive memory on
 * and off, when `memoryProviderOptions.tokenBudget` is reported as not applied, and which values are refused, naming
 * the field and the reason.
 */
import { describe, expect, it } from 'vitest';
import { resolveRecallOptions } from '../../src/api/runtime/recallOptions.js';
import { RecallOptionError, recallBudgetTokens, DEFAULT_RECALL_BUDGET_TOKENS } from '../../src/cognition/memory/retrieval/recall/budget.js';

/** A commit id, as `rerank.revision` takes one. */
const COMMIT = '233902d25c440f23af6f7d6e94d2946bac0bee0a';

/** The error `run` throws, or undefined when it throws none. */
function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('resolveRecallOptions', () => {
  it('passes the recall setting to the manager on the GMI path and applies no provider budget', () => {
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 800 }, capture: 'off' }, cognitiveMemory: true, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }))
      .toEqual({ managerRecall: { budget: { totalTokens: 800 }, capture: 'off' }, providerTokenBudget: undefined, ignored: [] });
  });

  it('reports token_budget not applied on the GMI path when cognitive memory is on and no memory provider reads it, whatever recall says', () => {
    expect(resolveRecallOptions({ recall: undefined, cognitiveMemory: true, providerTokenBudget: 9000, providerContext: false, where: 'gmi()' }).ignored).toEqual(['token_budget']);
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: true, providerTokenBudget: 9000, providerContext: false, where: 'gmi()' }).ignored).toEqual(['token_budget']);
  });

  it("does not report token_budget when the memory provider has getContext: generate() and stream() still hand it to the provider", () => {
    const resolved = resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: true, providerTokenBudget: 9000, providerContext: true, where: 'gmi()' });
    expect(resolved.ignored).toEqual([]);
    expect(resolved.providerTokenBudget).toBeUndefined();
    expect(resolved.managerRecall).toEqual({ budget: { totalTokens: 900 } });
  });

  it("without cognitive memory, totalTokens is the provider's budget when that is unset, and equal values pass", () => {
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: true, where: 'agent()' }).providerTokenBudget).toBe(900);
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: false, providerTokenBudget: 900, providerContext: true, where: 'agent()' }).providerTokenBudget).toBe(900);
    expect(resolveRecallOptions({ recall: undefined, cognitiveMemory: false, providerTokenBudget: 700, providerContext: true, where: 'agent()' }))
      .toEqual({ managerRecall: undefined, providerTokenBudget: 700, ignored: [] });
    expect(resolveRecallOptions({ recall: { budget: {} }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: true, where: 'agent()' }).providerTokenBudget).toBeUndefined();
  });

  it('without cognitive memory, two different budgets are refused with the reason conflict, naming both', () => {
    const error = thrown(() => resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: false, providerTokenBudget: 2000, providerContext: true, where: 'agent()' }));
    expect(error).toBeInstanceOf(RecallOptionError);
    expect(error).toMatchObject({ option: 'budget.totalTokens', reason: 'conflict' });
    expect((error as Error).message).toMatch(/^agent\(\): memory\.recall\.budget\.totalTokens \(900\) and memoryProviderOptions\.tokenBudget \(2000\)/);
  });

  it('without cognitive memory, capture is refused with the reason unsupported_runtime, even set to its default', () => {
    for (const capture of ['off', 'metadata', 'metadata+stream'] as const) {
      const error = thrown(() => resolveRecallOptions({ recall: { capture }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }));
      expect(error, capture).toMatchObject({ option: 'capture', reason: 'unsupported_runtime' });
      expect((error as Error).message, capture).toMatch(/^gmi\(\): memory\.recall\.capture .*runtime: 'gmi'/);
    }
  });

  it('without cognitive memory, rerank is refused with the reason unsupported_runtime, whatever its value', () => {
    const invoke = async (): Promise<string> => '[]';
    for (const rerank of ['none', { kind: 'local', model: 'm', revision: COMMIT }, { kind: 'llm', invoke, model: 'm' }] as const) {
      const error = thrown(() => resolveRecallOptions({ recall: { rerank }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: true, where: 'agent()' }));
      expect(error, JSON.stringify(rerank)).toMatchObject({ option: 'rerank', reason: 'unsupported_runtime' });
      expect((error as Error).message, JSON.stringify(rerank)).toMatch(/^agent\(\): memory\.recall\.rerank .*runtime: 'gmi'/);
    }
  });

  it('passes a rerank that names a local model or a model call to the manager on the GMI path, as given', () => {
    const invoke = async (): Promise<string> => '[]';
    for (const rerank of ['none', { kind: 'local', model: 'm', revision: COMMIT, timeoutMs: 800, maxCandidates: 10 }, { kind: 'llm', invoke, model: 'm' }] as const) {
      const resolved = resolveRecallOptions({ recall: { rerank }, cognitiveMemory: true, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' });
      expect(resolved.managerRecall?.rerank).toBe(rerank);
    }
  });

  it('refuses a rerank that names another provider with the reason unsupported_provider, and a field of the wrong kind with invalid_value, on either path', () => {
    const invoke = async (): Promise<string> => '[]';
    const cases: Array<[unknown, string, string]> = [
      [{ kind: 'cohere', apiKey: 'k' }, 'rerank', 'unsupported_provider'],
      [{ kind: 'voyage' }, 'rerank', 'unsupported_provider'],
      [{ model: 'm', revision: 'r' }, 'rerank', 'unsupported_provider'],
      ['local', 'rerank', 'invalid_value'],
      [true, 'rerank', 'invalid_value'],
      [['none'], 'rerank', 'invalid_value'],
      [{ kind: 'local', revision: 'r' }, 'rerank.model', 'invalid_value'],
      [{ kind: 'local', model: 7, revision: 'r' }, 'rerank.model', 'invalid_value'],
      [{ kind: 'local', model: 'm' }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: '   ' }, 'rerank.revision', 'invalid_value'],
      // A branch, a tag or a short id can name other weights later: only a whole commit id pins them.
      [{ kind: 'local', model: 'm', revision: 'main' }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: 'v1.0' }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: COMMIT.slice(0, 7) }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: `${COMMIT}0` }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: 42 }, 'rerank.revision', 'invalid_value'],
      [{ kind: 'llm', model: 'm' }, 'rerank.invoke', 'invalid_value'],
      [{ kind: 'llm', invoke: 'call', model: 'm' }, 'rerank.invoke', 'invalid_value'],
      [{ kind: 'llm', invoke, model: '' }, 'rerank.model', 'invalid_value'],
      [{ kind: 'llm', invoke, model: 'm', timeoutMs: 0 }, 'rerank.timeoutMs', 'invalid_value'],
      [{ kind: 'llm', invoke, model: 'm', timeoutMs: 1.5 }, 'rerank.timeoutMs', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: COMMIT, timeoutMs: Number.POSITIVE_INFINITY }, 'rerank.timeoutMs', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: COMMIT, maxCandidates: 0 }, 'rerank.maxCandidates', 'invalid_value'],
      [{ kind: 'local', model: 'm', revision: COMMIT, maxCandidates: '20' }, 'rerank.maxCandidates', 'invalid_value'],
    ];
    for (const cognitiveMemory of [true, false]) {
      for (const [rerank, option, reason] of cases) {
        const error = thrown(() => resolveRecallOptions({ recall: { rerank } as never, cognitiveMemory, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }));
        expect(error, JSON.stringify(rerank)).toBeInstanceOf(RecallOptionError);
        expect(error, JSON.stringify(rerank)).toMatchObject({ option, reason });
        expect((error as Error).message, JSON.stringify(rerank)).toContain(`gmi(): memory.recall.${option}`);
      }
    }
  });

  it('a null or undefined rerank is unset, and its optional fields may be null', () => {
    for (const rerank of [null, undefined, { kind: 'local', model: 'm', revision: COMMIT, timeoutMs: null, maxCandidates: null }, { kind: 'local', model: 'm', revision: COMMIT.toUpperCase() }]) {
      expect(thrown(() => resolveRecallOptions({ recall: { rerank } as never, cognitiveMemory: true, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }))).toBeUndefined();
    }
    expect(thrown(() => resolveRecallOptions({ recall: { rerank: null } as never, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: false, where: 'agent()' }))).toBeUndefined();
  });

  it('refuses a value of the wrong kind with the reason invalid_value, on either path', () => {
    const cases: Array<[unknown, string]> = [
      [{ budget: { totalTokens: -1 } }, 'budget.totalTokens'],
      [{ budget: { totalTokens: 12.5 } }, 'budget.totalTokens'],
      [{ budget: { totalTokens: Number.NaN } }, 'budget.totalTokens'],
      [{ budget: { totalTokens: Number.POSITIVE_INFINITY } }, 'budget.totalTokens'],
      [{ budget: { totalTokens: '800' } }, 'budget.totalTokens'],
      [{ capture: 'everything' }, 'capture'],
      [{ capture: 1 }, 'capture'],
    ];
    for (const cognitiveMemory of [true, false]) {
      for (const [recall, option] of cases) {
        const error = thrown(() => resolveRecallOptions({ recall: recall as never, cognitiveMemory, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }));
        expect(error, JSON.stringify(recall)).toMatchObject({ option, reason: 'invalid_value' });
        expect((error as Error).message, JSON.stringify(recall)).toContain(`memory.recall.${option}`);
      }
    }
  });

  it('refuses a setting or a budget that is not an object with the reason invalid_value, on either path, naming it', () => {
    const cases: Array<[unknown, string, string]> = [
      ['off', 'recall', 'memory.recall must be an object'],
      [2400, 'recall', 'memory.recall must be an object'],
      [[{ budget: { totalTokens: 900 } }], 'recall', 'memory.recall must be an object'],
      [{ budget: 2400 }, 'budget', 'memory.recall.budget must be an object'],
      [{ budget: [2400] }, 'budget', 'memory.recall.budget must be an object'],
      [{ budget: 'small' }, 'budget', 'memory.recall.budget must be an object'],
    ];
    for (const cognitiveMemory of [true, false]) {
      for (const [recall, option, message] of cases) {
        const error = thrown(() => resolveRecallOptions({ recall: recall as never, cognitiveMemory, providerTokenBudget: undefined, providerContext: true, where: 'gmi()' }));
        expect(error, JSON.stringify(recall)).toBeInstanceOf(RecallOptionError);
        expect(error, JSON.stringify(recall)).toMatchObject({ option, reason: 'invalid_value' });
        expect((error as Error).message, JSON.stringify(recall)).toContain(`gmi(): ${message}`);
      }
    }
  });

  it('without cognitive memory, a budget that no memoryProvider.getContext reads is reported as recall_budget not applied', () => {
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: false, where: 'agent()' }).ignored).toEqual(['recall_budget']);
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 0 } }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: false, where: 'agent()' }).ignored).toEqual(['recall_budget']);
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 900 } }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: true, where: 'agent()' }).ignored).toEqual([]);
    expect(resolveRecallOptions({ recall: { budget: {} }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: false, where: 'agent()' }).ignored).toEqual([]);
    expect(resolveRecallOptions({ recall: undefined, cognitiveMemory: false, providerTokenBudget: 700, providerContext: false, where: 'agent()' }).ignored).toEqual([]);
  });

  it('a null recall (a JSON persona) is unset, and a budget of 0 is a budget', () => {
    expect(resolveRecallOptions({ recall: null, cognitiveMemory: true, providerTokenBudget: undefined, providerContext: false, where: 'gmi()' }).managerRecall).toBeUndefined();
    expect(resolveRecallOptions({ recall: { budget: { totalTokens: 0 } }, cognitiveMemory: false, providerTokenBudget: undefined, providerContext: true, where: 'agent()' }).providerTokenBudget).toBe(0);
  });
});

describe('recallBudgetTokens', () => {
  it('is the configured total, 1600 when unset, and 0 when set to 0', () => {
    expect(DEFAULT_RECALL_BUDGET_TOKENS).toBe(1600);
    expect(recallBudgetTokens(undefined)).toBe(1600);
    expect(recallBudgetTokens({})).toBe(1600);
    expect(recallBudgetTokens({ budget: {} })).toBe(1600);
    expect(recallBudgetTokens({ budget: { totalTokens: 2400 } })).toBe(2400);
    expect(recallBudgetTokens({ budget: { totalTokens: 0 } })).toBe(0);
  });
});
