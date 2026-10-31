/**
 * AgencyRegistry.listAgencies(): the agency sessions running now, as copies. A caller that edits what it was given
 * changes nothing the registry holds: not a session, a seat, a history entry or any metadata record.
 */
import { describe, expect, it } from 'vitest';
import { AgencyRegistry } from '../AgencyRegistry.js';

describe('AgencyRegistry.listAgencies', () => {
  it('returns copies: editing a listed session, its seats, a history entry or any metadata changes nothing the registry holds', () => {
    const registry = new AgencyRegistry();
    const { agencyId } = registry.upsertAgency({
      workflowId: 'w-1',
      conversationId: 'c-1',
      metadata: { kind: 'launched', usage: { totalTokens: 12 } },
      memoryConfig: { enabled: true, writeRoles: ['writer'] },
    });
    registry.registerSeat({ agencyId, roleId: 'writer', gmiInstanceId: 'gmi-1', personaId: 'p-1', metadata: { form: 'temporary', tags: ['a'] } });
    registry.appendSeatHistory(agencyId, 'writer', { timestamp: 't0', status: 'completed', outputPreview: 'Done.', metadata: { outcome: 'completed' } });

    const [listed] = registry.listAgencies();
    // The copy holds what the registry holds (the precondition).
    expect(listed.seats.writer.history).toEqual([{ timestamp: 't0', status: 'completed', outputPreview: 'Done.', metadata: { outcome: 'completed' } }]);

    listed.workflowId = 'changed';
    listed.metadata!.kind = 'changed';
    (listed.metadata!.usage as { totalTokens: number }).totalTokens = 0;
    listed.memoryConfig!.writeRoles!.push('intruder');
    listed.seats.writer.metadata!.form = 'changed';
    (listed.seats.writer.metadata!.tags as string[]).push('b');
    listed.seats.writer.history![0].outputPreview = 'changed';
    listed.seats.writer.history![0].metadata!.outcome = 'changed';
    listed.seats.writer.history!.push({ timestamp: 't1' });
    delete listed.seats.writer;

    const [again] = registry.listAgencies();
    expect(again.workflowId).toBe('w-1');
    expect(again.metadata).toEqual({ kind: 'launched', usage: { totalTokens: 12 } });
    expect(again.memoryConfig).toEqual({ enabled: true, writeRoles: ['writer'] });
    expect(again.seats.writer.metadata).toEqual({ form: 'temporary', tags: ['a'] });
    expect(again.seats.writer.history).toEqual([{ timestamp: 't0', status: 'completed', outputPreview: 'Done.', metadata: { outcome: 'completed' } }]);
    expect(registry.getAgency(agencyId)?.seats.writer.history).toHaveLength(1);
  });
});
