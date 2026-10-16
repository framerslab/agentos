/**
 * @fileoverview Integration tests for the Memory I/O subsystem.
 *
 * Tests cover:
 * 1. JSON round-trip (export → import, verify data matches)
 * 2. JSON dedup (import same data twice, verify skipped > 0)
 * 3. Markdown export (verify files created with correct front-matter)
 * 4. Markdown import (create .md files, import, verify traces in DB)
 * 5. Obsidian export (verify [[wikilinks]] and #tags in files)
 * 6. Obsidian import (verify knowledge_edges created from [[wikilinks]])
 * 7. SQLite export (verify file copied / created)
 * 8. SQLite import (export brain A, import into brain B, verify data merged)
 * 9. ChatGPT import (mock conversations.json, verify traces created)
 * 10. CSV import (create a .csv file, import, verify traces in DB)
 * 11. Trace files read and written as data (content that opens with a
 *     front-matter block comes back whole from an export and an import; a
 *     block marked as JavaScript is never evaluated)
 *
 * @module memory/io/__tests__/io.test
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import matter from 'gray-matter';
import { Brain } from '../../retrieval/store/Brain.js';
import {
  JsonExporter,
  JsonImporter,
  MarkdownExporter,
  MarkdownImporter,
  ObsidianExporter,
  ObsidianImporter,
  ChatGptImporter,
  CsvImporter,
} from '../index.js';

// SqliteExporter/Importer are not barrel-exported (they require better-sqlite3 native module).
// Import directly for tests that have better-sqlite3 available.
import { SqliteExporter } from '../SqliteExporter.js';
import { SqliteImporter } from '../SqliteImporter.js';

// ---------------------------------------------------------------------------
// Test infrastructure helpers
// ---------------------------------------------------------------------------

/** All temp directories / db paths created during the test run. */
const cleanupPaths: string[] = [];

/**
 * Create a unique temp directory for this test. Registered for cleanup in
 * `afterEach`.
 */
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-io-test-'));
  cleanupPaths.push(d);
  return d;
}

/**
 * Return a unique temp .sqlite path (file not yet created).
 */
