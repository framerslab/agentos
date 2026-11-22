/**
 * `memoryPolicy`, `screen` and `sharedMemory` on a souled agent of the GMI runtime with cognitive memory on, end to end
 * over the real souledAgent(), gmi(), GMI, cognitive memory manager, Memory store and Brain; only the OpenAI provider
 * class is stubbed (helpers/stubProviders.ts), at its module boundary, and it embeds with a deterministic word hash.
 *
 * - An account the policy answers `{ longTerm: 'off' }` for files nothing and recalls nothing of the mind, no text of
 *   its turn is sent to be embedded, and what is stored stays as it is.
 * - `'raw'` files and recalls and compiles no page; `'compiled'` compiles.
 * - The screen's answer is the text filed and embedded for a filing; a screen that answers null files and embeds
 *   nothing.
 * - Under `sharedMemory` two anonymous sessions share one person's memory, and a one-shot call recalls what was said
 *   on both sides.
 * - A policy hook that throws or does not answer in time files nothing that turn and recalls nothing of the mind; the
 *   next turn asks again, and the hook is asked once a turn.
 * - An answer given to one session of a person holds in that person's other open session from its next turn.
 * - An input guard's sanitised text is the one the mind's recall sends to be embedded.
 * - Each write the rules refuse says why in one line, and a write that lands after a tombstone is taken back.
 * - Where the soul gives no store (an inline soul, an optional soul that does not load), the hooks stay refused beside
 *   cognitive memory, and nothing is opened.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import pino from 'pino';
import { souledAgent, type SouledAgent, type SouledAgentOptions } from '../souledAgent';
import { brainOf } from '../../cognition/memory/io/facade/handedBrain';
import type { Brain } from '../../cognition/memory/retrieval/store/Brain';
import { CognitiveMemoryManager } from '../../cognition/memory/CognitiveMemoryManager';
import { conversationScopeKey } from '../../cognition/memory/retrieval/store/conversationScopeKey';
import { SentimentTracker } from '../../cognition/substrate/SentimentTracker';
import { GuardrailAction, type GuardrailContext, type IGuardrailService } from '../../safety/guardrails/IGuardrailService';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { resetLoggerFactory, setLogger } from '../../core/logging/loggerFactory';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { MemoryWriteRecord } from '../runtime/memoryWriteRecord';

/** The runtime every case runs on. */
const RUNTIME = 'gmi' as const;
/** Cognitive memory on, embedding through OpenAI, with no mechanism that rewrites a stored row. */
const COGNITIVE = { cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false } };

/** Starts the mind's memory block: the assembler's preamble. */
const MIND_BLOCK = '## How To Use Your Memories';

let n = 0;
let dir: string;
const opened: SouledAgent[] = [];
/** Every line the library logged in the case, parsed. */
let events: Array<Record<string, unknown>>;
/** The embedding provider's script: every text the mind sent to be embedded. */
let embeddings: ProviderScript;
beforeEach(() => {
  globalLLMProviderHealth.reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'souled-joined-hooks-e2e-'));
  fs.writeFileSync(path.join(dir, 'SOUL.md'), '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.');
  events = [];
  setLogger(
    pino(
      { level: 'debug', base: undefined },
      {
        write(line: string) {
          events.push(JSON.parse(line));
        },
      },
    ),
  );
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const embeddingKey = `k-souled-joined-hooks-embed-${++n}`;
  embeddings = script('openai', embeddingKey, { replies: [] });
  vi.stubEnv('OPENAI_API_KEY', embeddingKey);
});
afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetLoggerFactory();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The logged lines of one event. */
const lines = (event: string) => events.filter((line) => line.event === event);

const keyOf = (id: string) => conversationScopeKey('aria-1', { kind: 'user', id });

let replyNo = 0;
/** Replies to spare, each with words of its own: the store keeps one trace for a text a person's memory already holds. */
const spare = (count = 16): ProviderScript['replies'] => Array.from({ length: count }, () => reply.text(`Noted ${++replyNo}.`));

