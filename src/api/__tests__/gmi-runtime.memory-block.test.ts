/**
 * The memory block a GMI turn sends the model, read from the request itself:
 * agent({ runtime: 'gmi' }) with cognitive memory on, its traces filed by the
 * session's own earlier sends, and the block taken from the messages the
 * provider received. The real provider manager, completion gateway, GMI,
 * prompt engine, memory bridge and cognitive memory manager run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI
 * stub embeds with a deterministic word hash, so texts that share words
 * recall each other. The memory assembler runs unchanged; a wrapper records
 * its first pass on the same input beside the block it returns and what it
 * reports of each memory line.
 *
 * Each case clears the session's history before the turn it reads, so what it
 * finds in the block reached the prompt through recall, not through history.
 *
 * agent() builds the persona from its options, which set no
 * `cognitiveMemoryConfig` but `recall` (from `memory.recall`, which these cases
 * leave unset); a case that needs one sets `personaMemory.config`,
 * and the persona agent() builds carries it, so the case reads what
 * createAgentCognitiveMemory makes of a persona's memory settings on this path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveMemoryPersonaConfig } from '../../cognition/memory/core/config';
import type { AssembledLineOutcome } from '../../cognition/memory/core/types';
vi.mock('../../core/llm/providers/implementations/OpenAIProvider', async () => ({ OpenAIProvider: (await import('./helpers/stubProviders')).stubProviderClass('openai') }));
const personaMemory = vi.hoisted(() => ({ config: undefined as CognitiveMemoryPersonaConfig | undefined }));
vi.mock('../runtime/gmiPersona', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtime/gmiPersona')>();
  return {
    ...actual,
    personaFromAgentOptions: (...args: Parameters<typeof actual.personaFromAgentOptions>) => {
      const persona = actual.personaFromAgentOptions(...args);
      return personaMemory.config ? { ...persona, cognitiveMemoryConfig: personaMemory.config } : persona;
    },
  };
});
// Each assembly also renders its first pass on the same input, so a case can check the block the model receives
// against it, and keeps what the assembly reports of each memory line. The returned block is the real one: the
// wrapper hands back what assembleMemoryContext returns.
const assemblies = vi.hoisted(
  () =>
    [] as {
      firstPass: string;
      block: string;
      lineOutcomes: AssembledLineOutcome[];
      includedMemoryIds: string[];
      /** The content of each trace the assembler was given a line for (retrieved, or led to by an association), by id. */
      contents: Map<string, string>;
      /** The ids of the retrieved traces, in the order recall ranked them. */
      rank: string[];
    }[],
);
vi.mock('../../cognition/memory/core/prompt/MemoryPromptAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/prompt/MemoryPromptAssembler')>();
  return {
    ...actual,
    assembleMemoryContext: (input: Parameters<typeof actual.assembleMemoryContext>[0]) => {
      const firstPass = actual.assembleMemoryContextFirstPass(input);
      const result = actual.assembleMemoryContext(input);
      const contents = new Map<string, string>();
      for (const trace of input.retrievedTraces ?? []) contents.set(trace.id, trace.content);
      for (const item of input.graphContext ?? []) {
        if (typeof item !== 'string' && item.traceId && !contents.has(item.traceId)) {
          contents.set(item.traceId, item.text.replace(/^\[[^\]\n]*\]\s/, ''));
        }
      }
      assemblies.push({
        firstPass: firstPass.contextText,
        block: result.contextText,
        lineOutcomes: result.lineOutcomes ?? [],
        includedMemoryIds: result.includedMemoryIds,
        contents,
        rank: (input.retrievedTraces ?? []).map((trace) => trace.id),
      });
      return result;
    },
  };
});
import { MEMORY_CUT_MARKER } from '../../cognition/memory/core/prompt/MemoryFormatters';
import { agent, type AgentOptions } from '../agent';
import { reply, script, type ProviderScript } from './helpers/stubProviders';
import { globalLLMProviderHealth } from '../../core/safety/LLMProviderHealthRegistry';
import type { ChatMessage } from '../../core/llm/providers/IProvider';

let n = 0;
const key = () => `k-memory-block-${++n}`;

const STYLE_TRAITS = {
  structured: { conscientiousness: 0.9, openness: 0.2, emotionality: 0.2 },
  narrative: { openness: 0.9, conscientiousness: 0.2, emotionality: 0.2 },
  emotional: { emotionality: 0.9, conscientiousness: 0.2, openness: 0.2 },
} as const;

