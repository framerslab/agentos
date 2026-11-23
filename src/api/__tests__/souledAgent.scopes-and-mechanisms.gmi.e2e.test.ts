import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { MetapromptExecutor } from '../../cognition/substrate/MetapromptExecutor';
import { buildSessionSeat } from '../runtime/agencyLaunch/sessionSeat';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { reply } from './helpers/stubProviders';
import {
  agentId,
  blocksOf,
  embedding,
  engines,
  memoryFixture,
  otherProviderText,
  personA,
  personB,
  rowsOf,
  testMechanisms,
  type MemoryFixture,
} from './helpers/twoPeopleMemory';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const RUNTIME = 'gmi' as const;
const keyOf = (id: string) => conversationScopeKey(agentId, { kind: 'user', id });

/** Cognitive memory with the one metaprompt a frustrated message raises. */
const imprinting: SouledAgentOptions['cognition'] = { memory: { embedding }, mechanisms: false, sentiment: true, metaprompts: ['frustration_recovery'] };
const frustrated = 'I hate this terrible awful orchard exercise.';
const imprint = 'For the orchard exercise, offer the shortest route first.';
/** The metaprompt's answer: one imprint whose value is text, and one whose value is not. */
const metapromptAnswer = JSON.stringify({
  adjustmentRationale: 'The user is frustrated.',
  recoveryStrategy: 'Keep the reply short.',
  newMemoryImprints: [
    { key: 'orchard_preference', value: imprint },
    { key: 'prefers_short_replies', value: true, description: 'asked twice' },
  ],
});
/** The two imprints as the mind files them: each says what it records. */
const filedImprints = [`orchard_preference: ${imprint}`, 'prefers_short_replies: true (asked twice)'];

/** A gate a held model call waits behind until the test opens it. */
function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

