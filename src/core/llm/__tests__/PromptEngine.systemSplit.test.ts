/**
 * PromptEngine's split of the system text. Entries carry a stability label
 * (`persona`, `conversation` or `turn`). When the caller asks for a cache
 * marker (`systemCacheMarker`) and the target is in the Anthropic family, the
 * leading run of fixed entries goes out as its own first system message and
 * the rest follows as a second one. The text and its order never change: the
 * messages joined with a blank line are the single string sent before. Every
 * other request keeps that single string.
 *
 * The labels, the marker and the result's `systemSplit` are passed and read
 * through loose types, and the two helper modules' reader is looked up by
 * name, so this file compiles with or without them.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { PromptEngine } from '../PromptEngine';
import type { ModelTargetInfo } from '../IPromptEngine';
import { promptEngineConfig } from '../../../cognition/substrate/__tests__/helpers/scriptedGmi';
import * as apiSeam from '../../../api/__tests__/helpers/stubProviders';
import * as gmiSeam from '../../../cognition/substrate/__tests__/helpers/scriptedGmi';

const target = (providerId: string, modelId = 'claude-sonnet-4-6'): ModelTargetInfo => ({
  providerId,
  modelId,
  maxContextTokens: 128000,
  optimalContextTokens: 128000,
  capabilities: ['chat'],
  promptFormatType: 'openai_chat',
  toolSupport: { supported: false, format: 'openai_functions' },
});

/** A message's text: the string, or its text parts joined with a blank line. */
const textOf = (message: any): string =>
  typeof message.content === 'string'
    ? message.content
    : message.content.filter((part: any) => part.type === 'text').map((part: any) => part.text).join('\n\n');

const systemsOf = (prompt: unknown): any[] => (prompt as any[]).filter((message) => message.role === 'system');

let engine: PromptEngine;

beforeEach(async () => {
  engine = new PromptEngine();
  const config = promptEngineConfig();
  config.performance.enableCaching = true;
  await engine.initialize(config);
});

/** Builds a prompt over `systemPrompts`, asking for the cache marker; `marker` null leaves the request out. */
const build = (systemPrompts: any[], provider = 'anthropic', marker: unknown = {}, model?: string) =>
  engine.constructPrompt(
    { systemPrompts, userInput: 'Hello.', ...(marker === null ? {} : { systemCacheMarker: marker }) } as never,
    target(provider, model),
  );

const entries = [
  { content: '  Policy  ', priority: 1, stability: 'persona' },
  { content: 'Traits', priority: 2, stability: 'conversation' },
  { content: 'Clock', priority: 50, stability: 'turn' },
  { content: 'Limits  ', priority: Number.MAX_SAFE_INTEGER, stability: 'persona' },
];
const joined = entries.map((entry) => entry.content).join('\n\n').trim();

describe('fixed system entries', () => {
  it('splits the leading fixed run and preserves the joined string', async () => {
    const result = await build(entries);
    const systems = systemsOf(result.prompt);
    expect(systems).toHaveLength(2);
    expect(systems[0].content).toEqual([{ type: 'text', text: 'Policy  \n\nTraits', cache_control: { type: 'ephemeral' } }]);
    expect(systems.map(textOf).join('\n\n')).toBe(joined);
    expect(result.metadata.systemSplit).toEqual({ fixedEntries: 2, restEntries: 2, marked: true });
  });

  it('carries a one-hour lifetime on the marker when asked', async () => {
    const result = await build(entries, 'anthropic', { ttl: '1h' });
    const systems = systemsOf(result.prompt);
    expect(systems).toHaveLength(2);
    expect(systems[0].content[0].cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(systems[1].content).toBe('Clock\n\nLimits');
  });

  it.each([
    { entries: [{ content: '  Policy  ', stability: 'persona' }] },
    { entries: [{ content: '  Policy  ', stability: 'persona' }, { content: '  ', stability: 'turn' }] },
  ])('trims an all-fixed or blank-tail prompt like the old join', async ({ entries: systemPrompts }) => {
    const result = await build(systemPrompts);
    const systems = systemsOf(result.prompt);
    expect(systems).toHaveLength(1);
    expect(systems[0].content).toEqual([{ type: 'text', text: 'Policy', cache_control: { type: 'ephemeral' } }]);
  });

  it.each(['openai', 'scripted'])('keeps one string on %s', async (provider) => {
    const result = await build(entries, provider);
    expect(systemsOf(result.prompt)).toHaveLength(1);
    expect((result.prompt as any[])[0].content).toBe(joined);
  });

  it('uses two plain strings for OpenRouter Anthropic', async () => {
    const result = await build(entries, 'openrouter', {}, 'anthropic/claude-sonnet-4-6');
    const systems = systemsOf(result.prompt);
    expect(systems).toHaveLength(2);
    expect(systems.every((message) => typeof message.content === 'string')).toBe(true);
    expect(systems.map(textOf).join('\n\n')).toBe(joined);
    expect(result.metadata.systemSplit).toMatchObject({ marked: false });
  });

  it('keeps one string when the marker is absent or the leading entry is not fixed', async () => {
    const absent = await build(entries, 'anthropic', null);
    expect(systemsOf(absent.prompt)).toHaveLength(1);
    expect((absent.prompt as any[])[0].content).toBe(joined);
    for (const first of [{ content: 'Unknown' }, { content: ' ', stability: 'persona' }, { content: 'Turn', stability: 'turn' }]) {
      const result = await build([first, ...entries]);
      expect(systemsOf(result.prompt)).toHaveLength(1);
      expect(typeof (result.prompt as any[])[0].content).toBe('string');
    }
  });

  it('never moves a later fixed entry in front of a turn entry', async () => {
    const result = await build(entries);
    const systems = systemsOf(result.prompt);
    expect(textOf(systems[0])).not.toContain('Limits');
    expect(textOf(systems.at(-1))).toMatch(/Limits$/);
  });

  it('does not share cached results across labels, marker or target', async () => {
    const a = await build(entries);
    const b = await build(entries.map((entry) => ({ ...entry, stability: 'turn' })));
    const c = await build(entries, 'anthropic', null);
    const d = await build(entries, 'openai');
    expect(new Set([a.cacheKey, b.cacheKey, c.cacheKey, d.cacheKey]).size).toBe(4);
    expect((b.prompt as any[])[0].content).toBeTypeOf('string');
  });

  it('both shared seams read all strings and text parts in order', () => {
    const messages = [
      { role: 'system', content: 'A' },
      { role: 'user', content: 'excluded' },
      { role: 'system', content: [{ type: 'text', text: 'B' }, { type: 'image_url', image_url: { url: 'test' } }, { type: 'text', text: 'C' }] },
    ];
    for (const seam of [apiSeam, gmiSeam]) {
      const reader = (seam as unknown as Record<string, (value: unknown) => string>).systemTextOf;
      expect(reader, 'systemTextOf must be exported').toBeTypeOf('function');
      expect(reader(messages)).toBe('A\n\nB\n\nC');
    }
  });
});