/** The script the provider of the agent opened last plays: every request it served is in `seen`. */
let served: ProviderScript;

/**
 * A souled agent on the GMI runtime with cognitive memory on, on the stubbed provider, which answers with `replies` in
 * order; `retention` and `tombstoneKey` are set so two people may share the store.
 */
async function open(extra: Record<string, unknown> = {}, replies: ProviderScript['replies'] = spare()): Promise<SouledAgent> {
  const apiKey = `k-souled-joined-hooks-${++n}`;
  served = script('openai', apiKey, { whole: true, replies });
  const a = await souledAgent({
    runtime: RUNTIME,
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    soul: dir,
    retention: { traces: 'until-deletion' },
    tombstoneKey: 'k-souled-joined-hooks-tombstones',
    ...COGNITIVE,
    ...extra,
  } as unknown as SouledAgentOptions);
  opened.push(a);
  return a;
}

type Row = { id: string; scope: string; scope_id: string; content: string; metadata: string; emotions: string };
/** Every live trace of the agent's store under one key, oldest first; the person's side first within a millisecond. */
async function rowsUnder(brain: Brain, key: string): Promise<Row[]> {
  const rows = await brain.all<Row & { created_at: number | string }>(
    "SELECT id, scope, scope_id, content, metadata, emotions, created_at FROM memory_traces WHERE brain_id = ? AND deleted = 0 AND scope = 'conversation' AND scope_id = ? ORDER BY created_at, id",
    [brain.brainId, key],
  );
  const speakerRank = (row: Row): number => (metaOf(row).speaker === 'user' ? 0 : 1);
  return rows
    .sort((a, b) => Number(a.created_at) - Number(b.created_at) || speakerRank(a) - speakerRank(b))
    .map(({ created_at: _createdAt, ...row }) => row);
}
/** A row's metadata, read as the store wrote it. */
const metaOf = (row: Row): Record<string, unknown> => JSON.parse(row.metadata || '{}') as Record<string, unknown>;
const storeBrain = (a: SouledAgent): Brain => brainOf(a.memory!);

/** The promise of a turn's write record, as the turn's result carries it. */
function writeOf(result: { memoryWrite?: Promise<MemoryWriteRecord> }): Promise<MemoryWriteRecord> {
  expect(result.memoryWrite).toBeInstanceOf(Promise);
  return result.memoryWrite!;
}
/** The ids a record says were written, in its order. */
const writtenIds = (record: MemoryWriteRecord): string[] =>
  record.entries.flatMap((entry) => (entry.outcome === 'written' ? [entry.traceId] : []));
/** A record whose two sides were both skipped, for one reason. */
const bothSkipped = (reason: string): MemoryWriteRecord =>
  ({
    entries: [
      { role: 'user', outcome: 'skipped', reason },
      { role: 'assistant', outcome: 'skipped', reason },
    ],
  }) as unknown as MemoryWriteRecord;

type ModelCall = ProviderScript['seen'][number];
/** The texts of a message: its one string, or the text of each of its text parts. */
function textPartsOf(message: ModelCall['messages'][number]): string[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
}
/** The mind's memory block of one model call: the text part that carries the assembler's preamble; '' when absent. */
const mindBlockOf = (call: ModelCall): string => call.messages.flatMap(textPartsOf).find((part) => part.includes(MIND_BLOCK)) ?? '';
/** The soul's provider block of one model call, its texts' spaces restored: the user-role message that opens with `<memory_recall>`; '' when absent. */
const providerBlockOf = (call: ModelCall): string => {
  const block = call.messages.find((m) => m.role === 'user' && typeof m.content === 'string' && m.content.startsWith('<memory_recall>'));
  // The block writes `^` in place of each run of whitespace in a text: read back as one space.
  return block ? (block.content as unknown as string).replace(/\^/g, ' ') : '';
};
/** The last model call the agent's provider served. */
const lastCall = (): ModelCall => served.seen[served.seen.length - 1];
/** The model calls that merged a person's traces into their wiki page. */
const merges = (): ModelCall[] => served.seen.filter((call) => JSON.stringify(call.messages).includes('You maintain a knowledge wiki page'));
/** Whether any text sent to be embedded holds `words`. */
const embeddedWith = (words: string): boolean => embeddings.embedded.some((text) => text.includes(words));

