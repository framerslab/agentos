/**
 * @fileoverview Integration tests for the bundled platform knowledge corpus.
 *
 * These tests exercise the REAL `knowledge/platform-corpus.json` file (not
 * mocked) to verify structural integrity, category coverage, specific entry
 * existence, and keyword-based searchability.
 *
 * No LLM calls or embedding APIs are needed — all assertions are against the
 * static corpus file and the KeywordFallback engine.
 *
 * @module @framers/agentos/query-router/__tests__/platform-knowledge.integration
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeAll } from 'vitest';

import { KeywordFallback } from '../KeywordFallback.js';
import type { CorpusChunk } from '../types.js';

// ---------------------------------------------------------------------------
// Locate the real platform corpus
// ---------------------------------------------------------------------------

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Candidate paths where the corpus file may live relative to this test file. */
const CORPUS_CANDIDATES = [
  // From src/orchestration/pipeline/query/__tests__/ -> package-root/knowledge/
  resolve(MODULE_DIR, '../../../../../knowledge/platform-corpus.json'),
  // Legacy shallower layouts, kept as fallbacks.
  resolve(MODULE_DIR, '../../../../knowledge/platform-corpus.json'),
  resolve(MODULE_DIR, '../../../knowledge/platform-corpus.json'),
];

/** Resolved path to the platform corpus, or null if not found. */
const corpusPath = CORPUS_CANDIDATES.find((p) => existsSync(p)) ?? null;

/**
 * The `tools` and `skills` corpus categories are sourced from sibling packages
 * (`agentos-extensions-registry`, `agentos-skills`) at corpus-build time. In standalone
 * CI those siblings are absent, so `scripts/build-knowledge-corpus.mjs` emits only the
 * static `faq`/`api`/`troubleshooting` entries (~68 rows, 3 categories). Assertions that
 * require sibling-sourced content — the ≥200-entry count, the full 5-category set, and the
 * `document-export` tool reference — can only hold against the full monorepo corpus, so we
 * skip them when the corpus is partial. They still run locally where the siblings exist.
 */
const FULL_CORPUS = (() => {
  if (!corpusPath) return false;
  try {
    const cats = new Set(
      (JSON.parse(readFileSync(corpusPath, 'utf-8')) as PlatformCorpusEntry[]).map((e) => e.category),
    );
    return cats.has('tools') && cats.has('skills');
  } catch {
    return false;
  }
})();

/** Runs an assertion only when the full (sibling-sourced) corpus is present. */
const itIfFull = FULL_CORPUS ? it : it.skip;

// ---------------------------------------------------------------------------
// Types for raw corpus entries
// ---------------------------------------------------------------------------

interface PlatformCorpusEntry {
  id: string;
  heading: string;
  content: string;
  category: string;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Platform Knowledge Corpus — integration', () => {
  let entries: PlatformCorpusEntry[];
  let chunks: CorpusChunk[];
  let fallback: KeywordFallback;

  beforeAll(() => {
    expect(corpusPath).not.toBeNull();
    const raw = readFileSync(corpusPath!, 'utf-8');
    entries = JSON.parse(raw) as PlatformCorpusEntry[];

    // Convert to CorpusChunk format (same transform as QueryRouter.loadPlatformKnowledge)
    chunks = entries.map((entry) => ({
      id: entry.id,
      heading: entry.heading,
      content: entry.content,
      sourcePath: `platform:${entry.category}/${entry.id}`,
    }));

    fallback = new KeywordFallback(chunks);
  });

  // =========================================================================
  // Structural integrity
  // =========================================================================

  itIfFull('contains at least 200 entries', () => {
    expect(entries.length).toBeGreaterThanOrEqual(200);
  });

  itIfFull('has all 5 expected categories', () => {
    const categories = new Set(entries.map((e) => e.category));
    expect(categories).toContain('tools');
    expect(categories).toContain('skills');
    expect(categories).toContain('faq');
    expect(categories).toContain('api');
    expect(categories).toContain('troubleshooting');
  });

  it('every entry has non-empty id, heading, content, and category', () => {
    for (const entry of entries) {
      expect(entry.id).toBeTruthy();
      expect(entry.heading).toBeTruthy();
      expect(entry.content).toBeTruthy();
      expect(entry.category).toBeTruthy();
    }
  });

  // =========================================================================
  // Specific entry existence
  // =========================================================================

  it('contains the generateText() API entry', () => {
    const match = entries.find((e) => e.id === 'api:generateText');
    expect(match).toBeDefined();
    expect(match!.heading).toContain('generateText');
    expect(match!.category).toBe('api');
  });

  it('contains the "How do I add voice?" FAQ entry', () => {
    const match = entries.find((e) => e.id === 'faq:add-voice');
    expect(match).toBeDefined();
    expect(match!.heading.toLowerCase()).toContain('voice');
    expect(match!.category).toBe('faq');
  });

  itIfFull('contains the document-export tool reference', () => {
    const match = entries.find((e) => e.id === 'tool-ref:com.framers.productivity.document-export');
    expect(match).toBeDefined();
    expect(match!.category).toBe('tools');
  });

  it('contains the streamText() API entry', () => {
    const match = entries.find((e) => e.id === 'api:streamText');
    expect(match).toBeDefined();
    expect(match!.heading).toContain('streamText');
    expect(match!.category).toBe('api');
  });

  it('contains the "What models are supported?" FAQ entry', () => {
    const match = entries.find((e) => e.id === 'faq:supported-models');
    expect(match).toBeDefined();
    expect(match!.category).toBe('faq');
  });

  // =========================================================================
  // Keyword fallback search
  // =========================================================================

  itIfFull('finds document-export when searching "PDF generation"', () => {
    const results = fallback.search('PDF generation document export', 10);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const hasDocExport = ids.some(
      (id) => id.includes('document-export') || id.includes('pdf')
    );
    expect(hasDocExport).toBe(true);
  });

  it('finds FAQ entry when searching "what models are supported"', () => {
    const results = fallback.search('what models are supported', 10);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const hasFaq = ids.some((id) => id.includes('faq:'));
    expect(hasFaq).toBe(true);
  });

  it('finds streamText API entry when searching "streaming"', () => {
    const results = fallback.search('streaming text generation', 10);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const hasStream = ids.some(
      (id) => id.includes('streamText') || id.includes('streaming')
    );
    expect(hasStream).toBe(true);
  });

  it('finds voice-related entries when searching "voice pipeline"', () => {
    const results = fallback.search('voice pipeline speech recognition', 10);
    expect(results.length).toBeGreaterThan(0);
    const ids = results.map((r) => r.id);
    const hasVoice = ids.some(
      (id) => id.includes('voice') || id.includes('stt') || id.includes('tts')
    );
    expect(hasVoice).toBe(true);
  });

  it('returns results with valid relevance scores', () => {
    const results = fallback.search('authentication tokens', 5);
    for (const result of results) {
      expect(result.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(result.relevanceScore).toBeLessThanOrEqual(1);
    }
  });
});
