import { describe, expect, it } from 'vitest';
import { parseSoul, renderSoulMarkdown } from '../SoulLoader.js';
import type { IPersonaDefinition } from '../IPersonaDefinition.js';

describe('SoulLoader reasoning-trace limits', () => {
  it('loads reasoningTrace frontmatter into reasoningTraceConfig', () => {
    const soul = parseSoul('---\nreasoningTrace:\n  maxEntries: 42\n  maxMessageLength: 300\n---\nYou are Aria.');
    expect(soul.personaDefinition.reasoningTraceConfig).toEqual({ maxEntries: 42, maxMessageLength: 300 });
  });
  it('renders and parses a persona back with the same limits', () => {
    const persona: IPersonaDefinition = { id: 'aria', name: 'Aria', description: 'd', version: '1.0.0', baseSystemPrompt: 'You are Aria.', reasoningTraceConfig: { maxEntries: 7 } };
    const back = parseSoul(renderSoulMarkdown(persona));
    expect(back.personaDefinition.reasoningTraceConfig).toEqual({ maxEntries: 7 });
  });
});
