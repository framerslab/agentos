// An application's use of the packed package's tags module: it imports @framers/agentos/cognition/library/tags, the
// subpath the package's "./*" export serves, compiles against the installed declarations alone and runs with network
// access refused. Every document, tag and count in it is synthetic. scripts/tags-package.test.mjs installs and runs it.
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import type { LegacyTagClass, TagDocument, TagResolution, TagUse } from '@framers/agentos/cognition/library/tags';

const refuse = (): never => { throw new Error('the tags module attempted network access'); };
net.Socket.prototype.connect = refuse; http.request = refuse; http.get = refuse;
https.request = refuse; https.get = refuse; globalThis.fetch = refuse; syncBuiltinESMExports();

const tags = await import('@framers/agentos/cognition/library/tags');

let passed = 0;
/** Runs one item and names it in the log, so a failure says which behaviour broke. */
function item(name: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    throw new Error(`tags consumer: ${name}`, { cause: error });
  }
  passed += 1;
  console.log(`ok - ${name}`);
}

/** A document as an application keeps one; its tags, its kind and its latest change are what the vocabulary reads. */
const doc = (id: string, kind: TagDocument['kind'], labels: string[], changedAt: number | null): TagDocument =>
  ({ id, kind, title: `Document ${id}`, text: 'Synthetic text.', keywords: [], tags: labels, changedAt });
/** A vocabulary row as an application may keep one in its own store. */
const use = (tag: string, uses: number, lastUsed: number | null): TagUse => ({ tag, uses, notes: uses, sessions: 0, lastUsed });

/** Reads a resolution through its declared union, which the compiler checks is whole. */
function describeResolution(resolution: TagResolution): string {
  switch (resolution.kind) {
    case 'existing':
      return `${resolution.from} -> ${resolution.tag} by ${resolution.via}`;
    case 'new':
      return `${resolution.from} -> new ${resolution.tag}`;
    default: {
      const unreachable: never = resolution;
      return unreachable;
    }
  }
}

item('the subpath serves every value the module declares', () => {
  // Each name is read through the installed declarations, so one they lack fails the compile before this runs.
  for (const name of ['isTag', 'normalizeTag', 'tagKey', 'canonicalTag', 'classifyLegacyTag', 'compareCodePoints',
    'tagKeysOf', 'tagVocabulary', 'preferredTagOrder', 'resolveTag'] as const) {
    assert.equal(typeof tags[name], 'function', name);
  }
  assert.equal(tags.TAG_MAX_CHARS, 40);
  assert.equal(tags.TAGS_MAX, 20);
  assert.equal(tags.TAG_SUGGESTIONS_MAX, 5);
});

item('normalizeTag makes typing a tag: folded, one hyphen for each run of other characters and none at either end', () => {
  assert.equal(tags.normalizeTag('Q3 Planning!'), 'q3-planning');
  assert.equal(tags.normalizeTag('  BUDGET '), 'budget');
  assert.equal(tags.normalizeTag('--Road -- map--'), 'road-map');
  assert.equal(tags.normalizeTag('Café'), 'café');
  assert.equal(tags.normalizeTag('Ｂｕｄｇｅｔ'), 'budget');
  assert.equal(tags.normalizeTag('ΟΣ-Α'), 'ος-α');
});

item('normalizeTag refuses rather than cuts: 40 code points at most, counted as code points', () => {
  assert.equal(tags.normalizeTag('a'.repeat(40)), 'a'.repeat(40));
  assert.equal(tags.normalizeTag('a'.repeat(41)), null);
  assert.equal(tags.normalizeTag(`${'a'.repeat(20)} ${'b'.repeat(20)}`), null);
  assert.equal(tags.normalizeTag('\u{20000}'.repeat(40)), '\u{20000}'.repeat(40));
  assert.equal(tags.normalizeTag('\u{20000}'.repeat(41)), null);
  for (const empty of ['', '   ', '!!!', '\u{1F600}', '́']) assert.equal(tags.normalizeTag(empty), null, JSON.stringify(empty));
});

