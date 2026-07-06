/**
 * @file AnchorManagerProvider.test.ts
 * @description Integration tests for AnchorManager with external AnchorProvider.
 * Verifies the fire-and-forget publish pattern, external_ref DB updates,
 * provider lifecycle, and failure isolation.
 */

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { AnchorManager } from '../anchoring/AnchorManager.js';
import { AgentKeyManager } from '../crypto/AgentKeyManager.js';
import { HashChain } from '../crypto/HashChain.js';
import type { AnchorProvider, AnchorProviderResult, AnchorRecord, ProofLevel, SignedEvent, ProvenanceSystemConfig } from '../types.js';

// =============================================================================
// Helpers
// =============================================================================

function createMockConfig(overrides?: Partial<ProvenanceSystemConfig>): ProvenanceSystemConfig {
  const { autonomy, ...rest } = overrides ?? {};
  return {
    storagePolicy: { mode: 'sealed', protectedTables: [] },
    provenance: {
      enabled: true,
      signatureMode: 'every-event',
      hashAlgorithm: 'sha256',
      keySource: { type: 'generate' },
    },
    autonomy: autonomy ?? {
      allowHumanPrompting: true,
      allowConfigEdits: true,
      allowToolChanges: true,
    },
    anchorIntervalMs: 0, // manual anchoring only
    anchorBatchSize: 1,
    ...rest,
  };
}

function createMockProvider(overrides?: Partial<AnchorProvider>): AnchorProvider & {
  publishMock: Mock<(anchor: AnchorRecord) => Promise<AnchorProviderResult>>;
  verifyMock: Mock<(anchor: AnchorRecord) => Promise<boolean>>;
  disposeMock: Mock<() => Promise<void>>;
} {
  const publishMock = vi.fn<(anchor: AnchorRecord) => Promise<AnchorProviderResult>>().mockResolvedValue({
    providerId: 'mock',
    success: true,
    externalRef: 'mock-ref-12345',
    publishedAt: new Date().toISOString(),
  });
  const verifyMock = vi.fn<(anchor: AnchorRecord) => Promise<boolean>>().mockResolvedValue(true);
  const disposeMock = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

  return {
    id: 'mock',
    name: 'Mock Provider',
    proofLevel: 'publicly-auditable' as ProofLevel,
    publish: (anchor) => publishMock(anchor),
    verify: (anchor) => verifyMock(anchor),
    dispose: () => disposeMock(),
    publishMock,
    verifyMock,
    disposeMock,
    ...overrides,
  };
}

async function buildEvents(count: number, km: AgentKeyManager): Promise<SignedEvent[]> {
  const chain = new HashChain();
  const events: SignedEvent[] = [];

  for (let i = 0; i < count; i++) {
    const { sequence, prevHash } = chain.advance();
    const payload = { i };
    const payloadHash = HashChain.computePayloadHash(payload);
    const timestamp = new Date(Date.now() + i * 1000).toISOString();

    const hash = HashChain.computeEventHash({
      sequence, type: 'message.created', timestamp,
      agentId: 'agent-1', prevHash, payloadHash,
    });

    const signature = await km.sign(hash);
    chain.recordHash(hash);

    events.push({
      id: `evt-${i}`, type: 'message.created', timestamp, sequence,
      agentId: 'agent-1', prevHash, hash, payloadHash,
      payload, signature, signerPublicKey: km.getPublicKeyBase64(),
    });
  }

  return events;
}

// =============================================================================
// Tests
// =============================================================================

