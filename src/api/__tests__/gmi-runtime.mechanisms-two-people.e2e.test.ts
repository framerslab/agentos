import { afterEach, beforeEach, describe, vi } from 'vitest';
import { gmi, type GmiHandle } from '../gmi';
import { agentId, embedding, engines, memoryFixture, testMechanisms, type MemoryFixture } from './helpers/twoPeopleMemory';

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