function tempDb(): string {
  const p = path.join(
    os.tmpdir(),
    `agentos-io-brain-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
  cleanupPaths.push(p);
  return p;
}

/** All `Brain` instances opened during the test. */
const openBrains: Brain[] = [];

/**
 * Open a `Brain` at `dbPath` and register it for cleanup.
 */
async function openBrain(dbPath?: string): Promise<Brain> {
  const p = dbPath ?? tempDb();
  if (!cleanupPaths.includes(p)) cleanupPaths.push(p);
  const brain = await Brain.openSqlite(p);
  openBrains.push(brain);
  return brain;
}

/**
 * Insert a minimal memory trace directly via SQL.
 * Returns the inserted trace ID.
 */
async function seedTrace(
  brain: Brain,
  overrides: {
    id?: string;
    type?: string;
    scope?: string;
    content?: string;
    strength?: number;
    tags?: string[];
  } = {},
): Promise<string> {
  const id = overrides.id ?? `mt_test_${Math.random().toString(36).slice(2)}`;
  await brain.run(
    `INSERT INTO memory_traces
         (brain_id, id, type, scope, content, embedding, strength, created_at, last_accessed,
          retrieval_count, tags, emotions, metadata, deleted)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, NULL, 0, ?, '{}', '{}', 0)`,
    [
      brain.brainId,
      id,
      overrides.type ?? 'episodic',
      overrides.scope ?? 'user',
      overrides.content ?? 'Test memory content',
      overrides.strength ?? 0.85,
      Date.now(),
      JSON.stringify(overrides.tags ?? []),
    ],
  );
  return id;
}

// ---------------------------------------------------------------------------
// Lifecycle hooks
// ---------------------------------------------------------------------------

afterEach(async () => {
  // Close all open brains.
  while (openBrains.length > 0) {
    const b = openBrains.pop()!;
    try { await b.close(); } catch { /* already closed */ }
  }

  // Remove temp files + directories.
  while (cleanupPaths.length > 0) {
    const p = cleanupPaths.pop()!;
    try {
      if (fs.existsSync(p)) {
        const stat = fs.statSync(p);
        if (stat.isDirectory()) {
          fs.rmSync(p, { recursive: true, force: true });
        } else {
          for (const suffix of ['', '-wal', '-shm']) {
            const f = p + suffix;
            if (fs.existsSync(f)) fs.unlinkSync(f);
          }
        }
      }
    } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// 1. JSON round-trip
// ---------------------------------------------------------------------------

describe('JsonExporter + JsonImporter', () => {
  it('round-trips memory traces through JSON', async () => {
    const sourceBrain = await openBrain();
    const traceId = await seedTrace(sourceBrain, {
      content: 'A unique episodic memory about the JSON round-trip test.',
      tags: ['json', 'test'],
    });

    const dir = tempDir();
    const jsonPath = path.join(dir, 'export.json');

    const exporter = new JsonExporter(sourceBrain);
    await exporter.export(jsonPath);

    expect(fs.existsSync(jsonPath)).toBe(true);

    const raw = fs.readFileSync(jsonPath, 'utf8');
    const payload = JSON.parse(raw) as { traces: { id: string; content: string }[] };

    expect(payload.traces).toBeDefined();
    expect(Array.isArray(payload.traces)).toBe(true);

    const exported = payload.traces.find((t) => t.id === traceId);
    expect(exported).toBeDefined();
    expect(exported!.content).toBe('A unique episodic memory about the JSON round-trip test.');

    // Import into a fresh brain.
    const targetBrain = await openBrain();
    const importer = new JsonImporter(targetBrain);
    const result = await importer.import(jsonPath);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBeGreaterThan(0);

    // Verify the trace exists in the target brain.
    const row = await targetBrain.get<{ content: string }>(
      'SELECT content FROM memory_traces WHERE id = ?',
      [traceId],
    );

    expect(row).toBeDefined();
    expect(row!.content).toBe('A unique episodic memory about the JSON round-trip test.');
  });

  it('includes embeddings as base64 when includeEmbeddings = true', async () => {
    const brain = await openBrain();
    // Insert a trace with a fake embedding BLOB.
    const id = `mt_embed_test`;
    const fakeEmbedding = Buffer.alloc(8, 0x42); // 8 bytes of 0x42
    await brain.run(
      `INSERT INTO memory_traces
           (brain_id, id, type, scope, content, embedding, strength, created_at,
            retrieval_count, tags, emotions, metadata, deleted)
         VALUES (?, ?, 'semantic', 'user', 'embedding test', ?, 1.0, ?, 0, '[]', '{}', '{}', 0)`,
      [brain.brainId, id, fakeEmbedding, Date.now()],
    );

    const dir = tempDir();
    const jsonPath = path.join(dir, 'export-with-embeddings.json');

    await new JsonExporter(brain).export(jsonPath, { includeEmbeddings: true });

    const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as {
      traces: Array<{ id: string; embedding?: string }>;
    };

    const trace = payload.traces.find((t) => t.id === id);
    expect(trace?.embedding).toBeDefined();
    expect(typeof trace!.embedding).toBe('string');

    // Decode and verify.
    const decoded = Buffer.from(trace!.embedding!, 'base64');
    expect(decoded.equals(fakeEmbedding)).toBe(true);
  });

  it('round-trips brain meta, documents, chunks, images, conversations, and messages through JSON strings', async () => {
    const sourceBrain = await openBrain();
    const traceId = await seedTrace(sourceBrain, {
      id: 'mt_json_chunk_1',
      content: 'Chunk-backed trace',
    });
    const sBrainId = sourceBrain.brainId;
    await sourceBrain.run(
      `INSERT OR REPLACE INTO brain_meta (brain_id, key, value) VALUES (?, 'last_sync', '1234567890')`,
      [sBrainId],
    );
    await sourceBrain.run(
      `INSERT INTO documents
         (brain_id, id, path, format, title, content_hash, chunk_count, metadata, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sBrainId, 'doc_json_1', '/tmp/notes.md', 'markdown', 'Notes', 'hash-1', 3, '{"source":"test"}', Date.now()],
    );
    await sourceBrain.run(
      `INSERT INTO conversations
         (brain_id, id, title, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [sBrainId, 'conv_json_1', 'Import Export', Date.now(), Date.now(), '{"channel":"test"}'],
    );
    await sourceBrain.run(
      `INSERT INTO document_chunks
         (brain_id, id, document_id, trace_id, content, chunk_index, page_number, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [sBrainId, 'chunk_json_1', 'doc_json_1', traceId, 'Chunk content', 0, 2, Buffer.from([1, 2, 3, 4])],
    );
    await sourceBrain.run(
      `INSERT INTO document_images
         (brain_id, id, document_id, chunk_id, data, mime_type, caption, page_number, embedding)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [sBrainId, 'img_json_1', 'doc_json_1', 'chunk_json_1', Buffer.from([0xde, 0xad, 0xbe, 0xef]), 'image/png', 'Diagram', 2, Buffer.from([5, 6, 7, 8])],
    );
    await sourceBrain.run(
      `INSERT INTO messages
         (brain_id, id, conversation_id, role, content, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [sBrainId, 'msg_json_1', 'conv_json_1', 'user', 'Hello export', Date.now(), '{"turn":1}'],
    );

    const payload = await new JsonExporter(sourceBrain).exportToString({ includeEmbeddings: true });

    const targetBrain = await openBrain();
    const result = await new JsonImporter(targetBrain).importFromString(payload);

    expect(result.errors).toHaveLength(0);

    const meta = await targetBrain.get<{ value: string }>(
      `SELECT value FROM brain_meta WHERE key = 'last_sync'`,
    );
    const document = await targetBrain.get<{ title: string }>(
      `SELECT title FROM documents WHERE id = ?`,
      ['doc_json_1'],
    );
    const chunk = await targetBrain.get<{ content: string; embedding_hex: string }>(
      `SELECT content, hex(embedding) AS embedding_hex FROM document_chunks WHERE id = ?`,
      ['chunk_json_1'],
    );
    const image = await targetBrain.get<{ caption: string; data_hex: string; embedding_hex: string }>(
      `SELECT caption, hex(data) AS data_hex, hex(embedding) AS embedding_hex
       FROM document_images
       WHERE id = ?`,
      ['img_json_1'],
    );
    const conversation = await targetBrain.get<{ title: string }>(
      `SELECT title FROM conversations WHERE id = ?`,
      ['conv_json_1'],
    );
    const message = await targetBrain.get<{ role: string; content: string }>(
      `SELECT role, content FROM messages WHERE id = ?`,
      ['msg_json_1'],
    );

    expect(meta?.value).toBe('1234567890');
    expect(document?.title).toBe('Notes');
    expect(chunk?.content).toBe('Chunk content');
    expect(chunk?.embedding_hex).toBe('01020304');
    expect(image?.caption).toBe('Diagram');
    expect(image?.data_hex).toBe('DEADBEEF');
    expect(image?.embedding_hex).toBe('05060708');
    expect(conversation?.title).toBe('Import Export');
    expect(message?.role).toBe('user');
    expect(message?.content).toBe('Hello export');
  });

  // -------------------------------------------------------------------------
  // 2. JSON dedup
  // -------------------------------------------------------------------------

  it('skips duplicate traces on second import', async () => {
    const sourceBrain = await openBrain();
    await seedTrace(sourceBrain, { content: 'Dedup test trace — unique content here.' });

    const dir = tempDir();
    const jsonPath = path.join(dir, 'export.json');

    await new JsonExporter(sourceBrain).export(jsonPath);

    const targetBrain = await openBrain();
    const importer = new JsonImporter(targetBrain);

    const first = await importer.import(jsonPath);
    expect(first.imported).toBeGreaterThan(0);
    expect(first.skipped).toBe(0);

    const second = await importer.import(jsonPath);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
  });

  it('returns an error for invalid JSON file', async () => {
    const dir = tempDir();
    const badPath = path.join(dir, 'bad.json');
    fs.writeFileSync(badPath, 'not-json');

    const brain = await openBrain();
    const result = await new JsonImporter(brain).import(badPath);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns an error when traces array is missing', async () => {
    const dir = tempDir();
    const badPath = path.join(dir, 'no-traces.json');
    fs.writeFileSync(badPath, JSON.stringify({ meta: {}, nodes: [] }));

    const brain = await openBrain();
    const result = await new JsonImporter(brain).import(badPath);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/traces/);
  });
});