describe.each(engines)('souled cognitive memory on %s', (engine) => {
  let fixture: MemoryFixture;
  let opened: SouledAgent | undefined;

  beforeEach(async () => {
    fixture = await memoryFixture(engine);
    writeFileSync(join(fixture.dir, 'SOUL.md'), `---\nname: Orchard Guide\nagentId: ${agentId}\n---\nYou are the orchard guide.`);
  });

  afterEach(async () => {
    try {
      await opened?.close();
    } finally {
      opened = undefined;
      await fixture?.close();
    }
  });

  async function open(
    cognition: SouledAgentOptions['cognition'] = { memory: { embedding }, mechanisms: false },
    hooks: { memoryPolicy?: SouledAgentOptions['memoryPolicy'] } = {},
  ) {
    opened = await souledAgent({
      ...fixture.route,
      runtime: RUNTIME,
      soul: fixture.dir,
      compile: false,
      retention: { traces: 'until-deletion' },
      tombstoneKey: 'orchard-test-tombstones',
      tombstoneCopy: { path: join(fixture.dir, 'tombstones.sqlite') },
      soulStore: { adapter: fixture.adapter },
      cognition,
      ...hooks,
    });
    return opened;
  }

  /** The model calls the metaprompts made: a GMI streams every turn, and a metaprompt asks for a whole reply. */
  const metapromptCalls = () => fixture.served.seen.filter(({ streamed }) => !streamed);
  /** The rows a metaprompt's imprint was filed as. */
  const imprintRows = async () => (await rowsOf(fixture.adapter)).filter(({ tags }) => (JSON.parse(tags) as string[]).includes('metaprompt'));
  /** How many writes were refused for `reason`. */
  const refusals = (reason: string) => fixture.events.filter((line) => line.event === 'memory.write_refused' && line.reason === reason).length;
  /** Resolves once the one metaprompt of the case has applied its answer, its imprints among it. */
  const metapromptApplied = async (applied: { mock: { results: Array<{ value?: unknown }> } }) => {
    await vi.waitFor(() => {
      expect(applied.mock.results).toHaveLength(1);
    });
    await applied.mock.results[0].value;
  };

  testMechanisms(
    () => fixture,
    (mechanisms) => open({ memory: { embedding }, mechanisms }),
    async () => {
      await opened!.memory!.remember(otherProviderText, {
        type: 'episodic',
        scope: 'conversation',
        scopeId: keyOf(personB),
        metadata: { speaker: 'user' },
      });
    },
  );

  it('files both people’s turns only under their conversation keys', async () => {
    const agent = await open();
    fixture.served.replies.push(reply.text('Amber lantern noted.'), reply.text('Cobalt lantern noted.'));
    const a = await agent.session('first', { userId: personA }).send('My lantern is amber.');
    const b = await agent.session('second', { userId: personB }).send('My lantern is cobalt.');
    await Promise.all([a.memoryWrite, b.memoryWrite]);

    const rows = await rowsOf(fixture.adapter);
    expect(rows).toHaveLength(4);
    expect(rows.map(({ scope }) => scope)).toEqual(['conversation', 'conversation', 'conversation', 'conversation']);
    expect(rows.filter(({ scope_id }) => scope_id === keyOf(personA)).map(({ content }) => content).sort()).toEqual([
      'Amber lantern noted.', 'My lantern is amber.',
    ]);
    expect(rows.filter(({ scope_id }) => scope_id === keyOf(personB)).map(({ content }) => content).sort()).toEqual([
      'Cobalt lantern noted.', 'My lantern is cobalt.',
    ]);
  });

  it('a seat session of a souled agent files and recalls no cognitive memory', async () => {
    const managerForSession = vi.spyOn(CognitiveMemoryManager.prototype, 'forSession');
    const agent = await open();
    fixture.served.replies.push(reply.text('Remembered the orchard lantern.'), reply.text('The seat noted the task.'), reply.text('The seat is done.'));
    const owner = agent.session('owner', { userId: personA });
    const filed = await owner.send('Orchard cedar lantern amberroute.');
    await filed.memoryWrite;
    await agent.memory!.remember(otherProviderText, {
      type: 'episodic',
      scope: 'conversation',
      scopeId: keyOf(personA),
      metadata: { speaker: 'user' },
    });

    const before = await rowsOf(fixture.adapter);
    expect(before).toHaveLength(3);
    expect(managerForSession).toHaveBeenCalledTimes(1);
    managerForSession.mockClear();
    const seat = buildSessionSeat(agent, { form: 'persistent', userId: personA });
    try {
      await seat.generate('For the orchard cedar lantern, mark the seat task as saffronroute.');
      await seat.generate('What did the orchard cedar lantern conversation say?');
    } finally {
      await seat.close();
    }

    expect(await rowsOf(fixture.adapter)).toEqual(before);
    for (const call of fixture.served.seen.slice(1)) {
      expect(blocksOf(call)).toEqual({ mind: '', provider: '' });
    }
    expect(managerForSession).not.toHaveBeenCalled();
  });

  it('files a metaprompt’s imprint as the assistant’s under the triggering person’s key', async () => {
    const agent = await open(imprinting);
    fixture.served.replies.push(reply.text('I can help with the orchard exercise.'), reply.text(metapromptAnswer));
    const result = await agent.session('imprint', { userId: personB }).send(frustrated);
    await result.memoryWrite;
    await vi.waitFor(() => {
      expect(metapromptCalls()).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const rows = await imprintRows();
      expect(rows.map(({ content }) => content).sort()).toEqual([...filedImprints].sort());
      for (const row of rows) {
        expect(row).toMatchObject({ scope: 'conversation', scope_id: keyOf(personB), deleted: 0 });
        expect(JSON.parse(row.metadata)).toMatchObject({ filedBy: 'mind', speaker: 'assistant' });
      }
    }, { timeout: 3000 });
  });

  it('does not file an imprint once a newer turn of its session has begun', async () => {
    const applied = vi.spyOn(MetapromptExecutor.prototype, 'applyMetapromptUpdates');
    const agent = await open(imprinting);
    const held = gate();
    fixture.served.replies.push(
      reply.text('I can help with the orchard exercise.'),
      reply.hold([], held.opened, reply.text(metapromptAnswer)),
      reply.text('Glad that helped.'),
    );
    const session = agent.session('imprint', { userId: personB });
    await (await session.send(frustrated)).memoryWrite;
    await vi.waitFor(() => {
      expect(metapromptCalls()).toHaveLength(1);
    });
    // The metaprompt's call is still open when the person's next turn begins and ends.
    await (await session.send('Thank you, that was a great help.')).memoryWrite;
    held.open();
    await metapromptApplied(applied);
    await agent.close();
    opened = undefined;

    expect(await imprintRows()).toEqual([]);
    expect((await rowsOf(fixture.adapter)).map(({ content }) => content).sort()).toEqual(
      ['Glad that helped.', 'I can help with the orchard exercise.', frustrated, 'Thank you, that was a great help.'].sort(),
    );
  });

  it('does not file an imprint that lands after a correction of the person’s memory', async () => {
    const applied = vi.spyOn(MetapromptExecutor.prototype, 'applyMetapromptUpdates');
    const agent = await open(imprinting);
    const held = gate();
    fixture.served.replies.push(reply.text('I can help with the orchard exercise.'), reply.hold([], held.opened, reply.text(metapromptAnswer)));
    await (await agent.session('imprint', { userId: personB }).send(frustrated)).memoryWrite;
    await vi.waitFor(() => {
      expect(metapromptCalls()).toHaveLength(1);
    });
    const said = (await rowsOf(fixture.adapter)).find(({ content }) => content === frustrated)!;
    await agent.correctUserMemory!(personB, { traceIds: [said.id] });
    held.open();
    await metapromptApplied(applied);
    await agent.close();
    opened = undefined;

    expect(await imprintRows()).toEqual([]);
    expect(refusals('corrected')).toBe(filedImprints.length);
  });

  it('holds a late imprint to the account’s newest policy answer and asks the host no second time', async () => {
    const applied = vi.spyOn(MetapromptExecutor.prototype, 'applyMetapromptUpdates');
    // The second ask, the turn of the person's other session, finds the host's policy service down.
    let asks = 0;
    const memoryPolicy = vi.fn((): { longTerm: 'raw' } => {
      asks += 1;
      if (asks === 2) throw new Error('policy service down');
      return { longTerm: 'raw' };
    });
    const agent = await open(imprinting, { memoryPolicy });
    const held = gate();
    fixture.served.replies.push(
      reply.text('I can help with the orchard exercise.'),
      reply.hold([], held.opened, reply.text(metapromptAnswer)),
      reply.text('Glad that helped.'),
    );
    await (await agent.session('imprint', { userId: personB }).send(frustrated)).memoryWrite;
    await vi.waitFor(() => {
      expect(metapromptCalls()).toHaveLength(1);
    });
    await (await agent.session('other', { userId: personB }).send('Thank you, that was a great help.')).memoryWrite;
    expect(memoryPolicy).toHaveBeenCalledTimes(2);
    const refusedBefore = refusals('policy_failed');
    held.open();
    await metapromptApplied(applied);
    await agent.close();
    opened = undefined;

    // The imprint's turn was decided before the failure: it reads that decision and the account's newest answer.
    expect(memoryPolicy).toHaveBeenCalledTimes(2);
    expect(await imprintRows()).toEqual([]);
    expect(refusals('policy_failed')).toBe(refusedBefore + filedImprints.length);
  });

  it('keeps both statements when a person contradicts an older fact', async () => {
    const agent = await open();
    fixture.served.replies.push(reply.text('Amber noted.'), reply.text('Cobalt noted.'), reply.text('Both statements are on file.'));
    const a = agent.session('facts', { userId: personA });
    const older = 'My orchard lantern is amber.';
    const newer = 'My orchard lantern is cobalt.';
    for (const input of [older, newer, 'What is the color of my orchard lantern?']) {
      await (await a.send(input)).memoryWrite;
    }

    const facts = (await rowsOf(fixture.adapter)).filter(({ content }) => content === older || content === newer);
    expect(facts.map(({ content }) => content).sort()).toEqual([older, newer].sort());
    expect(facts.every(({ scope_id, deleted }) => scope_id === keyOf(personA) && deleted === 0)).toBe(true);
    expect(blocksOf(fixture.served.seen.at(-1)!).mind).toContain(older);
    expect(blocksOf(fixture.served.seen.at(-1)!).mind).toContain(newer);
  });
});
