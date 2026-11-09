/**
 * The memory block a GMI's cognitive memory puts in the prompt each turn, read
 * through the real path: a CognitiveMemoryManager built from agent options over
 * the in-memory stores, recalled by `assembleForPrompt` and by the
 * CognitiveMemoryBridge a GMI uses (which asks for a 1600-token block).
 * Embeddings are a word hash, so texts that share words recall each other.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgentCognitiveMemory } from '../agentCognitiveMemory.js';
import { CognitiveMemoryBridge } from '../../../cognition/substrate/CognitiveMemoryBridge.js';
import { GMIMood } from '../../../cognition/substrate/IGMI';
import type { ICognitiveMemoryManager } from '../../../cognition/memory/CognitiveMemoryManager.js';

const DIM = 64;

/** A deterministic bag-of-words vector: texts that share words point the same way. */
function hashEmbed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const word of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0;
    for (const ch of word) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function makeEmbedder() {
  return {
    initialize: async () => undefined,
    generateEmbeddings: async (req: { texts: string | string[] }) => {
      const texts = Array.isArray(req.texts) ? req.texts : [req.texts];
      return { embeddings: texts.map(hashEmbed), modelId: 'test-embed', providerId: 'test', usage: { totalTokens: 0 } };
    },
    getEmbeddingModelInfo: async () => ({ modelId: 'test-embed', providerId: 'test', dimension: DIM }),
    getEmbeddingDimension: async () => DIM,
    checkHealth: async () => ({ isHealthy: true }),
    shutdown: async () => undefined,
  };
}

const STYLE_TRAITS = {
  structured: { conscientiousness: 0.9, openness: 0.2, emotionality: 0.2 },
  narrative: { openness: 0.9, conscientiousness: 0.2, emotionality: 0.2 },
  emotional: { emotionality: 0.9, conscientiousness: 0.2, openness: 0.2 },
} as const;

function memoryWith(traits: Record<string, number>) {
  const persona = {
    id: 'memo', name: 'Memo', description: 'd', version: '1.0.0', baseSystemPrompt: 'x',
    personalityTraits: traits,
  } as never;
  return createAgentCognitiveMemory({ persona, memory: {}, embeddingManager: makeEmbedder() as never });
}

const neutral = { valence: 0, arousal: 0, dominance: 0 };
const DAY_MS = 86_400_000;

/** Tokens of a text by the assembler's estimate (about four characters a token). */
const tokensOf = (text: string) => Math.ceil(text.length / 4);

afterEach(() => {
  vi.useRealTimers();
});

describe('memory block: a recalled trace is rendered whole', () => {
  // A question of about 200 characters and a reply whose fact sits past character 400 of the trace.
  const QUESTION =
    'Which locker at the downtown parcel station did we pick for the spare camping stove, and what code did we set on it when we dropped the stove off last weekend before the trip?';
  const REPLY =
    'We went to the downtown parcel station on a rainy afternoon, compared the small and the medium lockers, ' +
    'and settled on a medium one near the entrance because the stove box would not fit the small size. ' +
    'After that we checked the receipt twice. The locker is number 14 and its code is 5832.';
  const TRACE = `user: ${QUESTION}\nassistant: ${REPLY}`;

  it('keeps a fact that sits past the 400th character of the trace, in every formatting style', async () => {
    expect(QUESTION.length).toBeGreaterThan(170);
    expect(TRACE.indexOf('5832')).toBeGreaterThan(400);
    for (const [style, traits] of Object.entries(STYLE_TRAITS)) {
      const mem = await memoryWith(traits);
      try {
        await mem.manager.encode(TRACE, neutral, 'neutral', { type: 'episodic' });
        const out = await mem.manager.assembleForPrompt('which parcel locker code did we set for the camping stove', 1600, neutral);
        expect(out.contextText, style).toContain('The locker is number 14 and its code is 5832.');
        expect(out.contextText, style).not.toContain('…[cut]');
      } finally {
        await mem.close();
      }
    }
  });
});

describe('memory block: ages count days and carry the date', () => {
  it('prints a trace stored 26 days before the turn as "26 days ago" with its date, and a year-old one in days too', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const turnAt = Date.UTC(2026, 10, 8, 12, 0, 0); // 2026-11-08 12:00 UTC
    const mem = await memoryWith(STYLE_TRAITS.structured);
    try {
      vi.setSystemTime(turnAt - 26 * DAY_MS);
      await mem.manager.encode('We booked the harbor ferry tickets for the island visit.', neutral, 'neutral', { type: 'episodic' });
      vi.setSystemTime(turnAt - 365 * DAY_MS);
      await mem.manager.encode('We took the harbor ferry to the island for the first time.', neutral, 'neutral', { type: 'episodic' });
      vi.setSystemTime(turnAt - 3 * DAY_MS);
      await mem.manager.encode('We asked the harbor office about ferry times to the island.', neutral, 'neutral', { type: 'episodic' });
      vi.setSystemTime(turnAt);

      const out = await mem.manager.assembleForPrompt('when did we take the harbor ferry to the island', 1600, neutral);

      expect(out.contextText).toMatch(/booked the harbor ferry tickets[^\n]*26 days ago, 2026-10-13/);
      expect(out.contextText).toMatch(/first time[^\n]*365 days ago, 2025-11-08/);
      expect(out.contextText).toMatch(/ferry times to the island[^\n]*3d ago, 2026-11-05/);
      expect(out.contextText).not.toMatch(/\dw ago/);
    } finally {
      await mem.close();
    }
  });
});

describe('memory block: the budget an empty section leaves flows to the sections with content', () => {
  it('a store of episodic traces alone fills the 1600-token block the GMI asks for, never more', async () => {
    const mem = await memoryWith(STYLE_TRAITS.structured);
    try {
      const places = ['north ridge', 'cedar lake', 'river bend', 'pine hollow', 'stone bridge', 'fern valley', 'quarry pond', 'old mill', 'red cliffs', 'birch grove', 'salt marsh', 'echo canyon', 'willow creek', 'granite peak'];
      for (const [i, place] of places.entries()) {
        await mem.manager.encode(
          `Hiking day ${i + 1} at ${place}: we started the trail at dawn, packed water and a map, ` +
            `talked about the camping plan and the gear list, stopped at the overlook for lunch, ` +
            `counted the switchbacks on the way down, and wrote in the trail journal that ${place} ` +
            `had the best view of the season and that the hike took most of the day with two long breaks.`,
          neutral,
          'neutral',
          { type: 'episodic' },
        );
      }

      const bridge = new CognitiveMemoryBridge(
        mem.manager as unknown as ICognitiveMemoryManager,
        () => GMIMood.NEUTRAL,
        () => ({ userId: 'memo' }),
        () => 'memo',
        () => 'gmi-1',
        () => undefined,
      );
      const out = await bridge.assembleContext('what did we write in the trail journal about the hiking day and the view');
      expect(out).not.toBeNull();
      const text = out!.contextText;

      const bullets = text.split('\n').filter((line) => line.startsWith('- [episodic]'));
      // With a fixed 25% share the section held three or four of these; the block now spends the whole budget on them.
      expect(bullets.length).toBeGreaterThan(6);
      expect(out!.tokensUsed).toBeLessThanOrEqual(1600);
      expect(tokensOf(text)).toBeLessThanOrEqual(1600);
      expect(out!.tokensUsed).toBeGreaterThan(1500);
    } finally {
      await mem.close();
    }
  });
});
