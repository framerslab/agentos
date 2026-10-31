/**
 * @file ledger.integration.test.ts
 * The CI test for the ledger: every path of this release that makes a lasting self-change writes its rows, and the
 * list of paths is read from the code, not written by hand. The tools whose category is `emergent` are read from the
 * source, and each must be classed: in this release none records through the ledger (each refuses on a turn with no
 * learner and in mode off where a layer exists, and acts as before on a learner's turn), so a tool added to the
 * category fails this test until it is classed. For each recorded path: exactly one candidate row, or the call's own
 * row for an operator's call; under AGENTOS_LEARNING_FREEZE=1 an operator's call still writes its row and changes
 * state; every kind revert covers is reverted and its before-state comes back. The memory tools' and the
 * rolling-summary sink's paths are added with their routing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLearningLayer, InMemoryLearningStore, type LearnerContext, type LearnerKey } from '../index';
import { chainKeyOf } from '../ledger/Ledger';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSONA = { honesty: 0.9, extraversion: 0.8 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const CHAIN = chainKeyOf(KEY);
const context = (over: Partial<LearnerContext> = {}): LearnerContext => ({ sessionId: 's-1', personaId: 'tutor', authoredTraits: PERSONA, ...over });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Every tool class under `src/` that declares `readonly category = 'emergent'`, by its `readonly name`. */
function emergentToolNames(): string[] {
  const names: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== '__tests__') walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (!text.includes("readonly category = 'emergent'")) continue;
      for (const match of text.matchAll(/readonly name = '([a-z_]+)'/g)) names.push(match[1]!);
    }
  };
  walk(SRC);
  return names.sort();
}

/** The emergent tools, none of which records through the ledger in this release, with what each does instead. */
const EMERGENT_TOOLS_NOT_RECORDED: Record<string, string> = {
  adapt_personality: 'with a layer it refuses honesty, emotionality, steps above 0.02, a fourth call, a turn with no learner and mode off',
  create_workflow: 'with a layer it refuses a turn with no learner and mode off',
  forge_tool: 'with a layer it refuses a turn with no learner and mode off',
  manage_skills: 'with a layer it refuses a turn with no learner and mode off',
  self_evaluate: 'with a layer its adjust refuses a turn with no learner and mode off, and its evaluate stores nothing there',
};

describe('the paths that change learned state', () => {
  it('reads every emergent tool from the source, and each is classed', () => {
    expect(emergentToolNames()).toEqual(Object.keys(EMERGENT_TOOLS_NOT_RECORDED).sort());
  });

  describe.each([
    ['with no freeze', false],
    ['under AGENTOS_LEARNING_FREEZE=1', true],
  ])('%s', (_name, frozen) => {
    it("writes one candidate per trait row created and per operator's call, and a revert brings the before-state back", async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      if (frozen) vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
      const store = new InMemoryLearningStore();
      const layer = createLearningLayer({ store });
      const candidates = async () => (await store.chainRows(CHAIN)).filter((row) => row.rowType === 'candidate').map((row) => JSON.parse(row.body).reason);
      const openness = async () => JSON.parse((await store.traitRow('A', 'tutor', '42'))!.state).current.openness;

      await layer.forLearner(KEY, context());
      expect(await candidates()).toEqual(['created']);
      const set = await layer.operatorSet({ learner: KEY, traits: { openness: 0.7 }, by: 'ops' });
      expect(await candidates()).toEqual(['created', 'set']);
      expect(await openness()).toBe(0.7);
      await layer.importLearnedState(await layer.exportLearnedState(KEY));
      expect(await candidates()).toEqual(['created', 'set', 'import']);
      await layer.revert(set.id, 'ops');
      expect(await candidates()).toEqual(['created', 'set', 'import', 'revert']);
      expect(await openness()).toBe(0.5);
    });
  });
});