describe('AnchorManager + AnchorProvider integration', () => {
  let km: AgentKeyManager;
  let events: SignedEvent[];
  let mockStorage: any;
  let mockLedger: any;
  let config: ProvenanceSystemConfig;

  beforeEach(async () => {
    km = await AgentKeyManager.generate('agent-1');
    events = await buildEvents(5, km);

    mockStorage = {
      run: vi.fn().mockResolvedValue({ changes: 1 }),
      all: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(null),
    };

    mockLedger = {
      getEventsByRange: vi.fn().mockImplementation((from: number, to: number) =>
        Promise.resolve(events.filter(e => e.sequence >= from && e.sequence <= to)),
      ),
      getChainState: vi.fn().mockReturnValue({ lastHash: events[4].hash, sequence: 5 }),
      appendEvent: vi.fn().mockResolvedValue(undefined),
    };

    config = createMockConfig();
  });

  // ---------------------------------------------------------------------------
  // Provider wiring
  // ---------------------------------------------------------------------------

  it('should accept a provider and expose it via getProvider()', () => {
    const provider = createMockProvider();
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);
    expect(mgr.getProvider()).toBe(provider);
  });

  it('should return null from getProvider() when no provider is set', () => {
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '');
    expect(mgr.getProvider()).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // External publishing on createAnchor
  // ---------------------------------------------------------------------------

  it('should call provider.publish() after persisting an anchor', async () => {
    const provider = createMockProvider();
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);

    const anchor = await mgr.createAnchor(1, 5);

    // publish is fire-and-forget, so give it a tick to resolve
    await vi.waitFor(() => expect(provider.publishMock).toHaveBeenCalledTimes(1));

    // Verify the published anchor matches what was created
    const publishedAnchor = provider.publishMock.mock.calls[0][0] as AnchorRecord;
    expect(publishedAnchor.id).toBe(anchor.id);
    expect(publishedAnchor.merkleRoot).toBe(anchor.merkleRoot);
    expect(publishedAnchor.sequenceFrom).toBe(1);
    expect(publishedAnchor.sequenceTo).toBe(5);
  });

  it('should update external_ref in DB when provider returns a successful ref', async () => {
    const provider = createMockProvider();
    provider.publishMock.mockResolvedValue({
      providerId: 'mock',
      success: true,
      externalRef: 'rekor:logindex:abc123',
    });

    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);
    await mgr.createAnchor(1, 5);

    await vi.waitFor(() => {
      // The first run call is INSERT (anchor persist), second is UPDATE (external_ref)
      const calls = mockStorage.run.mock.calls;
      const updateCall = calls.find((c: unknown[]) => (c[0] as string).includes('UPDATE'));
      expect(updateCall).toBeTruthy();
      expect(updateCall[1]).toContain('rekor:logindex:abc123');
    });
  });

  it('should NOT update external_ref when provider returns success without a ref', async () => {
    const provider = createMockProvider();
    provider.publishMock.mockResolvedValue({
      providerId: 'mock',
      success: true,
      // no externalRef
    });

    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);
    await mgr.createAnchor(1, 5);

    // Give the fire-and-forget a moment
    await new Promise(r => setTimeout(r, 50));

    const updateCalls = mockStorage.run.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('UPDATE'),
    );
    expect(updateCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Failure isolation
  // ---------------------------------------------------------------------------

  it('should NOT block anchor creation when provider.publish() rejects', async () => {
    const provider = createMockProvider();
    provider.publishMock.mockRejectedValue(new Error('Network timeout'));

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);

    // createAnchor should resolve successfully despite provider failure
    const anchor = await mgr.createAnchor(1, 5);
    expect(anchor).toBeDefined();
    expect(anchor.id).toBeTruthy();
    expect(anchor.merkleRoot).toBeTruthy();

    // Give fire-and-forget a moment
    await new Promise(r => setTimeout(r, 50));
    consoleSpy.mockRestore();
  });

  it('should NOT block anchor creation when provider returns { success: false }', async () => {
    const provider = createMockProvider();
    provider.publishMock.mockResolvedValue({
      providerId: 'mock',
      success: false,
      error: 'Service unavailable',
    });

    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);
    const anchor = await mgr.createAnchor(1, 5);

    expect(anchor).toBeDefined();
    expect(anchor.merkleRoot).toBeTruthy();

    // No UPDATE call since success was false
    await new Promise(r => setTimeout(r, 50));
    const updateCalls = mockStorage.run.mock.calls.filter(
      (c: unknown[]) => (c[0] as string).includes('UPDATE'),
    );
    expect(updateCalls.length).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // No provider
  // ---------------------------------------------------------------------------

  it('should work without a provider (no publish call)', async () => {
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '');
    const anchor = await mgr.createAnchor(1, 5);

    expect(anchor).toBeDefined();
    expect(anchor.sequenceFrom).toBe(1);
    expect(anchor.sequenceTo).toBe(5);
  });

  // ---------------------------------------------------------------------------
  // Provider dispose on stop
  // ---------------------------------------------------------------------------

  it('should call provider.dispose() when stop() is called', () => {
    const provider = createMockProvider();
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);

    mgr.start();
    mgr.stop();

    expect(provider.disposeMock).toHaveBeenCalledTimes(1);
  });

  it('should handle missing dispose() gracefully', () => {
    const provider: AnchorProvider = {
      id: 'no-dispose',
      name: 'No Dispose',
      proofLevel: 'verifiable',
      publish: vi.fn().mockResolvedValue({ providerId: 'no-dispose', success: true }),
    };

    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);
    mgr.start();
    expect(() => mgr.stop()).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // createAnchorIfNeeded with provider
  // ---------------------------------------------------------------------------

  it('should publish externally when createAnchorIfNeeded triggers an anchor', async () => {
    const provider = createMockProvider();
    const mgr = new AnchorManager(mockStorage, mockLedger, km, config, '', provider);

    const anchor = await mgr.createAnchorIfNeeded();
    expect(anchor).not.toBeNull();

    await vi.waitFor(() => expect(provider.publishMock).toHaveBeenCalledTimes(1));
  });
});
