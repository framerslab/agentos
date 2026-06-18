import { describe, it, expect } from 'vitest';
import { LLMJudge } from '../LLMJudge';
import type { AIModelProviderManager } from '../../../core/llm/providers/AIModelProviderManager';

// A provider manager whose getProvider returns null drives judge() straight
// into its error path ("Provider not found") without any network call.
const failingProvider = { getProvider: () => null } as unknown as AIModelProviderManager;

describe('LLMJudge — fail-closed on evaluation error', () => {
  it('defaults to score 0 on error so a >= threshold safety gate does NOT pass', async () => {
    const judge = new LLMJudge({ llmProvider: failingProvider });
    const result = await judge.judge('input', 'output');
    expect(result.score).toBe(0);
    expect(result.confidence).toBe(0);
  });

  it('honors a configured errorScore (opt-out for non-gating quality scoring)', async () => {
    const judge = new LLMJudge({ llmProvider: failingProvider, errorScore: 0.3 });
    const result = await judge.judge('input', 'output');
    expect(result.score).toBe(0.3);
  });
});
