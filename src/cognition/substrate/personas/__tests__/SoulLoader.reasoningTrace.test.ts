import { describe, expect, it } from 'vitest';
import { parseSoul, renderSoulMarkdown } from '../SoulLoader.js';
import type { IPersonaDefinition } from '../IPersonaDefinition.js';

describe('SoulLoader reasoning-trace limits', () => {
  it('loads reasoningTrace frontmatter into reasoningTraceConfig', () => {
    const soul = parseSoul('---\nreasoningTrace:\n  maxEntries: 42\n  maxMessageLength: 300\n---\nYou are Aria.');
    expect(soul.personaDefinition.reasoningTraceConfig).toEqual({ maxEntries: 42, maxMessageLength: 300 });
  });
  it('refuses a reasoningTrace that is not an object when the soul is loaded', () => {
    expect(() => parseSoul('---\nreasoningTrace: 42\n---\nYou are Aria.')).toThrow("front matter field 'reasoningTrace' must be an object");
  });
  it('renders a malformed value unchanged, and loading that text refuses it', () => {
    const persona = { id: 'aria', name: 'Aria', description: 'd', version: '1.0.0', baseSystemPrompt: 'You are Aria.', reasoningTraceConfig: 42 as unknown as IPersonaDefinition['reasoningTraceConfig'] };
    const rendered = renderSoulMarkdown(persona);
    expect(rendered).toContain('reasoningTrace: 42');
    expect(() => parseSoul(rendered)).toThrow("front matter field 'reasoningTrace' must be an object");
  });
  it('renders and parses a persona back with the same limits', () => {
    const persona: IPersonaDefinition = { id: 'aria', name: 'Aria', description: 'd', version: '1.0.0', baseSystemPrompt: 'You are Aria.', reasoningTraceConfig: { maxEntries: 7 } };
    const back = parseSoul(renderSoulMarkdown(persona));
    expect(back.personaDefinition.reasoningTraceConfig).toEqual({ maxEntries: 7 });
  });
});
