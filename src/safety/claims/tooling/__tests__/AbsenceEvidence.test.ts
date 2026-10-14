import { describe, expect, it } from 'vitest';
import { digestOf } from '../../digest.js';
import { absenceAdapter, buildAbsenceRecord, inventoryDiff, type TripwireInput } from '../AbsenceEvidence.js';

const tripwire = (overrides: Partial<TripwireInput> = {}): TripwireInput => ({
  claimId: 'example-bot.primary',
  selectors: [{ kind: 'route', pattern: '^/api/v1/bot(?:/|$)' }, { kind: 'table', pattern: '\\bexample_bot_runs\\b' }],
  foundations: [{ pattern: 'roomName', reason: 'live audio rooms are not bots' }],
  scope: ['routes/', 'schema/'],
  probes: [{ method: 'GET', path: '/api/v1/bot/runs', expect: [404] }],
  noDatabaseReason: null,
  ...overrides,
});
const targets = [
  { path: 'routes/index.txt', text: '/api/v1/me\n/api/v1/live/start', kind: 'route' as const },
  { path: 'schema/live.ts', text: 'export const live = table("live_sessions", { roomName: text() });', kind: 'table' as const },
  { path: 'other/readme.md', text: '/api/v1/bot/ is planned', kind: 'source' as const },
];
const notFound = [{ method: 'GET' as const, path: '/api/v1/bot/runs', status: 404 }];

describe('absence evidence', () => {
  it('applies selectors only to their declared target kind', () => {
    const input = { ...tripwire(), selectors: [{ kind: 'route' as const, pattern: '/api/v1/bot/runs', reason: 'route' }], probes: [] };
    expect(buildAbsenceRecord(input, 'c'.repeat(40), [{ path: 'routes/example.txt', kind: 'source', text: '/api/v1/bot/runs' }], []).matches).toEqual([]);
    expect(buildAbsenceRecord(input, 'c'.repeat(40), [{ path: 'routes/example.txt', kind: 'route', text: '/api/v1/bot/runs' }], []).verdict).toBe('tripped');
  });
  it('records an absence over the scoped manifest, ignoring files outside the scope', async () => {
    const record = buildAbsenceRecord(tripwire(), 'c'.repeat(40), targets, notFound);
    expect(record.verdict).toBe('absent');
    expect(record.manifest.map((m) => m.path)).toEqual(['routes/index.txt', 'schema/live.ts']);
    expect(record.problems).toEqual([]);
    const outcome = await absenceAdapter().check({ kind: 'absence', ref: 'example-bot.primary', digest: digestOf(record), payload: record }, { claimId: 'example-bot.primary', sentenceDigest: 'x', requirements: [] }, new AbortController().signal);
    expect(outcome).toMatchObject({ verdict: 'supported', basis: 'deterministic' });
  });

  it('trips on a capability match or a probe that answers, and classifies a foundation match', () => {
    const added = [...targets, { path: 'routes/bots.txt', text: '/api/v1/bot/runs', kind: 'route' as const }];
    const tripped = buildAbsenceRecord(tripwire(), 'c'.repeat(40), added, notFound);
    expect(tripped.verdict).toBe('tripped');
    expect(tripped.matches.map((m) => [m.path, m.classification])).toEqual([['routes/bots.txt', 'capability']]);
    const answered = buildAbsenceRecord(tripwire(), 'c'.repeat(40), targets, [{ method: 'GET', path: '/api/v1/bot/runs', status: 200 }]);
    expect(answered.verdict).toBe('tripped');
    // A selector reads only targets of its own kind, so the field selector is given a field list to read.
    const withFields = [...targets, { path: 'schema/fields.txt', text: 'live_sessions.roomName', kind: 'field' as const }];
    const foundation = buildAbsenceRecord(tripwire({ selectors: [{ kind: 'field', pattern: 'roomName' }], probes: [] }), 'c'.repeat(40), withFields, []);
    expect(foundation.matches.map((m) => m.classification)).toEqual(['foundation']);
    expect(foundation.verdict).toBe('absent');
  });

  it('is invalid with no selectors, an empty manifest without a reason, or an unreached probe', () => {
    expect(buildAbsenceRecord(tripwire({ selectors: [] }), 'c'.repeat(40), targets, notFound).problems).toEqual(['the tripwire names no selector']);
    expect(buildAbsenceRecord(tripwire({ scope: ['nowhere/'] }), 'c'.repeat(40), targets, notFound).problems).toEqual(['the scoped manifest is empty and no reason says why']);
    expect(buildAbsenceRecord(tripwire(), 'c'.repeat(40), targets, [{ method: 'GET', path: '/api/v1/bot/runs', status: null }]).verdict).toBe('invalid');
    expect(buildAbsenceRecord(tripwire({ scope: ['nowhere/'], noDatabaseReason: 'a published listing has no table', probes: [] }), 'c'.repeat(40), targets, []).verdict).toBe('absent');
  });

  it('finds unclassified inventory additions so a rename cannot slip past', () => {
    const committed = [{ kind: 'route' as const, id: '/api/v1/me', classification: 'account' }];
    expect(inventoryDiff(committed, [{ kind: 'route', id: '/api/v1/me' }, { kind: 'route', id: '/api/v1/assistants' }])).toEqual({ unclassified: [{ kind: 'route', id: '/api/v1/assistants' }], removed: [] });
    expect(inventoryDiff(committed, [])).toEqual({ unclassified: [], removed: [{ kind: 'route', id: '/api/v1/me' }] });
  });
});
