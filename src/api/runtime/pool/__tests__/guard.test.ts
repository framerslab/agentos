import { describe, expect, it } from 'vitest';
import { guardPerCallOptions, POOL_DENIED_KEYS, PANEL_ALLOWED_KEYS, CUSTOM_MODEL_PARAMS_DENIED_PANEL } from '../guard.js';
import { AgencyConfigError } from '../../../types.js';
import type { GenerateTextOptions } from '../../../generateText.js';

/**
 * Every key of GenerateTextOptions, each sorted into allow or deny under
 * `panel`. A key added to the interface makes this object incomplete and
 * the typecheck job red, which is the decision point the spec asks for.
 */
const PANEL_DECISION: Record<keyof GenerateTextOptions, 'allow' | 'deny'> = {
  provider: 'deny', model: 'deny', prompt: 'deny', system: 'deny', messages: 'deny', tools: 'deny', toolChoice: 'allow',
  requestTimeout: 'allow', maxSteps: 'deny', toolMode: 'deny', temperature: 'allow', topP: 'allow', frequencyPenalty: 'allow',
  presencePenalty: 'allow', maxTokens: 'allow', thinking: 'allow', effort: 'allow', promptCacheKey: 'allow',
  promptCacheRetention: 'allow', serviceTier: 'allow', cache: 'allow', sessionId: 'allow', cacheDiagnostics: 'allow',
  customModelParams: 'allow', apiKey: 'deny', baseUrl: 'deny', usageLedger: 'allow', chainOfThought: 'allow', planning: 'allow',
  fallbackProviders: 'deny', onFallback: 'deny', source: 'allow', __rootStartedAt: 'deny', __fallbackDepth: 'deny', __hopBase: 'deny',
  __fallbackWalk: 'deny', router: 'deny', routerParams: 'deny', hostPolicy: 'deny', policyTier: 'deny', onBeforeGeneration: 'deny',
  onAfterGeneration: 'allow', onBeforeToolExecution: 'allow', __approvalGate: 'allow', __strictCredentials: 'deny',
  __panelDeadline: 'allow', __maskError: 'deny', _responseFormat: 'deny', _responseFormatBuilder: 'deny',
  _schemaInstruction: 'deny', _transcriptIncludeTrailingCallerMessages: 'deny', _continuation: 'deny',
};

describe('the pooled guard (deny list, presence not value)', () => {
  it.each([...POOL_DENIED_KEYS])('rejects %s present, also as undefined', (key) => {
    expect(() => guardPerCallOptions({ [key]: 'x' }, 'pool')).toThrow(AgencyConfigError);
    expect(() => guardPerCallOptions({ [key]: undefined }, 'pool')).toThrow(AgencyConfigError);
  });
  it('rejects customModelParams.model and .models, passes other params and unrelated keys', () => {
    expect(() => guardPerCallOptions({ customModelParams: { model: 'x' } }, 'pool')).toThrow(AgencyConfigError);
    expect(() => guardPerCallOptions({ customModelParams: { models: ['x'] } }, 'pool')).toThrow(AgencyConfigError);
    expect(() => guardPerCallOptions({ customModelParams: { provider: { sort: 'throughput' } }, system: 's', temperature: 0.1 }, 'pool')).not.toThrow();
    expect(() => guardPerCallOptions(undefined, 'pool')).not.toThrow();
  });
});

describe('the panel guard (allow list)', () => {
  it('sorts every GenerateTextOptions key as decided', () => {
    for (const [key, decision] of Object.entries(PANEL_DECISION)) {
      const call = () => guardPerCallOptions({ [key]: key === 'customModelParams' ? { temperature: 1 } : 'x' }, 'panel');
      if (decision === 'allow') expect(call, key).not.toThrow(); else expect(call, key).toThrow(AgencyConfigError);
    }
    expect(new Set(PANEL_ALLOWED_KEYS)).toEqual(new Set(Object.entries(PANEL_DECISION).filter(([, d]) => d === 'allow').map(([k]) => k)));
  });
  it('bars the nine customModelParams keys and passes others', () => {
    for (const k of CUSTOM_MODEL_PARAMS_DENIED_PANEL) expect(() => guardPerCallOptions({ customModelParams: { [k]: 1 } }, 'panel'), k).toThrow(AgencyConfigError);
    expect(() => guardPerCallOptions({ customModelParams: { provider: { order: ['Groq'] } } }, 'panel')).not.toThrow();
  });
  it('rejects an unknown key too', () => {
    expect(() => guardPerCallOptions({ somethingNew: 1 }, 'panel')).toThrow(AgencyConfigError);
  });
});
