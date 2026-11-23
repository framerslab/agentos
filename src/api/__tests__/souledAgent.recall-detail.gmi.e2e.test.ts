/** Recall detail through the real soul, GMI, cognitive memory manager and store. Only the model provider is stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import type { MemoryRecallConfig } from '../../cognition/memory/core/config';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import { gmi } from '../gmi';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import type { MemoryShownItem } from '../index';
import { reply, script, type ProviderScript } from './helpers/stubProviders';

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({
  OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai'),
}));

const RUNTIME = 'gmi' as const;
const AGENT = 'recall-detail';
const USER = 'reader';
const POSTGRES_URL = process.env.AGENTOS_TEST_POSTGRES_URL;
const QUESTION = 'What do you remember about my canary?';
const MIND_USER = 'My canary is named LARK-7.';
const MIND_ASSISTANT = 'A canary named LARK-7, noted.';
const PROVIDER = 'My canary practices scales at dawn.';
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

async function open(recall?: MemoryRecallConfig, store: Pick<SouledAgentOptions, 'soulStore' | 'tombstoneCopy'> = {}) {
  const agent = await souledAgent({
    ...route(),
    runtime: RUNTIME,
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
  const provider = await agent.memory!.remember(PROVIDER, {
    type: 'episodic',
    scope: 'conversation',
    scopeId: conversationScopeKey(AGENT, { kind: 'user', id: USER }),
    metadata: { speaker: 'user' },
  });
  const page = await agent.memory!.remember(PAGE, {
    type: 'semantic',
    scope: 'conversation',
    scopeId: conversationScopeKey(AGENT, { kind: 'operator' }),
    tags: ['wiki', `page:${PAGE_ID}`],
  });
  return { provider, page };
}

function blocksOfLastCall() {
  const parts = served.seen.at(-1)!.messages.flatMap(({ content }) =>
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
  expect(blocks.provider).not.toContain(provider.id);
  expect(blocks.provider).not.toContain(page.id);
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

  it('leaves recall detail absent when the turn sends no memory block', async () => {
    const agent = await open({ capture: DETAIL, budget: { totalTokens: 0 } });
    const result = await agent.session('empty', { userId: USER }).send(QUESTION);
    expect(blocksOfLastCall()).toEqual({ mind: '', provider: '' });
    expect(result.memoryShown).toBeUndefined();
    const stream = agent.session('empty-stream', { userId: USER }).stream(QUESTION);
    expect(await stream.memoryShown).toEqual([]);
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
