/**
 * @fileoverview The fixture texts of the tag suggestion tests: their shape, their loader and a long text made from
 * them. The texts live under `tests/fixtures/tags/` at the repository's root, one JSON object a file, each written for
 * that folder and holding no person's content (its README says how a case is added). A long text is made on demand by
 * {@link longFixture}, so no file of a million characters is stored.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** The folder of the fixture texts: `tests/fixtures/tags/` at the repository's root. */
export const TAG_FIXTURES_DIR = fileURLToPath(new URL('../../../../tests/fixtures/tags/', import.meta.url));

/**
 * The sets of fixture texts, each a folder under {@link TAG_FIXTURES_DIR}, with the number of files each holds:
 * `plain` work documents, `sessions` transcripts with a report's tags, `sensitive` texts holding words and names no
 * step may propose, `languages` one text in each of ten languages other than English, `injection` texts holding a
 * passage that asks a model for a tag, and `bytes` texts that pass an estimate of tokens by characters.
 */
export const TAG_FIXTURE_SETS = {
  plain: 20,
  sessions: 10,
  sensitive: 10,
  languages: 10,
  injection: 5,
  bytes: 4,
} as const;

/** The name of one set of fixture texts. */
export type TagFixtureSet = keyof typeof TAG_FIXTURE_SETS;

const SET_NAMES = Object.keys(TAG_FIXTURE_SETS) as [TagFixtureSet, ...TagFixtureSet[]];

/** One label of a fixture's vocabulary: the person's own spelling, how many items hold it and when one last did. */
const TagFixtureUse = z.strictObject({
  label: z.string().min(1),
  uses: z.number().int().nonnegative(),
  lastUsed: z.number().int().nonnegative().nullable(),
});

/** One tag of a session's report, with the words of the transcript it rests on. */
const TagFixtureReportTag = z.strictObject({
  label: z.string().min(1),
  quotes: z.array(z.string().min(1)).min(1),
});

/**
 * The shape of one fixture text, strict, so a misspelt member fails the parse instead of being read as absent.
 *
 * - `id`: the file's name without `.json`, lower case words joined by hyphens, unique across the sets.
 * - `set`: the folder that holds the file.
 * - `kind`: the kind of item the text stands for.
 * - `language`: the language detector's ISO 639-1 code for the text (`en` for English), or `und` where it has none.
 * - `title`, `headings`, `path`: what a host passes beside the text; `path` is null where the item has none.
 * - `text`: the text itself.
 * - `vocabulary`: the labels the person has used, with their counts; `typed` the labels they typed themselves.
 * - `expected`: the keys (in `tagKey`'s form) a good answer holds, from the vocabulary (`existing`) and new (`new`).
 * - `mustNot`: words and names no step may propose as a new tag.
 * - `asks`: the tag an injection fixture's text asks a model for.
 * - `report`: a session's report tags with their quotes; some quotes are absent from the text on purpose.
 */
export const TagFixture = z.strictObject({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  set: z.enum(SET_NAMES),
  kind: z.enum(['document', 'session']),
  language: z.string().regex(/^(?:[a-z]{2}|und)$/),
  title: z.string(),
  headings: z.array(z.string()),
  path: z.string().min(1).nullable(),
  text: z.string().min(1),
  vocabulary: z.array(TagFixtureUse),
  typed: z.array(z.string().min(1)),
  expected: z.strictObject({
    existing: z.array(z.string().min(1)),
    new: z.array(z.string().min(1)),
  }),
  mustNot: z.array(z.string().min(1)),
  asks: z.array(z.string().min(1)),
  report: z.array(TagFixtureReportTag).optional(),
});

/** One fixture text, as {@link TagFixture} parses it. */
export type TagFixture = z.infer<typeof TagFixture>;

/** One case of the label check: a label, the quotes it would rest on, and whether the quotes hold the label. */
export const TagLabelCase = z.strictObject({
  label: z.string().min(1),
  quotes: z.array(z.string().min(1)).min(1),
  held: z.boolean(),
  why: z.string().min(1),
});

/** One case of the label check, as {@link TagLabelCase} parses it. */
export type TagLabelCase = z.infer<typeof TagLabelCase>;

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function setFiles(set: TagFixtureSet): string[] {
  let names: string[];
  try {
    names = readdirSync(join(TAG_FIXTURES_DIR, set));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.endsWith('.json')).sort();
}

/**
 * Reads the fixture texts of one set, or of every set when none is named, sorted by set and then by file name.
 * Each file is parsed by {@link TagFixture}; a file whose `id` is not its name, or whose `set` is not its folder,
 * throws, as does a file that does not parse. A set whose folder is absent reads as no fixtures.
 *
 * @param set - The set to read; every set in {@link TAG_FIXTURE_SETS}' order when omitted.
 * @returns The parsed fixtures.
 */
export function loadTagFixtures(set?: string): TagFixture[] {
  const sets = set === undefined ? SET_NAMES : [z.enum(SET_NAMES).parse(set)];
  const fixtures: TagFixture[] = [];
  for (const name of sets) {
    for (const file of setFiles(name)) {
      const where = `${name}/${file}`;
      const parsed = TagFixture.safeParse(readJson(join(TAG_FIXTURES_DIR, name, file)));
      if (!parsed.success) throw new Error(`${where} does not parse: ${parsed.error.message}`);
      if (`${parsed.data.id}.json` !== file) throw new Error(`${where} holds the id ${parsed.data.id}`);
      if (parsed.data.set !== name) throw new Error(`${where} names the set ${parsed.data.set}`);
      fixtures.push(parsed.data);
    }
  }
  return fixtures;
}

/**
 * Reads the label check's cases from `label-cases.json`.
 *
 * @returns The parsed cases in the file's order; none when the file is absent.
 */
export function loadLabelCases(): TagLabelCase[] {
  let raw: unknown;
  try {
    raw = readJson(join(TAG_FIXTURES_DIR, 'label-cases.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return z.array(TagLabelCase).parse(raw);
}

/**
 * Makes a text of exactly `chars` UTF-16 code units from the `plain` set's paragraphs, each paragraph opened by a
 * counter (`[1] `, `[2] `, ...) so no two repeats are the same text. It is written text, made when a test needs it
 * (the extractor's timing reads a million characters), and never stored.
 *
 * @param chars - The length of the text, a non-negative integer.
 * @returns The text.
 */
export function longFixture(chars: number): string {
  if (!Number.isInteger(chars) || chars < 0) throw new RangeError(`longFixture needs a non-negative integer, not ${chars}`);
  const paragraphs = loadTagFixtures('plain')
    .flatMap((fixture) => fixture.text.split(/\n\s*\n/))
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  if (paragraphs.length === 0) throw new Error('longFixture needs the plain set, which holds no paragraph');
  const parts: string[] = [];
  let length = 0;
  for (let counter = 1; length < chars; counter += 1) {
    const part = `[${counter}] ${paragraphs[(counter - 1) % paragraphs.length]}\n\n`;
    parts.push(part);
    length += part.length;
  }
  const text = parts.join('').slice(0, chars);
  // A cut between the two halves of a surrogate pair would leave a lone half; a space takes its place.
  return /[\uD800-\uDBFF]$/.test(text) ? `${text.slice(0, -1)} ` : text;
}
