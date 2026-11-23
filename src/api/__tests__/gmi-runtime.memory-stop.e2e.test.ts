import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { gmi, type GmiOptions } from '../gmi';
import { reply, script } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const USER_TEXT = 'My canary is LARK-7.';
const ASSISTANT_TEXT = 'Your canary LARK-7, lovely.';
const FILED_EXCHANGE = [
  { type: 'episodic', content: USER_TEXT },
  { type: 'semantic', content: ASSISTANT_TEXT },
];
const STEP_USAGE = { promptTokens: 12, completionTokens: 3, totalTokens: 15 };
const AGENT_KEY = 'gmi-memory-stop';
let nextKey = 0;
let directory: string;
let agent: ReturnType<typeof gmi> | undefined;

beforeEach(async () => {
  globalLLMProviderHealth.reset();
  directory = await mkdtemp(join(tmpdir(), 'gmi-memory-stop-'));
});

afterEach(async () => {
  try {
    await agent?.close();
  } finally {
    agent = undefined;
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});

function open(onAfterGeneration?: GmiOptions['onAfterGeneration']) {
  const apiKey = `k-memory-stop-${++nextKey}`;
  const embeddingKey = `${apiKey}-embedding`;
  const embedder = script('openai', embeddingKey);
  script('openai', apiKey, { replies: [reply.text(ASSISTANT_TEXT, 'stub-model', STEP_USAGE)] });
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
  const path = join(directory, 'brain.sqlite');
  agent = gmi({
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    cognition: { memory: { embedding: { provider: 'openai' }, store: { path } }, mechanisms: false },
    learning: { agentKey: AGENT_KEY, mode: 'off' },
    onAfterGeneration,
  });

  return {
    session: agent.session('s1', { userId: 'u1' }),
    async filed() {
      // Read the store across scopes. Reopening the session would hide replies from its closed generation.
      const brain = await Brain.openSqlite(path, { brainId: AGENT_KEY });
      try {
        return await brain.all<{ type: string; content: string }>(
          'SELECT type, content FROM memory_traces WHERE brain_id = ? AND deleted = 0 ORDER BY content',
          [AGENT_KEY],
        );
      } finally {
        await brain.close();
      }
    },
    holdReplyEmbedding() {
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      embedder.beforeEmbedding = (texts) => {
        if (!texts.includes(ASSISTANT_TEXT)) return;
        entered();
        return gate;
      };
      return { started, release };
    },
  };
}

describe('GMI cognitive memory when a turn stops', () => {
  it('files neither side when the last generation hook aborts the turn', async () => {
    const stop = new AbortController();
    const reason = new Error('Stopped by the caller');
    const { session, filed } = open(async () => { stop.abort(reason); });

    await expect(session.send(USER_TEXT, { abortSignal: stop.signal })).rejects.toBe(reason);

    expect(session.messages().at(-1)).toMatchObject({ content: ASSISTANT_TEXT, partial: true });
    expect(await session.usage()).toMatchObject(STEP_USAGE);
    expect(await filed()).toEqual([]);
  });

  it('closes during the last generation hook without waiting for an embedding or filing either side', async () => {
    let entered!: () => void;
    let releaseHook!: () => void;
    const inHook = new Promise<void>((resolve) => { entered = resolve; });
    const hookGate = new Promise<void>((resolve) => { releaseHook = resolve; });
    const { session, filed, holdReplyEmbedding } = open(async () => {
      entered();
      await hookGate;
    });
    const embedding = holdReplyEmbedding();
    const turn = session.send(USER_TEXT).catch((error: unknown) => error);

    try {
      await inHook;
      const closing = session.close();
      const first = await Promise.race([
        closing.then(() => 'closed'),
        embedding.started.then(() => 'embedding'),
      ]);

      embedding.release();
      await closing;
      expect(await turn).toMatchObject({ message: expect.stringMatching(/abort/i) });
      expect(session.messages().at(-1)).toMatchObject({ content: ASSISTANT_TEXT, partial: true });
      expect(await session.usage()).toMatchObject(STEP_USAGE);
      expect({ first, traces: await filed() }).toEqual({ first: 'closed', traces: [] });
    } finally {
      releaseHook();
      embedding.release();
    }
  });

  it('files both sides when the turn finishes without a stop', async () => {
    const { session, filed } = open(async () => {});

    await expect(session.send(USER_TEXT)).resolves.toMatchObject({ text: ASSISTANT_TEXT });

    expect(await filed()).toEqual(FILED_EXCHANGE);
  });

  it('finishes filing an exchange if the session closes after its encoding starts', async () => {
    const { session, filed, holdReplyEmbedding } = open();
    const embedding = holdReplyEmbedding();
    const turn = session.send(USER_TEXT).catch((error: unknown) => error);

    try {
      const first = await Promise.race([embedding.started.then(() => 'embedding'), turn]);
      expect(first).toBe('embedding');
      // While the reply's embedding is held, neither the close nor the turn ends.
      const ended: string[] = [];
      const closing = session.close().finally(() => { ended.push('close'); });
      void turn.then(() => { ended.push('turn'); });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(ended).toEqual([]);
      embedding.release();

      await closing;
      expect(await turn).toMatchObject({ message: expect.stringMatching(/abort/i) });
      expect(await filed()).toEqual(FILED_EXCHANGE);
    } finally {
      embedding.release();
    }
  });
});
