import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitiveMechanismsEngine } from '../../cognition/memory/mechanisms/CognitiveMechanismsEngine';
import { gmi, type GmiHandle } from '../gmi';
import { agentId, blocksOf, embedding, engines, memoryFixture, testMechanisms, type MemoryFixture } from './helpers/twoPeopleMemory';

import { reply } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const RUNTIME = 'gmi' as const;

describe.each(engines)('standalone cognitive memory on %s', (engine) => {
  let fixture: MemoryFixture;
  let opened: GmiHandle | undefined;

  beforeEach(async () => {
    fixture = await memoryFixture(engine);
  });

  afterEach(async () => {
    try {
      await opened?.close();
    } finally {
      opened = undefined;
      await fixture?.close();
    }
  });

  testMechanisms(() => fixture, async (mechanisms) => {
    opened = gmi({
      ...fixture.route,
      runtime: RUNTIME,
      cognition: { memory: { embedding, store: { adapter: fixture.adapter } }, mechanisms },
      learning: { agentKey: agentId, mode: 'off' },
    });
    return opened;
  });
});

describe('standalone cognitive memory without a durable store', () => {
  it.each([
    ['another session id', 'session-a'],
    ['the memory owner id', agentId],
  ])('keeps a user’s recall and retrieval candidates private when their id equals %s', async (_label, otherUser) => {
    const fixture = await memoryFixture('SQLite');
    const retrieval = vi.spyOn(CognitiveMechanismsEngine.prototype, 'onRetrieval');
    const agent = gmi({
      ...fixture.route,
      runtime: RUNTIME,
      name: 'Orchard Guide',
      cognition: {
        memory: { embedding },
        mechanisms: { retrievalInducedForgetting: { enabled: true, similarityThreshold: 0 } },
      },
    });
    try {
      fixture.served.replies.push(reply.text('B’s lantern is cobalt.'), reply.text('A’s lantern is amber.'), reply.text('Amber lantern.'));
      await agent.session('session-b', { userId: otherUser }).send('My orchard lantern is cobaltroute.');
      const a = agent.session('session-a', { userId: 'person-a' });
      await a.send('My orchard lantern is amberroute.');
      retrieval.mockClear();
      await a.send('What do you remember about my orchard lantern?');

      const candidates = retrieval.mock.calls.flatMap(([, pool]) => pool.map(({ trace }) => trace.content));
      expect(candidates).toContain('My orchard lantern is amberroute.');
      expect(candidates).not.toContain('My orchard lantern is cobaltroute.');
      const { mind } = blocksOf(fixture.served.seen.at(-1)!);
      expect(mind).toContain('amberroute');
      expect(mind).not.toContain('cobaltroute');
    } finally {
      try {
        await agent.close();
      } finally {
        await fixture.close();
      }
    }
  });
});
