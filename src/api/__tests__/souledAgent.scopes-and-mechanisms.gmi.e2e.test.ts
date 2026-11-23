import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
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

  async function open(cognition: SouledAgentOptions['cognition'] = { memory: { embedding }, mechanisms: false }) {
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
    });
    return opened;
  }

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
    const agent = await open({ memory: { embedding }, mechanisms: false, sentiment: true, metaprompts: ['frustration_recovery'] });
    const imprint = 'For the orchard exercise, offer the shortest route first.';
    fixture.served.replies.push(
      reply.text('I can help with the orchard exercise.'),
      reply.text(JSON.stringify({
        adjustmentRationale: 'The user is frustrated.',
        recoveryStrategy: 'Keep the reply short.',
        newMemoryImprints: [{ key: 'orchard_preference', value: imprint }],
      })),
    );
    const result = await agent.session('imprint', { userId: personB }).send('I hate this terrible awful orchard exercise.');
    await result.memoryWrite;
    await vi.waitFor(() => {
      expect(fixture.served.seen.filter(({ streamed }) => !streamed)).toHaveLength(1);
    });
    await vi.waitFor(async () => {
      const rows = (await rowsOf(fixture.adapter)).filter(({ content }) => content.includes(imprint));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ scope: 'conversation', scope_id: keyOf(personB), deleted: 0 });
      expect(JSON.parse(rows[0].metadata)).toMatchObject({ filedBy: 'mind', speaker: 'assistant' });
    }, { timeout: 3000 });
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
