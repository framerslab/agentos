import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AdaptPersonalityTool } from '@framers/agentos/cognition/emergent';
import { NOTETAKER_PERSONA, OPERATOR_ONLY_TRAITS } from '@framers/agentos/cognition/substrate';

for (const withLearning of [false, true]) {
  for (const trait of OPERATOR_ONLY_TRAITS) {
    test(`published tool refuses ${trait}, learning ${withLearning}`, async () => {
      let reads = 0;
      let writes = 0;
      const tool = new AdaptPersonalityTool({
        config: { maxDeltaPerSession: 0.3 },
        getPersonality: () => { reads += 1; return { ...NOTETAKER_PERSONA }; },
        setPersonality: () => { writes += 1; },
      });
      const result = await tool.execute({ trait, delta: -0.01, reasoning: 'Fixture request.' }, {
        gmiId: 'fixture-gmi', personaId: 'notetaker', userContext: { userId: 'fixture-user' },
        correlationId: 'fixture-call',
        sessionData: {
          sessionId: 'fixture-session',
          ...(withLearning ? { learning: { learner: 'bound', mode: 'on' } } : {}),
        },
      });
      assert.equal(result.success, false);
      assert.deepEqual(result.details, { status: 'rejected', reason: 'operator_only' });
      assert.equal(reads, 0);
      assert.equal(writes, 0);
    });
  }
}