/** A gate a held reply waits on, and its opener. */
function gated(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

/** One of the operator's own pages, under `memory/`: what a turn that recalls nothing of the person still reads. */
function operatorPage(): void {
  fs.mkdirSync(path.join(dir, 'memory', 'concepts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'memory', 'concepts', 'ops.md'), '---\nid: concepts/ops\ntype: concept\nsummary: Opening hours\n---\nZorblat opens at nine.\n');
}

describe("an account's policy on the mind's path", () => {
  it("an account the policy keeps no memory of files nothing, sends nothing to be embedded, and leaves what is stored", async () => {
    let answer: Record<string, unknown> = { longTerm: 'compiled' };
    const a = await open({ memoryPolicy: () => answer }, [reply.text('A canary, lovely.'), reply.text('Nothing kept.'), ...spare()]);
    const brain = storeBrain(a);
    await writeOf(await a.session('s0', { userId: 'alice' }).send('My canary is named LARK-7.'));
    const stored = await rowsUnder(brain, keyOf('alice'));
    expect(stored.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);

    answer = { longTerm: 'off' };
    const result = await a.session('s1', { userId: 'alice' }).send('Where does my canary ZEPHYRQUILL sleep?');

    expect(await writeOf(result)).toEqual(bothSkipped('policy_off'));
    // No row is added, and none is touched: nothing recalled them.
    expect(await rowsUnder(brain, keyOf('alice'))).toEqual(stored);
    // Nothing of the turn was sent to be embedded: neither a filing nor a recall query.
    expect(embeddedWith('ZEPHYRQUILL')).toBe(false);
    expect(embeddedWith('Nothing kept')).toBe(false);
    // The mind's block is absent, and the provider's block holds nothing of hers.
    expect(mindBlockOf(lastCall())).toBe('');
    expect(providerBlockOf(lastCall())).not.toContain('LARK-7');
  });

  it("'raw' files and recalls and compiles no page; 'compiled' compiles", async () => {
    for (const longTerm of ['raw', 'compiled'] as const) {
      const a = await open({ memoryPolicy: () => ({ longTerm }) }, [reply.text('A canary, lovely.'), reply.text('It is LARK-7.'), ...spare()]);
      const key = keyOf(`alice-${longTerm}`);
      const userId = `alice-${longTerm}`;
      await writeOf(await a.session(`s1-${longTerm}`, { userId }).send('My canary is named LARK-7.'));
      const rows = await rowsUnder(storeBrain(a), key);
      expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'A canary, lovely.']);
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);

      await writeOf(await a.session(`s2-${longTerm}`, { userId }).send('What is my canary named?'));
      expect(mindBlockOf(lastCall())).toContain('LARK-7');

      const before = merges().length;
      await a.memory!.compileWiki({ scopes: [key] });
      if (longTerm === 'raw') {
        expect(merges()).toHaveLength(before);
        expect(lines('memory.compile_skipped').map((line) => line.reason)).toContain('policy_raw');
      } else {
        expect(merges()).toHaveLength(before + 1);
        expect(JSON.stringify(merges().at(-1)!.messages)).toContain('LARK-7');
      }
      opened.splice(opened.indexOf(a), 1);
      await a.close();
      events.length = 0;
    }
  });

  it.each<[string, () => unknown, Record<string, unknown>]>([
    [
      'throws',
      () => {
        throw new Error('the account service is down');
      },
      {},
    ],
    ['does not answer in time', () => new Promise(() => undefined), { memoryProviderOptions: { timeoutMs: 400 } }],
  ])('a policy hook that %s files nothing that turn and recalls nothing of the mind; the next turn asks again', async (name, failing, extra) => {
    operatorPage();
    let asked = 0;
    const memoryPolicy = (): unknown => {
      asked += 1;
      return asked === 1 ? failing() : { longTerm: 'compiled' };
    };
    const a = await open({ memoryPolicy, ...extra }, [reply.text('At nine.'), reply.text('Tea, noted.'), ...spare()]);
    const brain = storeBrain(a);
    // What she told the soul's provider before: her row, which a turn whose hook failed must not read.
    await a.memory!.remember('Alice keeps a canary named LARK-7.', { type: 'episodic', scope: 'conversation', scopeId: keyOf('alice') });
    const session = a.session('s1', { userId: 'alice' });

    const first = await session.send('When does Zorblat open, and how is my canary?');

    expect(await writeOf(first)).toEqual(bothSkipped('policy_failed'));
    expect(asked).toBe(1);
    expect(mindBlockOf(lastCall())).toBe('');
    expect(providerBlockOf(lastCall())).not.toContain('LARK-7');
    // A hook that throws leaves the turn the operator's pages; one that does not answer in time holds the provider's
    // recall for the same timeout, so the turn is sent with no recall at all.
    if (name === 'throws') expect(providerBlockOf(lastCall())).toContain('Zorblat opens at nine.');
    else expect(providerBlockOf(lastCall())).toBe('');
    expect(embeddedWith('Zorblat')).toBe(false);
    expect((await rowsUnder(brain, keyOf('alice'))).filter((row) => metaOf(row).filedBy === 'mind')).toEqual([]);

    const record = await writeOf(await session.send('I drink tea.'));
    expect(asked).toBe(2);
    const filed = (await rowsUnder(brain, keyOf('alice'))).filter((row) => metaOf(row).filedBy === 'mind');
    expect(filed.map((row) => row.content)).toEqual(['I drink tea.', 'Tea, noted.']);
    expect(writtenIds(record)).toEqual(filed.map((row) => row.id));
    expect(lines('memory.hook_failed').filter((line) => line.hook === 'memoryPolicy')).toHaveLength(1);
  });

  it("an answer that keeps no memory, given to another session of the person, holds in the first from its next turn", async () => {
    let answer: Record<string, unknown> = { longTerm: 'compiled' };
    let asked = 0;
    const a = await open(
      {
        memoryPolicy: () => {
          asked += 1;
          return answer;
        },
      },
      [reply.text('A canary, lovely.'), reply.text('Understood.'), reply.text('I cannot say.'), ...spare()],
    );
    const brain = storeBrain(a);
    const first = a.session('sA', { userId: 'alice' });
    await writeOf(await first.send('My canary is named LARK-7.'));
    const stored = await rowsUnder(brain, keyOf('alice'));
    expect(stored).toHaveLength(2);

    answer = { longTerm: 'off' };
    expect(await writeOf(await a.session('sB', { userId: 'alice' }).send('Please keep nothing of me.'))).toEqual(bothSkipped('policy_off'));
    expect(asked).toBe(2);

    const result = await first.send('Where does my canary ZEPHYRQUILL sleep?');

    // The first session's next turn reads the newest answer, with no new ask.
    expect(asked).toBe(2);
    expect(await writeOf(result)).toEqual(bothSkipped('policy_off'));
    expect(await rowsUnder(brain, keyOf('alice'))).toEqual(stored);
    expect(mindBlockOf(lastCall())).toBe('');
    expect(providerBlockOf(lastCall())).not.toContain('LARK-7');
    expect(embeddedWith('ZEPHYRQUILL')).toBe(false);
  });

  it("an objection to profiling, given to another session of the person, leaves the first's next turn unscored and its rows neutral", async () => {
    const analyze = vi.spyOn(SentimentTracker.prototype, 'analyzeTurnSentiment').mockResolvedValue(undefined);
    let answer: Record<string, unknown> = { longTerm: 'compiled' };
    const a = await open(
      {
        cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false, sentiment: true, metaprompts: false },
        memoryPolicy: () => answer,
      },
      [reply.text('A canary, lovely.'), reply.text('Understood.'), reply.text('Seeds, noted.'), ...spare()],
    );
    const brain = storeBrain(a);
    const first = a.session('sA', { userId: 'alice' });
    await writeOf(await first.send('My canary is named LARK-7 and I had a rough day.'));
    expect(analyze).toHaveBeenCalledTimes(1);

    answer = { longTerm: 'compiled', profiling: 'off' };
    await writeOf(await a.session('sB', { userId: 'alice' }).send('Please do not profile me.'));
    expect(analyze).toHaveBeenCalledTimes(1);

    const record = await writeOf(await first.send('My canary eats seeds, which made me so happy.'));

    expect(analyze).toHaveBeenCalledTimes(1);
    const rows = (await rowsUnder(brain, keyOf('alice'))).filter((row) => writtenIds(record).includes(row.id));
    expect(rows.map((row) => row.content)).toEqual(['My canary eats seeds, which made me so happy.', 'Seeds, noted.']);
    // A neutral state as the store keeps it: no valence or dominance, the middle of the arousal scale, no intensity.
    for (const row of rows) expect(JSON.parse(row.emotions)).toMatchObject({ valence: 0, arousal: 0.5, dominance: 0, intensity: 0 });
  });
});

