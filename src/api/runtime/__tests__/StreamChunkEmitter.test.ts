import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the otel module before importing StreamChunkEmitter
vi.mock('../../../safety/evaluation/observability/otel', () => ({
  shouldIncludeTraceInAgentOSResponses: vi.fn(() => false),
  getActiveTraceMetadata: vi.fn(() => null),
}));

// Mock normalizeUsage
vi.mock('../../../orchestration/turn-planner/helpers', () => ({
  normalizeUsage: vi.fn((u: any) => u ?? {}),
}));

import { StreamChunkEmitter } from '../StreamChunkEmitter';
import { AgentOSResponseChunkType } from '../../types/AgentOSResponse';
import {
  shouldIncludeTraceInAgentOSResponses,
  getActiveTraceMetadata,
} from '../../../safety/evaluation/observability/otel';
import type { StreamingManager } from '../../../core/streaming/StreamingManager';

function createMockStreamingManager(): StreamingManager {
  return {
    pushChunk: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe('StreamChunkEmitter', () => {
  let mockSM: StreamingManager;
  let contexts: Map<string, { languageNegotiation?: any }>;
  let emitter: StreamChunkEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSM = createMockStreamingManager();
    contexts = new Map();
    emitter = new StreamChunkEmitter(mockSM, contexts);
  });

  // --- pushChunk shape assembly ---

  describe('pushChunk', () => {
    it('assembles TEXT_DELTA chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'persona1', false, {
        textDelta: 'hello',
      });

      expect(mockSM.pushChunk).toHaveBeenCalledTimes(1);
      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.TEXT_DELTA);
      expect(chunk.streamId).toBe('s1');
      expect(chunk.gmiInstanceId).toBe('gmi1');
      expect(chunk.personaId).toBe('persona1');
      expect(chunk.isFinal).toBe(false);
      expect(chunk.textDelta).toBe('hello');
      expect(chunk.timestamp).toBeDefined();
    });

    it('assembles ERROR chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.ERROR, 'gmi1', 'p1', true, {
        code: 'ERR_CODE',
        message: 'something broke',
        details: { extra: true },
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(chunk.code).toBe('ERR_CODE');
      expect(chunk.message).toBe('something broke');
      expect(chunk.details).toEqual({ extra: true });
      expect(chunk.isFinal).toBe(true);
    });

    it('assembles FINAL_RESPONSE chunk correctly', async () => {
      const data = {
        finalResponseText: 'done',
        finalToolCalls: [],
        finalUiCommands: [],
        audioOutput: null,
        imageOutput: null,
        usage: { promptTokens: 10, completionTokens: 20 },
        reasoningTrace: [],
        error: null,
        updatedConversationContext: null,
        activePersonaDetails: null,
        structured: { value: { items: [] }, meta: { schemaName: 'week', valid: true, attempts: 1, enforcement: 'prompt_only', stage: 'model' } },
      };

      await emitter.pushChunk('s1', AgentOSResponseChunkType.FINAL_RESPONSE, 'gmi1', 'p1', true, data);

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.FINAL_RESPONSE);
      expect(chunk.finalResponseText).toBe('done');
      expect(chunk.isFinal).toBe(true);
      // a structured turn's parsed value rides the final chunk; a whitelist here is where it was dropped
      expect(chunk.structured).toEqual(data.structured);
    });

    it('assembles SYSTEM_PROGRESS chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.SYSTEM_PROGRESS, 'gmi1', 'p1', false, {
        message: 'Loading...',
        progressPercentage: 42,
        statusCode: 'PROCESSING',
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.SYSTEM_PROGRESS);
      expect(chunk.message).toBe('Loading...');
      expect(chunk.progressPercentage).toBe(42);
      expect(chunk.statusCode).toBe('PROCESSING');
    });

    it('assembles TOOL_CALL_REQUEST chunk correctly', async () => {
      const toolCalls = [{ id: 't1', type: 'function', function: { name: 'search', arguments: '{}' } }];
      await emitter.pushChunk('s1', AgentOSResponseChunkType.TOOL_CALL_REQUEST, 'gmi1', 'p1', false, {
        toolCalls,
        rationale: 'need to search',
        executionMode: 'external',
        requiresExternalToolResult: true,
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.TOOL_CALL_REQUEST);
      expect(chunk.toolCalls).toEqual(toolCalls);
      expect(chunk.rationale).toBe('need to search');
      expect(chunk.executionMode).toBe('external');
      expect(chunk.requiresExternalToolResult).toBe(true);
    });

    it('assembles TOOL_RESULT_EMISSION chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.TOOL_RESULT_EMISSION, 'gmi1', 'p1', false, {
        toolCallId: 'tc1',
        toolName: 'search',
        toolResult: { found: true },
        isSuccess: true,
        errorMessage: undefined,
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.TOOL_RESULT_EMISSION);
      expect(chunk.toolCallId).toBe('tc1');
      expect(chunk.toolName).toBe('search');
      expect(chunk.isSuccess).toBe(true);
    });

    it('assembles UI_COMMAND chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.UI_COMMAND, 'gmi1', 'p1', false, {
        uiCommands: [{ action: 'navigate', target: '/home' }],
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.UI_COMMAND);
      expect(chunk.uiCommands).toEqual([{ action: 'navigate', target: '/home' }]);
    });

    it('assembles WORKFLOW_UPDATE chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.WORKFLOW_UPDATE, 'gmi1', 'p1', false, {
        workflow: { id: 'wf1', status: 'running' },
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.WORKFLOW_UPDATE);
      expect(chunk.workflow).toEqual({ id: 'wf1', status: 'running' });
    });

    it('assembles METADATA_UPDATE chunk correctly', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.METADATA_UPDATE, 'gmi1', 'p1', false, {
        updates: { key: 'value' },
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.METADATA_UPDATE);
      expect(chunk.updates).toEqual({ key: 'value' });
    });

    it('falls back to ERROR chunk for unknown type', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await emitter.pushChunk('s1', 'unknown_type' as any, 'gmi1', 'p1', false, { foo: 'bar' });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(chunk.message).toContain('Unknown chunk type');
      consoleSpy.mockRestore();
    });
  });

  // --- language negotiation metadata ---

  describe('language negotiation metadata', () => {
    it('adds language metadata from activeStreamContexts', async () => {
      contexts.set('s1', { languageNegotiation: { detected: 'fr', preferred: 'en' } });

      await emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'p1', false, {
        textDelta: 'bonjour',
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.metadata).toBeDefined();
      expect(chunk.metadata.language).toEqual({ detected: 'fr', preferred: 'en' });
    });

    it('does not overwrite existing language metadata from data', async () => {
      contexts.set('s1', { languageNegotiation: { detected: 'fr' } });

      await emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'p1', false, {
        textDelta: 'hello',
        metadata: { language: { detected: 'en' } },
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      // data.metadata.language was already set, so context doesn't overwrite it
      expect(chunk.metadata.language).toEqual({ detected: 'en' });
    });

    it('does not add metadata when no stream context exists', async () => {
      await emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'p1', false, {
        textDelta: 'hello',
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      // No metadata key expected at all (or undefined)
      expect(chunk.metadata?.language).toBeUndefined();
    });
  });

  // --- trace metadata ---

  describe('trace metadata for specific chunk types', () => {
    it('attaches trace metadata to FINAL_RESPONSE when otel is enabled', async () => {
      vi.mocked(shouldIncludeTraceInAgentOSResponses).mockReturnValue(true);
      vi.mocked(getActiveTraceMetadata).mockReturnValue({
        traceId: 'trace-123',
        spanId: 'span-456',
        traceFlags: '01',
      } as any);

      await emitter.pushChunk('s1', AgentOSResponseChunkType.FINAL_RESPONSE, 'gmi1', 'p1', true, {
        finalResponseText: 'ok',
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.metadata?.trace).toEqual({
        traceId: 'trace-123',
        spanId: 'span-456',
        traceFlags: '01',
      });
    });

    it('does not attach trace metadata to TEXT_DELTA even when otel is enabled', async () => {
      vi.mocked(shouldIncludeTraceInAgentOSResponses).mockReturnValue(true);
      vi.mocked(getActiveTraceMetadata).mockReturnValue({ traceId: 'x' } as any);

      await emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'p1', false, {
        textDelta: 'test',
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.metadata?.trace).toBeUndefined();
    });
  });

  // --- pushError ---

  describe('pushError', () => {
    it('constructs an ERROR chunk with isFinal=true', async () => {
      await emitter.pushError('s1', 'p1', 'gmi1', 'ERR_42', 'bad things');

      expect(mockSM.pushChunk).toHaveBeenCalledTimes(1);
      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.ERROR);
      expect(chunk.isFinal).toBe(true);
      expect(chunk.code).toBe('ERR_42');
      expect(chunk.message).toBe('bad things');
    });

    it('passes details through', async () => {
      await emitter.pushError('s1', 'p1', 'gmi1', 'ERR', 'msg', { x: 1 });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.details).toEqual({ x: 1 });
    });
  });

  // --- emitLifecycleUpdate ---

  describe('emitLifecycleUpdate', () => {
    it('emits a METADATA_UPDATE chunk with lifecycle info', async () => {
      await emitter.emitLifecycleUpdate({
        streamId: 's1',
        gmiInstanceId: 'gmi1',
        personaId: 'p1',
        phase: 'executing',
        status: 'ok',
      });

      expect(mockSM.pushChunk).toHaveBeenCalledTimes(1);
      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.type).toBe(AgentOSResponseChunkType.METADATA_UPDATE);
      expect(chunk.isFinal).toBe(false);
      expect(chunk.updates.executionLifecycle.phase).toBe('executing');
      expect(chunk.updates.executionLifecycle.status).toBe('ok');
      expect(chunk.updates.executionLifecycle.timestamp).toBeDefined();
    });

    it('includes details when provided', async () => {
      await emitter.emitLifecycleUpdate({
        streamId: 's1',
        gmiInstanceId: 'gmi1',
        personaId: 'p1',
        phase: 'degraded',
        status: 'degraded',
        details: { fallback: true },
      });

      const chunk = (mockSM.pushChunk as any).mock.calls[0][1];
      expect(chunk.updates.executionLifecycle.details).toEqual({ fallback: true });
    });
  });

  // --- graceful error handling ---

  describe('graceful error handling', () => {
    it('catches and logs error when streamingManager.pushChunk throws', async () => {
      (mockSM.pushChunk as any).mockRejectedValueOnce(new Error('stream closed'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Should not throw
      await expect(
        emitter.pushChunk('s1', AgentOSResponseChunkType.TEXT_DELTA, 'gmi1', 'p1', false, { textDelta: 'hi' }),
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalled();
      expect(consoleSpy.mock.calls[0][0]).toContain('Failed to push chunk');
      consoleSpy.mockRestore();
    });
  });
});
