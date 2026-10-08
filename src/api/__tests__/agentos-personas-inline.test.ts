/**
 * @file agentos-personas-inline.test.ts
 * Boots the real runtime with AgentOS.create({ personas }) and a provider stub,
 * and checks that inline personas are listed, served by a GMI turn, normalized
 * like file personas, and rejected before any provider initialises when malformed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const providerInitialize = vi.fn(async () => undefined);

vi.mock('../../core/llm/providers/implementations/OpenAIProvider', () => {
  class OpenAIProvider {
    readonly providerId = 'openai';
    isInitialized = false;
    async initialize(_config: Record<string, unknown>) {
      await providerInitialize();
      this.isInitialized = true;
    }
    async generateCompletion() {
      return { choices: [{ message: { role: 'assistant', content: 'ok' }, finishReason: 'stop' }], responseText: 'ok' };
    }
    async *generateCompletionStream() {
      yield { responseTextDelta: 'Hello from the inline persona.' };
      yield { isFinal: true, choices: [{ message: { role: 'assistant', content: 'Hello from the inline persona.' }, finishReason: 'stop' }] };
    }
    async generateEmbeddings() { return { embeddings: [] }; }
    async listAvailableModels() { return []; }
    async getModelInfo() { return undefined; }
    async checkHealth() { return { isHealthy: true }; }
    async shutdown() {}
  }
  return { OpenAIProvider };
});

import { AgentOS } from '../AgentOS';
import { AgentOSResponseChunkType } from '../types/AgentOSResponse';
import { createAgentOSConfig } from '../../core/config/AgentOSConfig';
import type { IPersonaDefinition } from '../../cognition/substrate/personas/IPersonaDefinition';
import { GMIErrorCode } from '../../core/utils/errors.js';

const persona: IPersonaDefinition = {
  id: 'inline-helper', name: 'Inline Helper', description: 'A persona defined in code for the test.',
  version: '1.0.0', baseSystemPrompt: 'You are a helpful assistant.',
};
const withPresets = {
  ...persona, id: 'inline-presets', name: 'Inline Presets',
  sentimentTracking: { enabled: true, presets: ['frustration_recovery'] },
} as unknown as IPersonaDefinition;
const providers = { providers: [{ providerId: 'openai', enabled: true, isDefault: true, config: { apiKey: 'test' } }] };

// No storageAdapter: AgentOS.create() then runs on the package's Prisma stub and keeps
// conversations in memory (ConversationManager turns persistence off), which is the
// documented zero-config path the README sample uses.
async function boot(overrides: Record<string, unknown>): Promise<AgentOS> {
  return AgentOS.create({ modelProviderManagerConfig: providers, turnPlanning: { enabled: false }, ...overrides } as any);
}

async function collect(agentos: AgentOS, selectedPersonaId: string): Promise<any[]> {
  const chunks: any[] = [];
  for await (const chunk of agentos.processRequest({ userId: 'user-1', sessionId: `s-${selectedPersonaId}`, selectedPersonaId, textInput: 'Say hello.' } as any)) {
    chunks.push(chunk);
  }
  return chunks;
}

describe('AgentOS.create({ personas })', () => {
  let booted: AgentOS | undefined;
  beforeEach(() => { providerInitialize.mockClear(); booted = undefined; });
  afterEach(async () => { if (booted) await booted.shutdown(); });

  it('rejects contradictory or malformed persona sources before any provider initialises', async () => {
    const loader = { initialize: async () => undefined, loadPersonaById: async () => undefined, loadAllPersonaDefinitions: async () => [] };
    await expect(boot({ personas: [persona], personaLoader: loader })).rejects.toMatchObject({ code: GMIErrorCode.CONFIGURATION_ERROR });
    await expect(boot({ personas: [persona, { ...persona }] })).rejects.toMatchObject({ code: GMIErrorCode.CONFIGURATION_ERROR });
    await expect(boot({ personas: 'nope' })).rejects.toMatchObject({ code: GMIErrorCode.CONFIGURATION_ERROR });
    expect(providerInitialize).not.toHaveBeenCalled();
  });

  it('lists an inline persona and serves it through a real GMI turn', async () => {
    booted = await boot({ personas: [persona] });
    const listed = await booted.listAvailablePersonas('user-1');
    expect(listed.map((p) => p.id)).toContain('inline-helper');
    const chunks = await collect(booted, 'inline-helper');
    const text = chunks.filter((c) => c.type === AgentOSResponseChunkType.TEXT_DELTA).map((c) => c.textDelta).join('');
    expect(text).toContain('Hello from the inline persona.');
    expect(chunks.some((c) => c.type === AgentOSResponseChunkType.ERROR)).toBe(false);
  });

  it("reports an unknown persona as an error chunk carrying the manager's message", async () => {
    booted = await boot({ personas: [persona] });
    const chunks = await collect(booted, 'missing');
    const error = chunks.find((c) => c.type === AgentOSResponseChunkType.ERROR);
    expect(error).toBeTruthy();
    expect(error.code).toBe(GMIErrorCode.GMI_PROCESSING_ERROR);
    expect(error.message).toMatch(/Persona 'missing' not found/);
  });

  it('expands sentiment presets for inline and file personas alike', async () => {
    booted = await boot({ personas: [withPresets] });
    const inline = booted.getGMIManager().getPersonaDefinition('inline-presets');
    expect(inline?.metaPrompts?.map((m) => m.id)).toContain('gmi_frustration_recovery');
    await booted.shutdown();
    booted = undefined;

    const dir = await mkdtemp(join(tmpdir(), 'agentos-personas-'));
    try {
      await writeFile(join(dir, 'inline-presets.json'), JSON.stringify(withPresets), 'utf8');
      const base = await createAgentOSConfig();
      booted = await boot({ gmiManagerConfig: { ...base.gmiManagerConfig, personaLoaderConfig: { personaSource: dir, loaderType: 'file_system' } } });
      const fromFile = booted.getGMIManager().getPersonaDefinition('inline-presets');
      expect(fromFile?.metaPrompts?.map((m) => m.id)).toEqual(inline?.metaPrompts?.map((m) => m.id));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