describe("the screen on the mind's path", () => {
  it('a screen that rewrites: the row and the text sent to be embedded for the filing are the rewritten text alone', async () => {
    const { gate, release } = gated();
    const a = await open({ screen: (text: string) => text.replace(/LARK-7/g, '[name]') }, [reply.hold([], gate, reply.text('LARK-7 is a lovely name.')), ...spare()]);
    try {
      const sending = a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.');
      // The model call is open: the turn's recall has run, and nothing of it is filed yet.
      await vi.waitFor(() => expect(served.seen).toHaveLength(1), { timeout: 4_000 });
      const beforeFiling = embeddings.embedded.length;
      release();
      const record = await writeOf(await sending);

      const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
      expect(rows.map((row) => row.content)).toEqual(['My canary is named [name].', '[name] is a lovely name.']);
      expect(rows.map((row) => metaOf(row).filedBy)).toEqual(['mind', 'mind']);
      expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
      const forFiling = embeddings.embedded.slice(beforeFiling);
      expect(forFiling.some((text) => text.includes('My canary is named [name].'))).toBe(true);
      expect(forFiling.some((text) => text.includes('[name] is a lovely name.'))).toBe(true);
      expect(forFiling.some((text) => text.includes('LARK-7'))).toBe(false);
      // The model's reply, which no recall reads, never reached the embedding provider as it was written.
      expect(embeddedWith('LARK-7 is a lovely name')).toBe(false);
    } finally {
      release();
    }
  });

  it('a screen that answers null files and embeds nothing of the turn', async () => {
    const { gate, release } = gated();
    const a = await open({ screen: () => null }, [reply.hold([], gate, reply.text('LARK-7 is a lovely name.')), ...spare()]);
    try {
      const sending = a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.');
      await vi.waitFor(() => expect(served.seen).toHaveLength(1), { timeout: 4_000 });
      const beforeFiling = embeddings.embedded.length;
      release();

      expect(await writeOf(await sending)).toEqual(bothSkipped('screened'));
      expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
      expect(embeddings.embedded.slice(beforeFiling).some((text) => /LARK-7|lovely/.test(text))).toBe(false);
    } finally {
      release();
    }
  });
});

