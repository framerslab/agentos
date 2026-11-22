/**
 * @file CognitiveMemoryBridge.soul.integration.test.ts
 * A turn of a souled agent's mind files and recalls through the view of the soul's rules the turn carries, on a real
 * store: a `Memory` facade opened with `Memory.createSqlite`, a cognitive memory manager built by
 * `createAgentCognitiveMemory` on the facade's own Brain with `rows: 'mind'` and `hydration: 'scopes'`, the real
 * bridge, and the real GMI over a scripted provider. The view is the test's own object, except in the last case, where
 * it is the one a real `souledAgent()` on the GMI runtime hands its turn (only the OpenAI provider class is stubbed).
 *
 * - A turn reads the person's key alone, learning layer or not.
 * - A turn files through the view: what the view hands its writer is what is stored and embedded, under the person's
 *   key, marked as the mind's, and nothing goes under an agent-wide scope.
 * - The turn does not wait for its write: the sync resolves with a record that settles once the view's filings do.
 * - The view names the emotional stamp of what is filed: neutral, or the mind's mood.
 * - On the mind's manager, a filing with no view files nothing and says so in the reasoning trace; on any other manager
 *   the view is not used and the bridge files as before.
 * - The observer hears what was kept, never what was not.
 * - A metaprompt's imprint is filed through the last turn's view, as the assistant's; with no view it is not filed.
 * - A souled agent's view runs each filing through its gate: the screen's text is what is stored, and a person
 *   forgotten since files nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('../../../api/__tests__/helpers/stubProviders')).stubProviderClass('openai') }));
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pino from 'pino';
import { Memory } from '../../memory/io/facade/Memory.js';
import { brainOf } from '../../memory/io/facade/handedBrain.js';
import type { Brain } from '../../memory/retrieval/store/Brain.js';
import { conversationScopeKey } from '../../memory/retrieval/store/conversationScopeKey.js';
import { createAgentCognitiveMemory, type AgentCognitiveMemory } from '../../../api/runtime/agentCognitiveMemory.js';
import type { MemoryTrace } from '../../memory/core/types.js';
import type { MemoryWriteEntry, MemoryWriteRecord } from '../../../api/runtime/memoryWriteRecord.js';
import { CognitiveMemoryBridge } from '../CognitiveMemoryBridge';
import { GMI } from '../GMI';
import { GMIInteractionType, GMIMood, type GMITurnInput } from '../IGMI';
import { createScriptedGmi, runTurn, scriptedProvider, textReply, textTurn } from './helpers/scriptedGmi';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../../../api/souledAgent';
import { reply, script } from '../../../api/__tests__/helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../../core/safety/LLMProviderHealthRegistry';

const AGENT = 'aria-1';
const DIM = 8;
const keyOf = (id: string): string => conversationScopeKey(AGENT, { kind: 'user', id });
const NEUTRAL_PAD = { valence: 0, arousal: 0, dominance: 0 };
const FRUSTRATED_PAD = { valence: -0.65, arousal: 0.6, dominance: 0.2 };

/** A bag-of-words vector of `DIM` numbers: texts that share a word point the same way. */
function wordVector(text: string): number[] {
  const vector = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    vector[h % DIM] += 1;
  }
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm + 0.001);
}

/** An embedding manager that records every text it is sent. */
function embedder() {
  const sent: string[] = [];
  return {
    sent,
    manager: {
      initialize: async () => undefined,
      generateEmbeddings: async (request: { texts: string | string[] }) => {
        const texts = Array.isArray(request.texts) ? request.texts : [request.texts];
        sent.push(...texts);
        return { embeddings: texts.map(wordVector), modelId: 'words', providerId: 'test', usage: { totalTokens: 0 } };
      },
      getEmbeddingModelInfo: async () => ({ modelId: 'words', providerId: 'test', dimension: DIM }),
      getEmbeddingDimension: async () => DIM,
      checkHealth: async () => ({ isHealthy: true }),
      shutdown: async () => undefined,
    },
  };
}

const facades: Memory[] = [];
const dirs: string[] = [];
const closers: Array<() => Promise<void> | void> = [];
const opened: SouledAgent[] = [];