/** An agent whose sessions share cognitive memory (no mechanisms) that embeds through OpenAI, with the given traits. */
const withMemory = (apiKey: string, personality: Record<string, number> = STYLE_TRAITS.structured) =>
  agent({
    runtime: 'gmi',
    provider: 'openai',
    model: 'stub-model',
    apiKey,
    fallbackProviders: [],
    personality,
    cognition: { memory: { embedding: { provider: 'openai' } }, mechanisms: false },
  } as unknown as AgentOptions);

/** Starts every memory block (the assembler's preamble). */
const PREAMBLE_HEADING = '## How To Use Your Memories';

function textOf(message: ChatMessage): string {
  const content = message.content as unknown;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? (part as { text: string }).text : ''))
      .join('\n');
  }
  return '';
}

/** The texts of a message: its one string, or the text of each of its text parts. */
function textPartsOf(message: ChatMessage): string[] {
  const content = message.content as unknown;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : []));
}

/**
 * The memory block of the provider request `call`: the text from the preamble
 * heading to the end of the text part that carries it.
 */
function memoryBlockOf(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  const holders = request.messages.map(textOf).filter((text) => text.includes(PREAMBLE_HEADING));
  expect(holders, 'messages that carry the memory block').toHaveLength(1);
  // The block travels in a text part of its own, before the person's words: it runs to the end of that part.
  const text = request.messages.flatMap(textPartsOf).find((part) => part.includes(PREAMBLE_HEADING)) ?? holders[0];
  return text.slice(text.indexOf(PREAMBLE_HEADING));
}

/** Every message of the provider request `call`, as one text: what the model receives on that turn. */
function requestTextOf(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  return request.messages.map(textOf).join('\n\n');
}