describe('sharedMemory on the mind\'s path', () => {
  it("two anonymous sessions share one person's memory, and a one-shot call recalls what was said on both sides", async () => {
    const a = await open({ sharedMemory: { as: 'me', reason: 'one-persons-machine' } }, [
      reply.text('LARK-7 is a fine name for a canary.'),
      reply.text('Your canary is LARK-7.'),
      reply.text('It is LARK-7.'),
      ...spare(),
    ]);
    const brain = storeBrain(a);

    await writeOf(await a.session('s1').send('My canary is named LARK-7.'));
    const rows = await rowsUnder(brain, keyOf('me'));
    expect(rows.map((row) => row.content)).toEqual(['My canary is named LARK-7.', 'LARK-7 is a fine name for a canary.']);
    expect(rows.map((row) => metaOf(row))).toEqual([
      expect.objectContaining({ filedBy: 'mind', speaker: 'user', subject: { kind: 'user', id: 'me' } }),
      expect.objectContaining({ filedBy: 'mind', speaker: 'assistant', subject: { kind: 'user', id: 'me' } }),
    ]);

    // Another session that names nobody: the same person, and the mind recalls what the first one filed.
    await writeOf(await a.session('s2').send('What is my canary named?'));
    expect(mindBlockOf(lastCall())).toContain('LARK-7');

    // A one-shot call runs as the same person, and the soul's provider reads both sides the mind filed.
    await a.generate('Tell me about my canary and the name.');
    const block = providerBlockOf(lastCall());
    expect(block).toContain('My canary is named LARK-7.');
    expect(block).toContain('LARK-7 is a fine name for a canary.');
  });
});

