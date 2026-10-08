/**
 * @file PromptEngine.browser.test.ts
 * PromptEngine must load, build prompts and key its prompt cache where Node's
 * crypto module does not exist (browsers, Capacitor WebViews). Cache keys use
 * the plain-JavaScript SHA-256 in core/utils/sha256.
 *
 * node:crypto is mocked to throw on load: if PromptEngine or anything it
 * imports loads it, this file fails to import.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('node:crypto', () => {
  throw new Error('node:crypto is not available in this runtime');
});

import { PromptEngine } from '../PromptEngine';
import type { ModelTargetInfo, PromptExecutionContext } from '../IPromptEngine';

const modelInfo: ModelTargetInfo = {
  modelId: 'gpt-4o-mini',
  providerId: 'openai',
  maxContextTokens: 128000,
  optimalContextTokens: 64000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
};

const executionContext = {
  activePersona: {
    id: 'persona-test',
    name: 'Test Persona',
    description: 'Test persona',
    baseSystemPrompt: 'You are helpful.',
    contextualPromptElements: [],
  },
  workingMemory: {},
} as unknown as PromptExecutionContext;

describe('PromptEngine without Node crypto', () => {
  it('builds prompts and serves a repeat from its cache', async () => {
    const engine = new PromptEngine();
    await engine.initialize({
      defaultTemplateName: 'openai_chat',
      availableTemplates: {},
      tokenCounting: { strategy: 'estimated' },
      historyManagement: {
        defaultMaxMessages: 10,
        maxTokensForHistory: 2048,
        summarizationTriggerRatio: 0.8,
        preserveImportantMessages: true,
      },
      contextManagement: {
        maxRAGContextTokens: 2048,
        summarizationQualityTier: 'balanced',
        preserveSourceAttributionInSummary: true,
      },
      contextualElementSelection: {
        maxElementsPerType: {},
        defaultMaxElementsPerType: 3,
        priorityResolutionStrategy: 'highest_first',
        conflictResolutionStrategy: 'skip_conflicting',
      },
      performance: { enableCaching: true, cacheTimeoutSeconds: 60 },
    });

    const components = { systemPrompts: [{ content: 'Base instructions' }], userInput: 'Hello from a browser.' };

    const first = await engine.constructPrompt(components, modelInfo, executionContext);
    const repeat = await engine.constructPrompt(components, modelInfo, executionContext);

    expect(JSON.stringify(first.prompt)).toContain('Hello from a browser.');
    expect(repeat.cacheKey).toBe(first.cacheKey);
    expect((await engine.getEngineStatistics()).cacheStats).toMatchObject({ hits: 1, misses: 1 });
  });
});
