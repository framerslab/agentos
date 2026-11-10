/**
 * A soul's one mapping and its one id: the persona fields the front matter sets, the id every path keys the agent by,
 * and the check that refuses a front matter field of the wrong type.
 */
import { describe, expect, it } from 'vitest';
import { frontmatterToPersona, parseSoul, personaFieldsOf, soulAgentIdOf, SoulLoadError, validateSoulFrontmatter } from '../SoulLoader.js';
import { stableIdOfName } from '../stableId.js';

describe('personaFieldsOf', () => {
  const frontmatter = {
    name: 'Aria', agentId: 'aria-1', role: 'Support',
    hexaco: { honestyHumility: 0.9, openness: 0.2 },
    defaultMood: 'calm', allowedMoods: ['calm', 'warm'],
    hardLimits: ['Never name a diagnosis.'],
    reasoningTrace: { maxEntries: 7 },
    metadata: { team: 'care' },
  };

  it('sets the fields the mapping sets, and frontmatterToPersona adds only the version and the prompt', () => {
    const fields = personaFieldsOf(frontmatter);
    expect(fields).toMatchObject({
      id: 'aria-1', name: 'Aria', description: 'Support',
      personalityTraits: { honesty: 0.9, openness: 0.2 },
      moodAdaptation: { enabled: true, defaultMood: 'calm', allowedMoods: ['calm', 'warm'] },
      hardLimits: ['Never name a diagnosis.'],
      reasoningTraceConfig: { maxEntries: 7 },
      metadata: { team: 'care' },
    });
    expect(frontmatterToPersona(frontmatter, 'You are Aria.', 'Short sentences.')).toEqual({
      ...fields, version: '1.0.0', baseSystemPrompt: 'You are Aria.\n\n## Style\n\nShort sentences.',
    });
  });

  it('keeps the id of a soul with a name and no agentId as the slug of the name', () => {
    expect(personaFieldsOf({ name: 'Aria Stone' }).id).toBe('aria-stone');
  });
  it('gives the id soulAgentIdOf gives: a blank agentId reads as unset, a padded one is trimmed, a name with no Latin letters is hashed', () => {
    expect(personaFieldsOf({ agentId: '', name: 'Aria' }).id).toBe('aria');
    expect(personaFieldsOf({ agentId: ' aria-1 ', name: 'Aria' }).id).toBe('aria-1');
    expect(personaFieldsOf({ name: 'アリア' }).id).toBe(stableIdOfName('アリア'));
    expect(personaFieldsOf({}).id).toBe('unnamed-agent');
  });
});

describe('soulAgentIdOf', () => {
  it('takes agentId first, as given', () => {
    expect(soulAgentIdOf({ agentId: 'aria-1', name: 'Aria' }, 'Support')).toBe('aria-1');
  });
  it('takes the slug of the soul name when there is no agentId, whatever the agent is named', () => {
    expect(soulAgentIdOf({ name: 'Aria Stone' }, 'Support')).toBe('aria-stone');
  });
  it("takes the agent's name when the soul has neither, by the rule a named agent's id follows", () => {
    expect(soulAgentIdOf({}, 'Support Desk')).toBe('support-desk');
    expect(soulAgentIdOf({}, 'Zoë')).toBe(stableIdOfName('Zoë'));
  });
  it('trims a padded agentId', () => {
    expect(soulAgentIdOf({ agentId: ' aria-1 ', name: 'Aria' })).toBe('aria-1');
  });
  it('gives a soul name with no Latin letters or digits a stable id of its own, whatever the agent is named', () => {
    const id = stableIdOfName('アリア');
    expect(id).toMatch(/^agent-[0-9a-f]{12}$/);
    expect(soulAgentIdOf({ name: 'アリア' })).toBe(id);
    expect(soulAgentIdOf({ name: 'アリア' }, 'Support')).toBe(id);
  });
  it('keeps the slug a Latin soul name had, so an existing id does not move', () => {
    expect(soulAgentIdOf({ name: 'Zoë' })).toBe('zo');
  });
  it('is undefined when the soul has neither and the agent has no name, and for blank values', () => {
    expect(soulAgentIdOf({})).toBeUndefined();
    expect(soulAgentIdOf({ agentId: '  ', name: '  ' }, '  ')).toBeUndefined();
  });
  it('never answers a shared fallback id', () => {
    for (const id of [soulAgentIdOf({}), soulAgentIdOf({}, undefined)]) expect(id).not.toBe('agent');
  });
});

describe('validateSoulFrontmatter', () => {
  it('returns valid front matter, keeps unknown keys and drops a declared field set to null', () => {
    expect(validateSoulFrontmatter({ name: 'Aria', hardLimits: ['a'], role: null, custom: 1 })).toEqual({ name: 'Aria', hardLimits: ['a'], custom: 1 });
  });
  it.each([
    ['name', 42, 'a string'],
    ['agentId', 7, 'a string'],
    ['role', ['x'], 'a string'],
    ['defaultMood', {}, 'a string'],
    ['allowedMoods', 'calm', 'a list of strings'],
    ['hardLimits', 'never', 'a list of strings'],
    ['hardLimits', ['ok', 3], 'a list of strings'],
    ['voice', 'rachel', 'an object'],
    ['avatar', [], 'an object'],
    ['reasoningTrace', 42, 'an object'],
    ['metadata', 'x', 'an object'],
    ['hexaco', { openness: 'high' }, 'an object of numbers between 0 and 1'],
    ['hexaco', { openness: 1.5 }, 'an object of numbers between 0 and 1'],
  ])('refuses %s of the wrong type, naming the field', (field, value, expected) => {
    let thrown: unknown;
    try {
      validateSoulFrontmatter({ [field]: value }, '/souls/aria');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SoulLoadError);
    expect(thrown).toMatchObject({ name: 'SoulLoadError', code: 'SOUL_LOAD_FAILED', source: '/souls/aria' });
    expect((thrown as Error).message).toBe(`The soul failed to load (/souls/aria): front matter field '${field}' must be ${expected}`);
  });
  it.each([
    ['maxEntries', 'many'],
    ['maxMessageLength', '300'],
    ['maxEntries', Number.NaN],
    ['maxMessageLength', Number.POSITIVE_INFINITY],
  ])('refuses reasoningTrace.%s that is not a finite number (%s), naming the field', (member, value) => {
    expect(() => validateSoulFrontmatter({ reasoningTrace: { [member]: value } }, '/souls/aria')).toThrow(
      new SoulLoadError('/souls/aria', `front matter field 'reasoningTrace.${member}' must be a finite number`),
    );
  });
  it('reads a reasoningTrace member set to null (an empty YAML value) as unset', () => {
    expect(validateSoulFrontmatter({ reasoningTrace: { maxEntries: null, maxMessageLength: 40 } }).reasoningTrace).toEqual({ maxMessageLength: 40 });
  });
  it('is what parseSoul runs, with the inline source', () => {
    expect(() => parseSoul("---\nhardLimits: never\n---\nYou are Aria.")).toThrow("The soul failed to load (inline soul): front matter field 'hardLimits' must be a list of strings");
  });
});