item('one spelling per key: canonicalTag is exactly tagKey, so q3-planning and q3planning are one tag', () => {
  for (const typed of ['Q3 Planning!', 'q3-planning', 'q3planning', 'Q3_PLANNING', 'q3 – planning']) {
    assert.equal(tags.canonicalTag(typed), 'q3planning', typed);
    assert.equal(tags.tagKey(typed), 'q3planning', typed);
  }
  for (const typed of ['ΟΣ-Α', 'ΟΣΑ', 'ος α', 'οσα']) {
    assert.equal(tags.canonicalTag(typed), 'οσα', typed);
  }
  for (const typed of ['ΛΟΓΟΣ', 'λογοσ']) {
    assert.equal(tags.canonicalTag(typed), 'λογος', typed);
  }
  assert.equal(tags.canonicalTag('가 ᆨ'), '각');
  assert.equal(tags.canonicalTag('किताब'), 'किताब');
  assert.equal(tags.canonicalTag('كِتَاب'), 'كِتَاب');
  assert.equal(tags.canonicalTag('\u{1D400}\u{1D401}'), 'ab');
  assert.equal(tags.canonicalTag('\u{20000}\u{20001}'), '\u{20000}\u{20001}');
  assert.equal(tags.canonicalTag('r'), 'r');
  for (const input of ['Q3 Planning!', '!!!', '', 'ΟΣ-Α', 'a'.repeat(41)]) {
    assert.equal(tags.canonicalTag(input), tags.tagKey(input), JSON.stringify(input));
  }
  for (const typed of ['Q3 Planning!', 'Ｂudget', 'Café', '가 ᆨ', 'ᄀ-ᅡ', 'ΟΣ-Α']) {
    assert.equal(tags.isTag(tags.canonicalTag(typed) ?? ''), true, typed);
  }
});

item('isTag reads a tag as stored or typed', () => {
  for (const tag of ['budget', 'q3-planning', 'q3planning', 'café', 'किताब', 'r', '\u{20000}', 'a'.repeat(40)]) {
    assert.equal(tags.isTag(tag), true, tag);
  }
  for (const text of ['', 'Budget', 'q3--planning', '-budget', 'budget-', 'café', '́a', 'a b', 'a'.repeat(41), 'c++', 'budget\n']) {
    assert.equal(tags.isTag(text), false, JSON.stringify(text));
  }
});

item('classifyLegacyTag keeps a stored label: an alias only by case, normalization and separators', () => {
  const alias = (key: string): LegacyTagClass => ({ state: 'alias', key });
  const unresolved = (key: string | null): LegacyTagClass => ({ state: 'unresolved', key });
  assert.deepEqual(tags.classifyLegacyTag('Q3 Planning'), alias('q3planning'));
  assert.deepEqual(tags.classifyLegacyTag('q3_planning'), alias('q3planning'));
  assert.deepEqual(tags.classifyLegacyTag('q3–planning'), alias('q3planning'));
  assert.deepEqual(tags.classifyLegacyTag('Ｂudget'), alias('budget'));
  assert.deepEqual(tags.classifyLegacyTag(' Budget '), alias('budget'));
  assert.deepEqual(tags.classifyLegacyTag('C'), alias('c'));
  assert.deepEqual(tags.classifyLegacyTag('C++'), unresolved('c'));
  assert.deepEqual(tags.classifyLegacyTag('C#'), unresolved('c'));
  assert.deepEqual(tags.classifyLegacyTag('budget.'), unresolved('budget'));
  assert.deepEqual(tags.classifyLegacyTag('\u{1F3AF} goals'), unresolved('goals'));
  for (const label of ['!!!', 'x'.repeat(41), '']) assert.deepEqual(tags.classifyLegacyTag(label), unresolved(null), JSON.stringify(label));
});

