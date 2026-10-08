/**
 * @file agent.personality-keys.test.ts
 * agent() turns HEXACO personality values into system-prompt directives. The
 * SOUL.md spelling `honestyHumility` must produce the same directive as the
 * runtime key `honesty` instead of being ignored.
 */
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '../agent.js';

describe('agent personality trait keys', () => {
  it('renders the honesty directive for the SOUL.md spelling honestyHumility', () => {
    const prompt = buildSystemPrompt({ personality: { honestyHumility: 0.9 } });

    expect(prompt).toContain('Be straightforward and transparent');
  });

  it('accepts the other SOUL.md spellings through the typed options', () => {
    const snake = buildSystemPrompt({ personality: { honesty_humility: 0.9 } });
    const openness = buildSystemPrompt({ personality: { opennessToExperience: 0.1 } });

    expect(snake).toContain('Be straightforward and transparent');
    expect(openness).not.toBe(buildSystemPrompt({ personality: {} }));
  });
});