/** The lines of one section of a block, from its header to the next section. */
function sectionLines(block: string, header: string): string[] {
  const start = block.indexOf(header);
  if (start === -1) return [];
  const rest = block.slice(start + header.length);
  const next = rest.search(/\n\n## /);
  return (next === -1 ? rest : rest.slice(0, next)).split('\n').filter(Boolean);
}

const EPISODIC_HEADER = '## Recent Experiences';
const GRAPH_HEADER = '## Related Context';
const DAY_MS = 86_400_000;
/** Tokens of a text by the assembler's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

const SECTION_HEADERS = [
  '## Persistent Memory',
  '## Active Context',
  '## Relevant Memories',
  '## Recent Experiences',
  '## Reminders',
  '## Related Context',
  '## Observations',
  '## Something This Reminds Me Of',
] as const;

/** The lines of each section of a block, by header, in the block's order. */
function blockSections(block: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  for (const part of block.split(/\n\n(?=## )/)) {
    const header = SECTION_HEADERS.find((name) => part.startsWith(name));
    if (header) sections.set(header, part.slice(part.indexOf('\n') + 1).split('\n'));
  }
  return sections;
}

/** The header each memory-line section of the block starts with, by the section `lineOutcomes` names. */
const OUTCOME_HEADERS: Record<AssembledLineOutcome['section'], string | undefined> = {
  semanticRecall: '## Relevant Memories',
  // A hybrid block's one recall section.
  recall: '## Relevant Memories',
  recentEpisodic: '## Recent Experiences',
  graphAssociations: '## Related Context',
  involuntary: '## Something This Reminds Me Of',
  workingMemory: undefined,
  prospectiveAlerts: undefined,
  observationNotes: undefined,
  persistentMemory: undefined,
};
/** The sections whose lines show a memory. */
const MEMORY_LINE_HEADERS = ['## Relevant Memories', '## Recent Experiences', '## Related Context', '## Something This Reminds Me Of'];

beforeEach(() => globalLLMProviderHealth.reset());
afterEach(() => {
  personaMemory.config = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("agent({ runtime: 'gmi' }) memory block in the model request", () => {
  // A user statement of 409 characters whose fact starts at character 404: a block that cut traces at 300 characters lost it.
  const STATEMENT =
    'At the downtown parcel station on a rainy afternoon we compared the small and the medium lockers, settled on a medium one ' +
    'near the entrance because the stove box would not fit the small size, checked the receipt twice, took a photo of the ' +
    'locker door, and wrote the details on the back of the trip checklist so nobody would forget them before the camping ' +
    'weekend. The locker is number 14 and its code is 5832.';
  const FACT = 'The locker is number 14 and its code is 5832.';

  it('a recalled statement reaches the model whole, its fact past the 400th character, in every formatting style', async () => {
    expect(STATEMENT.indexOf('5832')).toBeGreaterThan(400);
    for (const [style, traits] of Object.entries(STYLE_TRAITS)) {
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Locker 14.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k, traits);
      try {
        const session = a.session('s');
        await session.send(STATEMENT);
        session.clear();
        await session.send('Which parcel locker code did we set for the camping stove?');
        const block = memoryBlockOf(s, 1);
        expect(block, style).toContain(FACT);
        expect(block, style).not.toContain('…[cut]');
      } finally {
        await a.close();
      }
    }
  });

  it('a recalled statement longer than the block has room for is left out whole: the request carries no cut line, and the statements that fit are whole', async () => {
    // Forty sentences of about 170 characters: more than the 1600-token block holds (6,400 characters, preamble included).
    const LONG_START = 'Inventory line 1 of the camping trip:';
    const LONG_STATEMENT = Array.from(
      { length: 40 },
      (_, i) =>
        `Inventory line ${i + 1} of the camping trip: the stove parcel waits in a locker at the downtown parcel station, ` +
        'with the receipt, the trip checklist and a spare fuel canister.',
    ).join(' ');
    const SHORT_STATEMENTS = ['The parcel locker for the camping stove is number 14.', 'The code of the camping stove parcel locker is 5832.'];
    expect(LONG_STATEMENT.startsWith(LONG_START)).toBe(true);
    expect(LONG_STATEMENT.length).toBeGreaterThan(1600 * 4);
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Okay.'), reply.text('Sure.'), reply.text('Locker 14.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send(LONG_STATEMENT);
      for (const statement of SHORT_STATEMENTS) await session.send(statement);
      session.clear();
      assemblies.length = 0;
      await session.send('Which parcel locker holds the camping stove, and what is its code?');

      const block = memoryBlockOf(s, 3);
      // No line of the block is a memory cut to fit.
      expect(block, `the block:\n${block}`).not.toContain(MEMORY_CUT_MARKER);
      // The long statement is nowhere in the request the model receives, in the block or outside it.
      expect(requestTextOf(s, 3)).not.toContain(LONG_START);
      // The statements that fit are in Recent Experiences, each once and whole.
      const experiences = sectionLines(block, EPISODIC_HEADER);
      for (const statement of SHORT_STATEMENTS) {
        expect(experiences.filter((line) => line.includes(statement)), `${statement}\nin the block:\n${block}`).toHaveLength(1);
      }
      expect(tokensOf(block)).toBeLessThanOrEqual(1600);

      // The assembly behind that request reports what became of each memory line. The three statements are the
      // episodic traces: the long one left out because its whole line does not fit the room Recent Experiences was
      // offered (it is more tokens than the whole block), the two short ones included.
      expect(assemblies.length, 'assemblies on the last turn').toBeGreaterThan(0);
      const { block: assembled, lineOutcomes } = assemblies[assemblies.length - 1];
      expect(block.startsWith(assembled.trimEnd()), "the request's block is the assembled one").toBe(true);
      const leftOut = lineOutcomes.filter((line) => line.outcome === 'left_out');
      expect(leftOut, JSON.stringify(lineOutcomes)).toHaveLength(1);
      expect(leftOut[0]).toMatchObject({ section: 'recentEpisodic', reason: 'section_full' });
      expect(leftOut[0].tokens).toBeGreaterThan(1600);
      const includedEpisodic = lineOutcomes.filter((line) => line.outcome === 'included' && line.section === 'recentEpisodic');
      expect(includedEpisodic, JSON.stringify(lineOutcomes)).toHaveLength(SHORT_STATEMENTS.length);
      for (const line of includedEpisodic) expect(line).not.toHaveProperty('reason');
    } finally {
      await a.close();
    }
  });

  it('a statement recall ranks first but that does not fit whole is passed over, and the statements ranked below it take its room, whole', async () => {
    // The question repeats the long statement's sentence, so recall ranks the long statement above the two short ones,
    // which share only a few of its words. Forty such sentences are more than the 1600-token block holds.
    const LONG_START = 'Inventory line 1 of the camping trip:';
    const SENTENCE =
      'of the camping trip: the stove parcel waits in a locker at the downtown parcel station, ' +
      'with the receipt, the trip checklist and a spare fuel canister.';
    const LONG_STATEMENT = Array.from({ length: 40 }, (_, i) => `Inventory line ${i + 1} ${SENTENCE}`).join(' ');
    const SHORT_STATEMENTS = ['The parcel locker for the camping stove is number 14.', 'The code of the camping stove parcel locker is 5832.'];
    expect(LONG_STATEMENT.length).toBeGreaterThan(1600 * 4);
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Okay.'), reply.text('Sure.'), reply.text('Locker 14.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      await session.send(LONG_STATEMENT);
      for (const statement of SHORT_STATEMENTS) await session.send(statement);
      session.clear();
      assemblies.length = 0;
      await session.send(`Inventory line ${SENTENCE} Which locker, and what is its code?`);

      const block = memoryBlockOf(s, 3);
      expect(assemblies.length, 'assemblies on the last turn').toBeGreaterThan(0);
      const { block: assembled, lineOutcomes, contents, rank } = assemblies[assemblies.length - 1];
      expect(block.startsWith(assembled.trimEnd()), "the request's block is the assembled one").toBe(true);

      // The fixture: recall returned the three statements, the long one ranked above both short ones.
      const idOf = (text: string) => {
        const ids = [...contents.entries()].filter(([, content]) => content.includes(text)).map(([id]) => id);
        expect(ids, `traces holding ${JSON.stringify(text.slice(0, 40))}`).toHaveLength(1);
        return ids[0];
      };
      const longId = idOf(LONG_START);
      const shortIds = SHORT_STATEMENTS.map(idOf);
      const where = `rank ${JSON.stringify(rank)}; long ${longId}; short ${JSON.stringify(shortIds)}\noutcomes ${JSON.stringify(lineOutcomes)}\nrequest block:\n${block}`;
      expect(rank.indexOf(longId), where).toBeGreaterThanOrEqual(0);
      for (const id of shortIds) expect(rank.indexOf(id), where).toBeGreaterThan(rank.indexOf(longId));

      // Recent Experiences reports its lines in rank order: the long statement left out for want of room, and both short
      // statements after it included, whole and once in the request's block. Nothing in the request is cut.
      const episodic = lineOutcomes.filter((line) => line.section === 'recentEpisodic');
      const longAt = episodic.findIndex((line) => line.id === longId);
      expect(episodic[longAt], where).toMatchObject({ outcome: 'left_out', reason: 'section_full' });
      expect(episodic[longAt].tokens, where).toBeGreaterThan(1600);
      for (const [index, id] of shortIds.entries()) {
        const at = episodic.findIndex((line) => line.id === id);
        expect(at, where).toBeGreaterThan(longAt);
        expect(episodic[at], where).toMatchObject({ outcome: 'included' });
        expect(sectionLines(block, EPISODIC_HEADER).filter((line) => line.includes(SHORT_STATEMENTS[index])), where).toHaveLength(1);
      }
      expect(block, where).not.toContain(MEMORY_CUT_MARKER);
      expect(requestTextOf(s, 3), where).not.toContain(LONG_START);
      expect(tokensOf(block)).toBeLessThanOrEqual(1600);
    } finally {
      await a.close();
    }
  });

  it('ages of a week or more reach the model in days with the stored date; under a week they keep the short form', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const turnAt = Date.UTC(2026, 10, 8, 12, 0, 0); // 2026-11-08 12:00 UTC
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Noted.'), reply.text('Noted.'), reply.text('Last year.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      vi.setSystemTime(turnAt - 365 * DAY_MS);
      await session.send('We took the harbor ferry to the island for the first time.');
      vi.setSystemTime(turnAt - 26 * DAY_MS);
      await session.send('We booked the harbor ferry tickets for the island visit.');
      vi.setSystemTime(turnAt - 3 * DAY_MS);
      await session.send('We asked the harbor office about ferry times to the island.');
      vi.setSystemTime(turnAt);
      session.clear();
      await session.send('When did we take the harbor ferry to the island?');

      const block = memoryBlockOf(s, 3);
      expect(block).toMatch(/first time[^\n]*365 days ago, 2025-11-08/);
      expect(block).toMatch(/booked the harbor ferry tickets[^\n]*26 days ago, 2026-10-13/);
      expect(block).toMatch(/ferry times to the island[^\n]*3d ago, 2026-11-05/);
      expect(block).not.toMatch(/\dw ago/);
    } finally {
      await a.close();
    }
  });

  it('the budget the empty sections leave reaches the episodic traces: more than a fixed share would hold, within the 1600 tokens', async () => {
    const places = ['north ridge', 'cedar lake', 'river bend', 'pine hollow', 'stone bridge', 'fern valley', 'quarry pond', 'old mill', 'red cliffs', 'birch grove', 'salt marsh', 'echo canyon', 'willow creek', 'granite peak'];
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [...places.map(() => reply.text('Noted.')), reply.text('The views.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      for (const [i, place] of places.entries()) {
        await session.send(
          `Hiking day ${i + 1} at ${place}: we started the trail at dawn, packed water and a map, ` +
            `talked about the camping plan and the gear list, stopped at the overlook for lunch, ` +
            `counted the switchbacks on the way down, and wrote in the trail journal that ${place} ` +
            `had the best view of the season and that the hike took most of the day with two long breaks.`,
        );
      }
      session.clear();
      await session.send('What did we write in the trail journal about the hiking day and the view?');

      const block = memoryBlockOf(s, places.length);
      const hikes = sectionLines(block, EPISODIC_HEADER).filter((line) => line.startsWith('- [episodic]') && line.includes('Hiking day'));
      // A fixed 25% share of the block held three or four of these; the share the empty sections leave now reaches them.
      expect(hikes.length).toBeGreaterThan(6);
      expect(tokensOf(block)).toBeLessThanOrEqual(1600);
    } finally {
      await a.close();
    }
  });

  it('a turn whose block the second pass fills still sends every memory line the first pass placed, in its section and its order', async () => {
    // Fourteen long hiking notes are more than the block holds, so the trace sections leave some out in the first pass.
    // A large Related Context share grants that section all its associations need; an association whose trace a trace
    // section already shows is left out, and the room it leaves reaches the second pass, which gives it to the traces.
    const places = ['north ridge', 'cedar lake', 'river bend', 'pine hollow', 'stone bridge', 'fern valley', 'quarry pond', 'old mill', 'red cliffs', 'birch grove', 'salt marsh', 'echo canyon', 'willow creek', 'granite peak'];
    const configs: (CognitiveMemoryPersonaConfig | undefined)[] = [
      undefined,
      { tokenBudget: { graphAssociations: 1 } },
      { tokenBudget: { graphAssociations: 1, recentEpisodic: 0.1 } },
      { tokenBudget: { workingMemory: 0.05 } },
    ];
    const filled: string[] = [];
    for (const config of configs) {
      const label = JSON.stringify(config?.tokenBudget ?? 'default shares');
      personaMemory.config = config;
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [...places.map(() => reply.text('Noted.')), reply.text('The views.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k);
      try {
        const session = a.session('s');
        for (const [i, place] of places.entries()) {
          await session.send(
            `Hiking day ${i + 1} at ${place}: we started the trail at dawn, packed water and a map, ` +
              `talked about the camping plan and the gear list, stopped at the overlook for lunch, ` +
              `counted the switchbacks on the way down, and wrote in the trail journal that ${place} ` +
              `had the best view of the season and that the hike took most of the day with two long breaks.`,
          );
        }
        session.clear();
        assemblies.length = 0;
        await session.send('What did we write in the trail journal about the hiking day and the view?');

        expect(assemblies.length, `${label}: assemblies on the last turn`).toBeGreaterThan(0);
        const { firstPass, block: assembled, lineOutcomes, includedMemoryIds, contents } = assemblies[assemblies.length - 1];
        const block = memoryBlockOf(s, places.length);
        // The request carries the block the assembler returned.
        expect(block.startsWith(assembled.trimEnd()), `${label}: the request's block is the assembled one`).toBe(true);
        expect(block, `${label}: no memory line is cut`).not.toContain(MEMORY_CUT_MARKER);

        // What the assembly reports of each memory line matches the request the model received: a hiking note reported
        // included is whole in the section named, one reported left out is in no memory section of the request.
        const outcomeIds = lineOutcomes.map((line) => line.id);
        expect(new Set(outcomeIds).size, `${label}: one outcome a trace`).toBe(outcomeIds.length);
        const includedIds = new Set(lineOutcomes.filter((line) => line.outcome === 'included').map((line) => line.id));
        for (const id of includedMemoryIds) expect(includedIds.has(id), `${label}: ${id} is in includedMemoryIds`).toBe(true);
        const hikes = lineOutcomes.filter((line) => (contents.get(line.id) ?? '').includes('Hiking day'));
        expect(hikes.filter((line) => line.outcome === 'included').length, `${label}: hiking notes included`).toBeGreaterThan(0);
        expect(hikes.filter((line) => line.outcome === 'left_out').length, `${label}: hiking notes left out`).toBeGreaterThan(0);
        for (const line of hikes) {
          const content = contents.get(line.id)!;
          const where = `${label}: ${line.outcome} ${line.section} ${JSON.stringify(content.slice(0, 40))}\nrequest block:\n${block}`;
          expect(line.tokens, where).toBeGreaterThanOrEqual(Math.ceil(content.length / 4));
          if (line.outcome === 'included') {
            expect(line, where).not.toHaveProperty('reason');
            const header = OUTCOME_HEADERS[line.section];
            expect(header, where).toBeDefined();
            expect(sectionLines(block, header!).filter((shown) => shown.includes(content)), where).toHaveLength(1);
          } else {
            expect(['budget', 'section_full'], where).toContain(line.reason);
            for (const header of MEMORY_LINE_HEADERS) {
              const at = content.indexOf('Hiking day');
              expect(sectionLines(block, header).some((shown) => shown.includes(content.slice(at, at + 60))), `${where}\n(in ${header})`).toBe(false);
            }
          }
        }

        const sent = blockSections(block);
        const firstSections = blockSections(firstPass);
        expect(firstSections.size, `${label}: sections in the first pass`).toBeGreaterThan(0);
        for (const [header, lines] of firstSections) {
          const later = sent.get(header) ?? [];
          let at = 0;
          for (const line of lines) {
            // A line is whole in both blocks: nothing in them is cut (these agents have no persistent memory text).
            while (at < later.length && later[at] !== line) at++;
            expect(
              at < later.length,
              `${label} ${header}: the first pass's line ${JSON.stringify(line.slice(0, 100))} is not in the request\n` +
                `first pass:\n${firstPass}\n\nrequest block:\n${block}`,
            ).toBe(true);
            at++;
          }
        }
        expect(tokensOf(assembled), label).toBeLessThanOrEqual(1600);
        if (assembled !== firstPass) {
          // The second pass placed something the first pass did not, and it reached the model too.
          const placed = new Set([...firstSections.values()].flat());
          const added = [...blockSections(assembled).entries()].flatMap(([header, lines]) =>
            lines.filter((line) => !placed.has(line)).map((line) => ({ header, line })),
          );
          expect(added.length, `${label}: lines the second pass added`).toBeGreaterThan(0);
          for (const { header, line } of added) {
            expect(sent.get(header) ?? [], `${label} ${header}: a line the second pass placed, in the request`).toContain(line);
          }
          expect(assembled.length, label).toBeGreaterThan(firstPass.length);
          filled.push(label);
        }
      } finally {
        await a.close();
      }
    }
    // At least one of the turns spent room in the second pass, so the check above read a block the second pass filled.
    expect(filled, 'configurations whose block the second pass filled').not.toHaveLength(0);
  });

  it("a persona's tokenBudget share of 0 keeps its section out of the request, where the default share renders it", async () => {
    for (const zeroed of [false, true]) {
      personaMemory.config = zeroed ? { tokenBudget: { recentEpisodic: 0 } } : undefined;
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Locker 14.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k);
      try {
        const session = a.session('s');
        await session.send(STATEMENT);
        session.clear();
        await session.send('Which parcel locker code did we set for the camping stove?');
        const block = memoryBlockOf(s, 1);
        if (zeroed) {
          expect(block, 'share 0').not.toContain(EPISODIC_HEADER);
          // Nowhere in the request: not in another message, not outside the block.
          expect(requestTextOf(s, 1), 'share 0, the whole request').not.toContain(EPISODIC_HEADER);
        } else {
          expect(block, 'default share').toContain(EPISODIC_HEADER);
          expect(sectionLines(block, EPISODIC_HEADER).join('\n')).toContain(FACT);
        }
      } finally {
        await a.close();
      }
    }
  });

  it("a memory whose sections a persona turned off is reported left out for the budget, and no memory section of the request shows it", async () => {
    // Recent Experiences and Related Context off: the statement (an episodic trace) has a line only in sections offered
    // no tokens, so the assembly reports it left out with reason budget. With the default shares it is included.
    for (const off of [false, true]) {
      personaMemory.config = off ? { tokenBudget: { recentEpisodic: 0, graphAssociations: 0 } } : undefined;
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Locker 14.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k);
      try {
        const session = a.session('s');
        await session.send(STATEMENT);
        session.clear();
        assemblies.length = 0;
        await session.send('Which parcel locker code did we set for the camping stove?');
        const block = memoryBlockOf(s, 1);
        expect(assemblies.length, 'assemblies on the last turn').toBeGreaterThan(0);
        const { block: assembled, lineOutcomes, contents } = assemblies[assemblies.length - 1];
        expect(block.startsWith(assembled.trimEnd()), "the request's block is the assembled one").toBe(true);
        const statementIds = [...contents.entries()].filter(([, content]) => content.includes(FACT)).map(([id]) => id);
        expect(statementIds, `traces holding the statement: ${JSON.stringify([...contents.values()])}`).toHaveLength(1);
        const outcome = lineOutcomes.find((line) => line.id === statementIds[0]);
        const where = `${off ? 'sections off' : 'default shares'}: ${JSON.stringify(lineOutcomes)}\nrequest block:\n${block}`;
        if (off) {
          expect(outcome, where).toMatchObject({ section: 'recentEpisodic', outcome: 'left_out', reason: 'budget' });
          expect(outcome!.tokens, where).toBeGreaterThan(Math.ceil(STATEMENT.length / 4) - 1);
          for (const header of MEMORY_LINE_HEADERS) {
            expect(sectionLines(block, header).some((line) => line.includes(FACT)), `${where}\n(in ${header})`).toBe(false);
          }
        } else {
          expect(outcome, where).toMatchObject({ section: 'recentEpisodic', outcome: 'included' });
          expect(outcome, where).not.toHaveProperty('reason');
          expect(sectionLines(block, EPISODIC_HEADER).filter((line) => line.includes(FACT)), where).toHaveLength(1);
        }
      } finally {
        await a.close();
      }
    }
  });

  it("a persona's workingMemoryCapacity bounds the Active Context the request carries", async () => {
    // Every send files the user's message and the reply, each focused in the session's working memory, and every
    // turn's recall focuses its top traces there too. With encoding's baseStrength at 1 a focused trace outlasts a few
    // turns of decay, so the slots fill: a capacity of 9 holds more than 5 of them, a capacity of 5 holds 5 at most.
    // The emotional traits leave the capacity as the persona sets it (openness and conscientiousness move it by one).
    const ACTIVE_HEADER = '## Active Context (in focus — reference directly)';
    const notes = [
      'We packed the camping stove and the blue tent for the lake trip.',
      'The lake trip needs the camping stove fuel and two sleeping bags.',
      'We bought fuel for the camping stove before the lake trip.',
      'The blue tent and the sleeping bags went in the car for the lake trip.',
      'We tested the camping stove in the yard before the lake trip.',
      'The lake trip map and the tent poles are in the blue bag.',
      'We checked the camping stove fuel again for the lake trip.',
      'The sleeping bags and the camping stove are ready for the lake trip.',
    ];
    const counts: Record<number, number> = {};
    for (const capacity of [9, 5]) {
      personaMemory.config = { workingMemoryCapacity: capacity, encoding: { baseStrength: 1 } };
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [...notes.map(() => reply.text('Noted.')), reply.text('By the lake.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k, STYLE_TRAITS.emotional);
      try {
        const session = a.session('s');
        for (const note of notes) await session.send(note);
        session.clear();
        await session.send('What did we pack for the camping stove on the lake trip?');
        const block = memoryBlockOf(s, notes.length);
        counts[capacity] = sectionLines(block, ACTIVE_HEADER).filter((line) => line.startsWith('- [')).length;
        if (capacity === 5) expect(counts[capacity], `capacity 5:\n${block}`).toBeLessThanOrEqual(5);
        else expect(counts[capacity], `capacity ${capacity}:\n${block}`).toBeGreaterThan(5);
      } finally {
        await a.close();
      }
    }
    expect(counts[5]).toBeGreaterThan(0);
    expect(counts[5]).toBeLessThan(counts[9]);
  });

  it('a graph association reaches the model whole, its fact past the 150th character, and a recalled trace it leads to appears once', async () => {
    // STATEMENT and the kayak notes are recalled together on the early and the mixed turns, so the memory graph links
    // them. The last question shares words with the kayak notes: three of them rank above STATEMENT and seed the graph
    // walk, and STATEMENT arrives as their association. Recall also returns STATEMENT itself, past the three seeds:
    // with Recent Experiences on it renders there and stays out of Related Context; with the persona's share of 0 for
    // Recent Experiences it renders in Related Context, whole.
    expect(STATEMENT.indexOf('5832')).toBeGreaterThan(150);
    const STATEMENT_START = 'At the downtown parcel station';
    const turns = [
      STATEMENT,
      'Kayak paddles hang on the garage rack beside the red canoe.',
      'The red canoe and the kayak paddles share the garage rack.',
      'Kayak paddles, red canoe, garage rack: all in place.',
      'Check the downtown parcel station locker code and the kayak paddles on the garage rack.',
      'Remember the parcel station locker near the entrance and the red canoe on the garage rack.',
    ];
    const acks = ['Noted.', 'Okay.', 'Sure.', 'Fine.', 'Right.', 'Yes.'];
    for (const episodicOff of [false, true]) {
      personaMemory.config = episodicOff ? { tokenBudget: { recentEpisodic: 0 } } : undefined;
      const k = key(); const emb = key();
      const s = script('openai', k, { replies: [...acks.map((ack) => reply.text(ack)), reply.text('On the rack.')] });
      script('openai', emb, { replies: [] });
      vi.stubEnv('OPENAI_API_KEY', emb);
      const a = withMemory(k);
      try {
        const session = a.session('s');
        for (const turn of turns) await session.send(turn);
        session.clear();
        await session.send('Kayak paddles, red canoe, garage rack: where again?');

        const block = memoryBlockOf(s, turns.length);
        expect(block.split(STATEMENT_START), `the statement once in:\n${block}`).toHaveLength(2);
        // Once in the whole request the model receives, not only in the block.
        const request = requestTextOf(s, turns.length);
        expect(request.split(STATEMENT_START), `the statement once in the request:\n${request}`).toHaveLength(2);
        const association = sectionLines(block, GRAPH_HEADER).find((line) => line.includes(STATEMENT_START));
        if (episodicOff) {
          expect(association, `the statement among the associations of:\n${block}`).toBeDefined();
          expect(association).toContain(FACT);
          expect(association).not.toContain('…[cut]');
        } else {
          expect(sectionLines(block, EPISODIC_HEADER).join('\n')).toContain(STATEMENT_START);
          expect(association, `the statement left out of the associations of:\n${block}`).toBeUndefined();
        }
      } finally {
        await a.close();
      }
    }
  });

  it('an age of a day or more counts UTC calendar days, so it agrees with the date beside it across a UTC midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    const turnAt = Date.UTC(2026, 10, 8, 0, 30, 0); // 2026-11-08 00:30 UTC
    const k = key(); const emb = key();
    const s = script('openai', k, { replies: [reply.text('Noted.'), reply.text('Noted.'), reply.text('Noted.'), reply.text('In October.')] });
    script('openai', emb, { replies: [] });
    vi.stubEnv('OPENAI_API_KEY', emb);
    const a = withMemory(k);
    try {
      const session = a.session('s');
      vi.setSystemTime(Date.UTC(2026, 9, 12, 23, 0, 0)); // 2026-10-12 23:00 UTC: 26 whole days and 1.5 hours before the turn
      await session.send('We mailed the kayak repair form to the outfitter in the city.');
      vi.setSystemTime(Date.UTC(2026, 10, 6, 23, 0, 0)); // 2026-11-06 23:00 UTC: 25.5 hours before the turn
      await session.send('We called the outfitter about the kayak repair form.');
      vi.setSystemTime(Date.UTC(2026, 10, 7, 23, 0, 0)); // 2026-11-07 23:00 UTC: 1.5 hours before the turn
      await session.send('The outfitter wrote that the kayak repair form arrived.');
      vi.setSystemTime(turnAt);
      session.clear();
      await session.send('When did we mail the kayak repair form to the outfitter?');

      const block = memoryBlockOf(s, 3);
      expect(block).toMatch(/mailed the kayak repair form[^\n]*27 days ago, 2026-10-12/);
      expect(block).toMatch(/called the outfitter[^\n]*2d ago, 2026-11-06/);
      // Under a day the age stays in hours, whatever the date.
      expect(block).toMatch(/kayak repair form arrived[^\n]*1h ago, 2026-11-07/);
      expect(block).not.toMatch(/26 days ago|1d ago/);
    } finally {
      await a.close();
    }
  });
});
