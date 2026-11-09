/**
 * The memory block a GMI turn sends the model, read from the request itself:
 * agent({ runtime: 'gmi' }) with cognitive memory on, its traces filed by the
 * session's own earlier sends, and the block taken from the messages the
 * provider received. The real provider manager, completion gateway, GMI,
 * prompt engine, memory bridge and cognitive memory manager run; only the
 * provider classes are stubbed (helpers/stubProviders.ts), and the OpenAI
 * stub embeds with a deterministic word hash, so texts that share words
 * recall each other. The memory assembler runs unchanged; a wrapper records
 * its first pass on the same input beside the block it returns.
 *
 * Each case clears the session's history before the turn it reads, so what it
 * finds in the block reached the prompt through recall, not through history.
 *
 * agent() builds the persona from its options, which set no
 * `cognitiveMemoryConfig`; a case that needs one sets `personaMemory.config`,
 * and the persona agent() builds carries it, so the case reads what
 * createAgentCognitiveMemory makes of a persona's memory settings on this path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CognitiveMemoryPersonaConfig } from '../../cognition/memory/core/config';
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
// against it. The returned block is the real one: the wrapper hands back what assembleMemoryContext returns.
const assemblies = vi.hoisted(() => [] as { firstPass: string; block: string }[]);
vi.mock('../../cognition/memory/core/prompt/MemoryPromptAssembler', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cognition/memory/core/prompt/MemoryPromptAssembler')>();
  return {
    ...actual,
    assembleMemoryContext: (input: Parameters<typeof actual.assembleMemoryContext>[0]) => {
      const firstPass = actual.assembleMemoryContextFirstPass(input);
      const result = actual.assembleMemoryContext(input);
      assemblies.push({ firstPass: firstPass.contextText, block: result.contextText });
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

/**
 * The memory block of the provider request `call`: the text from the preamble
 * heading to where the prompt engine resumes with the user's query.
 */
function memoryBlockOf(s: ProviderScript, call: number): string {
  const request = s.seen[call];
  expect(request, `model call ${call}`).toBeDefined();
  const holders = request.messages.map(textOf).filter((text) => text.includes(PREAMBLE_HEADING));
  expect(holders, 'messages that carry the memory block').toHaveLength(1);
  const text = holders[0];
  const start = text.indexOf(PREAMBLE_HEADING);
  const end = text.indexOf('\n\nUser Query:', start);
  return text.slice(start, end === -1 ? undefined : end);
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

/** Whether `later` is `line`, or `line` lengthened: a cut line's text before its marker starts `later`. */
function keepsLine(line: string, later: string): boolean {
  if (later === line) return true;
  const at = line.lastIndexOf(MEMORY_CUT_MARKER);
  return at > 0 && later.length > line.length - MEMORY_CUT_MARKER.length && later.startsWith(line.slice(0, at));
}

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
        const { firstPass, block: assembled } = assemblies[assemblies.length - 1];
        const block = memoryBlockOf(s, places.length);
        // The request carries the block the assembler returned.
        expect(block.startsWith(assembled.trimEnd()), `${label}: the request's block is the assembled one`).toBe(true);

        const sent = blockSections(block);
        const firstSections = blockSections(firstPass);
        expect(firstSections.size, `${label}: sections in the first pass`).toBeGreaterThan(0);
        for (const [header, lines] of firstSections) {
          const later = sent.get(header) ?? [];
          let at = 0;
          for (const line of lines) {
            while (at < later.length && !keepsLine(line, later[at])) at++;
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
          expect(added.length, `${label}: lines the second pass added or lengthened`).toBeGreaterThan(0);
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
