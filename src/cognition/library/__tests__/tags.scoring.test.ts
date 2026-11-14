/**
 * @fileoverview The scoring harness of the tag suggestion module. It loads the library entry and the browser entry,
 * scores each part of the module that an entry exports on the fixture texts under `tests/fixtures/tags/`, and writes
 * `report.json` to `TAGS_REPORT_DIR` (the system's temporary folder when unset), which `scripts/tags/summary.mjs`
 * prints as a table. A part no entry exports is reported as the word `missing`, never as a number and never as a pass.
 * A part an entry exports with no scorer written here fails the run, so a part ships with its scorer and its hard check.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The scoring job's report, one member a part of the module. Figures carry no threshold; the hard checks (quotes found,
 * nothing refused proposed, no asked tag in an answer, the browser entry's import graph, the model input's bytes) fail
 * the job in the test that computes them.
 */
export interface TagsReport {
  /** The engine's revision the scores were taken on. */
  engine: number | 'missing';
  /** Step 1, candidates from the text's own words: the shortlist's recall apart from the final choices. */
  step1: { cases: number; shortlistRecall: number; existingRecall: number; newRecall: number; precision: number } | 'missing';
  /** Step 3, the model proposer: needs a key, and is missing without one. */
  step3: { cases: number; existingRecall: number; newRecall: number; precision: number; cut: number } | 'missing';
  /** Proposals shown and those whose quotes were found word for word in their text. */
  quotes: { proposals: number; found: number } | 'missing';
  /** The refusal list and the name check: cases scored, and words or names proposed that should not be. */
  refusals: { cases: number; leaked: number } | 'missing';
  /** The language check: cases scored and cases answered right. */
  language: { cases: number; right: number } | 'missing';
  /** Injection fixtures: cases scored, and answers holding a tag the text asked for. */
  injection: { cases: number; leaked: number } | 'missing';
  /** The browser entry's import graph reaching no network module and no Node module. */
  browserGraph: 'pass' | 'missing';
  /** The model input's bound on the bytes fixtures: its largest input in bytes, and in tokens where a key reads them. */
  bytes: { cases: number; mostBytes: number; mostTokens: number | 'missing' } | 'missing';
  /** The extractor's time on a long text made from the plain set. */
  timing: { chars: number; ms: number } | 'missing';
}

/** The two entries of the module, as their namespaces. */
interface TagEntries {
  library: Record<string, unknown>;
  browser: Record<string, unknown>;
}

/** One part of the report: the exports it needs and, once written, its scorer. */
interface TagPart<K extends keyof TagsReport> {
  key: K;
  needs: ReadonlyArray<{ entry: keyof TagEntries; name: string }>;
  score?: (entries: TagEntries) => Promise<Exclude<TagsReport[K], 'missing'>>;
}

type AnyPart = { [K in keyof TagsReport]: TagPart<K> }[keyof TagsReport];

const library = (name: string) => ({ entry: 'library' as const, name });
const browser = (name: string) => ({ entry: 'browser' as const, name });

/**
 * The parts in the report's order. The task that adds a part's export adds its scorer here and replaces the part's
 * `missing` in the expectation below with its figures and its hard check.
 */
const PARTS: AnyPart[] = [
  { key: 'engine', needs: [library('TAG_ENGINE_REVISION')] },
  { key: 'step1', needs: [library('extractTagCandidates')] },
  { key: 'step3', needs: [library('modelTagProposer')] },
  { key: 'quotes', needs: [library('findTagQuotes')] },
  { key: 'refusals', needs: [library('refusalOf')] },
  { key: 'language', needs: [library('tagLanguageOf')] },
  { key: 'injection', needs: [library('modelTagProposer')] },
  { key: 'browserGraph', needs: [browser('suggestTags')] },
  { key: 'bytes', needs: [library('tagModelInput')] },
  { key: 'timing', needs: [library('extractTagCandidates')] },
];

async function loadEntries(): Promise<TagEntries> {
  return {
    library: (await import('../index.js')) as unknown as Record<string, unknown>,
    browser: (await import('../browser.js')) as unknown as Record<string, unknown>,
  };
}

/**
 * Scores each part whose exports exist and reports `missing` for each part that lacks one.
 *
 * @throws When an entry exports what a part needs and the harness holds no scorer for that part.
 */
async function buildReport(entries: TagEntries): Promise<TagsReport> {
  const report: Partial<Record<keyof TagsReport, unknown>> = {};
  for (const part of PARTS) {
    const present = part.needs.filter((need) => entries[need.entry][need.name] !== undefined);
    if (present.length < part.needs.length) {
      report[part.key] = 'missing';
      continue;
    }
    if (!part.score) {
      const names = present.map((need) => `${need.entry}.${need.name}`).join(', ');
      throw new Error(`The entries export ${names}, and the harness holds no scorer for "${part.key}"`);
    }
    report[part.key] = await part.score(entries);
  }
  return report as TagsReport;
}

function writeReport(report: TagsReport): string {
  const dir = process.env.TAGS_REPORT_DIR ?? tmpdir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'report.json');
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}

describe('the tag suggestion scores', () => {
  it('reports each part the module lacks as missing, never as a number', async () => {
    const report = await buildReport(await loadEntries());
    const file = writeReport(report);
    expect(report).toEqual({
      engine: 'missing',
      step1: 'missing',
      step3: 'missing',
      quotes: 'missing',
      refusals: 'missing',
      language: 'missing',
      injection: 'missing',
      browserGraph: 'missing',
      bytes: 'missing',
      timing: 'missing',
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(report);
    // An export with no scorer behind it fails the run instead of reading as a figure or a pass.
    await expect(buildReport({ library: { findTagQuotes: () => [] }, browser: {} })).rejects.toThrow(
      'the harness holds no scorer for "quotes"',
    );
  });
});