item('compareCodePoints orders by code point, where the default sort orders by UTF-16 unit', () => {
  assert.ok(tags.compareCodePoints('\u{1F600}', '｡') > 0);
  assert.deepEqual(['｡', '\u{1F600}'].sort(), ['\u{1F600}', '｡']);
  assert.deepEqual(['\u{1F600}', '｡'].sort(tags.compareCodePoints), ['｡', '\u{1F600}']);
  assert.ok(tags.compareCodePoints('ab', 'abc') < 0);
  assert.equal(tags.compareCodePoints('b', 'b'), 0);
});

const documents: TagDocument[] = [
  doc('n1', 'note', ['budget', 'Budget', 'q3-planning'], 10),
  doc('n2', 'note', ['budget', 'alpha'], 30),
  doc('s1', 'session', ['q3planning', 'roadmap'], 20),
  doc('n3', 'note', ['C++', 'C#'], 40),
  doc('n4', 'note', [], null),
  doc('s2', 'session', ['Road map'], null),
];

item('tagKeysOf gives a document its keys once each, in order, and none for an unresolved label', () => {
  assert.deepEqual(tags.tagKeysOf({ tags: ['Budget', 'q3-planning', 'C++', 'budget', 'q3 Planning'] }), ['budget', 'q3planning']);
  assert.deepEqual(tags.tagKeysOf(documents[3]!), []);
});

let vocabulary: TagUse[] = [];
item('tagVocabulary counts each document once a key, by kind, with its latest change; most used first, ties by code point', () => {
  function* stream(): Generator<TagDocument> {
    yield* documents;
  }
  vocabulary = tags.tagVocabulary(stream());
  assert.deepEqual(vocabulary, [
    { tag: 'budget', uses: 2, notes: 2, sessions: 0, lastUsed: 30 },
    { tag: 'q3planning', uses: 2, notes: 1, sessions: 1, lastUsed: 20 },
    { tag: 'roadmap', uses: 2, notes: 0, sessions: 2, lastUsed: 20 },
    { tag: 'alpha', uses: 1, notes: 1, sessions: 0, lastUsed: 30 },
  ]);
  assert.equal(vocabulary.some((row) => row.tag === 'c'), false);
  assert.deepEqual(tags.tagVocabulary([]), []);
});

item('preferredTagOrder: the most used, then the latest used with never used last, then the first by code point', () => {
  const rows = [use('a', 1, 50), use('b', 2, 1), use('c', 2, 9), use('d', 2, null), use('e', 2, 9)];
  assert.deepEqual(rows.sort(tags.preferredTagOrder).map((row) => row.tag), ['c', 'e', 'b', 'd', 'a']);
});

item('resolveTag by key, whatever the spelling, against the vocabulary the documents give', () => {
  assert.deepEqual(tags.resolveTag('Q3 Planning', vocabulary), { kind: 'existing', tag: 'q3planning', via: 'key', from: 'Q3 Planning' });
  assert.deepEqual(tags.resolveTag('road-map', vocabulary), { kind: 'existing', tag: 'roadmap', via: 'key', from: 'road-map' });
  assert.deepEqual(tags.resolveTag('Road map', vocabulary), { kind: 'existing', tag: 'roadmap', via: 'key', from: 'Road map' });
});

item('resolveTag by stem for one spaced word, and not for a hyphenated one', () => {
  assert.deepEqual(tags.resolveTag('Budgets', vocabulary), { kind: 'existing', tag: 'budget', via: 'stem', from: 'Budgets' });
  assert.deepEqual(tags.resolveTag('roadmaps', vocabulary), { kind: 'existing', tag: 'roadmap', via: 'stem', from: 'roadmaps' });
  assert.deepEqual(tags.resolveTag('road-maps', vocabulary), { kind: 'existing', tag: 'roadmap', via: 'edit', from: 'road-maps' });
});

