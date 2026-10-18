import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentOSConfig } from '../AgentOSConfig.js';
import { StatisticalUtilityAI } from '../../../cognition/nlp/ai_utilities/StatisticalUtilityAI.js';

describe('createAgentOSConfig with ENABLE_UTILITY_AI=true', () => {
  beforeEach(() => {
    vi.stubEnv('DATABASE_URL', 'file:./utility-config-test.sqlite');
    vi.stubEnv('OPENAI_API_KEY', '');
    vi.stubEnv('OPENROUTER_API_KEY', '');
    vi.stubEnv('REQUESTY_API_KEY', '');
    vi.stubEnv('ENABLE_UTILITY_AI', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('hands the runtime a StatisticalUtilityAI that is initialized', async () => {
    const config = await createAgentOSConfig();
    const utility = config.utilityAIService;
    expect(utility).toBeInstanceOf(StatisticalUtilityAI);
    // AgentOS uses the service as given and never initializes it, so it must arrive ready.
    expect((await utility!.checkHealth()).isHealthy).toBe(true);
    expect(await utility!.tokenize('Hello world')).toEqual(['hello', 'world']);
    expect((await utility!.analyzeSentiment('This is terrible.')).polarity).toBe('negative');
  });
});
