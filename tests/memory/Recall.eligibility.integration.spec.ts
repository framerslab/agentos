/**
 * @fileoverview One eligibility rule for every leg of a turn: under `retrieval: 'hybrid'` a trace too old, of another
 * type, under `minConfidence`, or whose trust policy refuses the asked capability reaches neither the result nor its
 * ranking, whichever leg found it; under `'dense'` the result is the one of no setting. SQLite on every run, Postgres
 * where the `test` job's service is set.
 */

import { describe, expect, it } from 'vitest';
import type { PADState } from '../../src/cognition/memory/core/config';
import type { CognitiveRetrievalOptions } from '../../src/cognition/memory/core/types';
import { ENGINES, FlatEmbedder, U1 } from './helpers/recallFixtures';
import { memoryWith, plant } from './helpers/recallMemory';

const NEUTRAL: PADState = { valence: 0, arousal: 0, dominance: 0 };
const NOW = Date.UTC(2026, 10, 10);
const NO_AUTHORIZATION = { usableForAuthorization: false, usableForPersonalization: true, usableForFactClaim: true };
const OPTIONS: CognitiveRetrievalOptions = {
  scopes: U1,
  types: ['semantic'],
  timeRange: { after: Date.UTC(2026, 5, 1) },
  minConfidence: 0.5,
  usableFor: 'authorization',
};

describe.each(ENGINES)('recall eligibility on %s', (_engine, open) => {
  async function fixture(recall: Record<string, unknown> | undefined) {
    const db = await open();
    const mem = await memoryWith(recall, new FlatEmbedder(), db.brain);
    await plant(mem, 'old', 'The harbor pass renews in March.', { createdAt: Date.UTC(2026, 0, 1) });
    await plant(mem, 'episodic', 'We talked about the harbor pass.', { type: 'episodic' });
    await plant(mem, 'unsure', 'The harbor pass may cost forty.', {
      provenance: { sourceType: 'agent_inference', sourceTimestamp: NOW, confidence: 0.2, verificationCount: 0 },
    });
    await plant(mem, 'no-auth', 'The harbor pass number is 7781.', { policy: NO_AUTHORIZATION });
    await plant(mem, 'good', 'The harbor pass is in the blue folder.');
    return { db, mem };
  }

  it("under 'hybrid' only the eligible trace is retrieved and ranked, from every leg", async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    const result = await mem.manager.retrieve('Where is the harbor pass?', NEUTRAL, OPTIONS);
    expect(result.retrieved.map((t) => t.id)).toEqual(['good']);
    const recall = result.diagnostics.recall as unknown as { ranked: Array<{ id: string }>; legs: Array<{ leg: string; ran: boolean }> };
    expect(recall.ranked.map((r) => r.id)).toEqual(['good']);
    expect(recall.legs.map((l) => [l.leg, l.ran])).toEqual([['dense', true], ['exact_words', true], ['recency', true]]);
    await mem.close();
    await db.close();
  });

  it("under 'hybrid' a supplied candidate on a turn that sets types, minConfidence or usableFor is ineligible", async () => {
    const { db, mem } = await fixture({ retrieval: 'hybrid' });
    const supplied = [{ id: 'fact', text: 'The harbor pass is renewed online.', scope: { scope: 'user' as const, scopeId: 'u1' } }];
    const result = await mem.manager.retrieve('Where is the harbor pass?', NEUTRAL, { ...OPTIONS, supplied } as never);
    expect(result.retrieved.map((t) => t.id)).toEqual(['good']);
    const recall = result.diagnostics.recall as unknown as { ranked: Array<{ id: string }>; suppliedRejected: unknown };
    expect(recall.ranked.map((r) => r.id)).toEqual(['good']);
    expect(recall.suppliedRejected).toEqual({ outOfScope: 0, ineligible: 1 });
    await mem.close();
    await db.close();
  });

  it("under 'dense' the result is the one of no setting", async () => {
    const unset = await fixture(undefined);
    const dense = await fixture({ retrieval: 'dense' });
    const a = await unset.mem.manager.retrieve('Where is the harbor pass?', NEUTRAL, OPTIONS);
    const b = await dense.mem.manager.retrieve('Where is the harbor pass?', NEUTRAL, OPTIONS);
    expect(b.retrieved.map((t) => t.id)).toEqual(a.retrieved.map((t) => t.id));
    expect(b.retrieved.map((t) => t.id)).toEqual(['good']);
    expect((b.diagnostics.recall as unknown as { legs: Array<{ leg: string }> }).legs.map((l) => l.leg)).toEqual(['dense']);
    await unset.mem.close();
    await unset.db.close();
    await dense.mem.close();
    await dense.db.close();
  });
});