describe("an input guard and the mind's recall", () => {
  const ORIGINAL = 'my number is 555 0100';
  const SANITISED = 'my number is [removed]';
  const context: GuardrailContext = { userId: 'user-1', sessionId: 'session-1' };
  const sanitisesInput: IGuardrailService = { id: 'san', config: { canSanitize: true }, evaluateInput: async () => ({ action: GuardrailAction.SANITIZE, modifiedText: SANITISED }) };

  it('a sanitising input guard decides what recall reads: the embedding provider is sent the sanitised text and never the original', async () => {
    const a = await open({ screen: (text: string) => text, memoryPolicy: () => ({ longTerm: 'compiled' }) }, [reply.text('Noted, thanks.'), ...spare()]);

    const record = await writeOf(await a.session('s1', { userId: 'alice' }).send(ORIGINAL, { guards: { services: [sanitisesInput], context, stages: ['input'] } } as never));

    expect(embeddedWith(SANITISED)).toBe(true);
    expect(embeddedWith('555 0100')).toBe(false);
    const rows = await rowsUnder(storeBrain(a), keyOf('alice'));
    expect(rows.map((row) => row.content)).toEqual([SANITISED, 'Noted, thanks.']);
    expect(writtenIds(record)).toEqual(rows.map((row) => row.id));
  });

  it("a turn that sends an image: the recall query holds the sanitised text and none of the image's data", async () => {
    const IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAE';
    const { gate, release } = gated();
    const a = await open({ screen: (text: string) => text }, [reply.hold([], gate, reply.text('A fine picture.')), ...spare()]);
    try {
      const sending = a.session('s1', { userId: 'alice' }).send(
        [
          { type: 'text', text: ORIGINAL },
          { type: 'image_url', image_url: { url: IMAGE } },
        ],
        { guards: { services: [sanitisesInput], context, stages: ['input'] } } as never,
      );
      // The model call is open: the turn's recall has run, and nothing of it is filed yet.
      await vi.waitFor(() => expect(served.seen).toHaveLength(1), { timeout: 4_000 });
      const query = embeddings.embedded.slice();
      expect(query.some((text) => text.includes(SANITISED))).toBe(true);
      expect(query.some((text) => /base64|image_url|555 0100/.test(text))).toBe(false);
      release();
      await writeOf(await sending);
      // Neither the recall nor the filing sent the image's data to be embedded.
      expect(embeddings.embedded.some((text) => text.includes('iVBORw0KGgo'))).toBe(false);
    } finally {
      release();
    }
  });
});

