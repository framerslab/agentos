/**
 * @file personalityDirectives.test.ts
 * The directive each trait renders, one entry per trait: a host that shows a trait's line beside its control (an
 * agent builder's slider) reads the same line the personality section sends, or `null` for a moderate trait. The
 * renderer is reached from the package root and the substrate barrel.
 */
import { describe, expect, it } from 'vitest';
import * as root from '../../../../index.js';
import * as substrate from '../../index.js';
import { HEXACO_TRAIT_KEYS } from '../hexaco';
import {
  PERSONALITY_SECTION_HEADING,
  renderPersonalityDirectives,
  renderPersonalitySection,
  type PersonalityDirective,
  type PersonalityRenderOptions,
} from '../personalityPrompt';

const ALL = (value: number) => Object.fromEntries(HEXACO_TRAIT_KEYS.map((key) => [key, value]));

describe('renderPersonalityDirectives', () => {
  it('gives six lines for six traits at 0.95, one per trait in the canonical order', () => {
    const directives: PersonalityDirective[] = renderPersonalityDirectives(ALL(0.95));

    expect(directives.map((d) => d.trait)).toEqual([...HEXACO_TRAIT_KEYS]);
    expect(directives.every((d) => typeof d.line === 'string' && d.line.length > 0)).toBe(true);
    expect(directives[0]).toEqual({
      trait: 'honesty',
      line: 'Be straightforward and transparent. Avoid flattery, spin, or evasion. Acknowledge limitations directly.',
    });
    expect(directives[5]).toEqual({
      trait: 'openness',
      line: 'Explore creative angles and unconventional ideas. Draw unexpected connections. Question established approaches.',
    });
  });

  it('gives null for every trait at 0.5, for a trait left out, and for anything that is not a trait map', () => {
    for (const traits of [ALL(0.5), {}, undefined, 'high']) {
      expect(renderPersonalityDirectives(traits)).toEqual(HEXACO_TRAIT_KEYS.map((trait) => ({ trait, line: null })));
    }
  });

  it('gives the low line below 0.35 and nothing at either threshold', () => {
    const [honesty, , , agreeableness] = renderPersonalityDirectives({ honesty: 0.05, agreeableness: 0.35, openness: 0.65 });

    expect(honesty.line).toBe('Be strategically diplomatic. Frame information to serve the conversation goal. Emphasize advantages.');
    expect(agreeableness.line).toBeNull();
    expect(renderPersonalityDirectives({ openness: 0.65 })[5].line).toBeNull();
  });

  it('reads the SOUL.md spelling of honesty-humility as honesty', () => {
    expect(renderPersonalityDirectives({ honestyHumility: 0.95 })[0]).toEqual(renderPersonalityDirectives({ honesty: 0.95 })[0]);
  });

  it('gives the lines the personality section sends under its heading, in either register and with passed bands', () => {
    const traits = { honesty: 0.9, emotionality: 0.2, extraversion: 0.5, agreeableness: 0.7, conscientiousness: 0.1, openness: 0.66 };
    const lines = (options: Parameters<typeof renderPersonalityDirectives>[1] = {}) =>
      renderPersonalityDirectives(traits, options).flatMap((d) => (d.line === null ? [] : [d.line]));

    expect(renderPersonalitySection(traits)).toBe(`${PERSONALITY_SECTION_HEADING}\n\n${lines().join('\n')}`);
    // The writing register puts its grounding rule above the trait lines; the rule belongs to no trait.
    const writing = renderPersonalitySection(traits, { register: 'writing' })!.split('\n');
    expect(writing.slice(3)).toEqual(lines({ register: 'writing' }));
    const bands = { extraversion: 'high' as const, openness: 'moderate' as const };
    expect(renderPersonalitySection(traits, { bands })).toBe(`${PERSONALITY_SECTION_HEADING}\n\n${lines({ bands }).join('\n')}`);
  });

  it('refuses a register that is neither conversation nor writing, as the section does', () => {
    expect(() => renderPersonalityDirectives({}, { register: 'Writing' as never })).toThrow(TypeError);
  });

  it('reads the register once in the section, so writing lines always come with their grounding rule', () => {
    // A JavaScript caller's options may answer a getter differently on each read.
    let reads = 0;
    const options = {
      get register() {
        reads += 1;
        return reads === 1 ? 'writing' : 'conversation';
      },
    } as PersonalityRenderOptions;

    expect(renderPersonalitySection({ honesty: 0.9 }, options)).toBe(renderPersonalitySection({ honesty: 0.9 }, { register: 'writing' }));
    expect(reads).toBe(1);
  });

  it('is exported from the package root and the substrate barrel', () => {
    expect(root.renderPersonalityDirectives).toBe(renderPersonalityDirectives);
    expect(substrate.renderPersonalityDirectives).toBe(renderPersonalityDirectives);
  });
});
