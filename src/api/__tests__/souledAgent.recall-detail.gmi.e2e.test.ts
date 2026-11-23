/** Recall detail through the real soul, GMI, cognitive memory manager and store. Only the model provider is stubbed. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import type { MemoryRecallConfig } from '../../cognition/memory/core/config';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { gmi } from '../gmi';
import type { MemoryRecallBlock } from '../runtime/memoryDataBlock';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { MemoryShownItem } from '../index';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));
vi.mock('../../core/llm/providers/implementations/AnthropicProvider', async () => ({
  AnthropicProvider: (await import('./helpers/stubProviders')).stubProviderClass('anthropic'),
}));

/**
 * The runtimes every case runs on, each as the options that select it: `runtime: 'gmi'`, and no `runtime` at all,
 * which is souledAgent()'s default.
 */
const RUNTIMES = [
  ["runtime: 'gmi'", { runtime: 'gmi' }],
  ['no runtime set', {}],
] as const;
/** The runtime options of the suite that is running: each suite of the runtimes sets them before its cases. */
let RUNTIME: (typeof RUNTIMES)[number][1] = RUNTIMES[0][1];
const AGENT = 'recall-detail';
const USER = 'reader';
const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const QUESTION = 'What do you remember about my canary?';
const MIND_USER = 'My canary is named LARK-7.';
const MIND_ASSISTANT = 'A canary named LARK-7, noted.';
const PROVIDER = 'My canary practices scales at dawn.';
const OTHER_PROVIDER = 'My canary sleeps beside the window.';
const PAGE = 'Canary food stays in the blue tin.';
const PAGE_ID = 'concepts/canary';
const REPLY = 'I remember.';
const DETAIL = 'metadata+text';

let serial = 0;
let dir: string;
let served: ProviderScript;
const opened: Array<{ close(): Promise<void> }> = [];

beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-recall-detail-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), `---\nname: Canary keeper\nagentId: ${AGENT}\n---\nHelp care for the canary.`);
  const embeddingKey = `k-recall-detail-embedding-${++serial}`;
  script('openai', embeddingKey, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
});

