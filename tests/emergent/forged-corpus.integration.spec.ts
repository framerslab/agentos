/**
 * The forged-tool corpus (tests/fixtures/forged-tools) on the in-process
 * executor, through the forge: every fixture meets its expectation. A fixture
 * that names a capability runs under a ceiling, through the broker, with a
 * call handle, and its run is ended as the engine ends one.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SandboxedToolForge } from '../../src/cognition/emergent/SandboxedToolForge.js';
import { CapabilityBroker } from '../../src/cognition/emergent/broker/CapabilityBroker.js';
import { resolveCeiling } from '../../src/cognition/emergent/ceiling.js';
import type { AllowlistName, SandboxExecutionResult } from '../../src/cognition/emergent/types.js';
import {
  checkExpectation,
  loadCorpus,
  startCorpusEnvironment,
  usesCapabilities,
  type CorpusEnvironment,
  type CorpusFixture,
} from '../fixtures/forged-tools/environment.js';

const { library, written } = loadCorpus();

let env: CorpusEnvironment;
let plain: SandboxedToolForge;
let brokered: SandboxedToolForge;
let broker: CapabilityBroker;

beforeAll(async () => {
  env = await startCorpusEnvironment();
  plain = new SandboxedToolForge();
  brokered = new SandboxedToolForge();
  broker = new CapabilityBroker(
    resolveCeiling(
      { fetch: { domains: ['127.0.0.1'] }, 'fs.read': { roots: [env.root] }, crypto: {} },
      { store: 'none' },
      { hasStorage: false },
    ),
  );
  brokered.attachBroker(broker);
});

afterAll(async () => {
  await env.close();
});

async function runFixture(fixture: CorpusFixture): Promise<SandboxExecutionResult> {
  const request = {
    code: fixture.code,
    input: env.fill(fixture.input),
    allowlist: fixture.allowlist as AllowlistName[],
    memoryMB: 128,
    timeoutMs: fixture.timeoutMs ?? 5000,
  };
  if (!usesCapabilities(fixture)) {
    return plain.execute(request);
  }
  const call = { id: randomUUID(), toolId: fixture.id, agentId: 'corpus', signal: new AbortController().signal };
  try {
    return await brokered.execute({ ...request, call });
  } finally {
    await broker.endCall(call.id);
  }
}

describe('the forged-tool corpus on the in-process executor', () => {
  it('has unique ids', () => {
    const ids = [...library, ...written].map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each([
    ['library', library],
    ['written', written],
  ] as const)('the %s set', (_set, fixtures) => {
    it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))('%s', async (_id, fixture) => {
      const result = await runFixture(fixture);
      expect(checkExpectation(fixture.expect, result)).toBeNull();
    });
  });
});
