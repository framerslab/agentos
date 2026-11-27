/**
 * @file policy.types.test.ts
 * The typed network's model callback stays required on the memory
 * configuration: the manager refuses a typed network without one when it
 * opens, so the compiler refuses it first, whatever the reserved `extraction`
 * setting holds. The policy resolver alone reads a typed network without a
 * callback. The typecheck job runs these assertions; the test runner only
 * loads the file.
 */
import { describe, expect, it } from 'vitest';
import type { CognitiveMemoryConfig, TypedNetworkRuntimeConfig } from '../../core/config.js';
import type { ITypedExtractionLLM } from '../../retrieval/typed-network/index.js';
import type { resolveExtractionPolicy } from '../policy.js';

declare const observerLLM: ITypedExtractionLLM;
declare const resolve: typeof resolveExtractionPolicy;

// Never called: the assertions below are type assertions the typecheck job runs.
const _types = () => {
  const withCallback: TypedNetworkRuntimeConfig = { variant: 'full', observerLLM };
  void withCallback;

  // @ts-expect-error a typed network without its model callback does not compile
  const withoutCallback: TypedNetworkRuntimeConfig = { variant: 'full' };
  void withoutCallback;

  const reserved: Pick<CognitiveMemoryConfig, 'extraction' | 'typedNetwork'> = {
    extraction: { mode: 'classical' },
    // @ts-expect-error the reserved extraction setting does not lift the requirement
    typedNetwork: { variant: 'minimal' },
  };
  void reserved;

  // The resolver reads a typed network that names no callback, and may resolve one without it.
  const policy = resolve({ extraction: true, typedNetwork: { variant: 'full' } });
  if (policy.typedNetwork !== false) {
    const callback: ITypedExtractionLLM | undefined = policy.typedNetwork.observerLLM;
    void callback;
  }
};

describe('typed-network configuration types', () => {
  it('compile', () => {
    expect(typeof _types).toBe('function');
  });
});