// ---------------------------------------------------------------------------
// 3. Markdown export
// ---------------------------------------------------------------------------

describe('MarkdownExporter', () => {
  it('creates one .md file per trace in {scope}/{type}/ folder', async () => {
    const brain = await openBrain();
    const id1 = await seedTrace(brain, {
      content: 'First episodic trace',
      type: 'episodic',
      scope: 'user',
      tags: ['react', 'debugging'],
    });
    const id2 = await seedTrace(brain, {
      content: 'A semantic trace',
      type: 'semantic',
      scope: 'user',
    });

    const outDir = tempDir();
    const exporter = new MarkdownExporter(brain);
    await exporter.export(outDir);

    const file1 = path.join(outDir, 'user', 'episodic', `${id1}.md`);
    const file2 = path.join(outDir, 'user', 'semantic', `${id2}.md`);

    expect(fs.existsSync(file1)).toBe(true);
    expect(fs.existsSync(file2)).toBe(true);
  });

  it('writes correct YAML front-matter fields', async () => {
    const brain = await openBrain();
    const id = await seedTrace(brain, {
      content: 'Memory with front-matter check',
      type: 'procedural',
      scope: 'persona',
      strength: 0.72,
      tags: ['jest', 'vitest'],
    });

    const outDir = tempDir();
    await new MarkdownExporter(brain).export(outDir);

    const filePath = path.join(outDir, 'persona', 'procedural', `${id}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = matter(raw);

    expect(parsed.data['id']).toBe(id);
    expect(parsed.data['type']).toBe('procedural');
    expect(parsed.data['scope']).toBe('persona');
    expect(parsed.data['strength']).toBe(0.72);
    expect(parsed.data['tags']).toEqual(['jest', 'vitest']);
    expect(parsed.content.trim()).toContain('Memory with front-matter check');
  });
});

// ---------------------------------------------------------------------------
// 4. Markdown import
// ---------------------------------------------------------------------------

describe('MarkdownImporter', () => {
  it('inserts traces from .md files into the database', async () => {
    const dir = tempDir();

    // Create a synthetic vault.
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });

    const noteContent = matter.stringify('This is an imported trace from Markdown.', {
      id: 'mt_md_import_001',
      type: 'episodic',
      scope: 'user',
      strength: 0.9,
      tags: ['imported', 'test'],
      createdAt: 1711234567890,
    });

    fs.writeFileSync(path.join(noteDir, 'mt_md_import_001.md'), noteContent, 'utf8');

    const brain = await openBrain();
    const importer = new MarkdownImporter(brain);
    const result = await importer.import(dir);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(1);

    const row = await brain.get<{ content: string; strength: number }>(
      'SELECT content, strength FROM memory_traces WHERE id = ?',
      ['mt_md_import_001'],
    );

    expect(row).toBeDefined();
    expect(row!.content).toContain('This is an imported trace from Markdown.');
    expect(row!.strength).toBe(0.9);
  });

  it('skips duplicate Markdown files on second import', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });

    const noteContent = matter.stringify('Dedup check content in Markdown.', {
      type: 'episodic',
      scope: 'user',
    });

    fs.writeFileSync(path.join(noteDir, 'note.md'), noteContent, 'utf8');

    const brain = await openBrain();
    const importer = new MarkdownImporter(brain);

    const first = await importer.import(dir);
    expect(first.imported).toBe(1);

    const second = await importer.import(dir);
    expect(second.skipped).toBe(1);
    expect(second.imported).toBe(0);
  });

  it('handles non-existent directory gracefully', async () => {
    const brain = await openBrain();
    const importer = new MarkdownImporter(brain);
    const result = await importer.import('/tmp/does-not-exist-agentos-io-test');
    // Should return 0 imported and 0 errors (walk returns empty for missing dir).
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Obsidian export
// ---------------------------------------------------------------------------

describe('ObsidianExporter', () => {
  it('includes #tags in the exported file body', async () => {
    const brain = await openBrain();
    const id = await seedTrace(brain, {
      content: 'Obsidian note with tags',
      tags: ['philosophy', 'ai-safety'],
      scope: 'user',
      type: 'semantic',
    });

    const outDir = tempDir();
    await new ObsidianExporter(brain).export(outDir);

    const filePath = path.join(outDir, 'user', 'semantic', `${id}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');

    expect(raw).toContain('#philosophy');
    expect(raw).toContain('#ai-safety');
  });

  it('includes [[wikilinks]] for related knowledge nodes', async () => {
    const brain = await openBrain();

    // Create source trace.
    const traceId = await seedTrace(brain, {
      content: 'Trace linked to a knowledge node',
      scope: 'user',
      type: 'episodic',
    });

    // Create two knowledge nodes — source and target — then link them.
    // `knowledge_edges` requires both source_id and target_id to be in
    // `knowledge_nodes`, so we create a "source" node representing this trace.
    const sourceNodeId = `kn_src_${Math.random().toString(36).slice(2)}`;
    const targetNodeId = `kn_tgt_${Math.random().toString(36).slice(2)}`;

    const bId = brain.brainId;
    await brain.run(
      `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, confidence, source, created_at)
         VALUES (?, ?, 'trace', ?, '{}', 1.0, '{}', ?)`,
      [bId, sourceNodeId, `trace:${traceId}`, Date.now()],
    );

    await brain.run(
      `INSERT INTO knowledge_nodes (brain_id, id, type, label, properties, confidence, source, created_at)
         VALUES (?, ?, 'concept', 'Python Programming', '{}', 1.0, '{}', ?)`,
      [bId, targetNodeId, Date.now()],
    );

    // Edge: source trace node → target concept node.
    // The ObsidianExporter joins on source_id = traceId — we use source_id = traceId
    // to match the SQL query in ObsidianExporter which filters by source_id.
    // Since ObsidianExporter queries `WHERE ke.source_id = ?` using traceId,
    // we need to insert with source_id = traceId. But FK requires source_id in
    // knowledge_nodes. So we insert the source node with id = traceId.
    // Let's create a node whose id equals the traceId so the FK + query both work.
    const traceNodeId = traceId; // reuse trace ID as node ID for test simplicity
    await brain.run(
      `INSERT OR IGNORE INTO knowledge_nodes (brain_id, id, type, label, properties, confidence, source, created_at)
         VALUES (?, ?, 'trace', ?, '{}', 1.0, '{}', ?)`,
      [bId, traceNodeId, `trace:${traceId}`, Date.now()],
    );

    await brain.run(
      `INSERT INTO knowledge_edges (brain_id, id, source_id, target_id, type, weight, bidirectional, metadata, created_at)
         VALUES (?, ?, ?, ?, 'related_to', 1.0, 0, '{}', ?)`,
      [
        bId,
        `ke_test_${Math.random().toString(36).slice(2)}`,
        traceNodeId,   // source: knowledge node whose id = traceId
        targetNodeId,  // target: Python Programming concept node
        Date.now(),
      ],
    );

    const outDir = tempDir();
    await new ObsidianExporter(brain).export(outDir);

    const filePath = path.join(outDir, 'user', 'episodic', `${traceId}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');

    expect(raw).toContain('[[Python Programming]]');
  });
});

// ---------------------------------------------------------------------------
// 6. Obsidian import
// ---------------------------------------------------------------------------

describe('ObsidianImporter', () => {
  it('creates knowledge_edges from [[wikilinks]]', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });

    // Note with a wikilink to "Machine Learning".
    const noteContent = matter.stringify(
      'This note references [[Machine Learning]] as a key topic.',
      { type: 'episodic', scope: 'user' },
    );

    fs.writeFileSync(path.join(noteDir, 'trace-with-wikilink.md'), noteContent, 'utf8');

    const brain = await openBrain();
    const importer = new ObsidianImporter(brain);
    const result = await importer.import(dir);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(1);

    // Verify that a knowledge_node for "Machine Learning" was created.
    const node = await brain.get<{ id: string; label: string }>(
      `SELECT id, label FROM knowledge_nodes WHERE label = ?`,
      ['Machine Learning'],
    );

    expect(node).toBeDefined();
    expect(node!.label).toBe('Machine Learning');

    // Verify that a knowledge_edge was created.
    const edge = await brain.get<{ id: string }>(
      `SELECT id FROM knowledge_edges WHERE target_id = ? AND type = 'related_to'`,
      [node!.id],
    );

    expect(edge).toBeDefined();
  });

  it('round-trips imported wikilinks back out through Obsidian export', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });

    const noteContent = matter.stringify(
      'This note references [[Machine Learning]] as a key topic.',
      { type: 'episodic', scope: 'user' },
    );

    fs.writeFileSync(path.join(noteDir, 'trace-with-wikilink.md'), noteContent, 'utf8');

    const brain = await openBrain();
    await new ObsidianImporter(brain).import(dir);

    const trace = await brain.get<{ id: string }>(
      'SELECT id FROM memory_traces ORDER BY created_at DESC LIMIT 1',
    );

    expect(trace).toBeDefined();

    const outDir = tempDir();
    await new ObsidianExporter(brain).export(outDir);

    const filePath = path.join(outDir, 'user', 'episodic', `${trace!.id}.md`);
    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).toContain('[[Machine Learning]]');
  });

  it('extracts inline #tags and merges them into the trace', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'semantic');
    fs.mkdirSync(noteDir, { recursive: true });

    const noteContent = matter.stringify(
      'This note uses inline tags: #typescript #testing',
      { type: 'semantic', scope: 'user' },
    );

    fs.writeFileSync(path.join(noteDir, 'tagged-note.md'), noteContent, 'utf8');

    const brain = await openBrain();
    const result = await new ObsidianImporter(brain).import(dir);

    expect(result.imported).toBe(1);

    // Find the trace and check its tags.
    const trace = await brain.get<{ id: string; tags: string }>(
      'SELECT id, tags FROM memory_traces ORDER BY created_at DESC LIMIT 1',
    );

    expect(trace).toBeDefined();
    const tags = JSON.parse(trace!.tags) as string[];
    expect(tags).toContain('typescript');
    expect(tags).toContain('testing');
  });

  it('handles multiple wikilinks in one note', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });

    const noteContent = matter.stringify(
      'Mentions [[React]] and [[TypeScript]] and [[Node.js]].',
      { type: 'episodic', scope: 'user' },
    );

    fs.writeFileSync(path.join(noteDir, 'multi-wiki.md'), noteContent, 'utf8');

    const brain = await openBrain();
    await new ObsidianImporter(brain).import(dir);

    const countRow = await brain.get<{ c: number }>(
      `SELECT COUNT(*) as c FROM knowledge_edges`,
    );
    const edgeCount = countRow?.c ?? 0;

    // 3 wikilinks = 3 edges.
    expect(edgeCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 7. SQLite export
// ---------------------------------------------------------------------------

describe('SqliteExporter', () => {
  it('creates a backup SQLite file at the given path', async () => {
    const brain = await openBrain();
    await seedTrace(brain, { content: 'Data to backup' });

    const outPath = path.join(tempDir(), 'backup.sqlite');
    await new SqliteExporter(brain).export(outPath);

    expect(fs.existsSync(outPath)).toBe(true);
    const stat = fs.statSync(outPath);
    expect(stat.size).toBeGreaterThan(0);
  });

  it('backup is a valid SQLite file readable by Brain', async () => {
    const brain = await openBrain();
    await seedTrace(brain, { content: 'Backup read test' });

    const outPath = path.join(tempDir(), 'backup-readable.sqlite');
    await new SqliteExporter(brain).export(outPath);

    // Open the backup as a separate brain and verify data is present.
    const backupBrain = await openBrain(outPath);

    const row = await backupBrain.get<{ content: string }>(
      'SELECT content FROM memory_traces WHERE content = ? LIMIT 1',
      ['Backup read test'],
    );

    expect(row).toBeDefined();
    expect(row!.content).toBe('Backup read test');
  });
});

// ---------------------------------------------------------------------------
// 8. SQLite import
// ---------------------------------------------------------------------------

describe('SqliteImporter', () => {
  it('merges traces from brain A into brain B', async () => {
    const brainA = await openBrain();
    const idA = await seedTrace(brainA, {
      content: 'Trace from brain A for SQLite merge',
    });

    // Export A to a file.
    const backupPath = path.join(tempDir(), 'brain-a.sqlite');
    await new SqliteExporter(brainA).export(backupPath);

    // Import into brand-new brain B.
    const brainB = await openBrain();
    const importer = new SqliteImporter(brainB);
    const result = await importer.import(backupPath);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBeGreaterThan(0);

    const row = await brainB.get<{ content: string }>(
      'SELECT content FROM memory_traces WHERE id = ?',
      [idA],
    );

    expect(row).toBeDefined();
    expect(row!.content).toBe('Trace from brain A for SQLite merge');
  });

  it('skips duplicate traces on second import (tag union)', async () => {
    const brainA = await openBrain();
    await seedTrace(brainA, {
      content: 'Duplicate SQLite import check',
      tags: ['original-tag'],
    });

    const backupPath = path.join(tempDir(), 'brain-a-dup.sqlite');
    await new SqliteExporter(brainA).export(backupPath);

    const brainB = await openBrain();
    const importer = new SqliteImporter(brainB);

    const first = await importer.import(backupPath);
    expect(first.imported).toBeGreaterThan(0);

    const second = await importer.import(backupPath);
    expect(second.skipped).toBeGreaterThan(0);
    expect(second.imported).toBe(0);
  });

  it('returns an error for a non-existent source file', async () => {
    const brainB = await openBrain();
    const result = await new SqliteImporter(brainB).import('/tmp/no-such-file-agentos.sqlite');
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 9. ChatGPT import
// ---------------------------------------------------------------------------

describe('ChatGptImporter', () => {
  /** Build a minimal ChatGPT conversations.json payload. */
  function buildMockConversations(): object[] {
    return [
      {
        title: 'Discussion about TypeScript generics',
        create_time: 1711234567.89,
        update_time: 1711234600.0,
        mapping: {
          'root-node': {
            id: 'root-node',
            message: null,
            parent: null,
            children: ['user-msg-1'],
          },
          'user-msg-1': {
            id: 'user-msg-1',
            message: {
              author: { role: 'user' },
              content: { parts: ['How do TypeScript generics work?'] },
              create_time: 1711234567.89,
            },
            parent: 'root-node',
            children: ['assistant-msg-1'],
          },
          'assistant-msg-1': {
            id: 'assistant-msg-1',
            message: {
              author: { role: 'assistant' },
              content: {
                parts: [
                  'TypeScript generics allow you to write reusable, type-safe code...',
                ],
              },
              create_time: 1711234580.0,
            },
            parent: 'user-msg-1',
            children: [],
          },
        },
      },
    ];
  }

  it('imports conversations and creates episodic traces', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');

    fs.writeFileSync(jsonPath, JSON.stringify(buildMockConversations()), 'utf8');

    const brain = await openBrain();
    const importer = new ChatGptImporter(brain);
    const result = await importer.import(jsonPath);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBeGreaterThan(0);

    // Verify the trace content contains [user] + [assistant].
    const trace = await brain.get<{ content: string; type: string }>(
      `SELECT content, type FROM memory_traces
         WHERE content LIKE '%TypeScript generics%'
         LIMIT 1`,
    );

    expect(trace).toBeDefined();
    expect(trace!.type).toBe('episodic');
    expect(trace!.content).toContain('[user]: How do TypeScript generics work?');
    expect(trace!.content).toContain('[assistant]: TypeScript generics allow');
  });

  it('creates a conversations row for each conversation', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');

    fs.writeFileSync(jsonPath, JSON.stringify(buildMockConversations()), 'utf8');

    const brain = await openBrain();
    await new ChatGptImporter(brain).import(jsonPath);

    const convo = await brain.get<{ title: string }>(
      `SELECT title FROM conversations WHERE title = ? LIMIT 1`,
      ['Discussion about TypeScript generics'],
    );

    expect(convo).toBeDefined();
    expect(convo!.title).toBe('Discussion about TypeScript generics');
  });

  it('deduplicates traces on second import', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(buildMockConversations()), 'utf8');

    const brain = await openBrain();
    const importer = new ChatGptImporter(brain);

    const first = await importer.import(jsonPath);
    expect(first.imported).toBeGreaterThan(0);

    const second = await importer.import(jsonPath);
    // New conversation rows are created (OR IGNORE), but trace content is duped.
    expect(second.skipped).toBeGreaterThan(0);
  });

  it('handles empty conversations.json gracefully', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, '[]', 'utf8');

    const brain = await openBrain();
    const result = await new ChatGptImporter(brain).import(jsonPath);

    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it('returns an error for invalid JSON file', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, 'not-json', 'utf8');

    const brain = await openBrain();
    const result = await new ChatGptImporter(brain).import(jsonPath);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('returns an error when top level is not an array', async () => {
    const dir = tempDir();
    const jsonPath = path.join(dir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify({ title: 'oops' }), 'utf8');

    const brain = await openBrain();
    const result = await new ChatGptImporter(brain).import(jsonPath);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 10. CSV import
// ---------------------------------------------------------------------------

describe('CsvImporter', () => {
  it('imports traces from a CSV file with a content column', async () => {
    const dir = tempDir();
    const csvPath = path.join(dir, 'memories.csv');

    fs.writeFileSync(
      csvPath,
      [
        'content,type,scope,tags',
        '"Alpha note about butterflies",semantic,user,"nature|insects"',
        '"Beta note about alpacas",episodic,persona,"animals"',
      ].join('\n'),
      'utf8',
    );

    const brain = await openBrain();
    const result = await new CsvImporter(brain).import(csvPath);

    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(2);

    const rows = await brain.all<{ content: string; type: string; scope: string; tags: string }>(
      `SELECT content, type, scope, tags
         FROM memory_traces
         ORDER BY content`,
    );

    expect(rows).toHaveLength(2);
    expect(rows[0]?.content).toBe('Alpha note about butterflies');
    expect(rows[0]?.type).toBe('semantic');
    expect(rows[0]?.scope).toBe('user');
    expect(rows[0]?.tags).toContain('nature');
  });

  it('deduplicates repeated CSV imports by content hash', async () => {
    const dir = tempDir();
    const csvPath = path.join(dir, 'dedup.csv');

    fs.writeFileSync(
      csvPath,
      [
        'content,type',
        '"Repeated fact about dark mode",semantic',
      ].join('\n'),
      'utf8',
    );

    const brain = await openBrain();
    const importer = new CsvImporter(brain);

    const first = await importer.import(csvPath);
    const second = await importer.import(csvPath);

    expect(first.imported).toBe(1);
    expect(second.skipped).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 11. Trace files read and written as data
// ---------------------------------------------------------------------------

describe('trace files read and written as data', () => {
  /** A global the block below would set if it were evaluated. */
  const EVALUATED = '__agentosTraceFrontMatterEvaluated';

  /** A front-matter block marked as JavaScript. Evaluated, it would set the global and give the type `semantic`. */
  const MARKED_BLOCK = `---js\n{ type: (globalThis.${EVALUATED} = true) && 'semantic' }\n---\n`;

  /** The columns of a trace that a Markdown file carries. */
  interface FileBackedRow {
    id: string;
    type: string;
    scope: string;
    content: string;
    strength: number;
    tags: string;
  }

  afterEach(() => {
    Reflect.deleteProperty(globalThis, EVALUATED);
  });

  it('MarkdownExporter and MarkdownImporter keep content that opens with a front-matter block', async () => {
    const dashes = '---\nA rule opens this note.\n---\nThe review moved to Thursday.';
    const marked = `${MARKED_BLOCK}The review moved to Thursday, as agreed.`;

    const source = await openBrain();
    const dashesId = await seedTrace(source, {
      id: 'mt_opens_with_dashes',
      content: dashes,
      type: 'semantic',
      scope: 'user',
      strength: 0.6,
      tags: ['notes'],
    });
    const markedId = await seedTrace(source, {
      id: 'mt_opens_with_marked_block',
      content: marked,
      type: 'episodic',
      scope: 'user',
      strength: 0.4,
      tags: ['notes'],
    });

    const outDir = tempDir();
    await new MarkdownExporter(source).export(outDir);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();

    // Each file is the trace's own front matter, then the content as it was stored.
    const dashesFile = fs.readFileSync(path.join(outDir, 'user', 'semantic', `${dashesId}.md`), 'utf8');
    expect(dashesFile.startsWith(`---\nid: ${dashesId}\n`)).toBe(true);
    expect(dashesFile.endsWith(`\n---\n${dashes}\n`)).toBe(true);
    const markedFile = fs.readFileSync(path.join(outDir, 'user', 'episodic', `${markedId}.md`), 'utf8');
    expect(markedFile.startsWith(`---\nid: ${markedId}\n`)).toBe(true);
    expect(markedFile.endsWith(`\n---\n${marked}\n`)).toBe(true);

    const target = await openBrain();
    const result = await new MarkdownImporter(target).import(outDir);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(2);

    // The fields come from each trace's own front matter, and the content comes back whole.
    const rows = await target.all<FileBackedRow>(
      'SELECT id, type, scope, content, strength, tags FROM memory_traces ORDER BY id',
    );
    expect(rows).toEqual([
      { id: dashesId, type: 'semantic', scope: 'user', content: dashes, strength: 0.6, tags: '["notes"]' },
      { id: markedId, type: 'episodic', scope: 'user', content: marked, strength: 0.4, tags: '["notes"]' },
    ]);
  });

  it('MarkdownImporter evaluates no front matter marked as JavaScript, and reads no fields from it', async () => {
    const dir = tempDir();
    const noteDir = path.join(dir, 'user', 'episodic');
    fs.mkdirSync(noteDir, { recursive: true });
    fs.writeFileSync(path.join(noteDir, 'marked.md'), `${MARKED_BLOCK}The review moved to Thursday.\n`, 'utf8');

    const brain = await openBrain();
    const result = await new MarkdownImporter(brain).import(dir);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(1);

    // The block gives no fields, so the trace takes the importer's defaults and the text after the block.
    const row = await brain.get<Pick<FileBackedRow, 'type' | 'scope' | 'content' | 'strength' | 'tags'>>(
      'SELECT type, scope, content, strength, tags FROM memory_traces',
    );
    expect(row).toEqual({
      type: 'episodic',
      scope: 'user',
      content: 'The review moved to Thursday.',
      strength: 1,
      tags: '[]',
    });
  });

  it('ObsidianExporter and ObsidianImporter keep content that opens with a front-matter block', async () => {
    const marked = `${MARKED_BLOCK}The review moved to Thursday.`;

    const source = await openBrain();
    const id = await seedTrace(source, {
      id: 'mt_obsidian_marked_block',
      content: marked,
      type: 'episodic',
      scope: 'user',
      strength: 0.4,
      tags: ['notes'],
    });

    const outDir = tempDir();
    await new ObsidianExporter(source).export(outDir);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();

    // The trace's own front matter, then the content as it was stored, then its tags.
    const file = fs.readFileSync(path.join(outDir, 'user', 'episodic', `${id}.md`), 'utf8');
    expect(file.startsWith(`---\nid: ${id}\n`)).toBe(true);
    expect(file.endsWith(`\n---\n${marked}\n\n#notes\n`)).toBe(true);

    const target = await openBrain();
    const result = await new ObsidianImporter(target).import(outDir);
    expect(Reflect.get(globalThis, EVALUATED)).toBeUndefined();
    expect(result.errors).toHaveLength(0);
    expect(result.imported).toBe(1);

    const rows = await target.all<FileBackedRow>(
      'SELECT id, type, scope, content, strength, tags FROM memory_traces',
    );
    expect(rows).toEqual([
      { id, type: 'episodic', scope: 'user', content: `${marked}\n\n#notes`, strength: 0.4, tags: '["notes"]' },
    ]);
  });
});
