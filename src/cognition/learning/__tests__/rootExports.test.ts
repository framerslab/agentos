/**
 * @file rootExports.test.ts
 * The learning layer at the package root as a host reaches it: the layer, its session and context types, and the
 * trait map a learner context carries and a session answers (`HexacoTraitValues`). The type checks run in
 * `tsc --noEmit`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as root from '../../../index.js';
import type { HexacoTraitValues, ILearnerSession, LearnerContext } from '../../../index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the learning surface at the package root', () => {
  it("types a learner context's traits and a session's answer with the root's trait map", async () => {
    // The layer logs its manifest once, at its first session.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const authored: HexacoTraitValues = { honesty: 0.9, openness: 0.2 };
    const context: LearnerContext = { sessionId: 's-1', personaId: 'tutor', authoredTraits: authored };
    const session: ILearnerSession = await root.createLearningLayer().forLearner(null, context);
    const traits: HexacoTraitValues = session.currentTraits();
    expect(traits).toEqual(authored);
  });
});