beforeEach(() => {
  globalLLMProviderHealth.reset();
  setLogger(pino({ level: 'debug', base: undefined }, { write() {} }));
});

afterEach(async () => {
  while (closers.length) await closers.pop()!();
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  while (facades.length) await facades.pop()!.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoggerFactory();
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A facade on a fresh SQLite file. */
async function openBrain(): Promise<Brain> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-soul-'));
  dirs.push(dir);
  const memory = await Memory.createSqlite(path.join(dir, 'brain.sqlite'), {
    graph: false,
    selfImprove: false,
    decay: false,
    embed: async (text: string) => wordVector(text),
    embeddings: { provider: 'test', dimensions: DIM },
  });
  facades.push(memory);
  return brainOf(memory);
}

/** A manager on `brain`: the mind's rows alone (`rows: 'mind'`), unless the case asks for every row. */
async function managerOn(brain: Brain, rows: 'all' | 'mind' = 'mind', embedding = embedder()): Promise<AgentCognitiveMemory & { sent: string[] }> {
  const built = await createAgentCognitiveMemory({
    persona: { id: AGENT, name: 'Aria', description: 'd', version: '1.0.0', baseSystemPrompt: 'x', personalityTraits: {} } as never,
    memory: {},
    brain,
    embeddingManager: embedding.manager as never,
    rows,
    hydration: 'scopes',
  });
  closers.push(() => built.close());
  return Object.assign(built, { sent: embedding.sent });
}

/** A bridge over `manager`, for user `userId`, in `mood`; it collects its reasoning-trace entries. */
function bridgeOver(manager: AgentCognitiveMemory['manager'], mood: GMIMood = GMIMood.NEUTRAL, userId = 'alice') {
  const entries: Array<{ type: string; message: string; details?: Record<string, unknown> }> = [];
  const bridge = new CognitiveMemoryBridge(
    manager,
    () => mood,
    () => ({ userId }) as never,
    () => AGENT,
    () => 'gmi-1',
    (type, message, details) => entries.push({ type, message, ...(details ? { details } : {}) }),
  );
  return { bridge, entries };
}

type Writer = (filing: unknown) => Promise<MemoryTrace>;
type Undo = (trace: MemoryTrace) => Promise<void>;

/**
 * A view of the soul's rules for user `id`: its `file` hands the writer `transform(content)` with the given stamp and
 * answers `written`, unless `skip` names a role it answers `skipped: 'screened'` for without writing. It records each
 * call, and waits for `hold` first when one is given.
 */
function seamFor(
  id: string,
  options: {
    transform?: (text: string) => string;
    stamp?: 'neutral' | 'mood';
    hold?: Promise<void>;
    skip?: 'user' | 'assistant';
  } = {},
) {
  const calls: Array<{ role: string; content: string; done: Promise<MemoryWriteEntry> }> = [];
  const seam = {
    scope: { scope: 'conversation' as const, scopeId: keyOf(id) },
    begin: async () => ({ recall: true, reconsolidation: true, sentiment: true }),
    file: (role: 'user' | 'assistant', content: string, write: Writer, _undo: Undo): Promise<MemoryWriteEntry> => {
      const done = (async (): Promise<MemoryWriteEntry> => {
        if (options.hold) await options.hold;
        if (options.skip === role) return { role, outcome: 'skipped', reason: 'screened' };
        const trace = await write({
          text: (options.transform ?? ((text: string) => text))(content),
          stamp: options.stamp ?? 'neutral',
          filing: { filedBy: 'mind', speaker: role, subject: { kind: 'user', id } },
          turnUserId: id,
        });
        return { role, outcome: 'written', traceId: trace.id };
      })();
      calls.push({ role, content, done });
      return done;
    },
  };
  return { seam, calls };
}

/** The bridge's turn sync, with the view as its fourth argument. */
const syncWith = (bridge: CognitiveMemoryBridge, turnInput: GMITurnInput, reply: string, soul: unknown): Promise<unknown> =>
  (bridge.syncForTurn as (...args: unknown[]) => Promise<unknown>).call(bridge, turnInput, reply, undefined, soul);

/** The record a sync resolved with, read through its `write`. */
function writeOf(synced: unknown): Promise<MemoryWriteRecord> {
  expect(synced).toMatchObject({ write: expect.any(Promise) });
  return (synced as { write: Promise<MemoryWriteRecord> }).write;
}

const userTurn = (text: string): GMITurnInput => ({
  interactionId: 'i-1',
  userId: 'alice',
  sessionId: 's-1',
  type: GMIInteractionType.TEXT,
  content: text,
});

interface Row {
  id: string;
  scope: string;
  scope_id: string;
  content: string;
  metadata: string;
}
const rowsOf = (brain: Brain): Promise<Row[]> =>
  brain.all<Row>('SELECT id, scope, scope_id, content, metadata FROM memory_traces WHERE brain_id = ? ORDER BY created_at', [brain.brainId]);

const encodeUser = { type: 'episodic' as const, sourceType: 'user_statement' as const, role: 'user' as const };

describe('a turn through the soul of its agent', () => {
  it('a turn reads one scope', async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { bridge } = bridgeOver(manager);
    const { seam } = seamFor('alice');
    expect(bridge.buildRetrievalScopes({ sessionId: 's-1', conversationId: 'c-1', organizationId: 'o-1', soul: seam } as never)).toEqual([seam.scope]);
    const learning = {
      scopes: { learner: 'bound', mode: 'on', userScopeId: 'alice', personaScopeId: `alice::${AGENT}`, namespace: '' },
    };
    expect(bridge.buildRetrievalScopes({ sessionId: 's-1', learning, soul: seam } as never)).toEqual([seam.scope]);
  });

  it('a turn files through the seam', async () => {
    const brain = await openBrain();
    const { manager, sent } = await managerOn(brain);
    const { bridge } = bridgeOver(manager);
    const { seam, calls } = seamFor('alice', { transform: (text) => text.toUpperCase() });
    await bridge.encode('hello', { ...encodeUser, soul: seam } as never);
    expect(calls.map((call) => [call.role, call.content])).toEqual([['user', 'hello']]);

    const rows = await rowsOf(brain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'conversation', scope_id: keyOf('alice'), content: 'HELLO' });
    expect(JSON.parse(rows[0].metadata)).toMatchObject({
      filedBy: 'mind',
      speaker: 'user',
      subject: { kind: 'user', id: 'alice' },
      turnUserId: 'alice',
    });
    // The embedding model was sent the view's text, never the turn's own.
    expect(sent).toContain('HELLO');
    expect(sent.some((text) => text.includes('hello'))).toBe(false);
    // Nothing went under an agent-wide scope.
    expect(rows.filter((row) => ['user', 'thread', 'persona', 'organization'].includes(row.scope))).toEqual([]);
  });

  it('the turn does not wait for its write', async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { bridge } = bridgeOver(manager);
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { seam, calls } = seamFor('alice', { hold });

    const synced = await syncWith(bridge, userTurn('I keep bees.'), 'Bees are wonderful.', seam);
    const write = writeOf(synced);
    let settled = false;
    void write.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(settled).toBe(false);
    // Both filings were started, the person's message first.
    expect(calls.map((call) => call.role)).toEqual(['user', 'assistant']);
    expect(await rowsOf(brain)).toEqual([]);

    release();
    const record = await write;
    expect(record.entries).toEqual([
      { role: 'user', outcome: 'written', traceId: expect.any(String) },
      { role: 'assistant', outcome: 'written', traceId: expect.any(String) },
    ]);
    const ids = (await rowsOf(brain)).map((row) => row.id).sort();
    expect(ids).toEqual(record.entries.map((entry) => (entry as { traceId: string }).traceId).sort());
  });

  it("the stamp is the seam's", async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { bridge } = bridgeOver(manager, GMIMood.FRUSTRATED);
    const encode = vi.spyOn(manager, 'encode');

    await bridge.encode('My tea went cold.', { ...encodeUser, soul: seamFor('alice', { stamp: 'neutral' }).seam } as never);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(encode.mock.calls[0][1]).toEqual(NEUTRAL_PAD);
    expect(encode.mock.calls[0][2]).toBe(GMIMood.NEUTRAL);
    expect(encode.mock.calls[0][3]).toMatchObject({ scope: 'conversation', scopeId: keyOf('alice'), turnUserId: 'alice' });

    await bridge.encode('The kettle broke too.', { ...encodeUser, soul: seamFor('alice', { stamp: 'mood' }).seam } as never);
    expect(encode).toHaveBeenCalledTimes(2);
    expect(encode.mock.calls[1][1]).toEqual(FRUSTRATED_PAD);
    expect(encode.mock.calls[1][2]).toBe(GMIMood.FRUSTRATED);
  });

  it("no seam, no filing on the mind's manager", async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { bridge, entries } = bridgeOver(manager);
    const encode = vi.spyOn(manager, 'encode');
    await bridge.encode('hello', encodeUser);
    expect(encode).not.toHaveBeenCalled();
    expect(await rowsOf(brain)).toEqual([]);
    expect(entries.filter((entry) => entry.type === 'WARNING')).toHaveLength(1);
  });

  it('a seam on another manager is not used', async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain, 'all');
    const { bridge } = bridgeOver(manager);
    const { seam, calls } = seamFor('alice', { transform: (text) => text.toUpperCase() });
    expect(bridge.buildRetrievalScopes({ sessionId: 's-1', soul: seam } as never)).toContainEqual({ scope: 'user', scopeId: 'alice' });

    await bridge.encode('hello', { ...encodeUser, soul: seam } as never);
    expect(calls).toEqual([]);
    const rows = await rowsOf(brain);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: 'user', scope_id: 'alice', content: 'hello' });
    expect(JSON.parse(rows[0].metadata).filedBy).toBeUndefined();
  });

  it('the observer hears only what was kept', async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { bridge } = bridgeOver(manager);
    const observe = vi.spyOn(manager, 'observe').mockResolvedValue(null);
    const { seam } = seamFor('alice', { transform: (text) => text.toUpperCase(), skip: 'assistant' });
    const record = await writeOf(await syncWith(bridge, userTurn('hello'), 'hi there', seam));
    expect(record.entries).toEqual([
      { role: 'user', outcome: 'written', traceId: expect.any(String) },
      { role: 'assistant', outcome: 'skipped', reason: 'screened' },
    ]);
    expect(observe.mock.calls.map((call) => [call[0], call[1]])).toEqual([['user', 'HELLO']]);
  });
});

