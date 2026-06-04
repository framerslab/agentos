/**
 * @fileoverview Tests for credential setup knowledge in the platform corpus.
 *
 * Validates that the bundled platform-corpus.json contains all FAQ entries
 * required for the agentic credential discovery flow (Gmail setup, extension
 * credentials, file discovery, wunderland connect reference) and that these
 * entries are surfaced through the KeywordFallback search engine.
 *
 * @module @framers/agentos/query-router/__tests__/credential-knowledge
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { KeywordFallback } from '../KeywordFallback.js';

// ---------------------------------------------------------------------------
// Corpus loading
// ---------------------------------------------------------------------------

/**
 * Candidate paths for the bundled platform knowledge corpus. This test lives at
 * `src/orchestration/pipeline/query/__tests__/`, so the package-root `knowledge/`
 * directory is five levels up. The shallower entries are kept as fallbacks for the
 * published `dist/` layout. A direct `readFileSync` on the wrong path throws ENOENT
 * at import time, which collapses the whole file to a "0 test" suite — hence the
 * `existsSync` probe and the `describe.skip` guard below.
 */
const CORPUS_CANDIDATES = [
  resolve(__dirname, '../../../../../knowledge/platform-corpus.json'),
  resolve(__dirname, '../../../../knowledge/platform-corpus.json'),
  resolve(__dirname, '../../../knowledge/platform-corpus.json'),
];

/** Resolved corpus path, or null when the generated corpus is unavailable. */
const corpusPath = CORPUS_CANDIDATES.find((p) => existsSync(p)) ?? null;

/** Parsed platform corpus entries (empty when the corpus is unavailable). */
const corpus: Array<{ id: string; heading: string; content: string; category: string }> =
  corpusPath ? JSON.parse(readFileSync(corpusPath, 'utf-8')) : [];

/** Run the suite only when the generated corpus is present. */
const describeIfCorpus = corpusPath ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Converts raw corpus entries into CorpusChunk-shaped objects suitable for
 * KeywordFallback. The sourcePath follows the convention `platform:<category>/<id>`.
 */
function toChunks() {
  return corpus.map((e) => ({
    id: e.id,
    heading: e.heading,
    content: e.content,
    sourcePath: `platform:${e.category}/${e.id}`,
  }));
}

// ---------------------------------------------------------------------------
// Tests — FAQ entry existence
// ---------------------------------------------------------------------------

describeIfCorpus('Credential setup knowledge in platform corpus', () => {
  it('contains Gmail setup FAQ', () => {
    const gmail = corpus.find((e) => e.id === 'faq:setup-gmail');
    expect(gmail).toBeDefined();
    expect(gmail!.content).toContain('client_secret');
    expect(gmail!.content).toContain('GOOGLE_CLIENT_ID');
  });

  it('contains general credential setup FAQ', () => {
    const general = corpus.find((e) => e.id === 'faq:setup-credentials-general');
    expect(general).toBeDefined();
    expect(general!.content).toContain('discover_capabilities');
    expect(general!.content).toContain('shell_execute');
    expect(general!.content).toContain('file_read');
  });

  it('contains extension credentials reference', () => {
    const creds = corpus.find((e) => e.id === 'faq:extension-credentials');
    expect(creds).toBeDefined();
    expect(creds!.content).toContain('GITHUB_TOKEN');
    expect(creds!.content).toContain('DISCORD_BOT_TOKEN');
    expect(creds!.content).toContain('ELEVENLABS_API_KEY');
  });

  it('contains file discovery FAQ', () => {
    const find = corpus.find((e) => e.id === 'faq:find-credential-files');
    expect(find).toBeDefined();
    expect(find!.content).toContain('Downloads');
    expect(find!.content).toContain('shell_execute');
  });

  it('contains wunderland connect reference', () => {
    const connect = corpus.find((e) => e.id === 'faq:wunderland-connect');
    expect(connect).toBeDefined();
    expect(connect!.content).toContain('--credentials');
  });

  // -------------------------------------------------------------------------
  // Tests — keyword search reachability
  // -------------------------------------------------------------------------

  it('keyword search for "gmail setup" finds the Gmail FAQ', () => {
    const fallback = new KeywordFallback(toChunks());
    const results = fallback.search('gmail setup credentials', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id.includes('gmail'))).toBe(true);
  });

  it('keyword search for "API keys needed" finds extension credentials', () => {
    const fallback = new KeywordFallback(toChunks());
    const results = fallback.search('what API keys credentials needed', 5);
    expect(results.length).toBeGreaterThan(0);
  });

  it('keyword search for "connect gmail" finds wunderland connect reference', () => {
    const fallback = new KeywordFallback(toChunks());
    const results = fallback.search('connect gmail wunderland', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id.includes('connect') || r.id.includes('gmail'))).toBe(true);
  });

  it('keyword search for "find credential files" finds the file discovery FAQ', () => {
    const fallback = new KeywordFallback(toChunks());
    const results = fallback.search('find credential files downloads', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.id.includes('credential') || r.id.includes('find'))).toBe(true);
  });
});
