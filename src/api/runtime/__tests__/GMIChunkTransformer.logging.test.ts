import { expect, it, vi } from 'vitest';
import { GMIChunkTransformer, type TransformerStreamContext } from '../GMIChunkTransformer.js';
import type { StreamChunkEmitter } from '../StreamChunkEmitter.js';
import type { AgentOSOrchestratorDependencies } from '../../types/OrchestratorConfig.js';
import type { GMIOutputChunk } from '../../../cognition/substrate/IGMI.js';

it('logs only the type of an unhandled GMI chunk', async () => {
  const sentinel = 'sentinel-words-7731';
  const transformer = new GMIChunkTransformer(
    new Map(), {} as StreamChunkEmitter, {} as AgentOSOrchestratorDependencies, false, async () => {},
  );
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await transformer.transformAndPushGMIChunk('stream-1', {
      gmi: { getGMIId: () => 'gmi-1' }, personaId: 'persona-1',
    } as TransformerStreamContext, { type: 'unknown', content: sentinel } as unknown as GMIOutputChunk);
    expect(warn).toHaveBeenCalledExactlyOnceWith("AgentOSOrchestrator: Unhandled GMIOutputChunkType 'unknown'.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sentinel);
  } finally {
    warn.mockRestore();
  }
});
