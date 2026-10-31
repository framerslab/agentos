/**
 * @fileoverview CompactionLog: what each transparency level keeps, retention,
 * the lookups and the stats.
 */

import { describe, expect, it } from 'vitest';
import { CompactionLog } from '../CompactionLog.js';
import type { CompactionEntry } from '../types.js';

function entry(id: string, partial: Partial<CompactionEntry> = {}): CompactionEntry {
  return {
    id,
    timestamp: 1_000,
    turnRange: [1, 5],
    strategy: 'sliding',
    inputTokens: 400,
    outputTokens: 50,
    compressionRatio: 8,
    summary: `summary ${id}`,
    droppedContent: ['Turn 2: "a detail"'],
    preservedEntities: ['docs/plan.md'],
    tracesCreated: ['trace-1'],
    observationNotes: [],
    durationMs: 10,
    ...partial,
  };
}

describe('CompactionLog', () => {
  it('keeps nothing when silent, drops the details in summary mode and keeps them in full', () => {
    const silent = new CompactionLog(10, 'silent');
    silent.append(entry('a'));
    expect(silent.size).toBe(0);
    expect(silent.format()).toBe('[No compaction events recorded]');

    const summary = new CompactionLog(10, 'summary');
    summary.append(entry('a'));
    expect(summary.getById('a')).toMatchObject({ droppedContent: [], observationNotes: undefined, summary: 'summary a' });

    const full = new CompactionLog(10, 'full');
    full.append(entry('a'));
    expect(full.getById('a')).toMatchObject({ droppedContent: ['Turn 2: "a detail"'], observationNotes: [] });
    expect(full.getById('missing')).toBeUndefined();
  });

  it('keeps the newest entries up to its retention, and finds them by turn, entity, time and word', () => {
    const log = new CompactionLog(2, 'full');
    log.append(entry('a', { timestamp: 1_000, turnRange: [1, 5] }));
    log.append(entry('b', { timestamp: 2_000, turnRange: [6, 9], preservedEntities: ['Ana Lopez'] }));
    log.append(entry('c', { timestamp: 3_000, turnRange: [10, 12], summary: 'Moved the launch to May' }));

    expect(log.getAll().map((e) => e.id)).toEqual(['b', 'c']);
    expect(log.findByTurn(7).map((e) => e.id)).toEqual(['b']);
    expect(log.findByTurn(3)).toEqual([]);
    expect(log.findByEntity('lopez').map((e) => e.id)).toEqual(['b']);
    expect(log.findByTimeRange(2_500, 3_000).map((e) => e.id)).toEqual(['c']);
    expect(log.search('LAUNCH').map((e) => e.id)).toEqual(['c']);

    log.clear();
    expect(log.size).toBe(0);
  });

  it('sums its entries into stats and formats them', () => {
    const log = new CompactionLog(10, 'full');
    expect(log.getStats()).toMatchObject({ totalCompactions: 0, avgCompressionRatio: 0, oldestEntry: undefined });

    log.append(entry('a', { inputTokens: 400, outputTokens: 50, durationMs: 10 }));
    log.append(entry('b', { inputTokens: 200, outputTokens: 50, durationMs: 21, preservedEntities: ['docs/plan.md', 'orders'] }));

    expect(log.getStats()).toMatchObject({
      totalCompactions: 2,
      totalInputTokens: 600,
      totalOutputTokens: 100,
      avgCompressionRatio: 6,
      totalTracesCreated: 2,
      totalEntitiesPreserved: 2,
      avgDurationMs: 16,
    });
    expect(log.getStats().oldestEntry?.id).toBe('a');
    expect(log.getStats().newestEntry?.id).toBe('b');

    const formatted = CompactionLog.formatEntry(log.getAll()[1]);
    expect(formatted).toContain('[Compaction b]');
    expect(formatted).toContain('Compression: 200 → 50 tokens (8.0x)');
    expect(formatted).toContain('Entities preserved: docs/plan.md, orders');
    expect(formatted).toContain('Memory traces created: 1');
    expect(formatted).toContain('Dropped fragments: 1');
    expect(log.format().split('\n\n')).toHaveLength(2);
  });
});
