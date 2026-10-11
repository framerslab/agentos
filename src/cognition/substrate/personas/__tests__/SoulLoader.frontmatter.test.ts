/**
 * @file SoulLoader.frontmatter.test.ts
 * A soul file's frontmatter is read as data, and a persona's prompt is
 * written as it is. A block marked as JavaScript is never evaluated, whether
 * SOUL.md opens with it or a rendered prompt does, and a prompt that opens
 * like a frontmatter block comes back whole from a render and a parse, for a
 * persona with fields to write and for one with none.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadSoul, loadSoulSync, parseSoul, renderSoulMarkdown } from '../SoulLoader.js';
import type { IPersonaDefinition } from '../IPersonaDefinition.js';

/** A global the block below would set if it were evaluated. */
const EVALUATED = '__agentosSoulFrontmatterEvaluated';

/** A frontmatter block marked as JavaScript. Evaluated, it would set the global and give the name `Evaluated`. */
const MARKED_BLOCK = `---js\n{ name: (globalThis.${EVALUATED} = true) && 'Evaluated' }\n---\n`;

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-frontmatter-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  Reflect.deleteProperty(globalThis, EVALUATED);
});

describe('SoulLoader frontmatter and prompt', () => {
  it('reads no fields from a SOUL.md whose frontmatter is marked as JavaScript, and evaluates none of it', async () => {
    const soulMarkdown = `${MARKED_BLOCK}You are Aria.\n`;
    const soulPath = path.join(dir, 'SOUL.md');
    fs.writeFileSync(soulPath, soulMarkdown);

    // The three reads: a file, the workspace folder that holds it, and the text itself.
    const souls = [await loadSoul({ source: soulPath }), loadSoulSync({ source: dir }), parseSoul(soulMarkdown)];

    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    for (const soul of souls) {
      expect(soul.frontmatter).toEqual({});
      expect(soul.personaDefinition.name).toBe('Unnamed Agent');
      expect(soul.soulContent).toBe('You are Aria.');
    }
  });

  it('renders a prompt that opens with a frontmatter block under the persona\'s own, and parses it back whole', () => {
    const prompt = `${MARKED_BLOCK}You are Aria.`;
    const persona: IPersonaDefinition = {
      id: 'aria',
      name: 'Aria',
      description: 'Customer support agent',
      version: '1.0.0',
      baseSystemPrompt: prompt,
    };

    const rendered = renderSoulMarkdown(persona);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    // The persona's own frontmatter, then the prompt as it is.
    expect(rendered.startsWith('---\nname: Aria\n')).toBe(true);
    expect(rendered.endsWith(`\n---\n${prompt}\n`)).toBe(true);

    const back = parseSoul(rendered);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    expect(back.frontmatter).toEqual({ name: 'Aria', agentId: 'aria', role: 'Customer support agent' });
    expect(back.soulContent).toBe(prompt);
    expect(back.personaDefinition.name).toBe('Aria');
    expect(back.personaDefinition.baseSystemPrompt).toBe(prompt);
  });

  it('renders a persona with no field to write so that a prompt that opens with a line of dashes parses back whole', () => {
    const prompt = '---\nRules come first.\n---\nYou are Aria.';
    // A persona as a migration from JSON reads one, here with a prompt and none of the fields the renderer writes.
    const persona: IPersonaDefinition = JSON.parse(JSON.stringify({ baseSystemPrompt: prompt }));

    const rendered = renderSoulMarkdown(persona);
    expect(rendered).toBe(`---\n---\n${prompt}\n`);

    const back = parseSoul(rendered);
    expect(back.frontmatter).toEqual({});
    expect(back.soulContent).toBe(prompt);
    expect(back.personaDefinition.baseSystemPrompt).toBe(prompt);
  });
});
