/**
 * @file SoulLoader.hexaco.test.ts
 * SOUL.md documents Honesty-Humility as `hexaco.honestyHumility`, while every
 * runtime reader of persona traits uses `honesty`. These tests pin the loaded
 * key, the accepted spellings, and a render-then-parse round trip through
 * renderSoulMarkdown and parseSoul.
 */
import { describe, expect, it } from 'vitest';
import { parseSoul, renderSoulMarkdown } from '../SoulLoader.js';
import type { IPersonaDefinition } from '../IPersonaDefinition.js';

describe('SoulLoader HEXACO keys', () => {
  it('loads frontmatter honestyHumility as the runtime key honesty', () => {
    const soul = parseSoul('---\nhexaco:\n  honestyHumility: 0.8\n  openness: 0.6\n---\nYou are Aria.');

    expect(soul.personaDefinition.personalityTraits).toStrictEqual({ honesty: 0.8, openness: 0.6 });
  });

  it('accepts honesty as a frontmatter spelling', () => {
    const soul = parseSoul('---\nhexaco:\n  honesty: 0.8\n  openness: 0.6\n---\nYou are Aria.');

    expect(soul.personaDefinition.personalityTraits).toStrictEqual({ honesty: 0.8, openness: 0.6 });
  });

  it('prefers honesty when both spellings are present', () => {
    const soul = parseSoul('---\nhexaco:\n  honestyHumility: 0.2\n  honesty: 0.7\n---\nYou are Aria.');

    expect(soul.personaDefinition.personalityTraits).toStrictEqual({ honesty: 0.7 });
  });

  it('renders a persona without voice or avatar config and parses it back to the same traits', () => {
    const persona: IPersonaDefinition = {
      id: 'aria',
      name: 'Aria',
      description: 'Customer support agent',
      version: '1.0.0',
      baseSystemPrompt: 'You are Aria.',
      personalityTraits: { honesty: 0.3, openness: 0.9 },
    };

    const markdown = renderSoulMarkdown(persona);

    expect(markdown).toContain('honestyHumility: 0.3');
    const reloaded = parseSoul(markdown);
    expect(reloaded.personaDefinition.personalityTraits).toStrictEqual({ honesty: 0.3, openness: 0.9 });
    expect(reloaded.personaDefinition.name).toBe('Aria');
    expect(reloaded.soulContent).toBe('You are Aria.');
  });
});