item('resolveTag one edit away only for keys of five code points or more, with the same digits, in a spaced script', () => {
  assert.deepEqual(tags.resolveTag('budgte', vocabulary), { kind: 'existing', tag: 'budget', via: 'edit', from: 'budgte' });
  const kept = [use('roadmap', 5, 100), use('q3', 3, 50), use('budget', 9, 10), use('2025budget', 1, 1), use('会議', 4, 1), use('plan', 1, 1)];
  assert.deepEqual(tags.resolveTag('Q3', kept), { kind: 'existing', tag: 'q3', via: 'key', from: 'Q3' });
  assert.deepEqual(tags.resolveTag('budgets', kept), { kind: 'existing', tag: 'budget', via: 'stem', from: 'budgets' });
  assert.deepEqual(tags.resolveTag('roadmaps', kept), { kind: 'existing', tag: 'roadmap', via: 'stem', from: 'roadmaps' });
  assert.deepEqual(tags.resolveTag('budgte', kept), { kind: 'existing', tag: 'budget', via: 'edit', from: 'budgte' });
  assert.equal(tags.resolveTag('!!!', kept), null);
  assert.deepEqual(tags.resolveTag('q4', kept), { kind: 'new', tag: 'q4', from: 'q4' });
  assert.deepEqual(tags.resolveTag('2026budget', kept), { kind: 'new', tag: '2026budget', from: '2026budget' });
  assert.deepEqual(tags.resolveTag('play', kept), { kind: 'new', tag: 'play', from: 'play' });
  assert.deepEqual(tags.resolveTag('会义', kept), { kind: 'new', tag: '会义', from: '会义' });
});

item('resolveTag takes the most used, then the latest used, then the first by code point among several matches', () => {
  assert.equal(tags.resolveTag('abcdz', [use('abcdx', 2, 5), use('abcdy', 2, 5), use('abcdw', 3, 1)])?.tag, 'abcdw');
  assert.equal(tags.resolveTag('abcdz', [use('abcdx', 2, 5), use('abcdy', 2, 9)])?.tag, 'abcdy');
  assert.equal(tags.resolveTag('abcdz', [use('abcdy', 2, 5), use('abcdx', 2, 5)])?.tag, 'abcdx');
  assert.deepEqual(tags.resolveTag('budgeted', [use('budget', 1, 9), use('budgets', 3, 1)]), { kind: 'existing', tag: 'budgets', via: 'stem', from: 'budgeted' });
  assert.equal(tags.resolveTag('budgeted', [use('budget', 2, 5), use('budgets', 2, 9)])?.tag, 'budgets');
  assert.equal(tags.resolveTag('budgeted', [use('budgets', 2, 5), use('budget', 2, 5)])?.tag, 'budget');
});

item('resolveTag leaves a new tag spelled as its key, keeps what was typed, and answers null where there is no key', () => {
  const fresh = tags.resolveTag('New Idea!', vocabulary);
  assert.deepEqual(fresh, { kind: 'new', tag: 'newidea', from: 'New Idea!' });
  assert.equal(fresh?.tag, tags.canonicalTag('New Idea!'));
  assert.equal(tags.isTag(fresh?.tag ?? ''), true);
  for (const nothing of ['!!!', '', '\u{1F600}', 'a'.repeat(41)]) assert.equal(tags.resolveTag(nothing, vocabulary), null, JSON.stringify(nothing));
});

item('the installed declarations type a resolution as a whole union', () => {
  const read = [tags.resolveTag('Road map', vocabulary), tags.resolveTag('New Idea!', vocabulary)]
    .map((resolution) => (resolution === null ? 'none' : describeResolution(resolution)));
  assert.deepEqual(read, ['Road map -> roadmap by key', 'New Idea! -> new newidea']);
});

console.log(`installed tags module passes: ${passed} items`);