describe("a GMI on the mind's manager", () => {
  it("an imprint is filed through the last turn's seam as the assistant's; with no seam it is not filed", async () => {
    const brain = await openBrain();
    const { manager } = await managerOn(brain);
    const { provider } = scriptedProvider([textReply('Tea it is.'), textReply('Noted.')]);
    const { gmi } = await createScriptedGmi({ provider, config: { cognitiveMemory: manager } });
    const { seam, calls } = seamFor('alice');

    const { output } = await runTurn(gmi, textTurn('t1', 'I like green tea.', { soulMemory: seam } as never));
    const record = await (output as unknown as { memoryWrite: Promise<MemoryWriteRecord> }).memoryWrite;
    expect(record.entries.map((entry) => [entry.role, entry.outcome])).toEqual([
      ['user', 'written'],
      ['assistant', 'written'],
    ]);

    // The executor's imprint callback, as a metaprompt that leaves an imprint calls it.
    const imprint = (gmi as unknown as { metapromptExecutor: { config: { onMemoryImprint(content: string, tags: string[]): Promise<void> } } })
      .metapromptExecutor.config.onMemoryImprint;
    await imprint('The user prefers green tea.', ['imprint']);
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(calls[2]).toMatchObject({ role: 'assistant', content: 'The user prefers green tea.' });
    expect(await calls[2].done).toMatchObject({ role: 'assistant', outcome: 'written' });
    const imprinted = (await rowsOf(brain)).find((row) => row.content === 'The user prefers green tea.');
    expect(imprinted).toMatchObject({ scope: 'conversation', scope_id: keyOf('alice') });
    expect(JSON.parse(imprinted!.metadata)).toMatchObject({ filedBy: 'mind', speaker: 'assistant' });

    // A turn with no seam: the next imprint is not filed.
    await runTurn(gmi, textTurn('t2', 'Anything else?'));
    await imprint('The user drinks it hot.', ['imprint']);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(calls).toHaveLength(3);
    expect((await rowsOf(brain)).some((row) => row.content === 'The user drinks it hot.')).toBe(false);
  });
});

