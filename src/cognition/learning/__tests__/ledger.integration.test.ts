/**
 * @file ledger.integration.test.ts
 * The CI test for the ledger: every path of this release that makes a lasting self-change writes its rows, and the
 * list of paths is read from the code, not written by hand. The tools whose category is `emergent` are read from the
 * source, and each must be classed: in this release none records through the ledger (each refuses on a turn with no
 * learner and in mode off where a layer exists, and acts as before on a learner's turn), so a tool added to the
 * category fails this test until it is classed. For each recorded path: exactly one candidate row, or the call's own
 * row for an operator's call; under AGENTOS_LEARNING_FREEZE=1 an operator's call still writes its row and changes
 * state; every kind revert covers is reverted and its before-state comes back. The memory tools' paths are read from
 * their source as the emergent tools' are; the rolling-summary sink's path is added with its routing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ToolExecutionContext } from '../../../core/tools/ITool';
import { createLearningLayer, InMemoryLearningStore, toolLearningContextFor, type LearnerContext, type LearnerKey } from '../index';
import { chainKeyOf } from '../ledger/Ledger';
import { closeMemory, facadeAt, liveContents, tempFile } from './helpers/memoryFixtures';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const PERSONA = { honesty: 0.9, extraversion: 0.8 };
const KEY: LearnerKey = { namespace: 'A', agentKey: 'tutor', userId: '42' };
const CHAIN = chainKeyOf(KEY);
const context = (over: Partial<LearnerContext> = {}): LearnerContext => ({ sessionId: 's-1', personaId: 'tutor', authoredTraits: PERSONA, ...over });

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeMemory();
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

/** Every memory tool under `src/cognition/memory/io/tools/` that declares `readonly hasSideEffects = true`, by its name. */
function memoryToolsThatWrite(): string[] {
  const dir = path.join(SRC, 'cognition/memory/io/tools');
  const names: string[] = [];
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith('.ts') || entry.endsWith('.d.ts')) continue;
    const text = fs.readFileSync(path.join(dir, entry), 'utf8');
    if (!text.includes('readonly hasSideEffects = true')) continue;
    for (const match of text.matchAll(/readonly name = '([a-z_]+)'/g)) names.push(match[1]!);
  }
  return names.sort();
}

/** The memory tools that write, and how each stands with the ledger in this release. */
const MEMORY_TOOLS_THAT_WRITE: Record<string, string> = {
  memory_add: 'recorded',
  memory_delete: 'recorded',
  memory_merge: 'recorded',
  memory_update: 'recorded',
  memory_reflect: 'withdrawn: refused wherever a learning layer exists, so it writes no row',
  rehydrate_memory: 'not a self-change: it reads the archive and logs the access',
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

describe("the memory tools' writes", () => {
  it('reads every memory tool that writes from the source, and each is classed', () => {
    expect(memoryToolsThatWrite()).toEqual(Object.keys(MEMORY_TOOLS_THAT_WRITE).sort());
  });

  it('leave one candidate and its kept verdict per recorded write; under AGENTOS_LEARNING_FREEZE=1 a new write leaves none, while revert brings each before-state back', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = new InMemoryLearningStore();
    const { memory, brain } = await facadeAt(tempFile(), 'tools-brain');
    const layer = createLearningLayer({ store, memoryTools: memory });
    const session = await layer.forLearner(KEY, context());
    const tools = Object.fromEntries(memory.createTools().map((tool) => [tool.name, tool]));
    const prepared = await session.prepareTurn({ turnId: 't-1', userId: '42', namespace: 'A', text: 'Remember.', modelIds: ['stub-model'], workflowSeat: false });
    const { tools: learning } = toolLearningContextFor(session, { learner: 'bound', mode: prepared.mode, scopes: prepared.scopes!, conversationId: 's-1' });
    const call: ToolExecutionContext = {
      gmiId: 'gmi-1',
      personaId: 'tutor',
      userContext: { userId: '42' } as ToolExecutionContext['userContext'],
      sessionData: { sessionId: 's-1', organizationId: 'A', learning },
    };
    const toolRows = async () =>
      (await store.chainRows(CHAIN)).filter((row) => row.kind === 'memory_write' && String(JSON.parse(row.body).actor).startsWith('tool:'));
    const idOf = (result: { output?: unknown }) => (result.output as { traceId: string }).traceId;

    const tea = await tools.memory_add!.execute({ content: 'Ana likes tea.' }, call);
    const jasmine = await tools.memory_add!.execute({ content: 'Ana likes jasmine.' }, call);
    const green = await tools.memory_update!.execute({ traceId: idOf(tea), content: 'Ana likes green tea.' }, call);
    const dropped = await tools.memory_delete!.execute({ traceId: idOf(jasmine) }, call);
    const hot = await tools.memory_add!.execute({ content: 'Ana drinks it hot.' }, call);
    const merged = await tools.memory_merge!.execute({ traceIds: [idOf(tea), idOf(hot)], mergedContent: 'Ana likes green tea, hot.' }, call);
    const writes = [tea, jasmine, green, dropped, hot, merged];

    expect(writes.map((write) => write.details?.status)).toEqual(['kept', 'kept', 'kept', 'kept', 'kept', 'kept']);
    const rows = await toolRows();
    expect(rows.filter((row) => row.rowType === 'candidate')).toHaveLength(6);
    expect(rows.filter((row) => row.rowType === 'verdict').map((row) => row.verdict)).toEqual(['kept', 'kept', 'kept', 'kept', 'kept', 'kept']);
    expect(await liveContents(brain)).toEqual(['Ana likes green tea, hot.']);

    vi.stubEnv('AGENTOS_LEARNING_FREEZE', '1');
    const refused: Array<[string, Record<string, unknown>]> = [
      ['memory_add', { content: 'Not written.' }],
      ['memory_update', { traceId: idOf(tea), content: 'Not written.' }],
      ['memory_delete', { traceId: idOf(tea) }],
      ['memory_merge', { traceIds: [idOf(tea), idOf(jasmine)] }],
    ];
    for (const [name, args] of refused) {
      expect((await tools[name]!.execute(args, call)).details?.reason, name).toBe('frozen');
    }
    expect(await toolRows()).toHaveLength(12);

    // Each revert, newest first, under the freeze: the store's contents step back to before each write.
    const afterEachRevert = [
      ['Ana drinks it hot.', 'Ana likes green tea.'],
      ['Ana likes green tea.'],
      ['Ana likes green tea.', 'Ana likes jasmine.'],
      ['Ana likes jasmine.', 'Ana likes tea.'],
      ['Ana likes tea.'],
      [],
    ];
    for (const [step, write] of [...writes].reverse().entries()) {
      await layer.revert(String(write.details?.ledgerId), 'ops');
      expect(await liveContents(brain), `after revert ${step + 1}`).toEqual(afterEachRevert[step]);
    }
  });
});
