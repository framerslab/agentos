import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPostgresAdapter } from '@framers/sql-storage-adapter';
import { SqlRunStore, meetingStoresDdl, meetingFundingUpgradeDdl } from '../stores/sql.js';
import { SecretBox } from '../signing.js';
import { SqlCompoundCreditStore } from '../../../../safety/runtime/SqlCompoundCreditStore.js';
import { fundedRun, meetingFundingContract } from './meeting-funding.contract.js';

const url = process.env.AGENTOS_TEST_POSTGRES_URL;
if (process.env.CI && !url) throw new Error('funding PostgreSQL CI service is required');

async function open() {
  const prefix = `mf_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const creditPrefix = `${prefix}_credit`;
  const first = createPostgresAdapter({ connectionString: url!, max: 10 });
  const second = createPostgresAdapter({ connectionString: url!, max: 10 });
  await first.open(); await second.open();
  await first.exec(meetingStoresDdl(prefix));
  const box = new SecretBox(Buffer.alloc(32, 7));
  const credit = new SqlCompoundCreditStore({ db: first, tablePrefix: creditPrefix, requireShared: true });
  const peerCredit = new SqlCompoundCreditStore({ db: second, tablePrefix: creditPrefix, requireShared: true });
  await credit.ensureSchema(); await peerCredit.ensureSchema();
  return { first, second, prefix, runs: new SqlRunStore({ db: first, tablePrefix: prefix, box }), peerRuns: new SqlRunStore({ db: second, tablePrefix: prefix, box }), credit, peerCredit,
    close: async () => {
      for (const suffix of ['accounts', 'lots', 'holds', 'allocations', 'attempts', 'entries', 'supplier_days']) await first.exec(`DROP TABLE IF EXISTS ${creditPrefix}_${suffix}`);
      for (const suffix of ['runs', 'jobs', 'turns', 'events', 'outbox', 'run_locks']) await first.exec(`DROP TABLE IF EXISTS ${prefix}_${suffix}`);
      await second.close(); await first.close();
    } };
}

describe.skipIf(!url)('PostgreSQL funding', () => {
  meetingFundingContract('two database clients', open);
  it('upgrades the previous schema twice, keeps old rows and round-trips a funded row', async () => {
    const h = await open();
    try {
      const legacy = { ...fundedRun('old'), funding: undefined };
      await h.runs.insert(legacy);
      await h.first.exec(`ALTER TABLE ${h.prefix}_runs DROP COLUMN funding_json, DROP COLUMN funding_reservation_id, DROP COLUMN funding_settlement_json, DROP COLUMN funding_cleanup_json`);
      await h.first.transaction((tx) => tx.exec(meetingFundingUpgradeDdl(h.prefix)));
      await h.first.transaction((tx) => tx.exec(meetingFundingUpgradeDdl(h.prefix)));
      expect((await h.peerRuns.get('old'))?.funding).toBeUndefined();
      const run = fundedRun('new'); await h.runs.insert(run);
      await h.runs.update('new', { fundingReservationId: 'hold-new', fundingSettlement: { billedSeconds: 0, unbilled: true } });
      expect(await h.peerRuns.get('new')).toMatchObject({ funding: run.funding, fundingReservationId: 'hold-new', fundingSettlement: { billedSeconds: 0, unbilled: true } });
      const raw = await h.first.get<{ funding_json: string }>(`SELECT funding_json FROM ${h.prefix}_runs WHERE run_id = ?`, ['new']);
      expect(JSON.parse(raw!.funding_json)).toEqual(run.funding);
      await expect(h.peerRuns.update('new', { fundingReservationId: 'another' })).rejects.toThrow('immutable funding');
      await expect(h.peerRuns.update('new', { fundingSettlement: { billedSeconds: 4, unbilled: false } })).rejects.toThrow('immutable funding');
    } finally { await h.close(); }
  });
});