afterEach(async () => {
  try {
    while (opened.length) await opened.pop()!.close();
  } finally {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function route() {
  const apiKey = `k-recall-detail-llm-${++serial}`;
  served = script('openai', apiKey, { whole: true, replies: [reply.text(MIND_ASSISTANT), reply.text(REPLY), reply.text(REPLY)] });
  return { provider: 'openai' as const, model: 'stub-model', apiKey, fallbackProviders: [] };
}

async function open(recall?: MemoryRecallConfig, store: Partial<SouledAgentOptions> = {}) {
  const agent = await souledAgent({
    ...route(),
    ...RUNTIME,
    soul: dir,
    compile: false,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'recall-detail-test-tombstones',
    cognition: { memory: { embedding: { provider: 'openai' }, recall }, mechanisms: false },
    screen: async (text) => (text === QUESTION || text === REPLY ? null : text),
    ...store,
  });
  opened.push(agent);
  return agent;
}

async function fileMemories(agent: SouledAgent) {
  const filing = await agent.session('filing', { userId: USER }).send(MIND_USER);
  const receipt = await filing.memoryWrite;
  expect(receipt?.entries.map((entry) => entry.outcome)).toEqual(['written', 'written']);
  const provider = await rememberForReader(agent, PROVIDER);
  const page = await agent.memory!.remember(PAGE, {
    type: 'semantic',
    scope: 'conversation',
    scopeId: conversationScopeKey(AGENT, { kind: 'operator' }),
    tags: ['wiki', `page:${PAGE_ID}`],
  });
  return { provider, page };
}

function rememberForReader(agent: SouledAgent, text: string) {
  return agent.memory!.remember(text, {
    type: 'episodic',
    scope: 'conversation',
    scopeId: conversationScopeKey(AGENT, { kind: 'user', id: USER }),
    metadata: { speaker: 'user' },
  });
}

function readProviderBlock(content: string): MemoryRecallBlock {
  return JSON.parse(content.slice('<memory_recall>'.length, -'</memory_recall>'.length));
}

function blocksOfLastCall(of: ProviderScript = served) {
  const parts = of.seen.at(-1)!.messages.flatMap(({ content }) =>
    typeof content === 'string' ? [content] : Array.isArray(content) ? content.flatMap((part) => ('text' in part ? [part.text] : [])) : [],
  );
  const provider = parts.find((part) => part?.startsWith('<memory_recall>')) ?? '';
  const mind = parts.find((part) => part?.includes('## How To Use Your Memories')) ?? '';
  return { provider, mind };
}

function expectNoMemoryText(value: unknown) {
  const serialized = JSON.stringify(value) ?? '';
  for (const text of [MIND_USER, MIND_ASSISTANT, PROVIDER, PAGE]) {
    expect(serialized).not.toContain(text);
    expect(serialized).not.toContain(text.replace(/\s+/g, '^'));
  }
}

async function expectRecallDetail(store?: Pick<SouledAgentOptions, 'soulStore' | 'tombstoneCopy'>) {
  const agent = await open({ capture: DETAIL }, store);
  const { provider, page } = await fileMemories(agent);
  const { traces } = await agent.exportUserMemory!(USER);
  const result = await agent.session('reader', { userId: USER }).send(QUESTION);
  const blocks = blocksOfLastCall();

  expect(blocks.mind).toContain(MIND_USER);
  const fromMind = traces.filter(({ text }) => blocks.mind.includes(text));
  const includedIds = result.memoryRecall?.candidates.filter(({ outcome }) => outcome === 'included').map(({ id }) => id) ?? [];
  expect(includedIds.slice().sort()).toEqual(fromMind.map(({ id }) => id).sort());
  const expectedMind = includedIds.map<MemoryShownItem>((id) => {
    const trace = fromMind.find((item) => item.id === id)!;
    const text = trace.speaker === 'assistant' ? `You said: ${trace.text}` : trace.text;
    expect(blocks.mind).toContain(text);
    return { source: 'memory', id, text, speaker: trace.speaker, at: trace.createdAt };
  });

  const modelItems = (JSON.parse(blocks.provider.slice('<memory_recall>'.length, -'</memory_recall>'.length)) as {
    items: Array<{ text: string; speaker: 'user' | 'note'; page?: string; when: string }>;
  }).items;
  expect(modelItems.map(({ text, speaker }) => ({ text, speaker }))).toEqual(
    expect.arrayContaining([
      { text: PROVIDER.replace(/ /g, '^'), speaker: 'user' },
      { text: PAGE.replace(/ /g, '^'), speaker: 'note' },
    ]),
  );
  expect(modelItems).toHaveLength(2);
  for (const id of [...includedIds, provider.id, page.id]) expect(blocks.provider).not.toContain(id);
  for (const item of modelItems) {
    expect(item).not.toHaveProperty('id');
    expect(item.when).toMatch(/\d{4}-\d{2}-\d{2}/);
    if (item.speaker === 'note') expect(item.page).toBe(PAGE_ID);
  }
  const expectedProvider = modelItems.map<MemoryShownItem>(({ text, speaker, page: pageId, when }) => ({
    source: 'provider',
    text: text.replace(/\^/g, ' '),
    speaker,
    at: when,
    ...(pageId ? { page: pageId } : { id: provider.id }),
  }));

  const shown = result.memoryShown;
  expect(shown).toEqual([...expectedMind, ...expectedProvider]);
  expectNoMemoryText(result.memoryRecall);
  const traceId = shown!.find((item) => item.source === 'provider' && item.speaker === 'user')!.id!;
  expect(await agent.correctUserMemory!(USER, { traceIds: [traceId] })).toMatchObject({ deleted: 1 });
  const after = await agent.exportUserMemory!(USER);
  expect(after.traces.map(({ id }) => id)).not.toContain(traceId);
  expect(after.traces.map(({ text }) => text)).toContain(MIND_USER);
}

describe.each(RUNTIMES)('with %s', (_name, runtime) => {
  beforeAll(() => {
    RUNTIME = runtime;
  });

  describe('recall detail on a souled agent', () => {
    it('records metadata by default without exposing recall text in the result', async () => {
      const agent = await open();
      await fileMemories(agent);
      const result = await agent.session('reader', { userId: USER }).send(QUESTION);
      const blocks = blocksOfLastCall();
      expect(blocks.mind).toContain(MIND_USER);
      expect(blocks.provider).toContain(PROVIDER.replace(/ /g, '^'));
      expect(result.memoryRecall?.candidates.some(({ outcome }) => outcome === 'included')).toBe(true);
      expect(result.memoryShown).toBeUndefined();
      expectNoMemoryText(result);
      expectNoMemoryText(result.memoryRecall);
    });

    it('returns what both blocks showed and provides the id for deleting a provider trace', async () => {
      await expectRecallDetail();
    });

    it.runIf(Boolean(POSTGRES_URL))('returns both sources and supports deletion on PostgreSQL', async () => {
      const schema = `souled_recall_detail_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      const adapter = createPostgresAdapter({ connectionString: POSTGRES_URL!, segment: schema, max: 5, typeParsers: { int8: 'number' } });
      const admin = createPostgresAdapter({ connectionString: POSTGRES_URL! });
      await adapter.open();
      opened.push({
        close: async () => {
          await adapter.close();
          await admin.open();
          try {
            await admin.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
          } finally {
            await admin.close();
          }
        },
      });
      await expectRecallDetail({ soulStore: { adapter }, tombstoneCopy: { path: path.join(dir, 'forgotten.sqlite') } });
    });

    it('resolves the same detail through the stream result after the stream ends', async () => {
      const agent = await open({ capture: DETAIL });
      await fileMemories(agent);
      const send = await agent.session('reader', { userId: USER }).send(QUESTION);
      const stream = agent.session('stream-reader', { userId: USER }).stream(QUESTION);
      const shown = stream.memoryShown;
      expect(shown).toBeInstanceOf(Promise);
      const parts = [];
      for await (const part of stream.fullStream) parts.push(part);
      expect(await stream.text).toBe(REPLY);
      expect(send.memoryShown?.length).toBeGreaterThan(0);
      expect(await shown).toEqual(send.memoryShown);
      expectNoMemoryText(parts);
    });

    it('keeps recall text out of stream parts under metadata streaming', async () => {
      const agent = await open({ capture: 'metadata+stream' });
      await fileMemories(agent);
      const result = agent.session('reader', { userId: USER }).stream(QUESTION);
      const parts = [];
      for await (const part of result.fullStream) parts.push(part);
      expect(blocksOfLastCall().mind).toContain(MIND_USER);
      expect(await result.memoryRecall).toBeDefined();
      expect(result.memoryShown).toBeUndefined();
      expectNoMemoryText(parts);
      expectNoMemoryText(await result.memoryRecall);
    });

    it('lists the provider memory left unchanged when the hook removes another', async () => {
      const removedText = PROVIDER.replace(/ /g, '^');
      const keptText = OTHER_PROVIDER.replace(/ /g, '^');
      let beforeHook: MemoryRecallBlock['items'] | undefined;
      const agent = await open({ capture: DETAIL }, {
        onBeforeGeneration: async ({ messages }) => ({
          messages: messages.map((message) => {
            const { content } = message;
            if (typeof content !== 'string' || !content.startsWith('<memory_recall>')) return message;
            const block = readProviderBlock(content);
            beforeHook = block.items;
            block.items = block.items.filter(({ text }) => text !== removedText);
            return { ...message, content: `<memory_recall>${JSON.stringify(block)}</memory_recall>` };
          }),
        }),
      });
      await rememberForReader(agent, PROVIDER);
      const kept = await rememberForReader(agent, OTHER_PROVIDER);

      const result = await agent.session('reader', { userId: USER }).send(QUESTION);
      const sent = readProviderBlock(blocksOfLastCall().provider).items;
      expect(beforeHook?.map(({ text }) => text).sort()).toEqual([keptText, removedText].sort());
      expect(sent).toEqual([{ text: keptText, speaker: 'user', when: expect.any(String) }]);
      expect(result.memoryShown?.filter(({ source }) => source === 'provider') ?? []).toEqual([
        { source: 'provider', id: kept.id, text: OTHER_PROVIDER, speaker: 'user', at: sent[0].when },
      ]);
    });

    it('lists the mind memory left unchanged when the hook removes another', async () => {
      const agent = await open({ capture: DETAIL }, {
        onBeforeGeneration: async ({ messages }) => ({
          messages: messages.map((message) => {
            const { content } = message;
            if (typeof content !== 'string' || !content.includes('## How To Use Your Memories')) return message;
            return { ...message, content: content.split('\n').filter((line) => !line.includes(MIND_ASSISTANT)).join('\n') };
          }),
        }),
      });
      // The recall metadata records the mind's original render, before the hook removes the reply.
      const filing = await agent.session('filing', { userId: USER }).send(MIND_USER);
      await filing.memoryWrite;
      const { traces } = await agent.exportUserMemory!(USER);
      const user = traces.find(({ text }) => text === MIND_USER)!;
      const assistant = traces.find(({ text }) => text === MIND_ASSISTANT)!;

      const result = await agent.session('reader', { userId: USER }).send(QUESTION);
      const sent = blocksOfLastCall();
      expect(sent.mind).toContain(MIND_USER);
      expect(sent.mind).not.toContain(MIND_ASSISTANT);
      expect(result.memoryRecall?.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: user.id, outcome: 'included' }),
        expect.objectContaining({ id: assistant.id, outcome: 'included' }),
      ]));
      expect(result.memoryShown?.filter(({ source }) => source === 'memory') ?? []).toEqual([
        { source: 'memory', id: user.id, text: MIND_USER, speaker: 'user', at: user.createdAt },
      ]);
    });

    it('omits rewritten entries and duplicated items from the receipt', async () => {
      const changedMind = 'My canary is named FINCH-8.';
      const changedProvider = 'My^canary^practices^scales^after^lunch.';
      const input = PROVIDER.replace(/ /g, '^');
      const agent = await open({ capture: DETAIL }, {
        onBeforeGeneration: async ({ messages }) => ({
          messages: messages.map((message) => {
            const { content } = message;
            if (typeof content !== 'string') return message;
            if (content.startsWith('<memory_recall>')) {
              const block = readProviderBlock(content);
              block.items = block.items.flatMap((item) =>
                item.text === input ? [{ ...item, text: changedProvider }] : [item, item],
              );
              return { ...message, content: `<memory_recall>${JSON.stringify(block)}</memory_recall>` };
            }
            if (content.includes('## How To Use Your Memories')) {
              return { ...message, content: content.replace(MIND_USER, changedMind) };
            }
            return message;
          }),
        }),
      });
      const { provider } = await fileMemories(agent);
      const other = await rememberForReader(agent, OTHER_PROVIDER);
      const { traces } = await agent.exportUserMemory!(USER);
      const user = traces.find(({ text }) => text === MIND_USER)!;

      const result = await agent.session('reader', { userId: USER }).send(QUESTION);
      const sent = blocksOfLastCall();
      expect(sent.mind).toContain(changedMind);
      expect(sent.mind).not.toContain(MIND_USER);
      const sentItems = readProviderBlock(sent.provider).items;
      expect(sentItems.some(({ text }) => text === changedProvider)).toBe(true);
      expect(sentItems.filter(({ text }) => text === OTHER_PROVIDER.replace(/ /g, '^'))).toHaveLength(2);
      const shown = result.memoryShown ?? [];
      expect(shown.filter(({ source }) => source === 'provider')).toEqual([]);
      expect(shown.map(({ id }) => id)).not.toContain(provider.id);
      expect(shown.map(({ id }) => id)).not.toContain(other.id);
      expect(shown.map(({ id }) => id)).not.toContain(user.id);
    });

    it('lists what the serving fallback hop was sent when a hook leaves the provider block out there', async () => {
      const fallbackKey = `k-recall-detail-fallback-${++serial}`;
      const fallback = script('anthropic', fallbackKey, { whole: true, replies: [reply.text(REPLY)] });
      vi.stubEnv('ANTHROPIC_API_KEY', fallbackKey);
      const agent = await open({ capture: DETAIL }, {
        fallbackProviders: [{ provider: 'anthropic', model: 'claude-x' }],
        onBeforeGeneration: async (context) =>
          context.provider === 'anthropic'
            ? { ...context, messages: context.messages.filter(({ content }) => !(typeof content === 'string' && content.startsWith('<memory_recall>'))) }
            : undefined,
      });
      // The reader's first hop fails before any output; the fallback serves the turn.
      served.replies.splice(1, 1, Object.assign(new Error('overloaded'), { httpStatus: 529 }));
      await fileMemories(agent);
      const result = await agent.session('reader', { userId: USER }).send(QUESTION);

      expect(result.provider).toBe('anthropic');
      expect(blocksOfLastCall(served).provider).toContain(PROVIDER.replace(/ /g, '^'));
      const sent = blocksOfLastCall(fallback);
      expect(sent.provider).toBe('');
      expect(sent.mind).toContain(MIND_USER);
      const includedIds = result.memoryRecall?.candidates.filter(({ outcome }) => outcome === 'included').map(({ id }) => id) ?? [];
      expect(includedIds.length).toBeGreaterThan(0);
      expect(result.memoryShown?.map(({ source, id }) => ({ source, id }))).toEqual(includedIds.map((id) => ({ source: 'memory', id })));
      for (const item of result.memoryShown ?? []) expect(sent.mind).toContain(item.text);
    });

    it('keeps what both blocks showed in the stream result when the reply breaks after it starts', async () => {
      const agent = await open({ capture: DETAIL });
      served.replies.splice(1, 1, reply.breakAfterFirstDelta('I re'));
      await fileMemories(agent);
      const stream = agent.session('reader', { userId: USER }).stream(QUESTION);
      const parts = [];
      for await (const part of stream.fullStream) parts.push(part);

      expect(parts.at(-1)?.type).toBe('error');
      expect(await stream.text).toBe('I re');
      const blocks = blocksOfLastCall();
      expect(blocks.mind).toContain(MIND_USER);
      expect(blocks.provider).toContain(PROVIDER.replace(/ /g, '^'));
      const includedIds = (await stream.memoryRecall)?.candidates.filter(({ outcome }) => outcome === 'included').map(({ id }) => id) ?? [];
      expect(includedIds.length).toBeGreaterThan(0);
      const shown = await stream.memoryShown;
      expect(shown?.filter(({ source }) => source === 'memory').map(({ id }) => id)).toEqual(includedIds);
      expect(shown?.filter(({ source }) => source === 'provider').map(({ text }) => text).sort()).toEqual([PAGE, PROVIDER].sort());
      expectNoMemoryText(parts);
    });

    it('leaves recall detail absent when the turn sends no memory block', async () => {
      const agent = await open({ capture: DETAIL, budget: { totalTokens: 0 } });
      const result = await agent.session('empty', { userId: USER }).send(QUESTION);
      expect(blocksOfLastCall()).toEqual({ mind: '', provider: '' });
      expect(result.memoryShown).toBeUndefined();
      const stream = agent.session('empty-stream', { userId: USER }).stream(QUESTION);
      expect(await stream.memoryShown).toEqual([]);
    });
  });
});

describe('recall detail on gmi()', () => {
  it('accepts the mode with cognitive memory on', async () => {
    const agent = gmi({ ...route(), memory: { embedding: { provider: 'openai' }, recall: { capture: DETAIL } } });
    opened.push(agent);
    const result = await agent.session('empty').send(QUESTION);
    expect(result.text).toBe(MIND_ASSISTANT);
  });

  it('refuses the mode with cognitive memory off', () => {
    expect(() => gmi({ ...route(), memory: { recall: { capture: DETAIL } }, cognition: { memory: false } })).toThrow(
      expect.objectContaining({ option: 'capture', reason: 'unsupported_runtime' }),
    );
  });
});
