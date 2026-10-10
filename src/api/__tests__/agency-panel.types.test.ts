/**
 * @file agency-panel.types.test.ts
 * The result types `agency()` gives, as the package entry declares them. The
 * typecheck job runs these assertions; the test runner only loads the file.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
// Types only: the assertions read the package entry's declarations without loading it.
import type * as Entry from '../../index.js';
import type { Agency, AgencyResult, AgencyStreamResult, PanelResult } from '../types.js';

declare const agency: typeof Entry.agency;
declare const importAgent: typeof Entry.importAgent;

// Never called: the assertions below are type assertions the typecheck job runs.
const _types = () => {
  const panel = agency({ strategy: 'panel', modelPool: { a: { provider: 'openai', model: 'gpt-4.1' } }, agents: { s: { instructions: 'x' } }, chair: false });
  expectTypeOf(panel.generate('x')).resolves.toEqualTypeOf<PanelResult>();
  expectTypeOf(panel.stream('x').result).resolves.toEqualTypeOf<PanelResult>();
  // The exported interface keeps `result` optional: an object typed as it before this member existed still compiles.
  const legacy: AgencyStreamResult = {
    textStream: (async function* () {})(),
    fullStream: (async function* () {})(),
    text: Promise.resolve(''),
    usage: Promise.resolve({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
    agentCalls: Promise.resolve([]),
    parsed: Promise.resolve(undefined),
    finalTextStream: (async function* () {})(),
  };
  void legacy;
  // Sessions stay untyped: the docs cast the session, then send()'s result, and that cast compiles here.
  expectTypeOf(panel.session()).toBeUnknown();
  const session = async () => {
    const s = panel.session('s') as { send(input: string): Promise<unknown> };
    const r = (await s.send('x')) as PanelResult;
    void r;
  };
  void session;
  const seats: Promise<PanelResult['seats']> = panel.generate('x').then((r) => r.seats);
  void seats;
  const plain = agency({ agents: { s: { instructions: 'x' } } });
  expectTypeOf(plain.generate('x')).resolves.toEqualTypeOf<AgencyResult>();
  const asAgency: Agency = plain;
  void asAgency;
  expectTypeOf(importAgent).returns.toEqualTypeOf<Agency>();
  // @ts-expect-error fallbackProviders is a seat option, not an agency-level one
  agency({ agents: { s: {} }, fallbackProviders: [] });
};

describe('agency() result types', () => {
  it('compile', () => {
    expect(typeof _types).toBe('function');
  });
});
