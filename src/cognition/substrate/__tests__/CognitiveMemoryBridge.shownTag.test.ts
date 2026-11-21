/**
 * The memory block a turn that sends the model no user id shows: the user's id is left out of every tag list its
 * structured lines show, a trace an earlier turn or an earlier release tagged with it included, and nothing else of the
 * block changes.
 */
import { describe, expect, it } from 'vitest';
import { withoutShownTag } from '../CognitiveMemoryBridge';

const line = (content: string, tags: string) =>
  `- [episodic] ${content} (just now, 2026-11-21 | moderate confidence | relevance: 0.22 | tags: ${tags})`;

describe('withoutShownTag', () => {
  it.each([
    ['the last tag', 'user, aria-1, u-42', 'user, aria-1'],
    ['the first tag', 'u-42, user, aria-1', 'user, aria-1'],
    ['a middle tag', 'assistant, u-42, aria-1', 'assistant, aria-1'],
  ])('leaves the id out when it is %s', (_case, tags, kept) => {
    expect(withoutShownTag(line('Who am I?', tags), 'u-42')).toBe(line('Who am I?', kept));
  });

  it('drops a tag list that held the id alone, and keeps the rest of the line', () => {
    expect(withoutShownTag(line('Who am I?', 'u-42'), 'u-42')).toBe(
      '- [episodic] Who am I? (just now, 2026-11-21 | moderate confidence | relevance: 0.22)',
    );
  });

  it('changes every line of a block, and no tag that only contains the id', () => {
    const block = ['## Memories', line('One.', 'user, aria-1, u-42'), line('Two.', 'assistant, u-42-old'), line('Three.', 'u-42')].join('\n');
    expect(withoutShownTag(block, 'u-42')).toBe(
      [
        '## Memories',
        line('One.', 'user, aria-1'),
        line('Two.', 'assistant, u-42-old'),
        '- [episodic] Three. (just now, 2026-11-21 | moderate confidence | relevance: 0.22)',
      ].join('\n'),
    );
  });

  it("leaves the id where a memory's own words hold it, and an id that holds a pattern's characters is matched as text", () => {
    const words = line('My login is u.42+x', 'user, u.42+x');
    expect(withoutShownTag(words, 'u.42+x')).toBe(line('My login is u.42+x', 'user'));
    expect(withoutShownTag(line('Hi.', 'user, u-42'), 'u.42')).toBe(line('Hi.', 'user, u-42'));
  });

  it('returns a block that holds no such tag as it was', () => {
    const block = line('Hi.', 'user, aria-1');
    expect(withoutShownTag(block, 'u-42')).toBe(block);
    expect(withoutShownTag(block, '')).toBe(block);
  });
});