describe("a souled agent's view of a turn", () => {
  it('files each side through its gate: the screen decides what is kept, and a person forgotten since files nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-soul-agent-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'SOUL.md'), `---\nname: Aria\nagentId: ${AGENT}\n---\nYou are Aria.`);
    const apiKey = `k-bridge-soul-${Date.now()}`;
    script('openai', apiKey, { whole: true, replies: Array.from({ length: 6 }, (_, i) => reply.text(`Noted ${i}.`)) } as never);
    const a = await souledAgent({
      runtime: 'gmi',
      provider: 'openai',
      model: 'stub-model',
      apiKey,
      fallbackProviders: [],
      soul: dir,
      retention: { traces: 'until-deletion' },
      tombstoneKey: 'k-bridge-soul-tombstones',
      screen: async (text: string) => text.toUpperCase(),
    } as unknown as SouledAgentOptions);
    opened.push(a);

    // The view the agent hands its turn.
    const seams: unknown[] = [];
    const runTurnStream = GMI.prototype.processTurnStream;
    vi.spyOn(GMI.prototype, 'processTurnStream').mockImplementation(function (this: GMI, turnInput: GMITurnInput) {
      if (turnInput.metadata?.soulMemory) seams.push(turnInput.metadata.soulMemory);
      return runTurnStream.call(this, turnInput);
    });
    await a.session('s1', { userId: 'alice' }).send('My cat is Tom.');
    expect(seams).toHaveLength(1);
    const seam = seams[0] as { scope?: { scope: string; scopeId: string } };
    expect(seam.scope).toEqual({ scope: 'conversation', scopeId: keyOf('alice') });

    // The mind's manager on the agent's own store.
    const brain = brainOf(a.memory as unknown as Memory);
    const { manager, sent } = await managerOn(brain);
    const { bridge } = bridgeOver(manager);
    const record = await writeOf(await syncWith(bridge, userTurn('I live in Oslo.'), 'Oslo is lovely.', seam));
    expect(record.entries).toEqual([
      { role: 'user', outcome: 'written', traceId: expect.any(String) },
      { role: 'assistant', outcome: 'written', traceId: expect.any(String) },
    ]);
    const filed = (await rowsOf(brain)).filter((row) => JSON.parse(row.metadata).filedBy === 'mind');
    expect(filed.map((row) => [row.scope_id, row.content])).toEqual([
      [keyOf('alice'), 'I LIVE IN OSLO.'],
      [keyOf('alice'), 'OSLO IS LOVELY.'],
    ]);
    expect(filed.map((row) => JSON.parse(row.metadata))).toEqual([
      expect.objectContaining({ filedBy: 'mind', speaker: 'user', subject: { kind: 'user', id: 'alice' }, turnUserId: 'alice' }),
      expect.objectContaining({ filedBy: 'mind', speaker: 'assistant', subject: { kind: 'user', id: 'alice' }, turnUserId: 'alice' }),
    ]);
    expect(sent.some((text) => text.includes('I live in Oslo.') || text.includes('Oslo is lovely.'))).toBe(false);

    await a.forgetUser!('alice');
    const after = await writeOf(await syncWith(bridge, userTurn('I moved to Bergen.'), 'Bergen is rainy.', seam));
    expect(after.entries).toEqual([
      { role: 'user', outcome: 'skipped', reason: 'forgotten' },
      { role: 'assistant', outcome: 'skipped', reason: 'forgotten' },
    ]);
    expect((await rowsOf(brain)).some((row) => /BERGEN/.test(row.content))).toBe(false);
  });
});
