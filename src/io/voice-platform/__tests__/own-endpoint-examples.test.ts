import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as resolution from '../ReasoningProviderResolver.js';
import * as authority from '../VoiceScopeContext.js';
import * as tools from '../reasoning/tools.js';
import * as budgets from '../../../safety/runtime/ModelAttemptBudget.js'; import { VoiceAdapterRuntime, type VoiceAdapterRequest } from '../../speech/VoiceAdapter.js';
import * as contracts from '../contracts/index.js';
import { InMemoryCompoundCreditStore } from '../../../safety/runtime/CompoundCreditStore.js';
import { grantCreditLot, reserveCompoundCredit } from '../../../safety/runtime/CompoundCreditLedger.js';
import { RATES } from '../../../safety/runtime/__tests__/compoundCreditLedger.contract.js';
import { reasoningFixture } from './ReasoningProviderResolver.test.js';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const example = (kind: 'local' | 'hosted') => root + `examples/voice-platform/own-endpoint-${kind}.ts`;
type Result = { text: string; usage: Array<{ attemptId: string; quantities: Record<string, number>; final: boolean }> };
function load(kind: 'local' | 'hosted'): (options: unknown) => Promise<Result> {
  const source = readFileSync(example(kind), 'utf8'); const built = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }, reportDiagnostics: true });
  expect(built.diagnostics ?? []).toEqual([]);
  const imports: Record<string, unknown> = {
    '../../src/io/voice-platform/ReasoningProviderResolver.js': resolution,
    '../../src/io/voice-platform/VoiceScopeContext.js': authority,
    '../../src/io/voice-platform/reasoning/tools.js': tools,
    '../../src/io/voice-platform/contracts/index.js': contracts,
    '../../src/safety/runtime/ModelAttemptBudget.js': budgets,
  };
  const module = { exports: {} as { run: (options: unknown) => Promise<Result> } };
  runInNewContext(built.outputText, { module, exports: module.exports, require: (name: string) => { if (!(name in imports)) throw new Error('unapproved example import'); return imports[name]; }, Buffer, AbortController, AbortSignal, structuredClone, Date }, { timeout: 1000 });
  return module.exports.run;
}
async function input(kind: 'local' | 'hosted') {
  const fixture = reasoningFixture(); const controller = new AbortController();
  const endpoint = { ...fixture.endpoint, ...(kind === 'hosted' ? { locality: 'remote' as const, credentialRef: 'credential-a' } : {}) };
  const scope = authority.captureVoiceScope({ ...fixture.scope, signal: controller.signal,
    policy: { ...fixture.scope.policy, mode: kind === 'hosted' ? 'hosted' : 'local', providers: fixture.scope.policy.providers.map((p) => p.providerId === 'model' ? { ...p, locality: endpoint.locality } : p) } });
  const store = new InMemoryCompoundCreditStore(); const now = Date.now();
  const rate = { ...RATES, version: 'local', components: { ...RATES.components,
    cached_input_token: RATES.components.input_token!, request: { customer: { unit: 'request' as const, micro: 0, per: 1 }, supplier: { unit: 'request' as const, micro: 0, per: 1 } } } };
  await grantCreditLot(store, { scopeId: scope.scopeId, lotId: 'fixture-lot', kind: 'paid', fundingRef: 'fixture-funding', principalMicro: 1000000, at: now });
  const reserved = await reserveCompoundCredit(store, { scopeId: scope.scopeId, operationId: scope.callId, kind: 'call', requestHash: 'fixture-request', rates: { primary: rate }, mediaComponent: 'media_second', durationSeconds: 60, attempts: fixture.config.attemptLimits, supplierDailyCapMicro: 1000000000, at: now, expiresAt: now + 600000 });
  if (reserved.status !== 'reserved') throw new Error('fixture hold');
  const key = { id: 'fixture', key: new Uint8Array(32).fill(1) }; const sealed = resolution.sealVoiceCredential(scope.scopeId, 'model', 'credential-a', 'not-a-real-endpoint-secret', key);
  const options = { scope, endpoint, limits: fixture.config.attemptLimits, text: 'hello', prompt: '',
    countInput: async () => 12, fence: fixture.stopped, lookup: async () => [{ address: '142.250.0.1', family: 4 as const }], connector: fixture.send,
    store, holdId: reserved.hold.holdId, credentialStore: { read: async () => sealed }, sealingKeys: [key] };
  return { options, fixture, controller, store, hold: reserved.hold };
}
describe('the checked-in own-endpoint examples', () => { it('fences a pending grant and treats acknowledged cancellation as stopped', async () => { const scope = reasoningFixture().scope; const budget = new budgets.CountingAttemptBudget({ maxAttempts: 2, perAttempt: { request: 1 } }); const original = budget.authorize.bind(budget); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const authorize = vi.spyOn(budget, 'authorize').mockImplementation(async (request) => { await gate; return original(request); }); const runtime = new VoiceAdapterRuntime(scope, 'stt', 'stt', budget); const work = vi.fn(async () => ({ value: 'ok', usage: { request: 1 }, final: true })); const fence = vi.fn(async () => ({ stopped: true as const, evidenceRef: 'native-stopped' })); const pending = runtime.run(scope.policy.identity, 'initial', work, fence); const refused = expect(pending).rejects.toThrow(); await vi.waitFor(() => expect(authorize).toHaveBeenCalledOnce()); runtime.fenceGeneration(scope.policy.identity.generation); release(); await refused; expect(work).not.toHaveBeenCalled(); await runtime.whenIdle(); authorize.mockRestore(); const next = new VoiceAdapterRuntime(scope, 'stt', 'stt', budget); const native = vi.fn((request: VoiceAdapterRequest) => new Promise<never>((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))); const active = next.run(scope.policy.identity, 'initial', native, fence); const cancelled = expect(active).rejects.toThrow('cancelled'); await vi.waitFor(() => expect(native).toHaveBeenCalledOnce()); next.fenceGeneration(scope.policy.identity.generation); await expect(next.whenIdle()).resolves.toBeUndefined(); await cancelled; expect(fence).toHaveBeenCalledOnce(); });
  it('type checks both real source files in CI with the repository compiler options', () => {
    const config = ts.readConfigFile(root + 'tsconfig.json', ts.sys.readFile); expect(config.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
    const program = ts.createProgram([example('local'), example('hosted')], { ...parsed.options, rootDir: root, composite: false, incremental: false, noEmit: true });
    const diagnostics = ts.getPreEmitDiagnostics(program).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'));
    expect(diagnostics).toEqual([]);
  });
  for (const kind of ['local', 'hosted'] as const) {
    it(`${kind} resolves its own endpoint, requests usage and records actual components`, async () => {
      const f = await input(kind); const result = await load(kind)(f.options);
      expect(result.text).toBe('hello'); expect(result.usage[0]!.quantities).toEqual({ input_token: 10, cached_input_token: 2, output_token: 5, reasoning_token: 1, request: 1 });
      expect(f.fixture.send).toHaveBeenCalledOnce();
      if (kind === 'hosted') {
        const attempts = await f.store.withTransaction((tx) => tx.listAttempts(f.hold.holdId)); expect(attempts).toHaveLength(1); expect(attempts[0]!.state).toBe('recorded');
        expect(JSON.stringify(f.options.endpoint)).not.toContain('not-a-real-endpoint-secret');
      }
    });
    it(`${kind} cancellation reaches the registered native fence and never invents a final usage record`, async () => {
      const f = await input(kind); const run = load(kind);
      await expect(run({ ...f.options, onText: () => f.controller.abort() })).rejects.toThrow();
      expect(f.fixture.stopped).toHaveBeenCalledOnce();
      if (kind === 'hosted') { const attempts = await f.store.withTransaction((tx) => tx.listAttempts(f.hold.holdId)); expect(attempts[0]!.state).toBe('authorized'); }
    });
  }
  it('refuses a private hosted destination before contacting its connector or authorizing an attempt', async () => {
    const f = await input('hosted');
    await expect(load('hosted')({ ...f.options, lookup: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toThrow();
    expect(f.fixture.send).not.toHaveBeenCalled(); expect(await f.store.withTransaction((tx) => tx.listAttempts(f.hold.holdId))).toEqual([]);
  });
  it('refuses copied sealed credentials and a foreign hold', async () => {
    const f = await input('hosted');
    await expect(load('hosted')({ ...f.options, holdId: 'missing' })).rejects.toThrow('hold');
    const changed = { ...f.options.endpoint, providerId: 'foreign' };
    await expect(load('hosted')({ ...f.options, endpoint: changed })).rejects.toThrow(); expect(f.fixture.send).not.toHaveBeenCalled();
  });
});