describe("each refusal on the mind's path says why", () => {
  it.each<[string, Record<string, unknown>, ((a: SouledAgent) => Promise<unknown>) | undefined, string, number]>([
    ['a forgotten person', { memoryPolicy: () => ({ longTerm: 'compiled' }) }, (a) => a.forgetUser!('alice'), 'forgotten', 4],
    [
      'a policy hook that fails',
      {
        memoryPolicy: () => {
          throw new Error('the account service is down');
        },
      },
      undefined,
      'policy_failed',
      4,
    ],
    ['an account that keeps no memory, once a session', { memoryPolicy: () => ({ longTerm: 'off' }) }, undefined, 'policy_off', 1],
    ['a screen that drops the text', { screen: () => null }, undefined, 'screened', 4],
    [
      'a screen that fails',
      {
        screen: () => {
          throw new Error('the screen is down');
        },
      },
      undefined,
      'screen_failed',
      4,
    ],
  ])('%s', async (_case, hooks, before, reason, count) => {
    const a = await open(hooks, [reply.text('A canary, lovely.'), reply.text('Seeds, noted.'), ...spare()]);
    if (before) await before(a);
    const session = a.session('s1', { userId: 'alice' });

    const records = [
      await writeOf(await session.send('My canary is named LARK-7.')),
      await writeOf(await session.send('My canary eats seeds.')),
    ];

    for (const record of records) expect(record).toEqual(bothSkipped(reason));
    expect(await rowsUnder(storeBrain(a), keyOf('alice'))).toEqual([]);
    const refused = lines('memory.write_refused');
    expect(refused).toHaveLength(count);
    for (const line of refused) expect(line).toMatchObject({ reason });
    expect(JSON.stringify(refused)).not.toMatch(/LARK-7|seeds|alice/);
  });

  it('a write that lands after the person was forgotten is taken back', async () => {
    const a = await open({ memoryPolicy: () => ({ longTerm: 'compiled' }) }, [reply.text('A canary, lovely.'), ...spare()]);
    const brain = storeBrain(a);
    // Every encode of the manager, a session's view of it included, stores through this one method.
    const proto = CognitiveMemoryManager.prototype as unknown as Record<string, (...given: unknown[]) => Promise<unknown>>;
    const encodeInto = proto.encodeInto;
    const { gate, release } = gated();
    let held = 0;
    // The mind's first write is held once it has passed the gate's first reading of the tombstone.
    vi.spyOn(proto, 'encodeInto').mockImplementation(async function (this: unknown, ...args: unknown[]) {
      if (++held === 1) await gate;
      return encodeInto.apply(this, args);
    });
    try {
      const result = await a.session('s1', { userId: 'alice' }).send('My canary is named LARK-7.');
      const write = writeOf(result);
      await vi.waitFor(() => expect(held).toBe(1), { timeout: 4_000 });
      // Another process forgets her while the write runs.
      await a.memory!.markForgotten({ kind: 'user', id: 'alice' });
      release();

      expect(await write).toEqual(bothSkipped('forgotten'));
      expect(await rowsUnder(brain, keyOf('alice'))).toEqual([]);
      const refused = lines('memory.write_refused');
      expect(refused).toHaveLength(2);
      for (const line of refused) expect(line).toMatchObject({ reason: 'forgotten' });
    } finally {
      release();
    }
  });
});

describe('where the soul gives no store', () => {
  it.each<[string, Record<string, unknown>]>([
    ['an inline soul', { soul: { content: '---\nname: Aria\nagentId: aria-1\n---\nYou are Aria.' } }],
    ['an optional soul that does not load', { soul: { path: path.join(os.tmpdir(), 'no-such-soul-joined-hooks'), optional: true } }],
  ])('%s with cognitive memory on refuses memoryPolicy, and nothing is opened', async (_case, soul) => {
    const outcome = open({ ...soul, memoryPolicy: () => ({ longTerm: 'off' }) });
    await expect(outcome).rejects.toThrow(TypeError);
    await expect(outcome).rejects.toThrow(/memoryPolicy/);
    expect(fs.existsSync(path.join(dir, 'memory', '.store'))).toBe(false);
  });
});
